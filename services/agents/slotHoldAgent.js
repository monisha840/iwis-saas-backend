/**
 * F07 · slotHoldAgent — first wave on triage.critical.submitted.
 *
 * Finds the patient's currently-assigned primary doctor (via PatientAssignment)
 * and tries to reserve the earliest free 30-minute slot within the next 24
 * hours. The created Appointment is marked PENDING_DOCTOR_APPROVAL so the
 * doctor sees it on their dashboard's Pending Approvals queue (DoctorDashboard
 * PendingApprovalCard) and either accepts or declines.
 *
 * No patient notification is sent here — the spec is explicit that the
 * patient should not learn about the hold until the doctor confirms.
 *
 * Scope decisions:
 *   • Window = 24 hours from now. Earliest slot wins. We don't try to be
 *     clever about doctor preference here.
 *   • Slot size = 30 minutes. We just probe 30-min intervals during the
 *     doctor's working window (08:00–18:00 local) and pick the first one
 *     with no overlapping Appointment.
 *   • If no slot exists in 24h, we log a warning and return — NEVER throw.
 *   • consultationType uses the enum value 'DOCTOR' (the schema enum is
 *     DOCTOR | THERAPIST | COMBINED — there is no URGENT_FOLLOW_UP value).
 *     Urgency lives in the status string + notes per the spec.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';

const SLOT_DURATION_MIN = 30;
const WORK_START_HOUR   = 8;   // 08:00
const WORK_END_HOUR     = 18;  // last slot starts at 17:30
const SEARCH_WINDOW_HRS = 24;

/**
 * @param {{ triageSessionId: string, patientId: string, branchId?: string|null }} payload
 */
export async function slotHoldAgent(payload) {
    const { triageSessionId, patientId, branchId } = payload;
    if (!patientId) {
        logger.warn('[agent:slotHold] missing patientId — skipping');
        return { skipped: true, reason: 'no_patient' };
    }

    // 1) Find the assigned doctor.
    let assignment = null;
    try {
        assignment = await prisma.patientAssignment.findFirst({
            where: { patientId, status: 'ACTIVE', type: 'PRIMARY' },
            select: { doctor: { select: { id: true, fullName: true } } },
        });
    } catch (err) {
        logger.warn('[agent:slotHold] assignment lookup failed', { patientId, err: err.message });
    }
    const doctorId = assignment?.doctor?.id ?? null;
    if (!doctorId) {
        logger.warn('[agent:slotHold] no active primary doctor assignment — skipping', { patientId });
        return { slotHeld: false, reason: 'no_assigned_doctor' };
    }

    // 2) Walk 30-min intervals over the next 24h, ignoring slots outside
    //    work hours, and pick the first one with no overlapping appointment.
    const now = new Date();
    const windowEnd = new Date(now.getTime() + SEARCH_WINDOW_HRS * 60 * 60 * 1000);

    let existingAppts = [];
    try {
        existingAppts = await prisma.appointment.findMany({
            where: {
                doctorId,
                date: { gte: now, lt: windowEnd },
                // Don't double-book against active appointments; ignore
                // cancelled / no-show statuses.
                status: { notIn: ['CANCELLED', 'NO_SHOW', 'DECLINED'] },
            },
            select: { date: true },
            orderBy: { date: 'asc' },
        });
    } catch (err) {
        logger.warn('[agent:slotHold] existing appt lookup failed', {
            doctorId, err: err.message,
        });
        return { slotHeld: false, reason: 'appt_lookup_failed' };
    }

    const taken = new Set(existingAppts.map((a) => new Date(a.date).getTime()));

    let chosenSlot = null;
    const cursor = new Date(now);
    // Snap up to the next 30-minute boundary so we never propose a slot that
    // starts a few seconds from now.
    cursor.setMinutes(Math.ceil(cursor.getMinutes() / SLOT_DURATION_MIN) * SLOT_DURATION_MIN, 0, 0);

    while (cursor < windowEnd) {
        const hour = cursor.getHours();
        const insideWindow = hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
        if (insideWindow && !taken.has(cursor.getTime())) {
            chosenSlot = new Date(cursor);
            break;
        }
        cursor.setMinutes(cursor.getMinutes() + SLOT_DURATION_MIN);
    }

    if (!chosenSlot) {
        logger.warn('[agent:slotHold] no free slot in next 24h — skipping', {
            patientId, doctorId, triageSessionId,
        });
        return { slotHeld: false, reason: 'no_slot_available' };
    }

    // 3) Hold the slot. Wrapped — never throw on a write failure either,
    //    log and return instead.
    let appointment = null;
    try {
        appointment = await prisma.appointment.create({
            data: {
                patientId,
                doctorId,
                branchId: branchId ?? null,
                date: chosenSlot,
                // String column, not an enum — PENDING_DOCTOR_APPROVAL is
                // the agreed status for slot-held appointments awaiting
                // doctor confirmation.
                status: 'PENDING_DOCTOR_APPROVAL',
                consultationType: 'DOCTOR',
                consultationMode: 'OFFLINE',
                notes: 'Auto-held from critical triage — awaiting doctor confirmation',
                triageSessionId,
            },
            select: { id: true, date: true, doctorId: true },
        });
    } catch (err) {
        // Most likely cause: TriageSession already has an Appointment (unique
        // constraint on Appointment.triageSessionId). That's fine — we just
        // don't double-hold.
        logger.warn('[agent:slotHold] create appointment failed', {
            patientId, doctorId, triageSessionId, err: err.message,
        });
        return { slotHeld: false, reason: 'create_failed' };
    }

    logger.info('[agent:slotHold] held slot', {
        triageSessionId,
        appointmentId: appointment.id,
        date: appointment.date.toISOString(),
        doctorId,
    });

    return {
        slotHeld: true,
        slotTime: appointment.date,
        appointmentId: appointment.id,
        doctorId,
    };
}
