#!/usr/bin/env node
// Verification of the attendance audit fixes (#1, #2, #3, #4, #5, #6, #7,
// #10, #11, #12, #15, #16 + the Sunday-closed branch handling).
//
// Strategy mirrors the workflow-engine verification: stub prisma in-place
// against the imported service module, run focused per-fix assertions.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StaffAttendanceService } from '../services/staffAttendance.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '..');

let pass = 0;
const check = async (label, fn) => {
    try {
        await fn();
        console.log('  ✓', label);
        pass++;
    } catch (err) {
        console.error('  ✗', label);
        console.error('    →', err.message);
        process.exit(1);
    }
};

// In-memory stub state
const state = {
    attendance: [],   // StaffAttendance rows
    users: [],
    branches: [],
    blockedSlots: [],
    auditLogs: [],
};

const prismaMod = await import('../lib/prisma.js');
const prisma = prismaMod.default;

prisma.staffAttendance = {
    findUnique: async ({ where }) => {
        const k = where.userId_date;
        return state.attendance.find((r) =>
            r.userId === k.userId && r.date.getTime() === k.date.getTime()) || null;
    },
    findMany: async ({ where }) => state.attendance.filter((r) => {
        if (where?.userId   && r.userId   !== where.userId)   return false;
        if (where?.branchId && r.branchId !== where.branchId) return false;
        if (where?.date) {
            const d = where.date;
            if (d.gte && r.date < d.gte) return false;
            if (d.lte && r.date > d.lte) return false;
            if (d instanceof Date && r.date.getTime() !== d.getTime()) return false;
        }
        return true;
    }),
    upsert: async ({ where, create, update }) => {
        const k = where.userId_date;
        const existing = state.attendance.find((r) =>
            r.userId === k.userId && r.date.getTime() === k.date.getTime());
        if (existing) {
            Object.assign(existing, update);
            return existing;
        }
        const row = { id: `att-${state.attendance.length + 1}`, ...create };
        state.attendance.push(row);
        return row;
    },
    update: async ({ where, data }) => {
        const row = state.attendance.find((r) => r.id === where.id ||
            (where.userId_date && r.userId === where.userId_date.userId &&
                r.date.getTime() === where.userId_date.date.getTime()));
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
    },
    delete: async ({ where }) => {
        const k = where.userId_date;
        const idx = state.attendance.findIndex((r) =>
            r.userId === k.userId && r.date.getTime() === k.date.getTime());
        if (idx === -1) throw new Error('not found');
        return state.attendance.splice(idx, 1)[0];
    },
};
prisma.user = {
    findUnique: async ({ where, select }) => {
        const u = state.users.find((x) => x.id === where.id);
        if (!u) return null;
        // Apply nested availability `where` filter on the therapist relation
        // so the service's dayOfWeek lookup behaves like the real client.
        if (select?.therapist?.select?.availability?.where && u.therapist?.availability) {
            const dow = select.therapist.select.availability.where.dayOfWeek;
            return {
                ...u,
                therapist: {
                    ...u.therapist,
                    availability: u.therapist.availability.filter((a) => a.dayOfWeek === dow),
                },
            };
        }
        return u;
    },
};
prisma.branch = {
    findUnique: async ({ where }) => state.branches.find((b) => b.id === where.id) || null,
};
prisma.doctor    = { findUnique: async ({ where }) => state.users.find((u) => u.id === where.userId)?.doctor    || null };
prisma.therapist = { findUnique: async ({ where }) => state.users.find((u) => u.id === where.userId)?.therapist || null };
prisma.blockedSlot = {
    findMany: async ({ where }) => state.blockedSlots.filter((b) => {
        // Crude filter — matches doctor or therapist id, on date or weekday.
        const ids = [
            ...(where.OR?.[0]?.doctorId?.in    || []),
            ...(where.OR?.[1]?.therapistId?.in || []),
        ];
        if (ids.length && !ids.includes(b.doctorId) && !ids.includes(b.therapistId)) return false;
        // We accept all date variants — the tests below set rows that match.
        return true;
    }),
};
prisma.auditLog = {
    create: async ({ data }) => {
        const row = { id: `audit-${state.auditLogs.length + 1}`, ...data };
        state.auditLogs.push(row);
        return row;
    },
};

