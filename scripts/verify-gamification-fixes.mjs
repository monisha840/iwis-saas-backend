#!/usr/bin/env node
// Verification of the Gamification Analytics audit fixes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BadgeService } from '../services/badge.service.js';
import { GamificationAnalyticsService } from '../services/gamificationAnalytics.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(__dirname, '..');

let pass = 0;
const check = async (label, fn) => {
    try { await fn(); console.log('  ✓', label); pass++; }
    catch (err) { console.error('  ✗', label); console.error('    →', err.message); process.exit(1); }
};

// ──────────────────────────────────────────────────────────────────────────
// In-memory stubs against the real prisma client
// ──────────────────────────────────────────────────────────────────────────
const state = {
    doctors: [],
    therapists: [],
    users: [],
    todos: [],
    appointments: [],
    treatmentJourneys: [],
    journeys: [],
    leaderboardAudits: [],
    leaderboardConfigs: [],
    badges: [],
    userBadges: [],
    clinicianStreaks: [],
    zenPointsLedger: [],
    patients: [],
    patientStreaks: [],
    patientChallengeCompletions: [],
    gamificationAnomalies: [],
    badgeEmits: [],
};

const prismaMod = await import('../lib/prisma.js');
const prisma = prismaMod.default;

// Tiny dynamic `where` matcher that covers the operators we use.
function matches(row, where) {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
        if (k === 'OR' && Array.isArray(v))   { if (!v.some((sub) => matches(row, sub))) return false; continue; }
        if (k === 'AND' && Array.isArray(v))  { if (!v.every((sub) => matches(row, sub))) return false; continue; }
        if (k === 'NOT' && v)                 { if (matches(row, v)) return false; continue; }
        if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
            const rv = row[k];
            if ('in' in v   && !v.in.includes(rv))                                       return false;
            if ('notIn' in v && v.notIn.includes(rv))                                    return false;
            if ('not' in v) {
                const not = v.not;
                if (not !== null && typeof not === 'object' && 'in' in not) {
                    if (not.in.includes(rv)) return false;
                } else if (rv === not) return false;
            }
            if ('gt' in v   && !(rv > v.gt))     return false;
            if ('gte' in v  && !(rv >= v.gte))   return false;
            if ('lt' in v   && !(rv < v.lt))     return false;
            if ('lte' in v  && !(rv <= v.lte))   return false;
            if ('equals' in v && rv !== v.equals) return false;
            // Nested relation filter — we only need User.deletedAt today.
            if (k === 'user' && 'deletedAt' in v) {
                const u = state.users.find((u) => u.id === row.userId);
                if (!u) return false;
                if (u.deletedAt !== v.deletedAt) return false;
            }
        } else if (row[k] !== v) {
            return false;
        }
    }
    return true;
}

