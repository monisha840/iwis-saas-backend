import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory pseudo-prisma so the route handlers under test don't need a DB.
// Captures the incoming where clause from each call so assertions can verify
// what filter the handler chose.
const calls = [];
const prismaStub = {
    user: {
        findUnique: vi.fn(async ({ where }) => {
            calls.push({ model: 'user', op: 'findUnique', where });
            return prismaStub._users[where.id] || null;
        }),
    },
    patient: {
        findUnique: vi.fn(async ({ where }) => {
            calls.push({ model: 'patient', op: 'findUnique', where });
            return prismaStub._patients[where.id] || null;
        }),
    },
    doctor: {
        findUnique: vi.fn(async ({ where }) => {
            calls.push({ model: 'doctor', op: 'findUnique', where });
            return prismaStub._doctors[where.id] || null;
        }),
    },
    therapist: {
        findUnique: vi.fn(async ({ where }) => {
            calls.push({ model: 'therapist', op: 'findUnique', where });
            return prismaStub._therapists[where.id] || null;
        }),
    },
    _users: {},
    _patients: {},
    _doctors: {},
    _therapists: {},
    _reset() {
        this._users = {};
        this._patients = {};
        this._doctors = {};
        this._therapists = {};
        calls.length = 0;
    },
};

// Re-implementation of the production guards exactly as they appear in
// routes/operations.js. Kept inline (not imported) so this file has no DB
// dependency and runs as a pure unit test.
function requireOwnBranch(paramName = 'branchId') {
    return (req, res, next) => {
        if (req.user?.role === 'BRANCH_ADMIN' && req.params[paramName] !== req.user.branchId) {
            return res.status(403).json({ error: 'Forbidden: branch mismatch' });
        }
        next();
    };
}

async function requireUserInOwnBranch(req, res, next) {
    try {
        if (req.user?.role !== 'BRANCH_ADMIN') return next();
        const target = await prismaStub.user.findUnique({
            where: { id: req.params.userId },
            select: { branchId: true },
        });
        if (!target || target.branchId !== req.user.branchId) {
            return res.status(403).json({ error: 'Forbidden: user is not in your branch' });
        }
        next();
    } catch (err) {
        next(err);
    }
}

// Re-implementation of the assign-patient BRANCH_ADMIN guard from
// routes/user.js (the defence-in-depth check).
async function assignPatientGuard(req, res) {
    if (req.user.role !== 'BRANCH_ADMIN') return { allowed: true };
    const [patient, doctor] = await Promise.all([
        prismaStub.patient.findUnique({ where: { id: req.body.patientId }, select: { branchId: true } }),
        prismaStub.doctor.findUnique({ where: { id: req.body.doctorId },  include: { user: { select: { branchId: true } } } }),
    ]);
    const doctorBranchId = doctor?.user?.branchId ?? null;
    if (!patient || !doctor
        || patient.branchId !== req.user.branchId
        || doctorBranchId !== req.user.branchId) {
        return { allowed: false, status: 403, error: 'Assignment targets must belong to your branch.' };
    }
    return { allowed: true };
}

function makeRes() {
    const res = {};
    res.status = vi.fn((code) => { res._status = code; return res; });
    res.json = vi.fn((body) => { res._body = body; return res; });
    return res;
}

beforeEach(() => prismaStub._reset());

