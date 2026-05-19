#!/usr/bin/env node
// Verification of the six audit fixes applied to the Workflow Automation engine.
// Avoids stubbing WhatsAppService (ESM live-binding pitfalls) and instead
// verifies each fix via the smallest reliable surface:
//
//   #1 — PHASE_COMPLETED removed: assert constants + validator behaviour
//   #2 — cooldown only on success: source-code shape check in the engine
//   #3 — zero-log diet adherence: run evalDietAdherenceLow against stubbed
//        prisma and verify it now fires when prior logic silently skipped
//   #4 — WhatsApp consent gate: source-code shape check (the runtime path
//        needs the real WhatsApp API for the success branch, which we don't
//        want to hit in CI; the opt-out branch is verifiable by source)
//   #7 — triggerType-family cooldown: run isInTriggerFamilyCooldown against
//        stubbed prisma across all four cases (same/different triggerType,
//        same/different branch, fresh vs stale log)
//   #8 — UI gate: verified separately via tsc on the frontend
//
// Exit code 0 iff every assertion passes.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    VALID_TRIGGER_TYPES,
    validateConditionValue,
    isInTriggerFamilyCooldown,
    evalDietAdherenceLow,
} from '../services/workflowEngine.service.js';

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

// ──────────────────────────────────────────────────────────────────────────
// Shared in-memory prisma stub — only the tables the engine actually queries.
// We assign methods on the real prisma client; the engine imports the same
// singleton so its callsites pick these up. Tables we DON'T touch (User,
// PatientAssignment, etc.) are left as the real client — they're not on the
// hot path of the functions we test.
// ──────────────────────────────────────────────────────────────────────────

const prismaMod = await import('../lib/prisma.js');
const prisma = prismaMod.default;

const state = {
    workflowRuleRows: [],
    workflowRuleLogRows: [],
    dietAdherenceLogRows: [],
    dietPrescriptionRows: [],
    patientRows: [],
    journeyRows: [],
};

prisma.workflowRuleLog = {
    findFirst: async ({ where }) => {
        for (const log of state.workflowRuleLogRows) {
            if (where.patientId && log.patientId !== where.patientId) continue;
            if (where.triggeredAt?.gte && log.triggeredAt < where.triggeredAt.gte) continue;
            if (where.rule) {
                const rule = state.workflowRuleRows.find((r) => r.id === log.ruleId);
                if (!rule) continue;
                if (where.rule.triggerType && rule.triggerType !== where.rule.triggerType) continue;
                if (where.rule.branchId   && rule.branchId   !== where.rule.branchId)   continue;
            }
            return log;
        }
        return null;
    },
};
prisma.dietAdherenceLog = {
    findMany: async ({ where }) => state.dietAdherenceLogRows.filter((r) =>
        r.patientId === where.patientId &&
        (!where.loggedAt?.gte || r.loggedAt >= where.loggedAt.gte)),
};
prisma.dietPrescription = {
    findFirst: async ({ where }) => state.dietPrescriptionRows.find((r) =>
        r.patientId === where.patientId && r.isActive === where.isActive &&
        (!where.startDate?.lt || r.startDate < where.startDate.lt)) || null,
};
prisma.treatmentJourney = {
    findMany: async ({ where }) => state.journeyRows.filter((j) =>
        j.branchId === where.branchId && j.status === where.status),
};
prisma.patient = {
    findMany: async ({ where }) => state.patientRows.filter((p) =>
        p.branchId === where.branchId && (where.userId?.in?.includes(p.userId) ?? true)),
};

// ──────────────────────────────────────────────────────────────────────────
// Fix #1 — PHASE_COMPLETED removed
// ──────────────────────────────────────────────────────────────────────────
console.log('\n#1 — PHASE_COMPLETED removed');

await check('VALID_TRIGGER_TYPES does NOT include PHASE_COMPLETED', () => {
    assert.equal(VALID_TRIGGER_TYPES.includes('PHASE_COMPLETED'), false);
});

await check('VALID_TRIGGER_TYPES still has the 5 live triggers', () => {
    const expected = ['NO_CHECKIN', 'PAIN_NOT_IMPROVING', 'DIET_ADHERENCE_LOW', 'PHASE_OVERDUE', 'PRESCRIPTION_UNCOLLECTED'];
    for (const t of expected) assert.ok(VALID_TRIGGER_TYPES.includes(t), `missing ${t}`);
});

await check('validateConditionValue rejects PHASE_COMPLETED with status=400', () => {
    let thrown;
    try { validateConditionValue('PHASE_COMPLETED', {}); } catch (e) { thrown = e; }
    assert.ok(thrown, 'expected throw');
    assert.equal(thrown.status, 400);
    assert.match(thrown.message, /Unknown triggerType/);
});

await check('validateConditionValue still accepts NO_CHECKIN { days: 3 }', () => {
    validateConditionValue('NO_CHECKIN', { days: 3 });
});

