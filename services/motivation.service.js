// Monday Motivation Card service.
//
// Picks one personalized weekly tip based on the patient's prakriti
// (Vata / Pitta / Kapha — falls back to GENERAL if not onboarded) and
// the current Indian season (HEMANTA / SHISHIRA / VASANTA / GRISHMA /
// VARSHA / SHARAD). The day-of-year is used as a deterministic offset
// inside the chosen 30-tip cell so consecutive weeks produce different
// tips even when prakriti+season are stable.
//
// Card lifecycle:
//   1. Cron at 10:00 IST every Monday (handler in scheduledJobs.service.js)
//      calls generateDailyCardsForAllPatients() — creates one row per
//      active patient and ships the WhatsApp Monday Motivation message.
//   2. Patient opens dashboard → GET /api/motivation/today fetches this
//      week's card. If no row exists yet (cron hasn't fired, patient
//      onboarded mid-week), it lazily creates one inline. The lazy-create
//      path does NOT fire WhatsApp — Monday-cron is the only sender, so
//      patients never receive mid-week messages.
//   3. Patient taps "Got it" → POST /api/motivation/:id/read marks isRead
//      and awards +5 Zen Points (rate-limited 1/day).
//   4. Patient toggles save → POST /api/motivation/:id/save flips isSaved.
//   5. "My Tips" tab → GET /api/motivation/saved returns the saved list.

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import {
  AYURVEDIC_TIPS,
  getCurrentSeason,
  getDayOfYear,
  getTipForPatient,
} from '../data/ayurvedicTips.js';
import { ZenPointsService } from './zenPoints.service.js';
import { WhatsAppService } from './whatsapp.service.js';

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function normalizePrakriti(raw) {
  if (!raw) return 'GENERAL';
  const upper = String(raw).toUpperCase();
  if (upper === 'VATA' || upper === 'PITTA' || upper === 'KAPHA') return upper;
  return 'GENERAL';
}

function extractPrakriti(patient) {
  // onboardingData is a free-form JSON column. Doctors / onboarding flow
  // historically wrote prakriti under different keys; check the common ones
  // before giving up to GENERAL.
  const data = patient?.onboardingData;
  if (!data || typeof data !== 'object') return 'GENERAL';
  return normalizePrakriti(
    data.prakriti ??
      data.dosha ??
      data.constitution ??
      data.bodyType ??
      data.body_type,
  );
}

export class MotivationService {
  /**
   * Pick today's tip for a patient — pure function, no DB writes.
   * Returns { tip, prakriti, season }.
   */
  static pickTipForToday(patient, now = new Date()) {
    const prakriti = extractPrakriti(patient);
    const dayOfYear = getDayOfYear(now);
    return getTipForPatient(prakriti, dayOfYear);
  }

  /**
   * Get (or lazily create) this week's motivation card for a patient.
   * Lazy-create does NOT send WhatsApp — Monday-cron is the only sender,
   * so patients can't be spammed mid-week by opening the dashboard.
   */
  static async getTodayCard(patientId) {
    const today = startOfDay();
    const patient = await prisma.patient.findUnique({
      where: { id: patientId },
      select: { id: true, onboardingData: true },
    });
    if (!patient) {
      throw new Error('Patient not found');
    }

    const existing = await prisma.dailyMotivationCard.findUnique({
      where: { patientId_date: { patientId, date: today } },
    });
    if (existing) return existing;

    const { tip, prakriti, season } = this.pickTipForToday(patient);
    // Race-safe upsert. Two simultaneous dashboard loads can both miss the
    // findUnique and both try to create — the @@unique([patientId, date])
    // constraint plus upsert collapses them into one row.
    return prisma.dailyMotivationCard.upsert({
      where: { patientId_date: { patientId, date: today } },
      update: {},
      create: {
        patientId,
        tip,
        prakriti,
        season,
        date: today,
      },
    });
  }