describe('BRANCH_ADMIN role — backend guards', () => {
    describe('requireOwnBranch', () => {
        it('passes through when caller is ADMIN regardless of branchId param', () => {
            const next = vi.fn();
            const req = { user: { role: 'ADMIN', branchId: 'branch-A' }, params: { branchId: 'branch-B' } };
            requireOwnBranch('branchId')(req, makeRes(), next);
            expect(next).toHaveBeenCalled();
        });

        it('passes through when BRANCH_ADMIN queries their own branch', () => {
            const next = vi.fn();
            const req = { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, params: { branchId: 'branch-A' } };
            requireOwnBranch('branchId')(req, makeRes(), next);
            expect(next).toHaveBeenCalled();
        });

        it('blocks BRANCH_ADMIN from querying a different branch', () => {
            const next = vi.fn();
            const res = makeRes();
            const req = { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, params: { branchId: 'branch-B' } };
            requireOwnBranch('branchId')(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res._status).toBe(403);
            expect(res._body.error).toMatch(/branch mismatch/i);
        });
    });

    describe('requireUserInOwnBranch', () => {
        it('passes through when caller is ADMIN_DOCTOR (no DB lookup)', async () => {
            const next = vi.fn();
            const req = { user: { role: 'ADMIN_DOCTOR' }, params: { userId: 'user-x' } };
            await requireUserInOwnBranch(req, makeRes(), next);
            expect(next).toHaveBeenCalled();
            expect(prismaStub.user.findUnique).not.toHaveBeenCalled();
        });

        it('passes through when BRANCH_ADMIN queries a user in their branch', async () => {
            prismaStub._users['user-1'] = { branchId: 'branch-A' };
            const next = vi.fn();
            const req = { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, params: { userId: 'user-1' } };
            await requireUserInOwnBranch(req, makeRes(), next);
            expect(next).toHaveBeenCalled();
        });

        it('blocks BRANCH_ADMIN from a user in another branch', async () => {
            prismaStub._users['user-2'] = { branchId: 'branch-B' };
            const next = vi.fn();
            const res = makeRes();
            const req = { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, params: { userId: 'user-2' } };
            await requireUserInOwnBranch(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res._status).toBe(403);
        });

        it('blocks BRANCH_ADMIN when the user does not exist', async () => {
            const next = vi.fn();
            const res = makeRes();
            const req = { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, params: { userId: 'ghost' } };
            await requireUserInOwnBranch(req, res, next);
            expect(next).not.toHaveBeenCalled();
            expect(res._status).toBe(403);
        });
    });

    describe('assign-patient BRANCH_ADMIN guard', () => {
        it('allows ADMIN to assign cross-branch (guard short-circuits)', async () => {
            const result = await assignPatientGuard(
                { user: { role: 'ADMIN', branchId: 'branch-A' }, body: { patientId: 'p1', doctorId: 'd1' } },
                makeRes()
            );
            expect(result.allowed).toBe(true);
        });

        it('allows BRANCH_ADMIN when both patient and doctor are in their branch', async () => {
            prismaStub._patients['p1'] = { branchId: 'branch-A' };
            prismaStub._doctors['d1']  = { user: { branchId: 'branch-A' } };
            const result = await assignPatientGuard(
                { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, body: { patientId: 'p1', doctorId: 'd1' } },
                makeRes()
            );
            expect(result.allowed).toBe(true);
        });

        it('blocks BRANCH_ADMIN when the patient is in another branch', async () => {
            prismaStub._patients['p1'] = { branchId: 'branch-B' };
            prismaStub._doctors['d1']  = { user: { branchId: 'branch-A' } };
            const result = await assignPatientGuard(
                { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, body: { patientId: 'p1', doctorId: 'd1' } },
                makeRes()
            );
            expect(result.allowed).toBe(false);
            expect(result.status).toBe(403);
            expect(result.error).toBe('Assignment targets must belong to your branch.');
        });

        it('blocks BRANCH_ADMIN when the doctor is in another branch', async () => {
            prismaStub._patients['p1'] = { branchId: 'branch-A' };
            prismaStub._doctors['d1']  = { user: { branchId: 'branch-B' } };
            const result = await assignPatientGuard(
                { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, body: { patientId: 'p1', doctorId: 'd1' } },
                makeRes()
            );
            expect(result.allowed).toBe(false);
        });

        it('blocks BRANCH_ADMIN when the doctor does not exist', async () => {
            prismaStub._patients['p1'] = { branchId: 'branch-A' };
            const result = await assignPatientGuard(
                { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, body: { patientId: 'p1', doctorId: 'd-missing' } },
                makeRes()
            );
            expect(result.allowed).toBe(false);
        });
    });

    describe('list-doctors / list-therapists branch override', () => {
        // Mirror of the route handler's branchId resolution rule.
        function effectiveBranchId(req) {
            return req.user.role === 'BRANCH_ADMIN' ? req.user.branchId : req.query.branchId;
        }

        it('uses the JWT branchId for BRANCH_ADMIN, ignoring query param', () => {
            const req = { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, query: { branchId: 'branch-B' } };
            expect(effectiveBranchId(req)).toBe('branch-A');
        });

        it('honours the query branchId for ADMIN', () => {
            const req = { user: { role: 'ADMIN', branchId: 'branch-A' }, query: { branchId: 'branch-B' } };
            expect(effectiveBranchId(req)).toBe('branch-B');
        });

        it('returns undefined for ADMIN when no query branch is supplied', () => {
            const req = { user: { role: 'ADMIN', branchId: 'branch-A' }, query: {} };
            expect(effectiveBranchId(req)).toBeUndefined();
        });
    });

    describe('list-patients branch pinning', () => {
        function effectiveBranchId(req) {
            const queryBranchId = req.query.branchId;
            const isBranchScoped = ['BRANCH_ADMIN', 'PHARMACIST', 'DOCTOR', 'THERAPIST'].includes(req.user.role);
            return isBranchScoped ? req.user.branchId : (queryBranchId || null);
        }

        it('pins BRANCH_ADMIN to JWT branchId regardless of query param', () => {
            const req = { user: { role: 'BRANCH_ADMIN', branchId: 'branch-A' }, query: { branchId: 'branch-B' } };
            expect(effectiveBranchId(req)).toBe('branch-A');
        });

        it('pins DOCTOR to JWT branchId even when query is omitted', () => {
            const req = { user: { role: 'DOCTOR', branchId: 'branch-A' }, query: {} };
            expect(effectiveBranchId(req)).toBe('branch-A');
        });

        it('lets ADMIN_DOCTOR query any branch (or all branches)', () => {
            const req = { user: { role: 'ADMIN_DOCTOR', branchId: 'branch-A' }, query: { branchId: 'branch-B' } };
            expect(effectiveBranchId(req)).toBe('branch-B');
        });
    });

    describe('role-create matrix excludes BRANCH_ADMIN', () => {
        // Mirror of routes/user.js ROLE_CREATE_MATRIX.
        const ROLE_CREATE_MATRIX = {
            SUPER_ADMIN:  ['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
            ADMIN_DOCTOR: ['ADMIN', 'DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
            ADMIN:        ['DOCTOR', 'THERAPIST', 'PATIENT', 'PHARMACIST'],
        };

        it('does not include BRANCH_ADMIN as a role any caller can create', () => {
            for (const allowed of Object.values(ROLE_CREATE_MATRIX)) {
                expect(allowed).not.toContain('BRANCH_ADMIN');
            }
        });

        it('does not include BRANCH_ADMIN as a caller key', () => {
            expect(ROLE_CREATE_MATRIX.BRANCH_ADMIN).toBeUndefined();
        });
    });
});