// Helpers for test setup
function makeBranch({ id = 'br-1', operatingHoursFrom = '09:00', operatingHoursTo = '18:00', closedDays = [] } = {}) {
    return {
        id, operatingHoursFrom, operatingHoursTo,
        isActive: true, weeklyClosedDays: closedDays,
    };
}
function makeUser({ id = 'user-1', role = 'DOCTOR', branchId = 'br-1', therapist = null, doctor = { id: 'd-1' } } = {}) {
    return { id, role, branchId, therapist, doctor };
}
// IST 09:00 on 2026-05-19 = 03:30 UTC.
function clinicTime(year, monthIndex, day, h, m) {
    // Build the UTC instant that corresponds to the given clinic-local (IST) time.
    return new Date(Date.UTC(year, monthIndex, day, h - 5, m - 30));
}

// ──────────────────────────────────────────────────────────────────────────
// Source-code checks (the kind of changes verifying via runtime would
// require even more stubs)
// ──────────────────────────────────────────────────────────────────────────
console.log('\nSource-code shape checks');

await check('Service has CLINIC_TZ_OFFSET and TZ_OFFSET_MIN constants (#5, #6)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /const CLINIC_TZ_OFFSET = '\+05:30'/);
    assert.match(src, /const TZ_OFFSET_MIN/);
});
await check('Service has MIN_WORKED_MIN_FOR_HALFDAY constant (#3)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /MIN_WORKED_MIN_FOR_HALFDAY = 30/);
});
await check('Service has unified _deriveStatus helper (#1+#3+#10+#11+#12)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /function _deriveStatus\(/);
    assert.match(src, /Single source of truth/);
});
await check('Service _resolveScheduledWindow honours weeklyClosedDays (Sunday handling)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /weeklyClosedDays/);
    assert.match(src, /branch\.weeklyClosedDays.*\.includes\(dayOfWeek\)/);
});
await check('Schema has Branch.weeklyClosedDays Int[]', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf8');
    assert.match(src, /weeklyClosedDays\s+Int\[\]\s+@default\(\[\]\)/);
});
await check('Idempotent SQL migration file exists', () => {
    const sql = fs.readFileSync(path.join(repoRoot, 'prisma/sql/branch_weekly_closed_days.sql'), 'utf8');
    assert.match(sql, /ADD COLUMN IF NOT EXISTS "weeklyClosedDays"/);
});
await check('Controller catches P2002 (#7)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'controllers/operations.controller.js'), 'utf8');
    assert.match(src, /err\?\.code === 'P2002'/);
});
await check('setAttendance reads existing notes before write (#2 — notes-append)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    // Must call findUnique on the row right before the upsert, and concat
    // previous.notes onto the result.
    assert.match(src, /previous = await prisma\.staffAttendance\.findUnique/);
    assert.match(src, /previous\?\.notes/);
});
await check('deleteAttendance writes an AuditLog row (#16)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /prisma\.auditLog\.create/);
    assert.match(src, /DELETE_STAFF_ATTENDANCE/);
});
await check('runNightlyReconciliation iterates BACKFILL_DAYS (#15)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /BACKFILL_DAYS = \d+/);
    assert.match(src, /for \(let offset = 1; offset <= this\.BACKFILL_DAYS/);
});
await check('getAttendanceStats.avgLateMinutes uses status===LATE not lateMinutes>0 (#10)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /lateRecords = records\.filter\(\(r\) => r\.status === 'LATE'\)/);
});
await check('getAttendanceStats separates Present and WFH (#12)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /presentDays = records\.filter\(\(r\) => r\.status === 'PRESENT'\)\.length/);
});
await check('getPunctualityReport tracks HALF_DAY (#11)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /halfDays: 0/);
    assert.match(src, /grouped\[uid\]\.halfDays\+\+/);
});
await check('_isFullDay handles null startTime/endTime (#4)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/staffAttendance.service.js'), 'utf8');
    assert.match(src, /block\.startTime == null && block\.endTime == null.*return true/s);
});
await check('Frontend todayKey uses clinic-local (#5)', () => {
    const src = fs.readFileSync(path.resolve(repoRoot, '../alshifa-frontend/src/pages/admin/AttendanceTracker.tsx'), 'utf8');
    assert.match(src, /toLocaleDateString\('en-CA'\)/);
    // Strip comments so the explanatory note about the old pattern doesn't
    // cause a false positive — we only care about the actual assignment.
    const codeOnly = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(
        /todayKey\s*=\s*new Date\(\)\.toISOString\(\)\.slice/.test(codeOnly),
        false,
        'old UTC pattern still present in the actual assignment',
    );
});

