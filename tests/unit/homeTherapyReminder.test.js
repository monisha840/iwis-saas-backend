import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runHomeTherapyDailyBrief,
  runHomeTherapyDailyBriefForBranch,
  _resetDedupeForTesting,
} from '../../jobs/homeTherapyReminder.job.js';
import prisma from '../../lib/prisma.js';
import { notificationService } from '../../services/notification.service.js';
import { WhatsAppService } from '../../services/whatsapp.service.js';

const ASIA_KOLKATA = 'Asia/Kolkata';

// Build a Date that, projected into the branch's tz, lands at the given
// HH:MM local time. We compute the offset by intersecting Intl.DateTimeFormat
// output with a known UTC reference. For Kolkata (UTC+5:30) this is a fixed
// offset, so 07:00 IST = 01:30 UTC.
function dateAtLocalTime(hour, minute, dateKeyYYYYMMDD = '2026-05-01') {
  // 01:30 UTC == 07:00 IST. Use this as the canonical reference; consumer
  // tests pass `dateKey` so we can stamp the right local-day expectation.
  const utcHour = hour - 5;     // IST is UTC+5:30
  const utcMin  = minute - 30;
  let h = utcHour, m = utcMin;
  if (m < 0) { m += 60; h -= 1; }
  return new Date(`${dateKeyYYYYMMDD}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);
}

beforeEach(() => {
  _resetDedupeForTesting();
  vi.restoreAllMocks();
});

describe('homeTherapyReminder job — runHomeTherapyDailyBrief', () => {
  it('skips silently when no branches exist', async () => {
    vi.spyOn(prisma.branch, 'findMany').mockResolvedValue([]);
    const out = await runHomeTherapyDailyBrief({ now: dateAtLocalTime(7, 0) });
    expect(out).toEqual([]);
  });

  it('skips when current branch-local time is outside 07:00–07:04', async () => {
    vi.spyOn(prisma.branch, 'findMany').mockResolvedValue([
      { id: 'br1', name: 'Branch 1', hospitalId: 'h1', hospital: { id: 'h1', timezone: ASIA_KOLKATA } },
    ]);
    const sessFind = vi.spyOn(prisma.homeTherapySession, 'findMany');
    const out = await runHomeTherapyDailyBrief({ now: dateAtLocalTime(8, 30) });
    expect(out[0].skipped).toBe(true);
    expect(out[0].reason).toMatch(/outside 07:00/);
    expect(sessFind).not.toHaveBeenCalled();
  });

  it('fires once per branch per local day and dedupes a second tick within the same window', async () => {
    vi.spyOn(prisma.branch, 'findMany').mockResolvedValue([
      { id: 'br1', name: 'Branch 1', hospitalId: 'h1', hospital: { id: 'h1', timezone: ASIA_KOLKATA } },
    ]);
    // Session at 09:00 IST today.
    const session = {
      id: 'sess1', branchId: 'br1', therapistId: 't1', mode: 'HOME', status: 'SCHEDULED',
      scheduledDate: dateAtLocalTime(9, 0),
      scheduledTime: '09:00',
      therapist: { id: 't1', fullName: 'Dr. Therapist', userId: 'u_t', user: { id: 'u_t', phoneNumber: '9876543210' } },
      patient:   { id: 'p1', fullName: 'Patient One', addressLine1: '12 Anna Nagar', city: 'Chennai', primaryPhone: '8765432109' },
    };
    vi.spyOn(prisma.homeTherapySession, 'findMany').mockResolvedValue([session]);
    vi.spyOn(prisma.user, 'findMany').mockResolvedValue([{ id: 'admin1' }, { id: 'admin2' }]);
    const createNotification = vi.spyOn(notificationService, 'createNotification').mockResolvedValue({ id: 'n', createdAt: new Date() });
    const sendText = vi.spyOn(WhatsAppService, 'sendText').mockResolvedValue({ status: 'SENT' });

    const out1 = await runHomeTherapyDailyBrief({ now: dateAtLocalTime(7, 1) });
    expect(out1[0].fired).toBe(true);
    expect(out1[0].sessions).toBe(1);
    expect(out1[0].therapists).toBe(1);
    // 1 therapist briefing + 2 admin summaries = 3 in-app notifications.
    expect(createNotification).toHaveBeenCalledTimes(3);
    // 1 WhatsApp send to the therapist.
    expect(sendText).toHaveBeenCalledTimes(1);
    const waText = sendText.mock.calls[0][1];
    expect(waText).toMatch(/Good morning Dr. Therapist!/);
    expect(waText).toMatch(/Patient One/);
    expect(waText).toMatch(/at 09:00/);

    // A second tick four minutes later, still inside the 07:00–07:04
    // window, must NOT re-fire.
    const out2 = await runHomeTherapyDailyBrief({ now: dateAtLocalTime(7, 4) });
    expect(out2[0].skipped).toBe(true);
    expect(out2[0].reason).toMatch(/already fired/);
    expect(createNotification).toHaveBeenCalledTimes(3); // still 3 — no new sends
  });

  it('marks the branch fired even when there are no sessions, so we do not retry every 5 min', async () => {
    vi.spyOn(prisma.branch, 'findMany').mockResolvedValue([
      { id: 'br1', name: 'Branch 1', hospitalId: 'h1', hospital: { id: 'h1', timezone: ASIA_KOLKATA } },
    ]);
    vi.spyOn(prisma.homeTherapySession, 'findMany').mockResolvedValue([]);
    const createNotification = vi.spyOn(notificationService, 'createNotification').mockResolvedValue({ id: 'n', createdAt: new Date() });
    const sendText = vi.spyOn(WhatsAppService, 'sendText');

    const out = await runHomeTherapyDailyBrief({ now: dateAtLocalTime(7, 2) });
    expect(out[0].skipped).toBe(true);
    expect(out[0].reason).toMatch(/no sessions/);
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it('runHomeTherapyDailyBriefForBranch bypasses the time-of-day gate', async () => {
    vi.spyOn(prisma.branch, 'findUnique').mockResolvedValue({
      id: 'br1', name: 'Branch 1', hospitalId: 'h1',
      hospital: { id: 'h1', timezone: ASIA_KOLKATA },
    });
    const session = {
      id: 'sess1', branchId: 'br1', therapistId: 't1', mode: 'HOME', status: 'SCHEDULED',
      scheduledDate: dateAtLocalTime(11, 0),
      scheduledTime: '11:00',
      therapist: { id: 't1', fullName: 'Dr. T', userId: 'u_t', user: { id: 'u_t', phoneNumber: '9876543210' } },
      patient:   { id: 'p1', fullName: 'Patient One', addressLine1: '12', city: 'Chennai', primaryPhone: '8' },
    };
    vi.spyOn(prisma.homeTherapySession, 'findMany').mockResolvedValue([session]);
    vi.spyOn(prisma.user, 'findMany').mockResolvedValue([]);
    const createNotification = vi.spyOn(notificationService, 'createNotification').mockResolvedValue({ id: 'n', createdAt: new Date() });
    vi.spyOn(WhatsAppService, 'sendText').mockResolvedValue({ status: 'SENT' });

    // Trigger at 14:00 local — outside the 07:00 window — but the manual
    // helper should still fire the brief. Pass an explicit `now` so the
    // local-day matching against the session's scheduledDate is stable.
    const res = await runHomeTherapyDailyBriefForBranch('br1', { now: dateAtLocalTime(14, 0) });
    expect(res.fired).toBe(true);
    expect(createNotification).toHaveBeenCalled();
  });
});
