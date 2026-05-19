#!/usr/bin/env node
// Verifies the two Reports/Analytics bug fixes:
//
//   • getPatientProgress now queries TreatmentJourney (phase-based) instead
//     of the legacy Journey (session-based) model that current installs
//     leave mostly empty.
//   • getMonthlyCompletedAppointments no longer scopes ADMIN_DOCTOR to their
//     personal doctorId — they get the hospital-wide oversight view that
//     ADMIN already had.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '..');

let pass = 0;
const check = async (label, fn) => {
    try { await fn(); console.log('  ✓', label); pass++; }
    catch (err) { console.error('  ✗', label); console.error('    →', err.message); process.exit(1); }
};

// ──────────────────────────────────────────────────────────────────────────
// State + prisma stubs
// ──────────────────────────────────────────────────────────────────────────
const state = {
    users: [],
    doctors: [],
    therapists: [],
    treatmentJourneys: [],
    journeys: [],
    appointments: [],
};

const prismaMod = await import('../lib/prisma.js');
const prisma = prismaMod.default;

function matches(row, where) {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
        if (k === 'OR' && Array.isArray(v))   { if (!v.some((s) => matches(row, s))) return false; continue; }
        if (k === 'AND' && Array.isArray(v))  { if (!v.every((s) => matches(row, s))) return false; continue; }
        if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
            const rv = row[k];
            if ('in' in v   && !v.in.includes(rv)) return false;
            if ('gt' in v   && !(rv > v.gt))       return false;
            if ('gte' in v  && !(rv >= v.gte))     return false;
            if ('lt' in v   && !(rv < v.lt))       return false;
            if ('lte' in v  && !(rv <= v.lte))     return false;
            if ('equals' in v && rv !== v.equals)  return false;
        } else if (row[k] !== v) {
            return false;
        }
    }
    return true;
}

// Apply nested include hydration to mock rows.
function hydrate(row, include) {
    if (!include) return row;
    const out = { ...row };
    if (include.patient && row.patientId) {
        const userRow = state.users.find((u) => u.id === row.patientId);
        if (userRow) {
            out.patient = { ...userRow };
            if (include.patient.include?.patient) {
                out.patient.patient = state.users.find((u) => u.id === row.patientId)?.patient || null;
            }
            if (include.patient.include?.user) {
                out.patient.user = userRow;
            }
        }
    }
    if (include.doctor && row.doctorId) {
        const userRow = state.users.find((u) => u.id === row.doctorId);
        if (userRow) {
            out.doctor = { ...userRow };
            if (include.doctor.include?.doctor) {
                out.doctor.doctor = state.users.find((u) => u.id === row.doctorId)?.doctor || null;
            }
            if (include.doctor.include?.user) {
                out.doctor.user = userRow;
            }
        }
    }
    if (include.phases) {
        out.phases = (row.phases || []).map((p) => ({ status: p.status }));
    }
    if (include.therapist && row.therapistId) {
        out.therapist = state.therapists.find((t) => t.id === row.therapistId) || null;
    }
    if (include.branch) {
        out.branch = row.branch || { name: row.branchId };
    }
    return out;
}

prisma.treatmentJourney = {
    findMany: async ({ where, include, orderBy: _o }) => {
        const rows = state.treatmentJourneys.filter((j) => matches(j, where));
        return rows.map((r) => hydrate(r, include));
    },
};
prisma.journey = {
    findMany: async ({ where, include: _i, orderBy: _o }) => state.journeys.filter((j) => matches(j, where)),
};
prisma.doctor = {
    findFirst:  async ({ where, select: _s }) => state.doctors.find((d) => {
        if (where?.OR) return where.OR.some((or) => or.id === d.id || or.userId === d.userId);
        return matches(d, where);
    }) || null,
    findUnique: async ({ where, select: _s }) => state.doctors.find((d) =>
        (where.id && d.id === where.id) || (where.userId && d.userId === where.userId)) || null,
};
prisma.therapist = {
    findUnique: async ({ where }) => state.therapists.find((t) =>
        (where.id && t.id === where.id) || (where.userId && t.userId === where.userId)) || null,
};
prisma.appointment = {
    count:    async ({ where }) => state.appointments.filter((a) => matches(a, where)).length,
    findMany: async ({ where, include, orderBy: _o, skip = 0, take }) => {
        const rows = state.appointments.filter((a) => matches(a, where));
        const sliced = take ? rows.slice(skip, skip + take) : rows.slice(skip);
        return sliced.map((r) => hydrate(r, include));
    },
};