// ──────────────────────────────────────────────────────────────────────────
// Runtime — exercise _deriveStatus via setAttendance (it's the simplest
// path that takes admin-provided clockIn/clockOut as HH:mm strings).
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — _deriveStatus via setAttendance');

state.users = [
    makeUser({ id: 'user-d1' }),
];
state.branches = [
    makeBranch({ id: 'br-1', closedDays: [] }),
];

// Reset for each scenario
function reset() {
    state.attendance.length = 0;
    state.blockedSlots.length = 0;
    state.auditLogs.length = 0;
}

await check('On-time clock-in + full shift → PRESENT', async () => {
    reset();
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:00', clockOut: '17:00',
    });
    assert.equal(r.status, 'PRESENT');
    assert.equal(r.lateMinutes, 0);
});

await check('Late clock-in by 20 min + full shift → LATE w/ lateMinutes=20', async () => {
    reset();
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:20', clockOut: '17:00',
    });
    assert.equal(r.status, 'LATE');
    assert.equal(r.lateMinutes, 20);
});

await check('Audit fix #1 — extreme late + short shift downgrades, not LATE w/ 566min', async () => {
    reset();
    // Clock in at 17:30, out at 18:00 → worked 30min → above MIN but below
    // HALF_DAY threshold → HALF_DAY (not LATE with lateMinutes=510).
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '17:30', clockOut: '18:00',
    });
    assert.equal(r.status, 'HALF_DAY');
    assert.equal(r.lateMinutes, 510, 'lateMinutes still recorded for audit');
});

await check('Audit fix #3 — clock-in/out 1 minute apart → ABSENT (was HALF_DAY)', async () => {
    reset();
    // setAttendance requires clockIn < clockOut, so we use a 1-minute span
    // — still way under the 30-min minimum, exercising the same code path
    // that produced "Clocked out · worked 0m · HALF DAY" on the screenshot.
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:00', clockOut: '09:01',
    });
    assert.equal(r.status, 'ABSENT', 'sub-30-minute span must NOT be HALF_DAY');
});

await check('Clock-out 20 min after clock-in → still ABSENT (< 30 min threshold)', async () => {
    reset();
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:00', clockOut: '09:20',
    });
    assert.equal(r.status, 'ABSENT');
});

await check('Clock-out 31 min after clock-in → HALF_DAY (crosses threshold)', async () => {
    reset();
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:00', clockOut: '09:31',
    });
    assert.equal(r.status, 'HALF_DAY');
});

await check('Admin-forced status wins over derived', async () => {
    reset();
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:00', clockOut: '17:00',
        status: 'WFH', // override
    });
    assert.equal(r.status, 'WFH');
});

// ──────────────────────────────────────────────────────────────────────────
// Audit fix #2 — notes-append preserves history
// ──────────────────────────────────────────────────────────────────────────
console.log('\nAudit fix #2 — notes audit-trail append');

await check('First admin edit writes notes + audit line', async () => {
    reset();
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'alice@iwis', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:00', clockOut: '17:00', notes: 'first edit',
    });
    assert.match(r.notes, /first edit \| Edited by alice@iwis/);
});

await check('Second admin edit APPENDS, does not overwrite', async () => {
    // (state still has the row from previous test)
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-2', actorEmail: 'bob@iwis', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:05', clockOut: '17:05', notes: 'second edit',
    });
    assert.match(r.notes, /first edit/);
    assert.match(r.notes, /alice@iwis/);
    assert.match(r.notes, /second edit/);
    assert.match(r.notes, /bob@iwis/);
});

await check('Third edit without notes still preserves prior notes', async () => {
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-3', actorEmail: 'cara@iwis', targetUserId: 'user-d1',
        date: '2026-05-19', clockIn: '09:10', clockOut: '17:10',
        // no `notes` field
    });
    assert.match(r.notes, /first edit/);
    assert.match(r.notes, /second edit/);
    assert.match(r.notes, /cara@iwis/);
});

// ──────────────────────────────────────────────────────────────────────────
// Audit fix #16 — delete writes an audit log
// ──────────────────────────────────────────────────────────────────────────
console.log('\nAudit fix #16 — delete audit log');

