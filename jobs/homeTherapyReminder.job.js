/**
 * Home Therapy — Daily Brief Job (Task 9).
 *
 * Runs at 07:00 each branch's local time. For each branch:
 *   1. Fetch all HomeTherapySession rows where scheduledDate is today
 *      (UTC day window) AND status = SCHEDULED.
 *   2. Group by therapistId.
 *   3. For each therapist with sessions today, send:
 *      a. In-app notification of type HOME_THERAPY_BRIEF
 *      b. WhatsApp message via the existing Evolution API integration
 *      c. (Push notification is delivered through the same in-app
 *         notification — there is no separate FCM/APNS pipeline today;
 *         createNotification + emitToUser fans out to the connected
 *         devices and the existing service-worker picks it up.)
 *   4. For ADMIN / ADMIN_DOCTOR / BRANCH_ADMIN users in the branch, send
 *      a single summary in-app notification:
 *        "Today: [N] home therapy sessions across [M] therapists."
 *
 * Branch-local 07:00 detection: same approach as the daily-checkin
 * reminder cron — registered as a 5-minute tick, the handler matches the
 * current HH:MM in each branch's timezone (we don't have an explicit
 * Branch.timezone column yet, so we approximate via the hospital's tz
 * stored on Hospital.timezone, falling back to Asia/Kolkata).
 *
 * Idempotency:
 *   - Each branch is tracked in `meta.lastBriefDate` (YYYY-MM-DD in branch tz)
 *     stored in-memory per process — fires once per branch per local day.
 *   - The in-app notification is also de-duplicated by `data.briefDate` so
 *     a process restart mid-window doesn't re-spam everyone.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from '../services/notification.service.js';
import { WhatsAppService } from '../services/whatsapp.service.js';

const DEFAULT_TZ = 'Asia/Kolkata';
const TARGET_HOUR = 7; // 07:00 local time
const TARGET_MINUTE_WINDOW_END = 5; // matches if it's 07:00–07:04

// Per-process dedupe — keyed by `${branchId}:${dateKey}`.
const lastFiredFor = new Map();

function localPartsForTz(date, timeZone) {
  // Returns { hour, minute, dateKey: YYYY-MM-DD } in the given tz. Uses
  // Intl.DateTimeFormat — supported in Node 18+ which this project targets.
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    return {
      hour: parseInt(get('hour'), 10),
      minute: parseInt(get('minute'), 10),
      dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    };
  } catch {
    // Bad tz string — fall back to UTC.
    const utcHour = date.getUTCHours();
    const utcMin  = date.getUTCMinutes();
    const dk = date.toISOString().slice(0, 10);
    return { hour: utcHour, minute: utcMin, dateKey: dk };
  }
}

function utcDayWindowForLocalDate(dateKeyYYYYMMDD, timeZone) {
  // Returns the UTC start/end DateTimes that bracket the given local date in
  // the given timezone. Used to filter HomeTherapySession.scheduledDate.
  // Cheap implementation: assume the local date covers any UTC instant from
  // (dateKey-1)T18:00Z to (dateKey+1)T06:00Z — a fixed ±18h envelope wide
  // enough for every IANA tz offset (UTC-12 to UTC+14). Filter the resulting
  // rows again by re-projecting their scheduledDate into the branch tz.
  const start = new Date(`${dateKeyYYYYMMDD}T00:00:00.000Z`);
  start.setUTCHours(start.getUTCHours() - 18);
  const end = new Date(`${dateKeyYYYYMMDD}T23:59:59.999Z`);
  end.setUTCHours(end.getUTCHours() + 18);
  return { start, end, timeZone };
}

function sessionFallsOnLocalDay(scheduledDate, dateKey, timeZone) {
  const { dateKey: scheduledLocalDateKey } = localPartsForTz(scheduledDate, timeZone);
  return scheduledLocalDateKey === dateKey;
}

function formatTimeForBranch(scheduledDate, scheduledTime) {
  // The form already stores HH:MM in the branch's local time (admins type
  // in branch-tz when scheduling). Re-using that string keeps ambiguity out.
  return scheduledTime || '';
}

/**
 * Build the WhatsApp template per the task spec.
 *   "Good morning [TherapistName]! You have [N] home therapy session(s)
 *    today. Your first patient is [PatientName] at [Time]. Open the IWIS
 *    app for the full route."
 */
