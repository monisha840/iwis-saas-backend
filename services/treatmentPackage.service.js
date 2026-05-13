import prisma from '../lib/prisma.js';

/**
 * Treatment Package management (IWIS competitor feature 5)
 * A package is a bundle of services sold at a flat price; enrolment generates
 * a single invoice line and tracks session consumption separately.
 */
export class TreatmentPackageService {
    /**
     * List packages, scoped by either a single branch or the user's
     * hospital (admin "All Branches" view). The branch relation is
     * included so the cross-branch UI can label packages with their
     * owning branch.
     */
    static async list({ branchId, hospitalId } = {}) {
        if (!branchId && !hospitalId) {
            throw Object.assign(
                new Error('list requires branchId or hospitalId'),
                { status: 400 },
            );
        }
        const where = { isActive: true };
        if (branchId) where.branchId = branchId;
        else where.branch = { hospitalId };
        return prisma.treatmentPackage.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            include: {
                _count: { select: { enrolments: true } },
                branch: { select: { id: true, name: true } },
            },
        });
    }

    static async create(data) {
        return prisma.treatmentPackage.create({ data });
    }

    static async update(id, data) {
        return prisma.treatmentPackage.update({ where: { id }, data });
    }

    static async deactivate(id) {
        return prisma.treatmentPackage.update({ where: { id }, data: { isActive: false } });
    }

    /**
     * Smart-delete a package:
     *   - If active enrolments exist → throw 409 (caller surfaces the
     *     "patients are currently enrolled" message).
     *   - If only past/completed enrolments exist → soft-delete (isActive=false)
     *     so the package keeps showing in those enrolments' history.
     *   - If zero enrolments ever existed → hard-delete the row.
     *
     * Active = endDate is null OR endDate >= today (i.e. not finished yet).
     */
    static async deleteOrFail(id) {
        const now = new Date();
        const activeCount = await prisma.packageEnrolment.count({
            where: {
                packageId: id,
                OR: [{ endDate: null }, { endDate: { gte: now } }],
            },
        });
        if (activeCount > 0) {
            throw Object.assign(
                new Error('Cannot delete: patients are currently enrolled in this package'),
                { status: 409, code: 'ACTIVE_ENROLMENTS' },
            );
        }
        const totalCount = await prisma.packageEnrolment.count({ where: { packageId: id } });
        if (totalCount > 0) {
            await prisma.treatmentPackage.update({ where: { id }, data: { isActive: false } });
            return { mode: 'soft', pastEnrolments: totalCount };
        }
        await prisma.treatmentPackage.delete({ where: { id } });
        return { mode: 'hard' };
    }

    // Billing is disabled application-wide; enrolment no longer creates an
    // invoice. `invoiceId` on PackageEnrolment is left null.
    static async enrolPatient({ packageId, patientId, startDate, sessionsTotal, notes }) {
        return prisma.$transaction(async (tx) => {
            const pkg = await tx.treatmentPackage.findUnique({ where: { id: packageId } });
            if (!pkg) throw Object.assign(new Error('Package not found'), { status: 404 });
            if (!pkg.isActive) throw Object.assign(new Error('Package is not active'), { status: 400 });

            const start = startDate ? new Date(startDate) : new Date();
            const end = new Date(start); end.setDate(end.getDate() + pkg.durationDays);

            return tx.packageEnrolment.create({
                data: {
                    packageId, patientId,
                    startDate: start, endDate: end,
                    sessionsTotal: sessionsTotal ?? 0,
                    notes,
                },
                include: { package: true }
            });
        });
    }

    static async listEnrolmentsForPatient(patientId) {
        return prisma.packageEnrolment.findMany({
            where: { patientId },
            include: { package: true, invoice: true, _count: { select: { sessionLogs: true } } },
            orderBy: { createdAt: 'desc' },
        });
    }

    static async logSession({ enrolmentId, sessionType, conductedAt, conductedById, appointmentId, notes }) {
        return prisma.$transaction(async (tx) => {
            const enrolment = await tx.packageEnrolment.findUnique({
                where: { id: enrolmentId },
                include: { package: { select: { isActive: true, name: true } } },
            });
            if (!enrolment) throw Object.assign(new Error('Enrolment not found'), { status: 404 });
            if (enrolment.status !== 'ACTIVE') throw Object.assign(new Error('Enrolment is not active'), { status: 400 });
            // Block sessions on deactivated packages so admins can stop work
            // on a package without cancelling every in-flight enrolment.
            if (!enrolment.package?.isActive) {
                throw Object.assign(
                    new Error(`Package "${enrolment.package?.name || ''}" has been deactivated — new sessions cannot be logged`),
                    { status: 400 },
                );
            }
            // Atomic increment: only succeeds if sessionsUsed < sessionsTotal.
            // Prevents a race where two concurrent logSession calls both read
            // the same sessionsUsed value and each increment to the same total.
            const incResult = await tx.packageEnrolment.updateMany({
                where: { id: enrolmentId, sessionsUsed: { lt: enrolment.sessionsTotal } },
                data: { sessionsUsed: { increment: 1 } },
            });
            if (incResult.count === 0) {
                throw Object.assign(new Error('All sessions in this package have been used'), { status: 400 });
            }

            const log = await tx.packageSessionLog.create({
                data: {
                    enrolmentId, sessionType,
                    conductedAt: conductedAt ? new Date(conductedAt) : new Date(),
                    conductedById, appointmentId, notes,
                }
            });

            const after = await tx.packageEnrolment.findUnique({
                where: { id: enrolmentId },
                select: { sessionsUsed: true, sessionsTotal: true },
            });
            const newStatus = after.sessionsUsed >= after.sessionsTotal ? 'COMPLETED' : 'ACTIVE';
            if (newStatus === 'COMPLETED') {
                await tx.packageEnrolment.update({
                    where: { id: enrolmentId },
                    data: { status: 'COMPLETED' },
                });
            }

            return { log, sessionsUsed: after.sessionsUsed, status: newStatus };
        });
    }

    /**
     * Therapist-side delivery view.
     *
     * The schema doesn't carry an `assignedTherapistId` on the enrolment —
     * therapists are only tied to a package via PackageSessionLog after a
     * session has been delivered. So "my package sessions" is composed of:
     *
     *   (a) every enrolment in the caller's branch that's still in flight
     *       (status ACTIVE and sessionsRemaining > 0) — the therapist's
     *       available work queue;
     *   (b) every other enrolment where this therapist has logged at least
     *       one PackageSessionLog — their own delivery history.
     *
     * Both sets are merged + de-duped on enrolment id. The caller gets
     * patient + package + per-enrolment progress + this therapist's
     * own session logs.
     */
    static async listForTherapist({ therapistId, branchId }) {
        // (b) enrolments this therapist has actually worked on
        const myLogs = await prisma.packageSessionLog.findMany({
            where: { conductedById: therapistId },
            select: { enrolmentId: true },
            distinct: ['enrolmentId'],
        });
        const workedEnrolmentIds = myLogs.map((r) => r.enrolmentId);

        // (a) in-flight enrolments in the same branch (workload queue) +
        //     (b) any enrolment the therapist has already touched.
        const where = {
            OR: [
                ...(branchId ? [{
                    status: 'ACTIVE',
                    patient: { branchId },
                }] : []),
                ...(workedEnrolmentIds.length > 0 ? [{ id: { in: workedEnrolmentIds } }] : []),
            ],
        };
        // If neither clause applies (therapist has no branch + no logs),
        // return empty rather than scan the whole table.
        if (where.OR.length === 0) return [];

        const enrolments = await prisma.packageEnrolment.findMany({
            where,
            include: {
                package: { select: { id: true, name: true } },
                patient: {
                    select: {
                        id: true, fullName: true, patientId: true,
                        user: { select: { id: true } },
                    },
                },
                sessionLogs: {
                    where: { conductedById: therapistId },
                    orderBy: { conductedAt: 'desc' },
                    select: {
                        id: true, sessionType: true, conductedAt: true,
                        notes: true, appointmentId: true,
                    },
                },
            },
            orderBy: { startDate: 'desc' },
        });

        return enrolments.map((e) => ({
            enrolmentId: e.id,
            status: e.status,
            startDate: e.startDate,
            endDate: e.endDate,
            sessionsTotal: e.sessionsTotal,
            sessionsUsed: e.sessionsUsed,
            sessionsRemaining: Math.max(0, e.sessionsTotal - e.sessionsUsed),
            progressPct: e.sessionsTotal > 0
                ? Math.round((e.sessionsUsed / e.sessionsTotal) * 100)
                : 0,
            packageName: e.package?.name ?? null,
            packageId: e.package?.id ?? null,
            patient: e.patient
                ? {
                    id: e.patient.id,
                    fullName: e.patient.fullName,
                    patientId: e.patient.patientId,
                }
                : null,
            // Sessions this therapist has personally logged on this enrolment.
            mySessions: e.sessionLogs,
        }));
    }

    static async getProgress(enrolmentId) {
        const enrolment = await prisma.packageEnrolment.findUnique({
            where: { id: enrolmentId },
            include: {
                package: true,
                sessionLogs: { orderBy: { conductedAt: 'desc' } },
                invoice: true,
            }
        });
        if (!enrolment) return null;
        const daysRemaining = Math.max(0, Math.ceil((enrolment.endDate - new Date()) / (1000 * 60 * 60 * 24)));
        const sessionsRemaining = Math.max(0, enrolment.sessionsTotal - enrolment.sessionsUsed);
        const progressPct = enrolment.sessionsTotal ? Math.round((enrolment.sessionsUsed / enrolment.sessionsTotal) * 100) : 0;
        return { enrolment, daysRemaining, sessionsRemaining, progressPct };
    }
}