prisma.doctor    = {
    count:      async ({ where } = {}) => state.doctors.filter((d) => matches(d, where)).length,
    findUnique: async ({ where, select: _s }) => state.doctors.find((d) => d.id === where.id || d.userId === where.userId) || null,
    findMany:   async ({ where, select: _s } = {}) => state.doctors.filter((d) => matches(d, where)),
};
prisma.therapist = {
    count:      async ({ where } = {}) => state.therapists.filter((t) => matches(t, where)).length,
    findUnique: async ({ where, select: _s }) => state.therapists.find((t) => t.id === where.id || t.userId === where.userId) || null,
};
prisma.clinicianStreak = {
    count:      async ({ where }) => state.clinicianStreaks.filter((s) => matches(s, where)).length,
    findUnique: async ({ where }) => state.clinicianStreaks.find((s) => s.participantId === where.participantId) || null,
};
prisma.leaderboardAudit = {
    findMany:   async ({ where, orderBy: _o, distinct, select: _s }) => {
        let rows = state.leaderboardAudits.filter((a) => matches(a, where));
        if (distinct?.includes('participantId')) {
            const seen = new Set();
            rows = rows.filter((r) => seen.has(r.participantId) ? false : (seen.add(r.participantId), true));
        }
        return rows;
    },
    groupBy:    async ({ where }) => {
        const matched = state.leaderboardAudits.filter((a) => matches(a, where));
        const ids = [...new Set(matched.map((a) => a.participantId))];
        return ids.map((id) => ({ participantId: id, _count: matched.filter((a) => a.participantId === id).length }));
    },
};
prisma.leaderboardConfig = {
    findMany: async ({ orderBy: _o, take }) => state.leaderboardConfigs.slice(-take).reverse(),
};
prisma.userBadge = {
    count:    async () => state.userBadges.length,
    findMany: async ({ where, select: _s }) => state.userBadges.filter((b) => matches(b, where)),
    create:   async ({ data }) => {
        const dup = state.userBadges.find((b) => b.userId === data.userId && b.badgeId === data.badgeId);
        if (dup) { const e = new Error('Unique constraint failed'); e.code = 'P2002'; throw e; }
        const row = { id: `ub-${state.userBadges.length + 1}`, ...data, awardedAt: new Date() };
        state.userBadges.push(row);
        return row;
    },
};
prisma.badge = {
    findMany: async ({ where, orderBy: _o }) => state.badges.filter((b) => matches(b, where)),
};
prisma.todo = {
    count:    async ({ where }) => state.todos.filter((t) => matches(t, where)).length,
    findMany: async ({ where, select: _s, orderBy: _o }) => state.todos.filter((t) => matches(t, where)),
};
prisma.appointment      = { count: async ({ where }) => state.appointments.filter((a) => matches(a, where)).length };
prisma.treatmentJourney = {
    count:    async ({ where }) => state.treatmentJourneys.filter((j) => matches(j, where)).length,
    findMany: async ({ where, select: _s }) => state.treatmentJourneys.filter((j) => matches(j, where)),
};
prisma.journey = {
    count:    async ({ where }) => state.journeys.filter((j) => matches(j, where)).length,
    findMany: async ({ where, select: _s }) => state.journeys.filter((j) => matches(j, where)),
};
prisma.gamificationAnomaly = { count: async ({ where }) => state.gamificationAnomalies.filter((a) => matches(a, where)).length };
prisma.patient = {
    count:      async ({ where } = {}) => state.patients.filter((p) => matches(p, where)).length,
    aggregate:  async ({ where, _avg, _max } = {}) => {
        const rows = state.patients.filter((p) => matches(p, where));
        const out = {};
        if (_avg?.zenPoints) {
            const total = rows.reduce((s, r) => s + (r.zenPoints || 0), 0);
            out._avg = { zenPoints: rows.length ? total / rows.length : 0 };
        }
        if (_max?.zenPoints) {
            out._max = { zenPoints: rows.reduce((m, r) => Math.max(m, r.zenPoints || 0), 0) };
        }
        return out;
    },
};
prisma.zenPointsLedger = {
    groupBy: async ({ by: _by, where }) => {
        const rows = state.zenPointsLedger.filter((r) => matches(r, where));
        const ids = [...new Set(rows.map((r) => r.patientId))];
        return ids.map((id) => ({ patientId: id, _count: rows.filter((r) => r.patientId === id).length }));
    },
};
prisma.patientStreak = {
    aggregate: async () => {
        const arr = state.patientStreaks.map((s) => s.currentStreak);
        return {
            _avg:   { currentStreak: arr.length ? arr.reduce((s, n) => s + n, 0) / arr.length : 0 },
            _max:   { currentStreak: arr.reduce((m, n) => Math.max(m, n), 0) },
            _count: state.patientStreaks.length,
        };
    },
};
prisma.patientChallengeCompletion = { count: async () => state.patientChallengeCompletions.length };

// ──────────────────────────────────────────────────────────────────────────
// Source-code checks
// ──────────────────────────────────────────────────────────────────────────
console.log('\nSource-code checks');

const badgeSrc      = fs.readFileSync(path.join(repoRoot, 'services/badge.service.js'), 'utf8');
const analyticsSrc  = fs.readFileSync(path.join(repoRoot, 'services/gamificationAnalytics.service.js'), 'utf8');
const todoSrc       = fs.readFileSync(path.join(repoRoot, 'services/todo.service.js'), 'utf8');