function buildWhatsAppText(therapistName, sessions) {
  const first = sessions[0];
  const patientName = first?.patient?.fullName ?? 'your first patient';
  const time = formatTimeForBranch(first?.scheduledDate, first?.scheduledTime);
  return `Good morning ${therapistName}! You have ${sessions.length} home therapy session(s) today. Your first patient is ${patientName} at ${time}. Open the IWIS app for the full route.`;
}

/**
 * Build the long-form in-app body. One line per session.
 */
function buildInAppBody(sessions) {
  return sessions.map((s) => {
    const t  = formatTimeForBranch(s.scheduledDate, s.scheduledTime);
    const pn = s.patient?.fullName ?? 'Patient';
    const addr = s.mode === 'HOME'
      ? [s.patient?.addressLine1, s.patient?.city].filter(Boolean).join(', ')
      : 'Hospital';
    return `${t} · ${pn}${addr ? ` · ${addr}` : ''}`;
  }).join('\n');
}

async function processBranch(branch, now, { force = false } = {}) {
  const tz = branch.tz || DEFAULT_TZ;
  const { hour, minute, dateKey } = localPartsForTz(now, tz);

  // Window: TARGET_HOUR:00 .. TARGET_HOUR:04 inclusive — gives us 5 chances
  // even if the cron tick lands a minute late. `force=true` (used by the
  // manual trigger and admin "Run now" buttons) skips this gate entirely.
  if (!force && (hour !== TARGET_HOUR || minute >= TARGET_MINUTE_WINDOW_END)) {
    return { skipped: true, reason: `outside 07:00 window (${hour}:${String(minute).padStart(2, '0')})` };
  }

  const dedupeKey = `${branch.id}:${dateKey}`;
  if (!force && lastFiredFor.get(dedupeKey)) {
    return { skipped: true, reason: 'already fired today' };
  }

  const { start, end, timeZone } = utcDayWindowForLocalDate(dateKey, tz);
  const candidates = await prisma.homeTherapySession.findMany({
    where: {
      branchId: branch.id,
      scheduledDate: { gte: start, lte: end },
      status: 'SCHEDULED',
    },
    include: {
      therapist: { select: { id: true, fullName: true, userId: true,
        user: { select: { id: true, phoneNumber: true } } } },
      patient: { select: { id: true, fullName: true, addressLine1: true, city: true,
        primaryPhone: true } },
    },
    orderBy: [{ scheduledDate: 'asc' }, { scheduledTime: 'asc' }],
  });

  // Refilter by branch-local day to drop UTC-window false positives at edges.
  const sessions = candidates.filter((s) => sessionFallsOnLocalDay(s.scheduledDate, dateKey, timeZone));
  if (sessions.length === 0) {
    lastFiredFor.set(dedupeKey, true);
    return { skipped: true, reason: 'no sessions scheduled today' };
  }

  // Group by therapistId.
  const byTherapist = new Map();
  for (const s of sessions) {
    const tid = s.therapistId;
    if (!byTherapist.has(tid)) byTherapist.set(tid, []);
    byTherapist.get(tid).push(s);
  }

  let therapistsBriefed = 0;
  for (const [, therSessions] of byTherapist) {
    const therapist = therSessions[0].therapist;
    if (!therapist?.userId) continue;
    const therapistName = therapist.fullName || 'Therapist';

    // 1. In-app notification (also drives the push via the service worker).
    try {
      await notificationService.createNotification({
        userId: therapist.userId,
        type: 'HOME_THERAPY_BRIEF',
        title: "Today's Home Therapy Schedule",
        message: buildInAppBody(therSessions),
        priority: 'HIGH',
        data: {
          briefDate: dateKey,
          sessionCount: therSessions.length,
          firstSessionTime: therSessions[0].scheduledTime,
        },
      });
    } catch (err) {
      logger.warn?.('[homeTherapyReminder] in-app notification failed',
        { therapistId: therapist.id, err: err?.message });
    }

    // 2. WhatsApp via Evolution API. Number lives on User.phoneNumber.
    const number = therapist.user?.phoneNumber;
    if (number) {
      try {
        await WhatsAppService.sendText(number, buildWhatsAppText(therapistName, therSessions));
      } catch (err) {
        logger.warn?.('[homeTherapyReminder] WhatsApp send failed',
          { therapistId: therapist.id, err: err?.message });
      }
    }

    therapistsBriefed += 1;
  }

  // 3. Admin / branch-admin summary.
  try {
    const admins = await prisma.user.findMany({
      where: {
        role: { in: ['ADMIN', 'ADMIN_DOCTOR', 'BRANCH_ADMIN'] },
        deletedAt: null,
        OR: [
          { branchId: branch.id },
          // ADMIN may be hospital-scoped without a branchId pin; include
          // them when their hospitalId matches the branch's hospital.
          { branchId: null, hospitalId: branch.hospitalId, role: 'ADMIN' },
        ],
      },
      select: { id: true },
    });
    const summary = `Today: ${sessions.length} home therapy session${sessions.length === 1 ? '' : 's'} across ${byTherapist.size} therapist${byTherapist.size === 1 ? '' : 's'}.`;
    for (const a of admins) {
      try {
        await notificationService.createNotification({
          userId: a.id,
          type: 'HOME_THERAPY_BRIEF_ADMIN',
          title: 'Home Therapy — Daily Brief',
          message: summary,
          priority: 'INFO',
          data: { briefDate: dateKey, branchId: branch.id, sessionCount: sessions.length, therapistCount: byTherapist.size },
        });
      } catch (err) {
        logger.warn?.('[homeTherapyReminder] admin summary failed',
          { adminId: a.id, err: err?.message });
      }
    }
  } catch (err) {
    logger.warn?.('[homeTherapyReminder] admin lookup failed', { err: err?.message });
  }

  lastFiredFor.set(dedupeKey, true);
  return { fired: true, sessions: sessions.length, therapists: byTherapist.size };
}

