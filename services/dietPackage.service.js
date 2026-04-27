import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';
import { ClinicianXPService } from './clinicianXP.service.js';

// Map of which prakriti types a package's doshaTarget "pacifies" — used to
// show a gentle mismatch warning at assign-time. Not blocking: clinician
// judgement overrides the heuristic.
const DOSHA_MATCH = {
    VATA:     ['VATA', 'VATA_PITTA', 'VATA_KAPHA'],
    PITTA:    ['PITTA', 'VATA_PITTA', 'PITTA_KAPHA'],
    KAPHA:    ['KAPHA', 'PITTA_KAPHA', 'VATA_KAPHA'],
    TRIDOSHA: ['TRIDOSHA', 'VATA', 'PITTA', 'KAPHA', 'VATA_PITTA', 'PITTA_KAPHA', 'VATA_KAPHA'],
};

// DOCTOR, THERAPIST, ADMIN_DOCTOR, and ADMIN can author packages. Because ADMIN
// and ADMIN_DOCTOR are also approvers, their packages auto-approve on create
// (see create/update below).
const CREATOR_ROLES  = new Set(['DOCTOR', 'THERAPIST', 'ADMIN_DOCTOR', 'ADMIN']);
const APPROVER_ROLES = new Set(['ADMIN', 'ADMIN_DOCTOR']);

function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

/**
 * Diet Packages — reusable templates with an approval workflow.
 *
 *  - ADMIN / ADMIN_DOCTOR authors → status APPROVED immediately (approvers).
 *  - DOCTOR / THERAPIST authors    → status PENDING, needs admin approval.
 *  - Only APPROVED + isActive packages can be assigned to patients.
 *  - Assignment snapshots the package into a new DietPrescription so later
 *    edits on the template don't mutate active patient plans.
 */