await check('routes/workflowRules.js zod enum no longer lists PHASE_COMPLETED', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'routes/workflowRules.js'), 'utf8');
    // Pull the triggerEnum declaration and confirm.
    const match = src.match(/const triggerEnum = z\.enum\(\[([\s\S]*?)\]\)/);
    assert.ok(match, 'triggerEnum not found in route file');
    assert.equal(match[1].includes('PHASE_COMPLETED'), false, 'triggerEnum still contains PHASE_COMPLETED');
});

// ──────────────────────────────────────────────────────────────────────────
// Fix #2 — Cooldown only on success (source-code shape check)
// ──────────────────────────────────────────────────────────────────────────
console.log('\n#2 — Cooldown only on success');

await check('Engine source has the new "any success" guard before updateCooldown', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/workflowEngine.service.js'), 'utf8');
    // The guard expression we added.
    assert.match(src, /const anySuccess = actionResults\.some\(/);
    // updateCooldown must be inside `if (anySuccess)` block, not the bare path.
    assert.match(src, /if \(anySuccess\)\s*\{\s*await updateCooldown\(/);
});

await check('Engine source no longer has an unconditional updateCooldown after executeActions', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/workflowEngine.service.js'), 'utf8');
    // The OLD pattern was the two lines in sequence with nothing between them.
    // The new pattern always has the anySuccess check between them.
    const oldPattern = /await executeActions\(rule, patient, reason\);\s*await updateCooldown\(/;
    assert.equal(oldPattern.test(src), false, 'unconditional updateCooldown still present');
});

// ──────────────────────────────────────────────────────────────────────────
// Fix #3 — Zero-log diet adherence
// ──────────────────────────────────────────────────────────────────────────
console.log('\n#3 — Zero-log diet adherence');

state.patientRows = [
    { id: 'pat-A', userId: 'user-A', branchId: 'br-1',
      user: { id: 'user-A', notificationPreference: null } },
    { id: 'pat-B', userId: 'user-B', branchId: 'br-1',
      user: { id: 'user-B', notificationPreference: null } },
];
state.journeyRows = [
    { branchId: 'br-1', status: 'ACTIVE', patientId: 'user-A' },
    { branchId: 'br-1', status: 'ACTIVE', patientId: 'user-B' },
];
state.dietPrescriptionRows = [
    { patientId: 'pat-A', isActive: true, startDate: new Date(Date.now() - 10 * 86_400_000) },
];
state.dietAdherenceLogRows = [];

const cohortAB = await evalDietAdherenceLow('br-1', { thresholdPercent: 40, days: 5 });

await check('Patient WITH active diet rx + zero logs → flagged (was silently skipped before)', () => {
    const a = cohortAB.find((r) => r.patient.id === 'pat-A');
    assert.ok(a, 'patient A must be in the match list');
    assert.match(a.reason, /No diet adherence logged/);
});

await check('Patient WITHOUT active diet rx + zero logs → not flagged', () => {
    const b = cohortAB.find((r) => r.patient.id === 'pat-B');
    assert.equal(b, undefined, 'patient B must not be flagged');
});

// Add one patient WITH logs above threshold — should not fire.
state.dietPrescriptionRows.push({
    patientId: 'pat-B', isActive: true, startDate: new Date(Date.now() - 10 * 86_400_000),
});
state.dietAdherenceLogRows = [
    { patientId: 'pat-A', loggedAt: new Date(), followed: true  },
    { patientId: 'pat-A', loggedAt: new Date(), followed: true  },
    { patientId: 'pat-A', loggedAt: new Date(), followed: true  },
    { patientId: 'pat-A', loggedAt: new Date(), followed: false },
    // pat-A adherence: 3/4 = 75% → above 40% threshold → no match
    { patientId: 'pat-B', loggedAt: new Date(), followed: false },
    { patientId: 'pat-B', loggedAt: new Date(), followed: false },
    { patientId: 'pat-B', loggedAt: new Date(), followed: true  },
    // pat-B adherence: 1/3 = 33% → below 40% threshold → match
];
const cohortAB2 = await evalDietAdherenceLow('br-1', { thresholdPercent: 40, days: 5 });
await check('Above-threshold adherence does not fire', () => {
    assert.equal(cohortAB2.find((r) => r.patient.id === 'pat-A'), undefined);
});
await check('Below-threshold adherence fires with the % in the reason', () => {
    const b = cohortAB2.find((r) => r.patient.id === 'pat-B');
    assert.ok(b);
    assert.match(b.reason, /33% over the last 5 days/);
});

// ──────────────────────────────────────────────────────────────────────────
// Fix #4 — Consent gate (source-code shape check)
// ──────────────────────────────────────────────────────────────────────────
console.log('\n#4 — WhatsApp consent gate');

await check('Engine source has the opt-out check in SEND_WHATSAPP', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/workflowEngine.service.js'), 'utf8');
    assert.match(src, /case 'SEND_WHATSAPP':[\s\S]*?notificationPreference[\s\S]*?whatsappEnabled === false/);
});

await check('Opt-out push uses the canonical error message', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/workflowEngine.service.js'), 'utf8');
    assert.match(src, /Patient has opted out of WhatsApp notifications/);
});