await check('Delete writes DELETE_STAFF_ATTENDANCE audit row with snapshot', async () => {
    // Use the row left over from the notes-append tests.
    const before = state.attendance.length;
    await StaffAttendanceService.deleteAttendance({
        actorId: 'admin-x', targetUserId: 'user-d1', date: '2026-05-19',
    });
    assert.equal(state.attendance.length, before - 1, 'row was deleted');
    const audit = state.auditLogs.at(-1);
    assert.equal(audit.action, 'DELETE_STAFF_ATTENDANCE');
    assert.equal(audit.userId, 'admin-x');
    assert.equal(audit.entityType, 'StaffAttendance');
    assert.ok(audit.oldData, 'oldData snapshot must be present');
});

// ──────────────────────────────────────────────────────────────────────────
// Sunday-closed branch handling — _resolveScheduledWindow returns null
// ──────────────────────────────────────────────────────────────────────────
console.log('\nSunday-closed branch handling');

await check('When branch closedDays includes Sunday, Sunday returns no schedule (skip)', async () => {
    reset();
    state.branches[0].weeklyClosedDays = [0]; // Sunday closed
    // 2026-05-17 is a Sunday (IST)
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-17', clockIn: '09:00', clockOut: '17:00',
    });
    // Sunday closed → schedule resolves to null → clockIn/clockOut still
    // accepted but derived status is PRESENT (no late comparison possible).
    assert.equal(r.scheduledStart, null);
});

await check('When branch closedDays is empty, Sunday IS a working day', async () => {
    reset();
    state.branches[0].weeklyClosedDays = []; // open every day
    const r = await StaffAttendanceService.setAttendance({
        actorId: 'admin-1', actorEmail: 'a@b', targetUserId: 'user-d1',
        date: '2026-05-17', clockIn: '09:00', clockOut: '17:00',
    });
    assert.equal(r.scheduledStart, '09:00');
    assert.equal(r.status, 'PRESENT');
});

// ──────────────────────────────────────────────────────────────────────────
// Stats endpoint — uses the new counting rules
// ──────────────────────────────────────────────────────────────────────────
console.log('\ngetAttendanceStats / getPunctualityReport — new counting');

reset();
// Seed a mix of records for 'user-d1'.
const seed = (status, lateMin = 0, date = new Date('2026-05-01')) => state.attendance.push({
    id: `att-${state.attendance.length + 1}`,
    userId: 'user-d1', branchId: 'br-1', date, status, lateMinutes: lateMin,
});
seed('PRESENT');
seed('PRESENT');
seed('LATE', 25);
seed('LATE', 50);
seed('LATE', 75);
seed('HALF_DAY');
seed('ABSENT');
seed('WFH');
seed('LEAVE');

await check('avgLateMinutes = mean of LATE-status rows only', async () => {
    const stats = await StaffAttendanceService.getAttendanceStats('user-d1', {});
    assert.equal(stats.lateDays, 3);
    // mean of [25, 50, 75] = 50
    assert.equal(stats.avgLateMinutes, 50);
});

await check('presentDays counts ONLY PRESENT (not Present+WFH)', async () => {
    const stats = await StaffAttendanceService.getAttendanceStats('user-d1', {});
    assert.equal(stats.presentDays, 2);
    assert.equal(stats.wfhDays, 1);
});

await check('halfDays / wfhDays / leaveDays separately tracked', async () => {
    const stats = await StaffAttendanceService.getAttendanceStats('user-d1', {});
    assert.equal(stats.halfDays, 1);
    assert.equal(stats.leaveDays, 1);
});

await check('Bucket totals add up to totalDays', async () => {
    const s = await StaffAttendanceService.getAttendanceStats('user-d1', {});
    const sum = s.presentDays + s.lateDays + s.absentDays + s.halfDays + s.wfhDays + s.leaveDays;
    assert.equal(sum, s.totalDays);
});

await check('Punctuality report exposes halfDays bucket (#11)', async () => {
    const rep = await StaffAttendanceService.getPunctualityReport('br-1', {});
    assert.equal(rep[0].halfDays, 1);
});

await check('Punctuality report buckets also add up to totalDays', async () => {
    const e = (await StaffAttendanceService.getPunctualityReport('br-1', {}))[0];
    const sum = e.presentDays + e.lateDays + e.absentDays + e.halfDays + e.wfhDays + e.leaveDays;
    assert.equal(sum, e.totalDays);
});

// ──────────────────────────────────────────────────────────────────────────
console.log(`\n✅  ${pass} assertions passed across all attendance audit fixes.`);