export const DietPackageService = {
    async list({ hospitalId, status, mineUserId, role }) {
        const where = {};
        if (hospitalId) where.hospitalId = hospitalId;
        if (status)     where.status = status;

        // When the caller is asking for APPROVED packages (the assignment-time
        // dropdown), strip out archived/inactive rows so they never show up in
        // the patient assignment selector. Other status filters (PENDING /
        // REJECTED / ARCHIVED) intentionally don't apply isActive — admins
        // need to see the full review queue.
        if (status === 'APPROVED') {
            where.isActive = true;
        }

        // Creators (DOCTOR / THERAPIST) see: any APPROVED package in the
        // hospital (so they can assign from a colleague's work) + all of
        // their own submissions in any status. Approvers see everything.
        // PENDING packages authored by the caller still show up here so
        // doctors can track their own submissions awaiting review.
        if (CREATOR_ROLES.has(role) && mineUserId) {
            where.OR = [
                { status: 'APPROVED', isActive: true },
                { createdById: mineUserId },
            ];
        }

        return prisma.dietPackage.findMany({
            where,
            include: {
                meals:      { orderBy: { mealTime: 'asc' } },
                createdBy:  { select: { id: true, email: true, doctor: { select: { fullName: true } } } },
                approvedBy: { select: { id: true, email: true, doctor: { select: { fullName: true } } } },
                _count:     { select: { prescriptions: true } },
            },
            orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        });
    },

    async get(id) {
        const pkg = await prisma.dietPackage.findUnique({
            where: { id },
            include: {
                meals:      { orderBy: { mealTime: 'asc' } },
                createdBy:  { select: { id: true, email: true, doctor: { select: { fullName: true } } } },
                approvedBy: { select: { id: true, email: true, doctor: { select: { fullName: true } } } },
            },
        });
        if (!pkg) throw httpError(404, 'Diet package not found');
        return pkg;
    },

    async create({ user, data }) {
        if (!CREATOR_ROLES.has(user.role)) {
            throw httpError(403, 'Only doctors, therapists, and admins can author diet packages');
        }
        const { meals = [], ...rest } = data;
        const isAdminAuthor = APPROVER_ROLES.has(user.role);
        const now = new Date();

        const pkg = await prisma.dietPackage.create({
            data: {
                ...rest,
                hospitalId:   user.hospitalId ?? null,
                createdById:  user.id,
                status:       isAdminAuthor ? 'APPROVED' : 'PENDING',
                approvedById: isAdminAuthor ? user.id : null,
                approvedAt:   isAdminAuthor ? now : null,
                meals: {
                    create: meals.map((m) => ({
                        mealTime:     m.mealTime,
                        foods:        m.foods || [],
                        avoidFoods:   m.avoidFoods || [],
                        instructions: m.instructions || null,
                    })),
                },
            },
            include: { meals: true },
        });

        // Only fan out to approvers when the package actually needs review.
        if (!isAdminAuthor && user.hospitalId) {
            await this.notifyApprovers(pkg, user).catch(() => {});
        }
        return pkg;
    },

    async update({ id, user, data }) {
        const existing = await prisma.dietPackage.findUnique({ where: { id } });
        if (!existing) throw httpError(404, 'Diet package not found');

        // Author-only: the creator can edit their own package.
        //  - DOCTOR / THERAPIST edit  → status resets to PENDING for re-review.
        //  - ADMIN_DOCTOR edit        → stays APPROVED, approval metadata refreshed.
        //  - ARCHIVED packages are frozen.
        const isOwner = existing.createdById === user.id;
        if (!isOwner || !CREATOR_ROLES.has(user.role)) {
            throw httpError(403, 'Only the package author can edit it');
        }
        if (existing.status === 'ARCHIVED') {
            throw httpError(409, 'Archived packages cannot be edited');
        }

        const { meals, ...rest } = data;
        const isAdminAuthor = APPROVER_ROLES.has(user.role);
        const now = new Date();

        return prisma.$transaction(async (tx) => {
            await tx.dietPackage.update({
                where: { id },
                data: isAdminAuthor
                    ? {
                        ...rest,
                        status:          'APPROVED',
                        approvedById:    user.id,
                        approvedAt:      now,
                        rejectionReason: null,
                    }
                    : {
                        ...rest,
                        status:          'PENDING',
                        approvedById:    null,
                        approvedAt:      null,
                        rejectionReason: null,
                    },
            });

            if (Array.isArray(meals)) {
                await tx.dietPackageMeal.deleteMany({ where: { packageId: id } });
                await tx.dietPackageMeal.createMany({
                    data: meals.map((m) => ({
                        packageId:    id,
                        mealTime:     m.mealTime,
                        foods:        m.foods || [],
                        avoidFoods:   m.avoidFoods || [],
                        instructions: m.instructions || null,
                    })),
                });
            }

            const refreshed = await tx.dietPackage.findUnique({ where: { id }, include: { meals: true } });

            // Re-notify approvers only when the edit re-enters the review queue.
            if (!isAdminAuthor && user.hospitalId) {
                this.notifyApprovers(refreshed, user).catch(() => {});
            }
            return refreshed;
        });
    },

    async approve({ id, user, data = {} }) {
        if (!APPROVER_ROLES.has(user.role)) throw httpError(403, 'Only admins can approve packages');
        const existing = await prisma.dietPackage.findUnique({ where: { id } });
        if (!existing) throw httpError(404, 'Diet package not found');
        if (existing.status !== 'PENDING') throw httpError(409, `Cannot approve a ${existing.status.toLowerCase()} package`);

        const xpAmount = Number.isFinite(data.xpAmount) ? data.xpAmount : 0;
        const notes    = typeof data.notes === 'string' && data.notes.trim() ? data.notes.trim() : null;

        const pkg = await prisma.dietPackage.update({
            where: { id },
            data: {
                status:          'APPROVED',
                approvedById:    user.id,
                approvedAt:      new Date(),
                rejectionReason: null,
                xpAwarded:       xpAmount,
                approvalNotes:   notes,
            },
            include: { meals: true, createdBy: { select: { id: true } } },
        });

        if (pkg.createdBy?.id && pkg.createdBy.id !== user.id) {
            const xpFragment   = xpAmount > 0 ? ` +${xpAmount} XP.` : '';
            const noteFragment = notes ? ` Notes: ${notes}` : '';
            await notificationService.createNotification({
                userId:  pkg.createdBy.id,
                type:    'DIET_PACKAGE_APPROVED',
                title:   'Diet package approved',
                message: `Your diet package "${pkg.title}" has been approved and can now be assigned.${xpFragment}${noteFragment}`,
                data:    { packageId: pkg.id, xpAwarded: xpAmount, approvalNotes: notes },
            }).catch(() => {});
        }

        if (xpAmount > 0 && pkg.createdBy?.id && pkg.createdBy.id !== user.id) {
            try {
                await ClinicianXPService.awardXP(
                    pkg.createdBy.id,
                    'DIET_PACKAGE_APPROVED',
                    xpAmount,
                    pkg.id,
                    { packageTitle: pkg.title, approvedBy: user.id, adminNotes: notes },
                );
            } catch (err) {
                logger.warn(`[dietPackage] XP award failed for pkg ${pkg.id}: ${err.message}`);
            }
        }

        return pkg;
    },

    async reject({ id, user, reason }) {
        if (!APPROVER_ROLES.has(user.role)) throw httpError(403, 'Only admins can reject packages');
        const existing = await prisma.dietPackage.findUnique({ where: { id } });
        if (!existing) throw httpError(404, 'Diet package not found');
        if (existing.status !== 'PENDING') throw httpError(409, `Cannot reject a ${existing.status.toLowerCase()} package`);

        const pkg = await prisma.dietPackage.update({
            where: { id },
            data: {
                status:          'REJECTED',
                approvedById:    user.id,
                approvedAt:      new Date(),
                rejectionReason: reason || null,
            },
            include: { createdBy: { select: { id: true } } },
        });

        if (pkg.createdBy?.id && pkg.createdBy.id !== user.id) {
            await notificationService.createNotification({
                userId:  pkg.createdBy.id,
                type:    'DIET_PACKAGE_REJECTED',
                title:   'Diet package rejected',
                message: `Your diet package "${pkg.title}" was rejected${reason ? `: ${reason}` : '.'}`,
                data:    { packageId: pkg.id, reason: reason || null },
            }).catch(() => {});
        }
        return pkg;
    },

    async archive({ id, user }) {
        if (!APPROVER_ROLES.has(user.role)) throw httpError(403, 'Only admins can archive packages');
        return prisma.dietPackage.update({
            where: { id },
            data:  { status: 'ARCHIVED', isActive: false },
        });
    },

    /**
     * Get everything the assign dialog needs to render a safe assignment
     * confirmation: does the package match the patient's constitution, do
     * they already have an active diet on file, etc.
     *
     * Returns shape is friendly for direct rendering (no joins required on
     * the client).
     */
    async getAssignContext({ packageId, patientId }) {
        const [pkg, patient, activePrescriptions, constitution] = await Promise.all([
            prisma.dietPackage.findUnique({
                where:  { id: packageId },
                select: { id: true, title: true, doshaTarget: true, durationDays: true, status: true, isActive: true },
            }),
            prisma.patient.findUnique({
                where:  { id: patientId },
                select: { id: true, fullName: true },
            }),
            prisma.dietPrescription.findMany({
                where: {
                    patientId,
                    isActive: true,
                    OR: [
                        { endDate: null },
                        { endDate: { gte: new Date() } },
                    ],
                },
                select: {
                    id: true, title: true, doshaTarget: true, category: true,
                    startDate: true, endDate: true, packageId: true,
                },
                orderBy: { startDate: 'desc' },
            }),
            prisma.constitutionProfile.findUnique({
                where:  { patientId },
                select: { prakriti: true, agniType: true, completedAt: true },
            }),
        ]);

        if (!pkg)     throw httpError(404, 'Diet package not found');
        if (!patient) throw httpError(404, 'Patient not found');

        // Mismatch heuristic: patient's prakriti is known and the package's
        // dosha target isn't in the "safe for" set. Never blocks — just a flag.
        let doshaMatch = { known: false, compatible: true, reason: null };
        if (constitution?.prakriti) {
            const safe = DOSHA_MATCH[pkg.doshaTarget] || [];
            const compatible = safe.includes(constitution.prakriti);
            doshaMatch = {
                known:      true,
                compatible,
                reason:     compatible ? null : `Package targets ${pkg.doshaTarget} but patient's prakriti is ${constitution.prakriti}`,
                prakriti:   constitution.prakriti,
                agniType:   constitution.agniType,
            };
        }

        return {
            package:             { id: pkg.id, title: pkg.title, doshaTarget: pkg.doshaTarget, durationDays: pkg.durationDays },
            patient:             { id: patient.id, fullName: patient.fullName },
            activePrescriptions,
            constitution:        constitution || null,
            doshaMatch,
            hasConflict:         activePrescriptions.length > 0,
        };
    },

    /**
     * Snapshot an APPROVED package into a new DietPrescription for a patient.
     * The doctor can override duration (days) and startDate.
     *   endDate = startDate + (durationDays override ?? package.durationDays).
     *
     * Conflict handling: by default, rejects if the patient has any other
     * active prescription whose window overlaps the new one. Passing
     * `deactivateExisting: true` auto-deactivates those rows inside the
     * transaction before creating the new prescription.
     */
    async assignToPatient({ id, user, data }) {
        const pkg = await prisma.dietPackage.findUnique({
            where: { id },
            include: { meals: true },
        });
        if (!pkg) throw httpError(404, 'Diet package not found');
        if (pkg.status !== 'APPROVED' || !pkg.isActive) {
            throw httpError(409, 'Only approved active packages can be assigned');
        }

        const duration = Math.max(1, Number(data.durationDays ?? pkg.durationDays));
        const startDate = data.startDate ? new Date(data.startDate) : new Date();
        const endDate = new Date(startDate);
        endDate.setDate(endDate.getDate() + duration);

        // Conflict check — active diet whose window overlaps the new one.
        // Overlap rule: existing.start <= new.end AND (existing.end is null OR existing.end >= new.start)
        const overlapping = await prisma.dietPrescription.findMany({
            where: {
                patientId: data.patientId,
                isActive:  true,
                AND: [
                    { startDate: { lte: endDate } },
                    { OR: [{ endDate: null }, { endDate: { gte: startDate } }] },
                ],
            },
            select: { id: true, title: true, startDate: true, endDate: true },
        });

        if (overlapping.length > 0 && !data.deactivateExisting) {
            const err = httpError(409, 'Patient already has an active diet plan that overlaps this date range');
            err.code = 'ACTIVE_DIET_CONFLICT';
            err.conflicts = overlapping;
            throw err;
        }

        // Resolve Doctor.id (DietPrescription requires Doctor.id, not User.id).
        let doctorId = data.doctorId;
        if (!doctorId) {
            const doctor = await prisma.doctor.findUnique({
                where:  { userId: user.id },
                select: { id: true },
            });
            if (!doctor) throw httpError(400, 'Assigning user has no linked Doctor profile');
            doctorId = doctor.id;
        }

        const rx = await prisma.$transaction(async (tx) => {
            if (data.deactivateExisting && overlapping.length > 0) {
                await tx.dietPrescription.updateMany({
                    where: { id: { in: overlapping.map((c) => c.id) } },
                    data:  { isActive: false },
                });
            }
            return tx.dietPrescription.create({
                data: {
                    patientId:   data.patientId,
                    doctorId,
                    packageId:   pkg.id,
                    title:       data.title || pkg.title,
                    doshaTarget: pkg.doshaTarget,
                    category:    pkg.category,
                    startDate,
                    endDate,
                    notes:       data.notes ?? pkg.notes ?? null,
                    journeyId:   data.journeyId ?? null,
                    meals: {
                        create: pkg.meals.map((m) => ({
                            mealTime:     m.mealTime,
                            foods:        m.foods,
                            avoidFoods:   m.avoidFoods,
                            instructions: m.instructions,
                        })),
                    },
                },
                include: { meals: true },
            });
        });

        // Notify the patient — they need to know a new diet is active.
        try {
            const patient = await prisma.patient.findUnique({
                where:  { id: data.patientId },
                select: { userId: true },
            });
            if (patient?.userId) {
                await notificationService.createNotification({
                    userId:  patient.userId,
                    type:    'DIET_PLAN_ASSIGNED',
                    title:   'New diet plan assigned',
                    message: `Your doctor has assigned a ${duration}-day diet plan: "${rx.title}". Review it on the My Diet page.`,
                    data:    { prescriptionId: rx.id, packageId: pkg.id, startDate, endDate },
                });
            }
        } catch { /* non-fatal */ }

        return rx;
    },

    async notifyApprovers(pkg, creator) {
        const approvers = await prisma.user.findMany({
            where: {
                hospitalId: pkg.hospitalId,
                role:       { in: ['ADMIN', 'ADMIN_DOCTOR'] },
                deletedAt:  null,
            },
            select: { id: true },
        });
        const creatorName = creator.email || 'A doctor';
        await Promise.all(approvers.map((u) =>
            notificationService.createNotification({
                userId:  u.id,
                type:    'DIET_PACKAGE_PENDING',
                title:   'Diet package awaiting approval',
                message: `${creatorName} submitted "${pkg.title}" for review.`,
                data:    { packageId: pkg.id },
            }).catch(() => {})
        ));
    },
};
