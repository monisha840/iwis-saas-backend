/**
 * Backfill PatientAssignment rows from legacy assignment sources so existing
 * patients remain visible in doctors' "My Patients" queues after the switch
 * to the new model.
 *
 * Priority (highest wins as PRIMARY, de-duped per patient):
 *   1. Active Journey rows (status IN_PROGRESS)                        → PRIMARY / ACTIVE
 *   2. Non-active journeys                                              → PRIMARY / ENDED (history)
 *   3. Appointment rows with status='ASSIGNED'                          → PRIMARY / ACTIVE (fallback only
 *                                                                         if no journey exists)
 *
 * Idempotent: skips any (patientId, doctorId) pair that already has a row.
 *
 *   cd alshifa-backend && node scripts/backfill-patient-assignments.js
 */
import prisma from '../lib/prisma.js';

async function pickSystemAdminId() {
    const sa = await prisma.user.findFirst({
        where:   { role: { in: ['ADMIN', 'ADMIN_DOCTOR'] }, deletedAt: null },
        select:  { id: true, email: true, role: true },
    });
    return sa?.id || null;
}

async function alreadyAssigned(patientId, doctorId) {
    const existing = await prisma.patientAssignment.findFirst({
        where:  { patientId, doctorId },
        select: { id: true },
    });
    return !!existing;
}

async function main() {
    const systemUserId = await pickSystemAdminId();
    if (!systemUserId) {
        console.error('[backfill] No ADMIN / ADMIN_DOCTOR user found to attribute backfilled rows to.');
        process.exit(1);
    }
    console.log(`[backfill] Attributing backfilled rows to system user ${systemUserId}`);

    let created = 0;
    let skipped = 0;

    // 1. Journeys — the real primary-care assignments.
    const journeys = await prisma.journey.findMany({
        select: {
            id: true, patientId: true, doctorId: true, status: true, createdAt: true,
        },
    });
    console.log(`[backfill] Found ${journeys.length} journey rows with doctor links`);

    for (const j of journeys) {
        if (!j.doctorId) continue;
        if (await alreadyAssigned(j.patientId, j.doctorId)) { skipped++; continue; }

        const isActive = j.status === 'IN_PROGRESS' || j.status === 'ACTIVE';
        await prisma.patientAssignment.create({
            data: {
                patientId:    j.patientId,
                doctorId:     j.doctorId,
                type:         'PRIMARY',
                status:       isActive ? 'ACTIVE' : 'ENDED',
                reason:       'Backfilled from legacy Journey',
                assignedById: systemUserId,
                assignedAt:   j.createdAt,
                endedAt:      isActive ? null : new Date(),
                endReason:    isActive ? null : 'Legacy journey was no longer active at backfill time',
            },
        });
        created++;
    }

    // 2. Appointments with status=ASSIGNED that have no Journey-based row.
    const assignedAppts = await prisma.appointment.findMany({
        where:  { status: 'ASSIGNED' },
        select: { id: true, patientId: true, doctorId: true, date: true },
    });
    console.log(`[backfill] Found ${assignedAppts.length} appointments with status=ASSIGNED`);

    for (const a of assignedAppts) {
        if (!a.doctorId) continue;
        if (await alreadyAssigned(a.patientId, a.doctorId)) { skipped++; continue; }

        await prisma.patientAssignment.create({
            data: {
                patientId:    a.patientId,
                doctorId:     a.doctorId,
                type:         'PRIMARY',
                status:       'ACTIVE',
                reason:       'Backfilled from Appointment(status=ASSIGNED)',
                assignedById: systemUserId,
                assignedAt:   a.date,
            },
        });
        created++;
    }

    console.log(`[backfill] Done. Created: ${created}, Skipped existing: ${skipped}`);
}

main()
    .catch((err) => { console.error('[backfill] Error:', err); process.exit(1); })
    .finally(() => prisma.$disconnect());