  /**
   * Mark a card as read. Awards +5 Zen Points the first time only
   * (rate-limited via PATIENT_RATE_LIMITS.MOTIVATION_READ).
   * Returns { card, awarded } where awarded is the awardPoints result
   * (or null if rate-limited or already read).
   */
  static async markRead(patientId, cardId) {
    const card = await prisma.dailyMotivationCard.findFirst({
      where: { id: cardId, patientId },
    });
    if (!card) {
      throw new Error('Motivation card not found');
    }

    let awarded = null;
    let updatedCard = card;

    if (!card.isRead) {
      updatedCard = await prisma.dailyMotivationCard.update({
        where: { id: cardId },
        data: { isRead: true, readAt: new Date() },
      });
      try {
        awarded = await ZenPointsService.awardPoints(patientId, 'MOTIVATION_READ', cardId);
      } catch (err) {
        logger.warn('[MondayMotivation] award MOTIVATION_READ failed', { err: err.message, patientId, cardId });
      }
    }

    return { card: updatedCard, awarded };
  }

  /**
   * Toggle the save flag on a card. Saved tips appear in "My Tips" tab.
   */
  static async toggleSave(patientId, cardId) {
    const card = await prisma.dailyMotivationCard.findFirst({
      where: { id: cardId, patientId },
    });
    if (!card) {
      throw new Error('Motivation card not found');
    }
    const isSaved = !card.isSaved;
    return prisma.dailyMotivationCard.update({
      where: { id: cardId },
      data: {
        isSaved,
        savedAt: isSaved ? new Date() : null,
      },
    });
  }

  /**
   * Saved tips for the My Tips tab — newest savedAt first.
   */
  static async getSavedTips(patientId, { limit = 100 } = {}) {
    return prisma.dailyMotivationCard.findMany({
      where: { patientId, isSaved: true },
      orderBy: { savedAt: 'desc' },
      take: limit,
    });
  }