// ──────────────────────────────────────────────────────────────────────────
// Fix #7 — Cross-rule family cooldown
// ──────────────────────────────────────────────────────────────────────────
console.log('\n#7 — Cross-rule family cooldown');

state.workflowRuleLogRows = [];
state.workflowRuleRows = [
    { id: 'rule-A', triggerType: 'DIET_ADHERENCE_LOW', branchId: 'br-1' },
    { id: 'rule-B', triggerType: 'DIET_ADHERENCE_LOW', branchId: 'br-1' },
    { id: 'rule-C', triggerType: 'NO_CHECKIN',         branchId: 'br-1' },
    { id: 'rule-D', triggerType: 'DIET_ADHERENCE_LOW', branchId: 'br-2' },
];

await check('Empty log table → not in family cooldown', async () => {
    assert.equal(await isInTriggerFamilyCooldown('pat-1', 'DIET_ADHERENCE_LOW', 'br-1'), false);
});

state.workflowRuleLogRows.push({
    ruleId: 'rule-A', patientId: 'pat-1',
    triggeredAt: new Date(Date.now() - 2 * 3_600_000),
});

await check('Recent fire of SAME triggerType in SAME branch → blocked', async () => {
    assert.equal(await isInTriggerFamilyCooldown('pat-1', 'DIET_ADHERENCE_LOW', 'br-1'), true);
});

await check('Same patient, DIFFERENT triggerType → not blocked', async () => {
    assert.equal(await isInTriggerFamilyCooldown('pat-1', 'NO_CHECKIN', 'br-1'), false);
});

await check('Same patient, same triggerType, DIFFERENT branch → not blocked', async () => {
    assert.equal(await isInTriggerFamilyCooldown('pat-1', 'DIET_ADHERENCE_LOW', 'br-2'), false);
});

state.workflowRuleLogRows.push({
    ruleId: 'rule-A', patientId: 'pat-2',
    triggeredAt: new Date(Date.now() - 26 * 3_600_000),
});
await check('Fire older than 24h → family cooldown expires, not blocked', async () => {
    assert.equal(await isInTriggerFamilyCooldown('pat-2', 'DIET_ADHERENCE_LOW', 'br-1'), false);
});

await check('Custom window (1h) catches a 2h-old fire as expired', async () => {
    assert.equal(await isInTriggerFamilyCooldown('pat-1', 'DIET_ADHERENCE_LOW', 'br-1', 1), false);
});

// ──────────────────────────────────────────────────────────────────────────
// Fix #7 — wiring into evaluateAllRules main loop (source check)
// ──────────────────────────────────────────────────────────────────────────
console.log('\n#7 — wiring into evaluateAllRules main loop');

await check('Main loop calls isInTriggerFamilyCooldown before isOnCooldown', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'services/workflowEngine.service.js'), 'utf8');
    assert.match(src, /isOnCooldown[\s\S]*?isInTriggerFamilyCooldown\(patient\.id, rule\.triggerType, rule\.branchId\)/);
});

// ──────────────────────────────────────────────────────────────────────────
// Fix #8 — UI gate (source check)
// ──────────────────────────────────────────────────────────────────────────
console.log('\n#8 — Evaluate Now button gated on ADMIN role');

await check('Frontend imports useAuth in the workflow page', () => {
    const src = fs.readFileSync(
        path.resolve(repoRoot, '../alshifa-frontend/src/pages/admin/WorkflowAutomation.tsx'),
        'utf8',
    );
    assert.match(src, /from "@\/hooks\/useAuth"/);
});

await check('Evaluate Now button wrapped in canEvaluateNow conditional', () => {
    const src = fs.readFileSync(
        path.resolve(repoRoot, '../alshifa-frontend/src/pages/admin/WorkflowAutomation.tsx'),
        'utf8',
    );
    assert.match(src, /const canEvaluateNow = role === "ADMIN"/);
    assert.match(src, /\{canEvaluateNow && \(\s*<Button[\s\S]*?Evaluate Now/);
});

await check('TRIGGER_ORDER no longer offers PHASE_COMPLETED to the dropdown', () => {
    const src = fs.readFileSync(
        path.resolve(repoRoot, '../alshifa-frontend/src/pages/admin/WorkflowAutomation.tsx'),
        'utf8',
    );
    const match = src.match(/const TRIGGER_ORDER:\s*TriggerType\[\]\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(match, 'TRIGGER_ORDER not found');
    assert.equal(match[1].includes('PHASE_COMPLETED'), false);
});

// ──────────────────────────────────────────────────────────────────────────
console.log(`\n✅  ${pass} assertions passed across all six audit fixes.`);