const { analyticsService } = await import('../services/analytics.service.js');

// ──────────────────────────────────────────────────────────────────────────
// Source-code shape checks
// ──────────────────────────────────────────────────────────────────────────
console.log('\nSource-code checks');

const src = fs.readFileSync(path.join(repoRoot, 'services/analytics.service.js'), 'utf8');

await check('getPatientProgress uses prisma.treatmentJourney (not legacy Journey)', () => {
    // Strip comments so the explanatory text doesn't trip a false positive
    const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(codeOnly, /prisma\.treatmentJourney\.findMany/);
    // The legacy `prisma.journey.findMany` should no longer be called from
    // the patient-progress method. (It may still appear elsewhere in the file.)
    const patientProgressBlock = codeOnly.split('async getPatientProgress')[1]?.split('async getDoctorPerformance')[0] || '';
    assert.ok(patientProgressBlock, 'getPatientProgress block not found');
    assert.equal(patientProgressBlock.includes('prisma.journey.findMany'), false,
        'getPatientProgress still references legacy prisma.journey.findMany');
});

await check('getPatientProgress includes phases on the journey query', () => {
    const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const block = codeOnly.split('async getPatientProgress')[1]?.split('async getDoctorPerformance')[0] || '';
    assert.match(block, /phases:\s*\{[^}]*select:\s*\{[^}]*status:\s*true/);
});