/**
 * Cron entry — invoked by scheduledJobs.service.js once per tick. Iterates
 * branches and lets each `processBranch` decide whether to fire based on
 * its local time. Returns aggregate stats for logging.
 */
export async function runHomeTherapyDailyBrief({ now } = {}) {
  const at = now instanceof Date ? now : new Date();
  // We tag each branch with the hospital's timezone (Hospital.timezone column
  // exists on the schema). When unset, falls back to Asia/Kolkata. We don't
  // restrict by Hospital.status here — even SUSPENDED tenants get a heads-up,
  // because the doctor + admin can still see the schedule.
  const branches = await prisma.branch.findMany({
    where: { isActive: true },
    select: {
      id: true, name: true, hospitalId: true,
      hospital: { select: { id: true, timezone: true } },
    },
  });
  const enriched = branches.map((b) => ({ ...b, tz: b.hospital?.timezone || DEFAULT_TZ }));
  const results = [];
  for (const branch of enriched) {
    try {
      const res = await processBranch(branch, at);
      results.push({ branchId: branch.id, ...res });
    } catch (err) {
      logger.warn?.('[homeTherapyReminder] branch processing failed',
        { branchId: branch.id, err: err?.message });
    }
  }
  return results;
}

/**
 * Test / admin trigger — lets us call the same logic immediately for
 * on-demand "Run now" flows (e.g. the admin dashboard could expose this).
 * Currently unused but exposed for parity with reminderSetting.service.js's
 * triggerNow API.
 */
export async function runHomeTherapyDailyBriefForBranch(branchId, { now } = {}) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: {
      id: true, name: true, hospitalId: true,
      hospital: { select: { id: true, timezone: true } },
    },
  });
  if (!branch) {
    const e = new Error('Branch not found'); e.status = 404; throw e;
  }
  // Bypass the time-of-day gate for manual triggers.
  const tz = branch.hospital?.timezone || DEFAULT_TZ;
  const at = now instanceof Date ? now : new Date();
  const dateKey = localPartsForTz(at, tz).dateKey;
  lastFiredFor.delete(`${branchId}:${dateKey}`);
  return processBranch({ ...branch, tz }, at, { force: true });
}

// Manual-test helpers — exported so tests can reset the dedupe map between cases.
export function _resetDedupeForTesting() {
  lastFiredFor.clear();
}

export default {
  runHomeTherapyDailyBrief,
  runHomeTherapyDailyBriefForBranch,
};