  /**
   * Cron entry point — runs at 10:00 IST every Monday. Generates this
   * week's card for every active patient (onboarding completed) and pushes
   * a Monday Motivation WhatsApp message. No Zen Points awarded here —
   * only on the patient's "Got it" tap.
   *
   * Idempotent via @@unique([patientId, date]): a same-day re-run upserts
   * to the same row. Cards already messaged this week have whatsappSentAt
   * stamped so the WhatsApp dispatch self-skips.
   */
  static async generateDailyCardsForAllPatients() {
    const today = startOfDay();
    const season = getCurrentSeason(today);
    const dayOfYear = getDayOfYear(today);

    const patients = await prisma.patient.findMany({
      where: { onboardingCompleted: true },
      select: {
        id: true,
        fullName: true,
        onboardingData: true,
        user: {
          select: {
            notificationPreference: {
              select: {
                whatsappEnabled: true,
                whatsappNumber: true,
              },
            },
          },
        },
      },
    });

    let processed = 0;
    let whatsappSent = 0;
    let whatsappSkipped = 0;
    let whatsappFailed = 0;

    for (const patient of patients) {
      try {
        const resolvedPrakriti = extractPrakriti(patient);
        // Reuse the same pure helper so every patient's tip across the
        // platform stays in lock-step with the on-demand path.
        const cell = AYURVEDIC_TIPS[resolvedPrakriti]?.[season] ?? AYURVEDIC_TIPS.GENERAL;
        const tip = cell[dayOfYear % cell.length];

        const card = await prisma.dailyMotivationCard.upsert({
          where: { patientId_date: { patientId: patient.id, date: today } },
          update: {},
          create: {
            patientId: patient.id,
            tip,
            prakriti: resolvedPrakriti,
            season,
            date: today,
          },
        });
        processed += 1;

        // Skip WhatsApp if already sent this week (same-day cron re-run).
        if (card.whatsappSentAt) {
          whatsappSkipped += 1;
          continue;
        }

        // Get patient's next upcoming appointment.
        const nextAppointment = await prisma.appointment.findFirst({
          where: {
            patientId: patient.id,
            status: { in: ['CONFIRMED', 'ACCEPTED'] },
            date: { gt: new Date() },
          },
          include: {
            doctor: { select: { fullName: true } },
          },
          orderBy: { date: 'asc' },
        });

        // Format appointment text.
        let appointmentText = '';
        if (nextAppointment) {
          const apptDate = new Date(nextAppointment.date);
          const dayName = apptDate.toLocaleDateString('en-IN', { weekday: 'long' });
          const dateStr = apptDate.toLocaleDateString('en-IN', {
            day: 'numeric', month: 'short',
          });
          const timeStr = apptDate.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit',
          });
          // User has no `name` column; doctor name lives on Doctor.fullName.
          const doctorName = nextAppointment.doctor?.fullName || 'your doctor';
          appointmentText = `\n📅 Next appointment: ${doctorName} — ${dayName}, ${dateStr} at ${timeStr}`;
        }

        // Get patient streak — PatientStreak.patientId is unique.
        let streakText = '';
        try {
          const streakRecord = await prisma.patientStreak.findUnique({
            where: { patientId: patient.id },
          });
          const streakCount = streakRecord?.currentStreak ?? 0;
          if (streakCount > 0) {
            streakText = `\n🔥 Current streak: ${streakCount} days`;
          }
        } catch (e) {
          // Streak lookup failed — skip silently.
        }

        // Send WhatsApp if patient has number and has it enabled.
        const pref = patient.user?.notificationPreference;
        const whatsappNumber = pref?.whatsappNumber;
        const whatsappEnabled = pref?.whatsappEnabled;

        if (whatsappNumber && whatsappEnabled) {
          try {
            const patientFirstName = patient.fullName?.split(' ')[0] || 'there';
            const doshaLabel = resolvedPrakriti !== 'GENERAL'
              ? `your ${resolvedPrakriti.charAt(0) + resolvedPrakriti.slice(1).toLowerCase()} constitution`
              : 'your wellness journey';

            const message = `🌿 *Monday Motivation from Al-Shifa*\n\nGood morning, ${patientFirstName}! A new week begins 🌱\n\n*This week's Ayurvedic focus for ${doshaLabel}:*\n\n"${tip}"\n\n_${season} season_${streakText}${appointmentText}\n\nHave a healthy week 💚\n— Al-Shifa Care Team`;

            // WhatsAppService.sendText is positional (number, text) — see
            // services/whatsapp.service.js. Returns { status: 'SENT' | 'SKIPPED' | 'FAILED' }.
            const result = await WhatsAppService.sendText(whatsappNumber, message);
            if (result?.status && result.status !== 'SENT') {
              whatsappFailed += 1;
              console.error(`[MondayMotivation] WhatsApp non-SENT (${result.status}) for patient ${patient.id}`);
            } else {
              await prisma.dailyMotivationCard.update({
                where: { id: card.id },
                data: { whatsappSentAt: new Date() },
              });
              whatsappSent += 1;
              console.log(`[MondayMotivation] WhatsApp sent to ${patientFirstName}`);
            }
          } catch (err) {
            whatsappFailed += 1;
            console.error(`[MondayMotivation] WhatsApp failed for patient ${patient.id}:`, err.message);
            // Never throw — always continue to next patient.
          }
        } else {
          whatsappSkipped += 1;
          console.log(`[MondayMotivation] Skipped WhatsApp for patient ${patient.id} — no number or disabled`);
        }
      } catch (err) {
        logger.error('[MondayMotivation] generate card failed', {
          err: err.message,
          patientId: patient.id,
        });
      }
    }

    logger.info('[MondayMotivation] weekly generation complete', {
      total: patients.length,
      processed,
      whatsappSent,
      whatsappSkipped,
      whatsappFailed,
      season,
    });

    return { total: patients.length, processed, whatsappSent, whatsappSkipped, whatsappFailed, season };
  }
}

export default MotivationService;
