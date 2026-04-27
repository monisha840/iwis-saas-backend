/**
 * Tests for the 2026-04-25b IWIS bug-bash session.
 *
 * Covers:
 *   1. UserService.listDoctors — availability flag computation (BlockedSlot,
 *      today's appointments, soft cap), and ADMIN_DOCTOR rows must surface.
 *   2. UserService.assignPatient — ADMIN_DOCTOR self-assign succeeds; bad
 *      target roles rejected; soft-deleted target rejected; TEMPORARY does
 *      NOT replace existing PRIMARY.
 *   3. DietPackageService.list — APPROVED queries auto-add isActive:true.
 *   4. AuditService.getRecentActivity — denormalised actor name resolution,
 *      hospital scoping, system rows preserved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma.js', () => ({
    default: {
        doctor: {
            findMany:   vi.fn(),
            findUnique: vi.fn(),
        },
        patient: {
            findUnique: vi.fn(),
        },
        blockedSlot: {
            findMany: vi.fn(),
        },
        appointment: {
            groupBy: vi.fn(),
        },
        patientAssignment: {
            findFirst:  vi.fn(),
            findMany:   vi.fn(),
            updateMany: vi.fn(),
            create:     vi.fn(),
        },
        dietPackage: {
            findMany: vi.fn(),
        },
        auditLog: {
            findMany: vi.fn(),
        },
        $transaction: vi.fn(async (cb) => {
            // Two flavours: array form and callback form. We support both.
            if (typeof cb === 'function') {
                return cb({
                    patientAssignment: {
                        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
                        create: vi.fn().mockImplementation((args) => Promise.resolve({
                            id: 'created-assignment',
                            ...args.data,
                            doctor: { id: args.data.doctorId, fullName: 'Stub Dr', specialization: null },
                            patient: { id: args.data.patientId, fullName: 'Stub Pt' },
                        })),
                    },
                });
            }
            return Promise.all(cb);
        }),
    },
}));

vi.mock('../../lib/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../../services/notification.service.js', () => ({
    notificationService: {
        createNotification: vi.fn().mockResolvedValue({}),
    },
}));

vi.mock('../../services/clinicianXP.service.js', () => ({
    ClinicianXPService: {
        awardXP: vi.fn().mockResolvedValue({}),
    },
}));

const prisma = (await import('../../lib/prisma.js')).default;
const { UserService } = await import('../../services/user.service.js');
const { DietPackageService } = await import('../../services/dietPackage.service.js');
const { AuditService } = await import('../../services/audit.service.js');

beforeEach(() => {
    vi.clearAllMocks();
});

// ─── 1. listDoctors availability ─────────────────────────────────────────

describe('UserService.listDoctors — availability', () => {
    it('flags doctor as UNAVAILABLE when an active BlockedSlot exists for today', async () => {
        prisma.doctor.findMany.mockResolvedValue([
            {
                id: 'doc-1', userId: 'u-1', fullName: 'Dr. Saleem',
                specialization: 'Ayurveda', profilePhoto: null,
                yearsExperience: 10, qualification: 'BAMS', clinic: null,
                user: { email: 'saleem@x.com', role: 'DOCTOR', branchId: 'b-1', branch: { name: 'Main' } },
                _count: { appointments: 50 },
            },
        ]);
        const today = new Date(); today.setHours(0, 0, 0, 0);
        prisma.blockedSlot.findMany.mockResolvedValue([
            { doctorId: 'doc-1', kind: 'LEAVE', reason: 'Annual leave', date: today, dayOfWeek: null },
        ]);
        prisma.appointment.groupBy.mockResolvedValue([]);

        const result = await UserService.listDoctors({ branchId: 'b-1' });

        expect(result).toHaveLength(1);
        expect(result[0].availability).toBe('UNAVAILABLE');
        expect(result[0].unavailableReason).toContain('Annual leave');
        expect(result[0].userId).toBe('u-1');
        expect(result[0].role).toBe('DOCTOR');
    });

    it('flags doctor as AT_CAPACITY when today appointment count >= 12', async () => {
        prisma.doctor.findMany.mockResolvedValue([
            {
                id: 'doc-2', userId: 'u-2', fullName: 'Dr. Busy',
                specialization: null, profilePhoto: null, yearsExperience: 5, qualification: null, clinic: null,
                user: { email: 'busy@x.com', role: 'DOCTOR', branchId: 'b-1', branch: { name: 'Main' } },
                _count: { appointments: 1000 },
            },
        ]);
        prisma.blockedSlot.findMany.mockResolvedValue([]);
        prisma.appointment.groupBy.mockResolvedValue([
            { doctorId: 'doc-2', _count: { _all: 14 } },
        ]);

        const result = await UserService.listDoctors({ branchId: 'b-1' });

        expect(result[0].availability).toBe('AT_CAPACITY');
        expect(result[0].appointmentsToday).toBe(14);
        expect(result[0].unavailableReason).toMatch(/14/);
    });

    it('flags doctor as AVAILABLE when no blocks and below soft cap', async () => {
        prisma.doctor.findMany.mockResolvedValue([
            {
                id: 'doc-3', userId: 'u-3', fullName: 'Dr. Free',
                specialization: 'GP', profilePhoto: null, yearsExperience: 3, qualification: null, clinic: null,
                user: { email: 'free@x.com', role: 'DOCTOR', branchId: 'b-1', branch: { name: 'Main' } },
                _count: { appointments: 200 },
            },
        ]);
        prisma.blockedSlot.findMany.mockResolvedValue([]);
        prisma.appointment.groupBy.mockResolvedValue([{ doctorId: 'doc-3', _count: { _all: 4 } }]);

        const result = await UserService.listDoctors({ branchId: 'b-1' });

        expect(result[0].availability).toBe('AVAILABLE');
        expect(result[0].unavailableReason).toBeNull();
        expect(result[0].appointmentsToday).toBe(4);
    });

    it('includes ADMIN_DOCTOR doctor records in the result (no role filter)', async () => {
        prisma.doctor.findMany.mockResolvedValue([
            {
                id: 'admin-doc-1', userId: 'admin-u-1', fullName: 'Dr. Admin',
                specialization: null, profilePhoto: null, yearsExperience: 12, qualification: null, clinic: null,
                user: { email: 'admin@x.com', role: 'ADMIN_DOCTOR', branchId: 'b-1', branch: { name: 'Main' } },
                _count: { appointments: 30 },
            },
        ]);
        prisma.blockedSlot.findMany.mockResolvedValue([]);
        prisma.appointment.groupBy.mockResolvedValue([]);

        const result = await UserService.listDoctors({ branchId: 'b-1' });

        expect(result).toHaveLength(1);
        expect(result[0].role).toBe('ADMIN_DOCTOR');
        expect(result[0].id).toBe('admin-doc-1');
    });

    it('falls back to AVAILABLE when blockedSlot/appointment queries fail (catch path)', async () => {
        prisma.doctor.findMany.mockResolvedValue([
            {
                id: 'doc-x', userId: 'u-x', fullName: 'Dr. X',
                specialization: null, profilePhoto: null, yearsExperience: 1, qualification: null, clinic: null,
                user: { email: 'x@x.com', role: 'DOCTOR', branchId: 'b-1', branch: { name: 'Main' } },
                _count: { appointments: 0 },
            },
        ]);
        prisma.blockedSlot.findMany.mockRejectedValue(new Error('db down'));
        prisma.appointment.groupBy.mockRejectedValue(new Error('db down'));

        const result = await UserService.listDoctors({ branchId: 'b-1' });

        expect(result[0].availability).toBe('AVAILABLE');
        expect(result[0].appointmentsToday).toBe(0);
    });

    it('respects dayOfWeek-based recurring blocks', async () => {
        prisma.doctor.findMany.mockResolvedValue([
            {
                id: 'doc-rec', userId: 'u-rec', fullName: 'Dr. Recurring',
                specialization: null, profilePhoto: null, yearsExperience: 1, qualification: null, clinic: null,
                user: { email: 'rec@x.com', role: 'DOCTOR', branchId: 'b-1', branch: { name: 'Main' } },
                _count: { appointments: 0 },
            },
        ]);
        const todayDow = new Date().getDay();
        prisma.blockedSlot.findMany.mockResolvedValue([
            { doctorId: 'doc-rec', kind: 'WFH', reason: null, date: null, dayOfWeek: todayDow },
        ]);
        prisma.appointment.groupBy.mockResolvedValue([]);

        const result = await UserService.listDoctors({ branchId: 'b-1' });
        expect(result[0].availability).toBe('UNAVAILABLE');
        expect(result[0].unavailableReason).toMatch(/home/i);
    });
});

// ─── 2. assignPatient — admin-doctor self-assign + role guards ──────────

describe('UserService.assignPatient', () => {
    const ADMIN_DOCTOR_TARGET = {
        id: 'doc-ad-1',
        user: { id: 'u-ad-1', role: 'ADMIN_DOCTOR', branchId: 'b-1', deletedAt: null },
    };
    const PATIENT_REC = {
        id: 'pt-1', branchId: 'b-1',
        user: { id: 'u-pt-1', deletedAt: null },
    };

    it('allows ADMIN_DOCTOR as a valid assignee target (self-assign)', async () => {
        prisma.patient.findUnique.mockResolvedValue(PATIENT_REC);
        prisma.doctor.findUnique.mockResolvedValue(ADMIN_DOCTOR_TARGET);
        prisma.patientAssignment.findFirst.mockResolvedValue(null);

        const result = await UserService.assignPatient({
            patientId: 'pt-1',
            doctorId:  'doc-ad-1',
            assignedById: 'u-ad-1', // admin-doctor assigning to themselves
            type: 'PRIMARY',
            allowCrossBranch: false,
        });

        expect(result).toBeDefined();
        expect(result.id).toBe('created-assignment');
    });

    it('rejects assignment when target user is soft-deleted', async () => {
        prisma.patient.findUnique.mockResolvedValue(PATIENT_REC);
        prisma.doctor.findUnique.mockResolvedValue({
            ...ADMIN_DOCTOR_TARGET,
            user: { ...ADMIN_DOCTOR_TARGET.user, deletedAt: new Date() },
        });

        await expect(
            UserService.assignPatient({
                patientId: 'pt-1', doctorId: 'doc-ad-1', assignedById: 'u-x',
            }),
        ).rejects.toThrow(/deactivated/);
    });

    it('rejects assignment when target user role is not DOCTOR/ADMIN_DOCTOR', async () => {
        prisma.patient.findUnique.mockResolvedValue(PATIENT_REC);
        prisma.doctor.findUnique.mockResolvedValue({
            id: 'doc-bad', user: { id: 'u-bad', role: 'PHARMACIST', branchId: 'b-1', deletedAt: null },
        });

        await expect(
            UserService.assignPatient({
                patientId: 'pt-1', doctorId: 'doc-bad', assignedById: 'u-x',
            }),
        ).rejects.toThrow(/PHARMACIST/);
    });

    it('rejects cross-branch assignment for non-admin actors', async () => {
        prisma.patient.findUnique.mockResolvedValue({ ...PATIENT_REC, branchId: 'b-1' });
        prisma.doctor.findUnique.mockResolvedValue({
            ...ADMIN_DOCTOR_TARGET,
            user: { ...ADMIN_DOCTOR_TARGET.user, branchId: 'b-2' },
        });

        await expect(
            UserService.assignPatient({
                patientId: 'pt-1', doctorId: 'doc-ad-1', assignedById: 'u-x',
                allowCrossBranch: false,
            }),
        ).rejects.toThrow(/Cross-branch/);
    });

    it('TEMPORARY assignment does NOT replace existing PRIMARY', async () => {
        prisma.patient.findUnique.mockResolvedValue(PATIENT_REC);
        prisma.doctor.findUnique.mockResolvedValue(ADMIN_DOCTOR_TARGET);
        prisma.patientAssignment.findFirst.mockResolvedValue(null);

        // Capture what's passed inside the transaction by spying on
        // $transaction's callback and inspecting tx.patientAssignment.updateMany
        // call count.
        let updateManyCalls = 0;
        prisma.$transaction.mockImplementationOnce(async (cb) => {
            return cb({
                patientAssignment: {
                    updateMany: vi.fn().mockImplementation(() => {
                        updateManyCalls += 1;
                        return Promise.resolve({ count: 0 });
                    }),
                    create: vi.fn().mockResolvedValue({
                        id: 'temp-assignment', type: 'TEMPORARY',
                        doctor: { id: 'doc-ad-1', fullName: 'Dr. Admin', specialization: null },
                        patient: { id: 'pt-1', fullName: 'Pt' },
                    }),
                },
            });
        });

        await UserService.assignPatient({
            patientId: 'pt-1', doctorId: 'doc-ad-1', assignedById: 'u-ad-1',
            type: 'TEMPORARY',
        });

        expect(updateManyCalls).toBe(0); // PRIMARY-replace branch must NOT fire
    });

    it('PRIMARY assignment DOES flip existing primary to REPLACED', async () => {
        prisma.patient.findUnique.mockResolvedValue(PATIENT_REC);
        prisma.doctor.findUnique.mockResolvedValue(ADMIN_DOCTOR_TARGET);
        prisma.patientAssignment.findFirst.mockResolvedValue(null);

        let updateManyArgs = null;
        prisma.$transaction.mockImplementationOnce(async (cb) => {
            return cb({
                patientAssignment: {
                    updateMany: vi.fn().mockImplementation((args) => {
                        updateManyArgs = args;
                        return Promise.resolve({ count: 1 });
                    }),
                    create: vi.fn().mockResolvedValue({ id: 'new-primary' }),
                },
            });
        });

        await UserService.assignPatient({
            patientId: 'pt-1', doctorId: 'doc-ad-1', assignedById: 'u-ad-1',
            type: 'PRIMARY',
        });

        expect(updateManyArgs).toBeTruthy();
        expect(updateManyArgs.where.type).toBe('PRIMARY');
        expect(updateManyArgs.data.status).toBe('REPLACED');
    });
});

// ─── 3. DietPackageService.list — isActive auto-filter for APPROVED ─────

describe('DietPackageService.list', () => {
    it('appends isActive:true when status=APPROVED', async () => {
        prisma.dietPackage.findMany.mockResolvedValue([]);
        await DietPackageService.list({
            hospitalId: 'h-1', status: 'APPROVED',
            mineUserId: null, role: 'ADMIN',
        });

        expect(prisma.dietPackage.findMany).toHaveBeenCalledTimes(1);
        const call = prisma.dietPackage.findMany.mock.calls[0][0];
        expect(call.where.status).toBe('APPROVED');
        expect(call.where.isActive).toBe(true);
    });

    it('does NOT add isActive filter for PENDING (admin review queue stays full)', async () => {
        prisma.dietPackage.findMany.mockResolvedValue([]);
        await DietPackageService.list({
            hospitalId: 'h-1', status: 'PENDING',
            mineUserId: null, role: 'ADMIN',
        });

        const call = prisma.dietPackage.findMany.mock.calls[0][0];
        expect(call.where.status).toBe('PENDING');
        expect(call.where.isActive).toBeUndefined();
    });

    it('creator role sees APPROVED+isActive OR own submissions in any status', async () => {
        prisma.dietPackage.findMany.mockResolvedValue([]);
        await DietPackageService.list({
            hospitalId: 'h-1', status: undefined,
            mineUserId: 'doc-user-1', role: 'DOCTOR',
        });

        const call = prisma.dietPackage.findMany.mock.calls[0][0];
        expect(Array.isArray(call.where.OR)).toBe(true);
        const approvedClause = call.where.OR.find((c) => c.status === 'APPROVED');
        expect(approvedClause).toBeDefined();
        expect(approvedClause.isActive).toBe(true);
        const ownClause = call.where.OR.find((c) => c.createdById === 'doc-user-1');
        expect(ownClause).toBeDefined();
    });
});

// ─── 4. AuditService.getRecentActivity ──────────────────────────────────

describe('AuditService.getRecentActivity', () => {
    it('returns denormalised actor name (doctor > therapist > patient > email)', async () => {
        prisma.auditLog.findMany.mockResolvedValue([
            {
                id: 'a1', action: 'CREATE_USER', entityType: 'User', entityId: 'u-1',
                createdAt: new Date('2026-04-25T10:00:00Z'),
                oldData: null, newData: null,
                user: {
                    id: 'u-actor', email: 'doc@x.com', role: 'DOCTOR',
                    doctor:    { fullName: 'Dr. Saleem' },
                    therapist: null,
                    patient:   null,
                },
            },
        ]);

        const result = await AuditService.getRecentActivity({ hospitalId: 'h-1', limit: 10 });

        expect(result).toHaveLength(1);
        expect(result[0].actor.name).toBe('Dr. Saleem');
        expect(result[0].actor.role).toBe('DOCTOR');
        expect(result[0].action).toBe('CREATE_USER');
    });

    it('falls back to email when no role-specific profile is linked', async () => {
        prisma.auditLog.findMany.mockResolvedValue([
            {
                id: 'a2', action: 'UPDATE_USER', entityType: 'User', entityId: 'u-2',
                createdAt: new Date(), oldData: null, newData: null,
                user: {
                    id: 'u-actor-2', email: 'plain@x.com', role: 'ADMIN',
                    doctor: null, therapist: null, patient: null,
                },
            },
        ]);

        const result = await AuditService.getRecentActivity({ hospitalId: 'h-1' });
        expect(result[0].actor.name).toBe('plain@x.com');
    });

    it('treats null user as a System actor', async () => {
        prisma.auditLog.findMany.mockResolvedValue([
            {
                id: 'a3', action: 'AUTO_COMPLETE', entityType: 'Appointment', entityId: 'app-1',
                createdAt: new Date(), oldData: null, newData: null,
                user: null,
            },
        ]);
        const result = await AuditService.getRecentActivity({ hospitalId: 'h-1' });
        expect(result[0].actor.name).toBe('System');
        expect(result[0].actor.role).toBe('SYSTEM');
    });

    it('hospital-scoped query includes a userId-null OR for system rows', async () => {
        prisma.auditLog.findMany.mockResolvedValue([]);
        await AuditService.getRecentActivity({ hospitalId: 'h-1', limit: 5 });

        const args = prisma.auditLog.findMany.mock.calls[0][0];
        expect(Array.isArray(args.where.OR)).toBe(true);
        expect(args.where.OR).toEqual(expect.arrayContaining([
            { userId: null },
            { user: { hospitalId: 'h-1' } },
        ]));
        expect(args.take).toBe(5);
    });

    it('clamps limit to [1, 100]', async () => {
        prisma.auditLog.findMany.mockResolvedValue([]);
        await AuditService.getRecentActivity({ hospitalId: null, limit: 999 });
        expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(100);

        prisma.auditLog.findMany.mockClear();
        await AuditService.getRecentActivity({ hospitalId: null, limit: 0 });
        expect(prisma.auditLog.findMany.mock.calls[0][0].take).toBe(20); // 0 → falsy → default
    });

    it('omits hospital-scope clause when hospitalId is null (super-admin path)', async () => {
        prisma.auditLog.findMany.mockResolvedValue([]);
        await AuditService.getRecentActivity({ hospitalId: null, limit: 5 });

        const args = prisma.auditLog.findMany.mock.calls[0][0];
        expect(args.where.OR).toBeUndefined();
    });
});
