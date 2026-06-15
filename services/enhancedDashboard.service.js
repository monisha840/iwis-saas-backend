/**
 * EnhancedDashboardService — proactive, guided patient dashboard.
 *
 * Aggregates: smart banner, daily task checklist, smart messages, today's
 * medications, vitals tiles, treatment journey progress, zen + challenges,
 * pain map, and notifications into a single payload.
 *
 * Also exposes the inline action endpoints (check-in, quick-log vital,
 * mark medication taken, log pain region) and the smart-insight engine
 * that surfaces patterns from recent check-ins.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ZenPointsService } from './zenPoints.service.js';
import { notificationService } from './notification.service.js';
import { emitToUser } from '../websocket/index.js';
import { parseDailyDoseCount } from './medicationFrequency.js';
import { SmartInsightService } from './smartInsight.service.js';

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}

function bucketOfDay() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

// Map prescription frequency text → ordered slot list.
function parseFrequencySlots(frequency = '') {
  const f = frequency.toLowerCase();
  if (f.includes('three') || f.includes('3 times') || f.includes('tid')) {
    return ['morning', 'afternoon', 'evening'];
  }
  if (f.includes('twice') || f.includes('2 times') || f.includes('bid')) {
    return ['morning', 'evening'];
  }
  if (f.includes('night') || f.includes('bedtime') || f.includes('hs')) {
    return ['evening'];
  }
  if (f.includes('afternoon') || f.includes('lunch')) {
    return ['afternoon'];
  }
  return ['morning'];
}

function nextScheduledHourForBucket(bucket) {
  if (bucket === 'morning') return 9;
  if (bucket === 'afternoon') return 14;
  return 20;
}

export class EnhancedDashboardService {
  // ── Public: full dashboard summary in one call ───────────────────────────
  static async getSummary(patientId, userId) {
    logger.info('[EnhancedDashboard] summary', { patientId, userId });
    const now = new Date();

    const [
      patient,
      todayCheckIn,
      activePrescriptions,
      todayMedLogs,
      activeJourneyByUser,
      zenLedgerToday,
      challengeCompletionsToday,
      latestVitalsByType,
      vitalsLogged24h,
      nextAppointment,
      patientStreak,
      latestTriage,
      latestCheckInWithRegions,
      unreadNotifications,
      prescribedVitals,
      careTeamAssignments,
    ] = await Promise.all([
      prisma.patient.findUnique({
        where: { id: patientId },
        select: { fullName: true, zenPoints: true, userId: true },
      }),
      prisma.dailyCheckIn.findFirst({
        where: { patientId, createdAt: { gte: startOfToday() } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.prescription.findMany({
        where: {
          patientId,
          // "Active" = not discontinued, not yet past its expected end date.
          //
          // The legacy `totalQuantity > 0` gate was dropping every freshly-
          // written prescription that hadn't had a manual quantity entered
          // (the prescription form leaves it as the schema @default(0)) AND
          // every prescription using the newer dispensedQty/consumedQty
          // lifecycle (both also @default(0) pre-dispense). Quantity-
          // remaining is a refill-warning concern handled by
          // MedicationSupplyCard via the medicationLifecycle forecasts —
          // not a gate on whether the patient should see the dose to log
          // today.
          discontinuedAt: null,
          OR: [
            { expectedEndDate: null },
            { expectedEndDate: { gte: startOfToday() } },
          ],
        },
        select: {
          id: true, medicationName: true, dosage: true, frequency: true,
          notes: true, totalQuantity: true,
          dispensedQty: true, consumedQty: true, dailyDoseCount: true,
          expectedEndDate: true,
        },
      }),
      prisma.medicationLog.findMany({
        where: {
          prescription: { patientId },
          taken: true,
          date: { gte: startOfToday(), lte: endOfToday() },
        },
        select: { id: true, prescriptionId: true, takenAt: true, date: true },
      }),
      prisma.treatmentJourney.findFirst({
        where: { status: 'ACTIVE', patientId: userId },
        include: {
          phases: { orderBy: { order: 'asc' } },
          milestones: { orderBy: { targetDate: 'asc' } },
        },
      }),
      prisma.zenPointsLedger.findMany({
        where: { patientId, createdAt: { gte: startOfToday() } },
        select: { action: true, points: true },
      }),
      prisma.patientChallengeCompletion.findMany({
        where: { patientId, completedAt: { gte: startOfToday() } },
        select: { challengeId: true },
      }).catch(() => []),
      // Self-scoped: userId is the authenticated caller's own User id (own dashboard).
      // Parameterised tagged template (no string interpolation).
      prisma.$queryRaw`
        SELECT DISTINCT ON ("type") "type", "value", "unit", "recordedAt"
        FROM "PatientVital"
        WHERE "patientId" = ${userId}
        ORDER BY "type", "recordedAt" DESC`.catch(() => []),
      prisma.patientVital.count({
        where: { patientId: userId, recordedAt: { gte: new Date(now.getTime() - MS_DAY) } },
      }).catch(() => 0),
      prisma.appointment.findFirst({
        where: {
          patientId,
          status: { in: ['PENDING', 'SCHEDULED', 'CONFIRMED'] },
          date: { gte: now },
        },
        include: {
          doctor: { select: { id: true, fullName: true } },
          therapist: { select: { id: true, fullName: true } },
          branch: { select: { id: true, name: true } },
        },
        orderBy: { date: 'asc' },
      }),
      prisma.patientStreak.findUnique({ where: { patientId } }).catch(() => null),
      prisma.triageSession.findFirst({
        where: { patientId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, painRegions: true, createdAt: true },
      }),
      // Latest DailyCheckIn that actually has a body-map array — primary
      // source for the dashboard pain map. Falls back to TriageSession
      // inside buildPainMap when this is null.
      prisma.dailyCheckIn.findFirst({
        where: { patientId, painRegions: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, painRegions: true, createdAt: true },
      }),
      prisma.notification.count({ where: { userId, isRead: false } }),
      prisma.prescribedVital.findMany({
        where: { patientId, active: true },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, vitalType: true, frequency: true, notes: true,
          prescribedBy: {
            select: {
              id: true, email: true,
              doctor: { select: { fullName: true } },
              therapist: { select: { fullName: true } },
            },
          },
        },
      }),
      // Active care-team assignments — surfaced on the patient dashboard so
      // the patient can see at a glance who their primary doctor is (and any
      // consulting / temporary fall-backs). Sorted by type so PRIMARY is
      // always first regardless of insertion order.
      prisma.patientAssignment.findMany({
        where: { patientId, status: 'ACTIVE' },
        orderBy: [{ type: 'asc' }, { assignedAt: 'desc' }],
        include: {
          doctor: {
            select: {
              id: true, fullName: true, specialization: true,
              qualification: true, profilePhoto: true,
              user: { select: { email: true } },
            },
          },
        },
      }).catch(() => []),
    ]);

    if (!patient) {
      throw new Error('Patient not found');
    }

    // ── Build Today's Medications ────────────────────────────────────────
    const medications = this.buildTodayMedications(activePrescriptions, todayMedLogs);
    const adherenceWeek = await this.computeWeeklyAdherence(patientId, activePrescriptions);

    // ── Vitals — driven by what the doctor has prescribed ───────────────
    const vitals = this.buildVitalsTiles(latestVitalsByType, prescribedVitals);

    // ── Daily Tasks (medication, check-in, vitals, exercises, phase tasks)
    const tasks = await this.buildDailyTasks({
      patientId, userId, todayCheckIn, medications, vitals,
      activeJourney: activeJourneyByUser,
    });

    // ── Smart Banner (single most-important action) ──────────────────────
    const banner = this.computeBanner({
      todayCheckIn, medications, vitals,
      nextAppointment, activeJourney: activeJourneyByUser,
      now,
    });

    // ── Zen profile + today's challenges ─────────────────────────────────
    const zenProfile = await this.buildZenProfile({
      patient, patientStreak,
      todayCheckIn, medications, vitals,
      challengeCompletionsToday, zenLedgerToday,
    });

    // ── Treatment Journey card ───────────────────────────────────────────
    const journey = this.buildJourneyCard(activeJourneyByUser);

    // ── Pain Map ─────────────────────────────────────────────────────────
    const painMap = this.buildPainMap(latestCheckInWithRegions, latestTriage);

    // ── Smart Messages ───────────────────────────────────────────────────
    const smartMessages = await this.getSmartMessages(patientId, userId, {
      todayCheckIn, medications, nextAppointment, patientStreak,
    });

    // ── Care Team — patient-facing snapshot of who's assigned ────────────
    // PRIMARY is the lead doctor; CONSULTING / TEMPORARY are surfaced as
    // "additional" rows so the patient understands fall-back coverage.
    const careTeam = (() => {
      const primary = careTeamAssignments.find((a) => a.type === 'PRIMARY') || null;
      const additional = careTeamAssignments.filter((a) => a.type !== 'PRIMARY');
      const mapAssignment = (a) => ({
        assignmentId: a.id,
        type: a.type,
        assignedAt: a.assignedAt,
        doctor: {
          id: a.doctor.id,
          fullName: a.doctor.fullName || null,
          specialization: a.doctor.specialization || null,
          qualification: a.doctor.qualification || null,
          profilePhoto: a.doctor.profilePhoto || null,
          email: a.doctor.user?.email || null,
        },
      });
      return {
        primary: primary ? mapAssignment(primary) : null,
        additional: additional.map(mapAssignment),
      };
    })();

    // ── Notification preference (channel indicators) ─────────────────────
    const channels = await prisma.notificationPreference.findUnique({
      where: { userId },
      select: {
        pushEnabled: true, whatsappEnabled: true,
      },
    });

    return {
      patient: {
        id: patientId,
        fullName: patient.fullName || null,
      },
      banner,
      tasks,
      checkIn: {
        completedToday: !!todayCheckIn,
        record: todayCheckIn || null,
      },
      medications: {
        items: medications,
        adherenceWeekPct: adherenceWeek,
      },
      vitals: {
        items: vitals,
        loggedTodayCount: vitalsLogged24h,
      },
      journey,
      zen: zenProfile,
      painMap,
      smartMessages,
      careTeam,
      channels: channels || {
        pushEnabled: true, whatsappEnabled: false,
      },
      unreadNotifications,
      generatedAt: now.toISOString(),
    };
  }

  // ── Today's medications grouped by morning/afternoon/evening ─────────────
  static buildTodayMedications(prescriptions, todayMedLogs) {
    const takenMap = new Map();
    for (const log of todayMedLogs) {
      if (!takenMap.has(log.prescriptionId)) takenMap.set(log.prescriptionId, []);
      takenMap.get(log.prescriptionId).push(log.takenAt || log.date);
    }

    const now = new Date();
    const currentBucket = bucketOfDay();

    const result = [];
    for (const rx of prescriptions) {
      const slots = parseFrequencySlots(rx.frequency);
      const takenStamps = takenMap.get(rx.id) || [];

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const slotHour = nextScheduledHourForBucket(slot);
        const scheduledTime = new Date();
        scheduledTime.setHours(slotHour, 0, 0, 0);

        // A taken stamp covers the earliest unfilled slot.
        const takenAt = takenStamps[i] || null;

        let status = 'PENDING';
        if (takenAt) status = 'TAKEN';
        else if (slot === currentBucket) status = 'DUE';
        else if (
          (slot === 'morning' && currentBucket !== 'morning') ||
          (slot === 'afternoon' && currentBucket === 'evening')
        ) {
          // missed window
          status = scheduledTime.getTime() < now.getTime() - 2 * MS_HOUR ? 'MISSED' : 'PENDING';
        }

        result.push({
          prescriptionId: rx.id,
          medicationName: rx.medicationName,
          dosage: rx.dosage,
          instructions: rx.notes || null,
          slot,
          scheduledHour: slotHour,
          status,
          takenAt,
        });
      }
    }

    // Sort: morning → afternoon → evening, then by name
    const order = { morning: 0, afternoon: 1, evening: 2 };
    result.sort((a, b) => order[a.slot] - order[b.slot] || a.medicationName.localeCompare(b.medicationName));
    return result;
  }

  static async computeWeeklyAdherence(patientId, prescriptions) {
    if (prescriptions.length === 0) return null;
    const since = new Date(Date.now() - 7 * MS_DAY);
    const logs = await prisma.medicationLog.count({
      where: {
        prescription: { patientId },
        taken: true,
        date: { gte: since },
      },
    });
    const expected = prescriptions.reduce(
      (sum, rx) => sum + parseFrequencySlots(rx.frequency).length * 7,
      0,
    );
    if (expected === 0) return null;
    return Math.min(100, Math.round((logs / expected) * 100));
  }

  // ── Latest value for each vital the doctor has prescribed ───────────────
  // Returns one tile per active PrescribedVital. If the doctor hasn't
  // prescribed any, returns an empty list — the UI surfaces an empty state.
  static buildVitalsTiles(rawRows, prescribedVitals) {
    const byType = new Map();
    for (const row of rawRows || []) {
      byType.set(row.type, row);
    }

    const prescribed = prescribedVitals || [];
    return prescribed.map((p) => {
      const r = byType.get(p.vitalType);
      const prescriberName =
        p.prescribedBy?.doctor?.fullName ||
        p.prescribedBy?.therapist?.fullName ||
        p.prescribedBy?.email ||
        null;
      const base = {
        type: p.vitalType,
        prescriptionId: p.id,
        frequency: p.frequency,
        notes: p.notes,
        prescribedBy: prescriberName,
      };
      if (!r) {
        return { ...base, value: null, unit: null, lastLoggedAt: null, status: 'NOT_LOGGED' };
      }
      const staleMs = p.frequency === 'WEEKLY' ? 7 * MS_DAY : MS_DAY;
      const ageMs = Date.now() - new Date(r.recordedAt).getTime();
      const status = ageMs > staleMs ? 'STALE' : 'OK';
      return {
        ...base,
        value: r.value,
        unit: r.unit,
        lastLoggedAt: r.recordedAt,
        status,
      };
    });
  }

  // ── Daily Task Checklist ─────────────────────────────────────────────────
  static async buildDailyTasks({ patientId, userId, todayCheckIn, medications, vitals, activeJourney }) {
    const tasks = [];

    // Daily check-in (always one task)
    tasks.push({
      id: 'checkin-daily',
      type: 'CHECKIN',
      title: 'Log mood, pain, and sleep',
      status: todayCheckIn ? 'DONE' : 'PENDING',
      completedAt: todayCheckIn?.createdAt || null,
      priority: 1,
      action: { kind: 'OPEN_CHECKIN_MODAL' },
      points: 20,
    });

    // Medications (one task per pending dose)
    for (const m of medications.filter((m) => m.status !== 'TAKEN')) {
      tasks.push({
        id: `med-${m.prescriptionId}-${m.slot}`,
        type: 'MEDICATION',
        title: `Take ${m.medicationName} ${m.dosage}`,
        subtitle: m.instructions ? `${m.slot} · ${m.instructions}` : m.slot,
        status: m.status === 'MISSED' ? 'OVERDUE' : (m.status === 'DUE' ? 'ACTIVE' : 'PENDING'),
        priority: m.status === 'DUE' ? 2 : (m.status === 'MISSED' ? 1 : 4),
        action: { kind: 'MARK_MED_TAKEN', prescriptionId: m.prescriptionId, slot: m.slot },
        points: 5,
      });
    }

    // Vitals not logged today
    for (const v of vitals.filter((v) => v.status === 'NOT_LOGGED' || v.status === 'STALE')) {
      tasks.push({
        id: `vital-${v.type}`,
        type: 'VITAL',
        title: `Log today's ${this.vitalLabel(v.type)}`,
        status: v.status === 'STALE' ? 'OVERDUE' : 'PENDING',
        priority: 5,
        action: { kind: 'OPEN_VITAL_LOGGER', vitalType: v.type },
        points: 5,
      });
    }

    // Active journey phase tasks (not completed today)
    if (activeJourney) {
      const activePhase = activeJourney.phases?.find((p) => p.status === 'ACTIVE');
      if (activePhase) {
        const tasksInPhase = await prisma.phaseTask.findMany({
          where: { phaseId: activePhase.id },
          include: {
            completions: {
              where: { patientId: userId, completedAt: { gte: startOfToday() } },
              take: 1,
            },
          },
        });
        for (const t of tasksInPhase) {
          tasks.push({
            id: `phase-task-${t.id}`,
            type: t.type,
            title: t.title,
            subtitle: t.description || null,
            status: t.completions.length > 0 ? 'DONE' : 'PENDING',
            completedAt: t.completions[0]?.completedAt || null,
            priority: 6,
            action: { kind: 'COMPLETE_PHASE_TASK', taskId: t.id },
            points: 10,
          });
        }
      }
    }

    // Sort: PENDING/ACTIVE/OVERDUE first, then DONE; tiebreak by priority
    const statusOrder = { OVERDUE: 0, ACTIVE: 1, PENDING: 2, DONE: 3 };
    tasks.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 5;
      const sb = statusOrder[b.status] ?? 5;
      if (sa !== sb) return sa - sb;
      return (a.priority || 99) - (b.priority || 99);
    });

    return tasks;
  }

  static vitalLabel(type) {
    const map = {
      BP_SYSTOLIC: 'blood pressure',
      WEIGHT: 'weight',
      GLUCOSE: 'glucose',
      SLEEP_HOURS: 'sleep',
      MOOD: 'mood',
      PAIN_SCORE: 'pain score',
      BP_DIASTOLIC: 'blood pressure',
    };
    return map[type] || type.toLowerCase();
  }

  // ── Banner: pick the single most important call-to-action ───────────────
  static computeBanner({ todayCheckIn, medications, nextAppointment, activeJourney, now }) {
    // Highest priority: appointment in 15 min
    if (nextAppointment) {
      const minsUntil = (new Date(nextAppointment.date).getTime() - now.getTime()) / 60000;
      if (minsUntil > 0 && minsUntil <= 15) {
        const docName = nextAppointment.doctor?.fullName || nextAppointment.therapist?.fullName || 'your clinician';
        return {
          severity: 'CRITICAL',
          title: `Your video call with ${docName} starts in ${Math.ceil(minsUntil)} min`,
          cta: { label: 'Join Now', kind: 'JOIN_APPOINTMENT', appointmentId: nextAppointment.id },
        };
      }
    }

    // Appointment within 24h + check-in not done
    if (nextAppointment && !todayCheckIn) {
      const hoursUntil = (new Date(nextAppointment.date).getTime() - now.getTime()) / MS_HOUR;
      if (hoursUntil > 0 && hoursUntil <= 24) {
        const docName = nextAppointment.doctor?.fullName || nextAppointment.therapist?.fullName || 'your doctor';
        const timeStr = new Date(nextAppointment.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        return {
          severity: 'HIGH',
          title: `${docName} wants an update before your session at ${timeStr}`,
          cta: { label: 'Complete Check-in', kind: 'OPEN_CHECKIN_MODAL' },
        };
      }
    }

    // Medication missed
    const overdue = medications.filter((m) => m.status === 'MISSED').length;
    if (overdue > 0) {
      return {
        severity: 'HIGH',
        title: `You missed ${overdue} medication${overdue > 1 ? 's' : ''} today — log them now`,
        cta: { label: 'Log Medications', kind: 'SCROLL_TO_MEDS' },
      };
    }

    // Medication due now
    const dueNow = medications.filter((m) => m.status === 'DUE').length;
    if (dueNow > 0 && now.getHours() >= 10) {
      return {
        severity: 'MEDIUM',
        title: `You have ${dueNow} medication${dueNow > 1 ? 's' : ''} due — log them now`,
        cta: { label: 'View Medications', kind: 'SCROLL_TO_MEDS' },
      };
    }

    // Wellness score dropped (active journey signal)
    if (activeJourney && activeJourney.wellnessScore && activeJourney.wellnessScore < 60) {
      return {
        severity: 'MEDIUM',
        title: 'Your wellness score dropped — complete a check-in so your doctor can review',
        cta: { label: 'Start Check-in', kind: 'OPEN_CHECKIN_MODAL' },
      };
    }

    // Default check-in nudge before 10 AM
    if (!todayCheckIn) {
      return {
        severity: 'INFO',
        title: 'Take 60 seconds to log how you feel today',
        cta: { label: 'Quick Check-in', kind: 'OPEN_CHECKIN_MODAL' },
      };
    }

    // All done
    return {
      severity: 'SUCCESS',
      title: 'You\'re on track today — keep going!',
      cta: null,
    };
  }

  // ── Zen profile + today's challenges ─────────────────────────────────────
  static async buildZenProfile({ patient, patientStreak, todayCheckIn, medications, vitals, challengeCompletionsToday, zenLedgerToday }) {
    const points = patient.zenPoints || 0;
    const level = ZenPointsService.getLevel(points);

    // Challenge templates (rendered each day)
    const challenges = [
      {
        id: 'chal-checkin',
        title: 'Complete today\'s check-in',
        points: 20,
        completed: !!todayCheckIn,
        action: { kind: 'OPEN_CHECKIN_MODAL' },
      },
      {
        id: 'chal-meds',
        title: 'Mark all medications taken',
        points: 15,
        completed: medications.length > 0 && medications.every((m) => m.status === 'TAKEN'),
        action: { kind: 'SCROLL_TO_MEDS' },
      },
      {
        id: 'chal-vital',
        title: 'Log a vital today',
        points: 10,
        completed: vitals.some((v) => v.status === 'OK'),
        action: { kind: 'SCROLL_TO_VITALS' },
      },
    ];

    return {
      points,
      level,
      streak: {
        current: patientStreak?.currentStreak || 0,
        longest: patientStreak?.longestStreak || 0,
      },
      challenges,
      pointsEarnedToday: zenLedgerToday.reduce((sum, e) => sum + (e.points || 0), 0),
    };
  }

  static buildJourneyCard(journey) {
    if (!journey) return null;
    const phases = journey.phases || [];
    const total = phases.length;
    const completed = phases.filter((p) => p.status === 'COMPLETED').length;
    const active = phases.find((p) => p.status === 'ACTIVE');

    let currentDayInPhase = null;
    if (active?.startedAt) {
      currentDayInPhase = Math.floor((Date.now() - new Date(active.startedAt).getTime()) / MS_DAY) + 1;
    }

    return {
      id: journey.id,
      title: journey.title,
      condition: journey.condition,
      wellnessScore: journey.wellnessScore,
      targetDate: journey.targetDate,
      overallPct: total > 0 ? Math.round((completed / total) * 100) : 0,
      phaseHeader: active ? {
        name: active.name,
        currentDay: currentDayInPhase,
        durationDays: active.durationDays,
      } : null,
      phases: phases.map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        order: p.order,
        durationDays: p.durationDays,
      })),
      milestones: (journey.milestones || []).slice(0, 6).map((m) => ({
        id: m.id,
        title: m.title,
        achieved: m.isAchieved,
        targetDate: m.targetDate,
        achievedAt: m.achievedAt,
      })),
    };
  }

  /**
   * Build the dashboard pain map. Latest DailyCheckIn.painRegions is the
   * primary source — patients now log pain through the daily check-in body
   * map. Falls back to the latest TriageSession.painRegions when the patient
   * triaged but hasn't done a check-in yet (so returning patients still see
   * their last known pain map). Always emits the simplified
   * { region, severity } shape that the existing dashboard tile expects;
   * the rich body-map view reads `painRegionsRaw` instead.
   */
  static buildPainMap(latestCheckInWithRegions, latestTriage) {
    const source = (latestCheckInWithRegions && Array.isArray(latestCheckInWithRegions.painRegions))
      ? latestCheckInWithRegions
      : latestTriage;

    if (!source || !source.painRegions) {
      return { regions: [], regionsRaw: [], lastUpdated: null };
    }
    const regions = Array.isArray(source.painRegions) ? source.painRegions : [];
    return {
      regions: regions
        .filter((r) => r && (r.severity || r.intensity || r.score) != null)
        .map((r) => ({
          region: r.regionLabel || r.region || r.label || 'Unknown',
          severity: r.severity ?? r.intensity ?? r.score ?? 0,
        })),
      // Full structured regions for the body-map renderer (read-only).
      regionsRaw: regions.filter((r) => r && (r.intensity || r.severity || r.score) != null),
      lastUpdated: source.createdAt,
    };
  }

  /**
   * Normalize a pain-regions array off the request body. Caps array length,
   * clamps intensity to 0-10, sanitizes characters to a known whitelist,
   * defaults regionLabel from regionId. Anything malformed is dropped
   * silently rather than failing the whole check-in.
   */
  static normalizePainRegions(input) {
    if (!Array.isArray(input)) return [];
    const allowedCharacters = new Set(['Aching', 'Burning', 'Stabbing', 'Throbbing', 'Cramping', 'Numbness', 'Tingling']);
    const out = [];
    for (const r of input.slice(0, 26)) {
      if (!r || typeof r !== 'object') continue;
      const regionId = String(r.regionId || r.region || '').trim();
      if (!regionId) continue;
      const intensityRaw = Number(r.intensity ?? r.severity ?? r.score);
      if (!Number.isFinite(intensityRaw)) continue;
      const intensity = Math.max(0, Math.min(10, Math.round(intensityRaw)));
      const characters = Array.isArray(r.characters)
        ? r.characters.filter((c) => typeof c === 'string' && allowedCharacters.has(c))
        : [];
      const radiates = Boolean(r.radiates);
      const radiatesTo = typeof r.radiatesTo === 'string' && r.radiatesTo ? r.radiatesTo : undefined;
      out.push({
        regionId,
        regionLabel: String(r.regionLabel || r.label || regionId).slice(0, 80),
        intensity,
        characters,
        radiates,
        ...(radiatesTo ? { radiatesTo } : {}),
      });
    }
    return out;
  }

  /**
   * Last persisted pain regions for a patient — used to pre-populate the
   * body map in Step 2 of the daily check-in so returning patients only
   * have to adjust rather than re-enter from scratch. Reads the most
   * recent DailyCheckIn first, falling back to the latest TriageSession.
   */
  static async getLastPainRegions(patientId) {
    const lastCheckIn = await prisma.dailyCheckIn.findFirst({
      where: { patientId, painRegions: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { painRegions: true, createdAt: true },
    });
    if (lastCheckIn && Array.isArray(lastCheckIn.painRegions)) {
      return { painRegions: lastCheckIn.painRegions, source: 'check_in', recordedAt: lastCheckIn.createdAt };
    }
    const lastTriage = await prisma.triageSession.findFirst({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
      select: { painRegions: true, createdAt: true },
    });
    if (lastTriage && Array.isArray(lastTriage.painRegions)) {
      return { painRegions: lastTriage.painRegions, source: 'triage', recordedAt: lastTriage.createdAt };
    }
    return { painRegions: [], source: null, recordedAt: null };
  }

  // ── Smart Messages ───────────────────────────────────────────────────────
  static async getSmartMessages(patientId, userId, ctx = {}) {
    const messages = [];

    const dbNotifs = await prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    for (const n of dbNotifs) {
      messages.push({
        id: n.id,
        type: this.classifyNotificationType(n.type, n.priority),
        sender: 'System',
        title: n.title,
        preview: n.message,
        timestamp: n.createdAt,
        unread: !n.isRead,
        action: n.data?.appointmentId
          ? { kind: 'VIEW_APPOINTMENT', appointmentId: n.data.appointmentId }
          : null,
      });
    }

    // Inject computed insight (non-persistent — recomputed per request)
    const insight = await this.computeSmartInsight(patientId);
    if (insight) {
      messages.unshift({
        id: 'insight-' + Date.now(),
        type: 'INSIGHT',
        sender: 'Wellness Insight',
        title: insight.title,
        preview: insight.message,
        timestamp: new Date(),
        unread: true,
        action: null,
      });
    }

    return messages.slice(0, 12);
  }

  static classifyNotificationType(type, priority) {
    const t = String(type || '').toUpperCase();
    if (t.includes('REMINDER') || t.includes('DUE')) return 'REMINDER';
    if (t.includes('ALERT') || priority === 'HIGH') return 'ALERT';
    if (t.includes('REWARD') || t.includes('BADGE') || t.includes('POINT') || t.includes('MILESTONE')) return 'REWARD';
    if (t.includes('CHAT') || t.includes('MESSAGE') || t.includes('DOCTOR')) return 'CLINICAL';
    return 'CLINICAL';
  }

  // ── Smart Insight Engine — multi-region pattern detection ────────────────
  // Delegates to SmartInsightService so the engine is unit-testable and
  // independently usable. Engine surfaces multi-region patterns
  // (persistent_region, new_region) plus the legacy sleep / trend rules.
  static async computeSmartInsight(patientId) {
    return SmartInsightService.computeForPatient(patientId);
  }

  // ── Action: submit 3-step check-in ───────────────────────────────────────
  static async submitCheckIn(patientId, userId, body) {
    const today = startOfToday();
    const existing = await prisma.dailyCheckIn.findFirst({
      where: { patientId, createdAt: { gte: today } },
    });
    if (existing) {
      throw Object.assign(new Error('You have already checked in today.'), { status: 409 });
    }

    const moodMap = { TERRIBLE: 'terrible', LOW: 'low', OKAY: 'okay', GOOD: 'good', GREAT: 'great' };
    const sleepMap = { POOR: 3, FAIR: 5.5, GOOD: 7, GREAT: 8.5 };

    // Normalize the body-map regions sent from Step 2. Empty array is a
    // valid "no pain today" state — the patient can mark zero regions and
    // proceed; we record painRegions: [] and set painLevel to the
    // explicit slider value or 0.
    const painRegions = this.normalizePainRegions(body.painRegions);
    const maxIntensityFromRegions = painRegions.reduce(
      (max, r) => Math.max(max, r.intensity || 0),
      0,
    );
    // painLevel is kept for legacy analytics paths — derive it from the
    // body map's max intensity when regions are present, otherwise fall
    // back to the explicit numeric the client sent.
    const painLevel = painRegions.length > 0
      ? maxIntensityFromRegions
      : (Number(body.painLevel) || 0);

    const checkIn = await prisma.$transaction(async (tx) => {
      const created = await tx.dailyCheckIn.create({
        data: {
          patientId,
          painLevel,
          painRegions: painRegions.length > 0 ? painRegions : [],
          mood: moodMap[String(body.mood || '').toUpperCase()] || 'okay',
          sleepHours: typeof body.sleepHours === 'number'
            ? body.sleepHours
            : (sleepMap[String(body.sleepQuality || '').toUpperCase()] ?? 6),
          notes: body.notes || null,
        },
      });
      await tx.patient.update({
        where: { id: patientId },
        data: { zenPoints: { increment: 20 } },
      });
      return created;
    });

    // Care-gap alert: trigger when ANY single body region was rated
    // intensity >= 8 (or the legacy painLevel scalar in the no-regions
    // path). Includes the offending region names + scores in the message
    // so the doctor sees actionable context immediately.
    const highPainRegions = painRegions.filter((r) => r.intensity >= 8);
    const triggerAlert = highPainRegions.length > 0
      || (painRegions.length === 0 && Number(body.painLevel) >= 8);

    if (triggerAlert) {
      try {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const existingAlert = await prisma.notification.findFirst({
          where: {
            type: 'CARE_GAP_HIGH_PAIN',
            relatedId: patientId,
            createdAt: { gte: oneDayAgo },
          },
          select: { id: true },
        });
        if (!existingAlert) {
          const patientRow = await prisma.patient.findUnique({
            where: { id: patientId },
            select: { fullName: true, branchId: true },
          });
          const doctors = await prisma.user.findMany({
            where: {
              role: { in: ['DOCTOR', 'ADMIN_DOCTOR'] },
              deletedAt: null,
              ...(patientRow?.branchId ? { branchId: patientRow.branchId } : {}),
            },
            select: { id: true },
            take: 10,
          });

          const patientLabel = patientRow?.fullName || 'A patient';
          const message = highPainRegions.length > 0
            ? `${patientLabel} reported ${highPainRegions
                .map((r) => `intensity ${r.intensity} in ${r.regionLabel}`)
                .join(' and ')} in today's check-in.`
            : `${patientLabel} reported pain ${body.painLevel}/10 in today's check-in.`;

          const wsPayload = {
            patientId,
            checkInId: checkIn.id,
            patientName: patientLabel,
            highPainRegions: highPainRegions.map((r) => ({
              regionId: r.regionId,
              regionLabel: r.regionLabel,
              intensity: r.intensity,
            })),
            message,
          };

          for (const d of doctors) {
            await prisma.notification.create({
              data: {
                userId: d.id,
                type: 'CARE_GAP_HIGH_PAIN',
                title: 'High pain reported',
                message,
                priority: 'HIGH',
                relatedId: patientId,
                data: wsPayload,
              },
            });
            try {
              emitToUser(d.id, 'care_gap.high_pain', wsPayload);
            } catch (wsErr) {
              logger.warn('[EnhancedDashboard] care-gap socket emit failed', { err: wsErr.message });
            }
          }
        }
      } catch (err) {
        logger.warn('[EnhancedDashboard] high-pain notify failed', { err: err.message });
      }
    }

    return checkIn;
  }

  // ── Action: mark medication taken (one tap) ─────────────────────────────
  static async markMedicationTaken(patientId, prescriptionId, slot) {
    const rx = await prisma.prescription.findUnique({ where: { id: prescriptionId } });
    if (!rx || rx.patientId !== patientId) {
      throw Object.assign(new Error('Prescription not found'), { status: 404 });
    }
    if (rx.discontinuedAt) {
      throw Object.assign(new Error('Prescription discontinued'), { status: 400 });
    }
    if ((rx.dispensedQty ?? 0) - (rx.consumedQty ?? 0) <= 0) {
      throw Object.assign(new Error('No remaining quantity'), { status: 400 });
    }

    const log = await prisma.$transaction(async (tx) => {
      // Atomic consume guarded by (dispensedQty > consumedQty) to prevent the
      // balance going negative under concurrent taps. We could also CAS on
      // totalQuantity since onConsumption keeps it in sync, but gating on the
      // authoritative counters is clearer.
      // Parameterised tagged template. Defense-in-depth: also pin patientId
      // (already validated as the caller's prescription above) so a by-id write
      // can never touch another patient's row.
      const rows = await tx.$executeRaw`
        UPDATE "Prescription"
           SET "consumedQty" = "consumedQty" + 1,
               "totalQuantity" = "totalQuantity" - 1
         WHERE "id" = ${prescriptionId} AND "patientId" = ${patientId}
           AND "dispensedQty" > "consumedQty" AND "discontinuedAt" IS NULL`;
      if (rows === 0) {
        throw Object.assign(new Error('No remaining quantity'), { status: 400 });
      }
      // Recompute expectedEndDate + clear the missed-dose streak. Kept inline
      // here (rather than calling lifecycle.onConsumption) because we already
      // incremented consumedQty atomically above — calling onConsumption would
      // double-increment.
      const fresh = await tx.prescription.findUnique({
        where: { id: prescriptionId },
        select: { dispensedQty: true, consumedQty: true, dailyDoseCount: true, frequency: true, startDate: true },
      });
      const ddc = fresh.dailyDoseCount ?? parseDailyDoseCount(fresh.frequency);
      const remaining = Math.max(0, fresh.dispensedQty - fresh.consumedQty);
      const expectedEndDate = (ddc && ddc > 0)
        ? new Date(Date.now() + Math.floor(remaining / ddc) * 24 * 60 * 60 * 1000)
        : null;
      await tx.prescription.update({
        where: { id: prescriptionId },
        data: {
          expectedEndDate,
          missedDoseStreak: 0,
          missedDoseNotifiedAt: null,
          ...(fresh.startDate ? {} : { startDate: new Date() }),
          ...(fresh.dailyDoseCount ? {} : (ddc > 0 ? { dailyDoseCount: ddc } : {})),
        },
      });
      const created = await tx.medicationLog.create({
        data: {
          prescriptionId,
          medicationName: rx.medicationName,
          dosage: rx.dosage,
          quantityTaken: 1,
          taken: true,
          takenAt: new Date(),
          date: new Date(),
          notes: slot ? `Slot: ${slot}` : null,
        },
      });
      return created;
    });

    // Award zen points (best-effort)
    try {
      await ZenPointsService.awardPoints(patientId, 'MEDICATION_TAKEN', log.id);
    } catch (err) {
      logger.warn('[EnhancedDashboard] zen award failed', { err: err.message });
    }

    return log;
  }

  // ── Action: quick-log a vital ───────────────────────────────────────────
  static async quickLogVital(userId, body) {
    const { type, value, unit } = body;
    if (!type || value == null) {
      throw Object.assign(new Error('type and value required'), { status: 400 });
    }
    const vital = await prisma.patientVital.create({
      data: {
        patientId: userId,
        type,
        value: Number(value),
        unit: unit || this.defaultUnitFor(type),
        source: 'patient_dashboard',
      },
    });
    return vital;
  }

  static defaultUnitFor(type) {
    const map = {
      BP_SYSTOLIC: 'mmHg', BP_DIASTOLIC: 'mmHg',
      WEIGHT: 'kg', GLUCOSE: 'mg/dL',
      SLEEP_HOURS: 'hours', PAIN_SCORE: '/10', MOOD: '/10',
    };
    return map[type] || '';
  }

  // ── Action: log/update a pain region (creates a lightweight triage entry)
  static async logPainPoint(patientId, body) {
    const { region, severity } = body;
    if (!region || severity == null) {
      throw Object.assign(new Error('region and severity required'), { status: 400 });
    }
    const sev = Math.max(0, Math.min(10, Number(severity)));

    // Read latest triage to merge regions
    const latest = await prisma.triageSession.findFirst({
      where: { patientId },
      orderBy: { createdAt: 'desc' },
    });

    const existing = Array.isArray(latest?.painRegions) ? [...latest.painRegions] : [];
    const idx = existing.findIndex((r) => r && (r.region || r.regionId || r.label) === region);
    if (idx >= 0) existing[idx] = { ...existing[idx], region, severity: sev };
    else existing.push({ region, severity: sev });

    // Append-only: create a new lightweight triage record so audit trail is preserved
    const created = await prisma.triageSession.create({
      data: {
        patientId,
        responses: { source: 'patient_dashboard_painmap' },
        severity: String(sev),
        painRegions: existing,
      },
    });

    return { regions: existing, triageSessionId: created.id };
  }

  // ── Action: complete a phase task ────────────────────────────────────────
  // A task can be completed at most once per calendar day. Tapping the same
  // task twice on the dashboard used to create a second TaskCompletion row
  // (and award zen points twice via the journey path); both endpoints now
  // surface a 409 instead so the UI can keep the row marked DONE without
  // farming points.
  static async completePhaseTask(userId, taskId) {
    const task = await prisma.phaseTask.findUnique({
      where: { id: taskId },
      include: { phase: true },
    });
    if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const alreadyToday = await prisma.taskCompletion.findFirst({
      where: {
        taskId,
        patientId: userId,
        completedAt: { gte: startOfDay },
      },
    });
    if (alreadyToday) {
      throw Object.assign(
        new Error('This task is already completed for today. Try again tomorrow.'),
        { status: 409, code: 'TASK_ALREADY_COMPLETED_TODAY' },
      );
    }

    const completion = await prisma.taskCompletion.create({
      data: { taskId, patientId: userId },
    });
    return completion;
  }
}

function avg(xs) {
  if (!xs || xs.length === 0) return 0;
  return xs.reduce((s, n) => s + n, 0) / xs.length;
}

export default EnhancedDashboardService;