await check('_gatherStats now returns todosCompleted (#1)', () => {
    assert.match(badgeSrc, /todosCompleted,[\s\S]*todosCompletedAssigned,[\s\S]*todosAssignedToOthers,[\s\S]*todoStreak,/);
});
await check('_gatherStats resolves Doctor.id → User.id for Todo + TreatmentJourney joins (#2)', () => {
    assert.match(badgeSrc, /prisma\.doctor\.findUnique\([\s\S]*select:\s*\{\s*userId:\s*true\s*\}/);
    assert.match(badgeSrc, /prisma\.treatmentJourney\.count\(/);
});
await check('checkCumulativeBadgesForUser entrypoint exists (#6)', () => {
    assert.match(badgeSrc, /static async checkCumulativeBadgesForUser\(userId\)/);
});
await check('Brittle P2002 substring check replaced with strict equality', () => {
    // Strip line + block comments so the explanatory comment about the old
    // pattern doesn't trip a false positive.
    const codeOnly = badgeSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(codeOnly.includes(`includes('P2002')`), false);
    assert.match(codeOnly, /err\.code !== 'P2002'/);
});
await check('todo.service.js calls BadgeService.checkCumulativeBadgesForUser on COMPLETED (#6)', () => {
    assert.match(todoSrc, /BadgeService\.checkCumulativeBadgesForUser\(actor\.id\)/);
});

await check('Engagement overview filters soft-deleted clinicians (#5)', () => {
    assert.match(analyticsSrc, /prisma\.doctor\.count\(\{\s*where:\s*\{\s*user:\s*\{\s*deletedAt:\s*null\s*\}\s*\}/);
});
await check('Active streaks have a freshness guard (#11)', () => {
    assert.match(analyticsSrc, /clinicianStreak\.count\([\s\S]*currentStreak:\s*\{\s*gt:\s*0\s*\}[\s\S]*updatedAt:\s*\{\s*gte/);
});
await check('Score trend XP fallback removed; empty buckets return null (#2)', () => {
    assert.equal(analyticsSrc.includes('XP_FALLBACK'), false);
    assert.match(analyticsSrc, /avgScore:\s*b\.sampleSize > 0\s*\?[\s\S]*:\s*null/);
});
await check('Outcome correlation top bucket clamps to 100 inclusive (#4)', () => {
    assert.match(analyticsSrc, /top_90_100:[\s\S]*inclusiveMax:\s*true/);
});
await check('Outcome correlation queries treatmentJourney (#3)', () => {
    assert.match(analyticsSrc, /prisma\.treatmentJourney\.findMany/);
});
await check('Config impact requires minimum after-window samples (#9)', () => {
    assert.match(analyticsSrc, /MIN_CONFIG_IMPACT_SAMPLES/);
    assert.match(analyticsSrc, /afterAudits\.length < this\.MIN_CONFIG_IMPACT_SAMPLES/);
});
await check('Patient stats use ZenPointsLedger for active definition (#6 patient-side)', () => {
    assert.match(analyticsSrc, /prisma\.zenPointsLedger\.groupBy/);
    assert.match(analyticsSrc, /activeWindowDays:\s*30/);
});

// ──────────────────────────────────────────────────────────────────────────
// Runtime — badges
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — badge cumulative re-evaluation');

state.users = [
    { id: 'u-doc-1', role: 'DOCTOR', deletedAt: null },
];
state.doctors = [{ id: 'doc-1', userId: 'u-doc-1' }];
state.badges = [
    { id: 'b1', code: 'TASK_STARTER',   isActive: true, criteria: { type: 'milestone',  metric: 'todosCompleted', threshold: 1 } },
    { id: 'b2', code: 'TASK_MASTER_50', isActive: true, criteria: { type: 'cumulative', metric: 'todosCompletedAssigned', threshold: 50 } },
    { id: 'b3', code: 'DELEGATION_PRO', isActive: true, criteria: { type: 'cumulative', metric: 'todosAssignedToOthers', threshold: 50 } },
    { id: 'b4', code: 'STREAK_7',       isActive: true, criteria: { type: 'streak',     metric: 'activeDays', threshold: 7 } },
    { id: 'b5', code: 'SCORE_90',       isActive: true, criteria: { type: 'rate',       metric: 'excellenceScore', threshold: 90 } },
];

await check('No completed todos → TASK_STARTER not yet awarded', async () => {
    state.userBadges.length = 0;
    state.todos.length = 0;
    const awards = await BadgeService.checkCumulativeBadgesForUser('u-doc-1');
    assert.equal(awards.find((a) => a.code === 'TASK_STARTER'), undefined);
});

await check('1 completed assigned todo → TASK_STARTER fires (was unreachable before fix)', async () => {
    state.userBadges.length = 0;
    state.todos = [
        { id: 't1', assignedToId: 'u-doc-1', createdById: 'someone-else', status: 'COMPLETED', completedAt: new Date() },
    ];
    const awards = await BadgeService.checkCumulativeBadgesForUser('u-doc-1');
    assert.ok(awards.find((a) => a.code === 'TASK_STARTER'), 'TASK_STARTER must fire');
});

await check('Rate-type badges (SCORE_90) NOT awarded by cumulative entrypoint', async () => {
    state.userBadges.length = 0;
    // even with completed todos, rate-type badges should be skipped
    const awards = await BadgeService.checkCumulativeBadgesForUser('u-doc-1');
    assert.equal(awards.find((a) => a.code === 'SCORE_90'), undefined);
});

await check('Already-awarded badge does NOT fire again (dedup)', async () => {
    // userBadges already has TASK_STARTER from the previous test
    state.todos = [
        { id: 't1', assignedToId: 'u-doc-1', createdById: 'someone-else', status: 'COMPLETED', completedAt: new Date() },
    ];
    const awards = await BadgeService.checkCumulativeBadgesForUser('u-doc-1');
    assert.equal(awards.find((a) => a.code === 'TASK_STARTER'), undefined);
});

// ──────────────────────────────────────────────────────────────────────────
// Runtime — analytics
// ──────────────────────────────────────────────────────────────────────────
console.log('\nRuntime — analytics');

await check('getEngagementOverview totalClinicians excludes soft-deleted', async () => {
    state.users = [
        { id: 'u-doc-1', deletedAt: null },
        { id: 'u-doc-2', deletedAt: new Date() }, // soft-deleted
    ];
    state.doctors = [
        { id: 'doc-1', userId: 'u-doc-1' },
        { id: 'doc-2', userId: 'u-doc-2' },
    ];
    state.therapists = [];
    state.clinicianStreaks = [];
    state.leaderboardAudits = [];
    state.gamificationAnomalies = [];
    state.userBadges = [];
    const out = await GamificationAnalyticsService.getEngagementOverview();
    assert.equal(out.totalClinicians, 1, 'soft-deleted clinician excluded');
});

await check('Active streak requires recent updatedAt', async () => {
    state.users = [{ id: 'u-doc-1', deletedAt: null }];
    state.doctors = [{ id: 'doc-1', userId: 'u-doc-1' }];
    const longAgo = new Date(Date.now() - 60 * 86_400_000);
    state.clinicianStreaks = [
        { participantId: 'doc-1', currentStreak: 5, updatedAt: longAgo }, // stale
    ];
    const out = await GamificationAnalyticsService.getEngagementOverview();
    assert.equal(out.activeStreaks, 0, 'stale streak NOT counted as active');

    state.clinicianStreaks = [
        { participantId: 'doc-1', currentStreak: 5, updatedAt: new Date() },
    ];
    const out2 = await GamificationAnalyticsService.getEngagementOverview();
    assert.equal(out2.activeStreaks, 1, 'fresh streak counted');
});

await check('Score trend returns null for empty buckets (not 0)', async () => {
    state.leaderboardAudits = []; // no audit data
    const trend = await GamificationAnalyticsService.getScoreTrend();
    assert.equal(trend.length, 12);
    for (const bucket of trend) {
        assert.equal(bucket.avgScore, null, 'empty bucket → null (was 0 before)');
        assert.equal(bucket.source, 'EMPTY');
    }
});

await check('Score trend never returns XP_FALLBACK source (fallback removed)', async () => {
    const trend = await GamificationAnalyticsService.getScoreTrend();
    for (const bucket of trend) {
        assert.notEqual(bucket.source, 'XP_FALLBACK');
    }
});

await check('Outcome correlation includes score=100 in top bucket', async () => {
    state.leaderboardAudits = [
        { participantId: 'doc-1', participantRole: 'DOCTOR', score: 100, calculationDate: new Date() },
    ];
    state.doctors = [{ id: 'doc-1', userId: 'u-doc-1' }];
    state.treatmentJourneys = [
        { doctorId: 'u-doc-1', status: 'COMPLETED' },
        { doctorId: 'u-doc-1', status: 'ACTIVE' },
    ];
    const corr = await GamificationAnalyticsService.getOutcomeCorrelation();
    const top = corr.find((c) => c.scoreRange.toLowerCase().includes('top'));
    assert.ok(top, 'top bucket present');
    assert.equal(top.clinicianCount, 1, 'perfect-100 clinician must be in top bucket');
    assert.equal(top.avgJourneySuccessRate, 50, '1/2 completed');
});

await check('Outcome correlation queries TreatmentJourney via resolved User.id', async () => {
    // The previous test already exercised this — but reassert via the
    // explicit bucket math: 1 doctor with 1/2 TreatmentJourneys completed.
    state.leaderboardAudits = [
        { participantId: 'doc-1', participantRole: 'DOCTOR', score: 75, calculationDate: new Date() },
    ];
    state.treatmentJourneys = [
        { doctorId: 'u-doc-1', status: 'COMPLETED' },
        { doctorId: 'u-doc-1', status: 'COMPLETED' },
        { doctorId: 'u-doc-1', status: 'ACTIVE' },
    ];
    state.journeys = [];
    const corr = await GamificationAnalyticsService.getOutcomeCorrelation();
    const high = corr.find((c) => c.scoreRange.toLowerCase().includes('high'));
    assert.equal(high.clinicianCount, 1);
    assert.equal(high.avgJourneySuccessRate, 67, '2/3 completed = 67%');
});

await check('Config impact returns hasComparison:false when after-window samples < 5', async () => {
    state.leaderboardConfigs = [
        { id: 'c-new', createdAt: new Date(Date.now() - 60_000) },     // 1 min ago
        { id: 'c-old', createdAt: new Date(Date.now() - 60 * 86_400_000) }, // 60d ago
    ];
    // Lots of before data, no after data (the new config is too fresh).
    state.leaderboardAudits = Array.from({ length: 30 }, () => ({
        participantId: 'doc-1', participantRole: 'DOCTOR', score: 70,
        calculationDate: new Date(Date.now() - 10 * 86_400_000),
    }));
    const out = await GamificationAnalyticsService.getConfigImpact();
    assert.equal(out.hasComparison, false);
    assert.match(out.message, /Not enough data after config change/);
});

await check('Patient stats: active means earned points in last 30d (#6)', async () => {
    state.users = [
        { id: 'pu-1', deletedAt: null }, { id: 'pu-2', deletedAt: null }, { id: 'pu-3', deletedAt: null },
    ];
    state.patients = [
        { id: 'p-1', userId: 'pu-1', zenPoints: 100 },
        { id: 'p-2', userId: 'pu-2', zenPoints: 50 },
        { id: 'p-3', userId: 'pu-3', zenPoints: 200 },
    ];
    // p-1 active recently; p-2 only earned 60 days ago; p-3 active recently.
    state.zenPointsLedger = [
        { patientId: 'p-1', points: 10, createdAt: new Date(Date.now() - 2 * 86_400_000) },
        { patientId: 'p-2', points: 10, createdAt: new Date(Date.now() - 60 * 86_400_000) },
        { patientId: 'p-3', points: 10, createdAt: new Date(Date.now() - 5 * 86_400_000) },
    ];
    state.patientStreaks = [];
    state.patientChallengeCompletions = [];
    const out = await GamificationAnalyticsService.getPatientGamificationStats();
    assert.equal(out.activePatients, 2, 'p-2 (dormant) excluded; p-1 and p-3 active');
    assert.equal(out.totalPatients, 3);
    // avg over ACTIVE only → (100 + 200) / 2 = 150
    assert.equal(out.avgZenPoints, 150);
    assert.equal(out.activeWindowDays, 30);
});

console.log(`\n✅  ${pass} assertions passed across the gamification analytics audit fixes.`);