await check('getMonthlyCompletedAppointments no longer scopes ADMIN_DOCTOR to personal doctorId', () => {
    const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const block = codeOnly.split('async getMonthlyCompletedAppointments')[1] || '';
    assert.ok(block.length > 0);
    // The OR with ADMIN_DOCTOR is gone — only plain DOCTOR triggers the personal scope.
    assert.equal(/role === ['"]DOCTOR['"]\s*\|\|\s*role === ['"]ADMIN_DOCTOR['"]/.test(block), false,
        'ADMIN_DOCTOR still bundled with DOCTOR in the role scope');
    assert.match(block, /role === ['"]DOCTOR['"]/);
});

// ──────────────────────────────────────────────────────────────────────────
// Runtime — Patient Progress
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — Patient Progress');

// User rows that act as both Patient and Doctor users.
state.users = [
    {
        id: 'u-pat-1', email: 'sangeetha@iwis',
        patient: { id: 'p-1', patientId: 'PAT-001', fullName: 'Sangeetha' },
        doctor: null,
    },
    {
        id: 'u-pat-2', email: 'ranjan@iwis',
        patient: { id: 'p-2', patientId: 'PAT-002', fullName: 'Ranjan' },
        doctor: null,
    },
    {
        id: 'u-doc-1', email: 'saleem@iwis',
        patient: null,
        doctor: { id: 'doc-saleem', fullName: 'Dr. Saleem' },
    },
];
state.doctors = [{ id: 'doc-saleem', userId: 'u-doc-1' }];

state.treatmentJourneys = [
    {
        id: 'tj-1', patientId: 'u-pat-1', doctorId: 'u-doc-1', branchId: 'br-1',
        status: 'ACTIVE', startDate: new Date(), updatedAt: new Date(),
        phases: [
            { status: 'COMPLETED' },
            { status: 'COMPLETED' },
            { status: 'ACTIVE' },
            { status: 'UPCOMING' },
        ],
    },
    {
        id: 'tj-2', patientId: 'u-pat-2', doctorId: 'u-doc-1', branchId: 'br-1',
        status: 'COMPLETED', startDate: new Date(), updatedAt: new Date(),
        phases: [
            { status: 'COMPLETED' },
            { status: 'COMPLETED' },
        ],
    },
];

// Legacy Journey table is empty — confirms the old code path was the bug.
state.journeys = [];

await check('Returns rows from TreatmentJourney (was empty because legacy Journey is empty)', async () => {
    const out = await analyticsService.getPatientProgress({});
    assert.equal(out.length, 2);
});

await check('Row shape matches the frontend interface (patientName, totalSessions, …)', async () => {
    const [row] = await analyticsService.getPatientProgress({});
    assert.ok('patientName' in row);
    assert.ok('totalSessions' in row);
    assert.ok('completedSessions' in row);
    assert.ok('progress' in row);
    assert.ok('status' in row);
    assert.ok('doctorName' in row);
});

await check('totalSessions = phase count, completedSessions = COMPLETED phases', async () => {
    const rows = await analyticsService.getPatientProgress({});
    const sang = rows.find((r) => r.patientName === 'Sangeetha');
    assert.equal(sang.totalSessions, 4);
    assert.equal(sang.completedSessions, 2);
    assert.equal(sang.progress, 50);
});

await check('100% progress for fully-completed journey', async () => {
    const rows = await analyticsService.getPatientProgress({});
    const ranjan = rows.find((r) => r.patientName === 'Ranjan');
    assert.equal(ranjan.progress, 100);
    assert.equal(ranjan.status, 'COMPLETED');
});

await check('doctorName resolves through User → Doctor relation', async () => {
    const [row] = await analyticsService.getPatientProgress({});
    assert.equal(row.doctorName, 'Dr. Saleem');
});

await check('branchId filter applies directly to TreatmentJourney.branchId', async () => {
    const inBranch = await analyticsService.getPatientProgress({ branchId: 'br-1' });
    assert.equal(inBranch.length, 2);
    const wrongBranch = await analyticsService.getPatientProgress({ branchId: 'br-XYZ' });
    assert.equal(wrongBranch.length, 0);
});

await check('status filter narrows to matching journeys', async () => {
    const completed = await analyticsService.getPatientProgress({ status: 'COMPLETED' });
    assert.equal(completed.length, 1);
    assert.equal(completed[0].patientName, 'Ranjan');
});

// ──────────────────────────────────────────────────────────────────────────
// Runtime — Monthly Completed Appointments
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — Monthly Completed Appointments');

const now = new Date();
const sometime = new Date(now.getFullYear(), now.getMonth(), 10, 10, 0);

state.appointments = [
    // Saleem completed 0 this month personally.
    // Other doctors have:
    { id: 'a-1', date: sometime, status: 'COMPLETED', doctorId: 'doc-rahman',  patientId: 'p-1', branchId: 'br-1', patient: { fullName: 'Sangeetha' }, doctor: { fullName: 'Dr. Rahman' } },
    { id: 'a-2', date: sometime, status: 'COMPLETED', doctorId: 'doc-rahman',  patientId: 'p-2', branchId: 'br-1', patient: { fullName: 'Ranjan' },    doctor: { fullName: 'Dr. Rahman' } },
    { id: 'a-3', date: sometime, status: 'COMPLETED', doctorId: 'doc-meena',   patientId: 'p-1', branchId: 'br-2', patient: { fullName: 'Sangeetha' }, doctor: { fullName: 'Dr. Meena' } },
    // One belonging to Saleem (so personal-scope wouldn't return zero — to make the bucket distinction crystal-clear).
    { id: 'a-4', date: sometime, status: 'COMPLETED', doctorId: 'doc-saleem',  patientId: 'p-2', branchId: 'br-1', patient: { fullName: 'Ranjan' },    doctor: { fullName: 'Dr. Saleem' } },
];

await check('ADMIN_DOCTOR sees ALL completed appointments in the hospital (was 1, now 4)', async () => {
    const out = await analyticsService.getMonthlyCompletedAppointments({
        role: 'ADMIN_DOCTOR', userId: 'u-doc-1', branchId: null,
    });
    assert.equal(out.meta.total, 4, 'ADMIN_DOCTOR must NOT be scoped to personal doctorId');
});

await check('Plain DOCTOR is still scoped to their personal appointments', async () => {
    const out = await analyticsService.getMonthlyCompletedAppointments({
        role: 'DOCTOR', userId: 'u-doc-1', branchId: null,
    });
    assert.equal(out.meta.total, 1, 'DOCTOR keeps personal scope');
});

await check('ADMIN sees all (regression check — was already correct)', async () => {
    const out = await analyticsService.getMonthlyCompletedAppointments({
        role: 'ADMIN', userId: 'u-doc-1', branchId: null,
    });
    assert.equal(out.meta.total, 4);
});

await check('Explicit branchId filter narrows the hospital-wide view', async () => {
    const out = await analyticsService.getMonthlyCompletedAppointments({
        role: 'ADMIN_DOCTOR', userId: 'u-doc-1', branchId: 'br-1',
    });
    assert.equal(out.meta.total, 3); // a-3 lives in br-2
});

console.log(`\n✅  ${pass} assertions passed across the reports & analytics fixes.`);
