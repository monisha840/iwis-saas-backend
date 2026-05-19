/**
 * Workflow Automation Rules Engine (Feature 3)
 *
 * Branch admins author no-code rules; the engine runs hourly via the existing
 * scheduledJobs BullMQ pipeline and fires actions for matching patients.
 *
 * Schema gotchas baked in:
 *   • TreatmentJourney.patientId references User.id (NOT Patient.id) → we
 *     resolve patients via journey.patientId → Patient.userId.
 *   • PatientVital.patientId references User.id  → use patient.userId.
 *   • TaskCompletion.patientId references User.id → use patient.userId.
 *   • DietAdherenceLog.patientId references Patient.id (correct as-is).
 *   • DailyCheckIn.patientId references Patient.id (correct as-is).
 *   • Patient has NO `assignedDoctor` field → resolve via PatientAssignment
 *     (PRIMARY/ACTIVE) with most-recent-appointment fallback.
 *   • notificationPreference lives on User, NOT Patient.
 *   • Patient.fullName + user.email (User has no `name` column).
 *   • Patient.phoneNumber + Patient.primaryPhone (User has no `phone`).
 *   • JourneyPhase status enum values: UPCOMING|ACTIVE|COMPLETED|SKIPPED —
 *     "IN_PROGRESS" doesn't exist; ACTIVE is the equivalent.
 *   • JourneyPhase has no `createdAt` — only `startedAt`.
 *   • notificationService.createNotification(...) (NOT `.create(...)`); link
 *     goes inside `data` JSON since Notification has no `link` column.
 *   • WhatsAppService.sendText(number, text) — positional args.
 */

import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';
import { WhatsAppService } from './whatsapp.service.js';
import {
    createFollowUpTask,
    resolveAssignedDoctorId,
} from './followUpTask.service.js';

// ── Constants ───────────────────────────────────────────────────────────────

// PHASE_COMPLETED was previously listed here as "event-based; cron skips it",
// but no event hook ever called back into the workflow engine — admins could
// author rules that looked active but never fired. Removed in audit fix #1.
// The cron skip below (`if (rule.triggerType === 'PHASE_COMPLETED')`) stays
// as defence-in-depth for any legacy DB rows still carrying that triggerType.
export const VALID_TRIGGER_TYPES = [
    'NO_CHECKIN',
    'PAIN_NOT_IMPROVING',
    'DIET_ADHERENCE_LOW',
    'PHASE_OVERDUE',
    'PRESCRIPTION_UNCOLLECTED',
];

export const VALID_ACTION_TYPES = [
    'SEND_WHATSAPP',
    'SEND_IN_APP',
    'CREATE_FOLLOW_UP_TASK',
    'FLAG_FOR_DOCTOR',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** {patientName} / {reason} / etc. interpolation. Unmatched keys stay literal. */
export function interpolateTemplate(template, vars) {
    if (typeof template !== 'string') return '';
    return template.replace(/\{(\w+)\}/g, (match, key) => {
        const v = vars?.[key];
        return v != null && v !== '' ? String(v) : match;
    });
}

/** Phone normaliser shared with healthReport / followUp services. */
function normalisePhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.substring(1);
    if (digits.length < 10) return null;
    return digits.startsWith('91') ? digits : `91${digits}`;
}

/**
 * Validate the conditionValue payload for a given triggerType. Throws an
 * error with .status=400 if the shape is wrong — used by the route layer.
 */
export function validateConditionValue(triggerType, conditionValue) {
    const isPos = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
    const c = conditionValue || {};
    switch (triggerType) {
        case 'NO_CHECKIN':
        case 'PAIN_NOT_IMPROVING':
        case 'PRESCRIPTION_UNCOLLECTED':
            if (!isPos(c.days)) throw badReq('conditionValue.days must be a positive number');
            return;
        case 'DIET_ADHERENCE_LOW':
            if (!isPos(c.thresholdPercent) || c.thresholdPercent > 100) {
                throw badReq('conditionValue.thresholdPercent must be 1–100');
            }
            if (!isPos(c.days)) throw badReq('conditionValue.days must be a positive number');
            return;
        case 'PHASE_OVERDUE':
            if (!isPos(c.days)) throw badReq('conditionValue.days must be a positive number');
            if (typeof c.taskCompletionBelow !== 'number' || c.taskCompletionBelow < 0 || c.taskCompletionBelow > 100) {
                throw badReq('conditionValue.taskCompletionBelow must be 0–100');
            }
            return;
        // PHASE_COMPLETED case removed in audit fix #1 — the trigger is no
        // longer offered and is rejected by the create / update zod schema
        // in routes/workflowRules.js. Falls through to the default below.
        default:
            throw badReq(`Unknown triggerType: ${triggerType}`);
    }
}
function badReq(msg) {
    const e = new Error(msg);
    e.status = 400;
    return e;
}

/**
 * Validate the actions array — non-empty, each entry has a known `type` and
 * the type-specific required fields (e.g. messageTemplate for SEND_WHATSAPP).
 */
export function validateActions(actions) {
    if (!Array.isArray(actions) || actions.length === 0) {
        throw badReq('actions must be a non-empty array');
    }
    for (const a of actions) {
        if (!a || !VALID_ACTION_TYPES.includes(a.type)) {
            throw badReq(`Invalid action type: ${a?.type}`);
        }
        if (a.type === 'SEND_WHATSAPP' || a.type === 'SEND_IN_APP') {
            if (!a.messageTemplate || typeof a.messageTemplate !== 'string') {
                throw badReq(`${a.type} requires messageTemplate`);
            }
        }
        if (a.type === 'CREATE_FOLLOW_UP_TASK') {
            if (!a.taskTitle || typeof a.taskTitle !== 'string') {
                throw badReq('CREATE_FOLLOW_UP_TASK requires taskTitle');
            }
            if (a.priority && !['HIGH', 'MEDIUM', 'LOW'].includes(a.priority)) {
                throw badReq('CREATE_FOLLOW_UP_TASK.priority must be HIGH/MEDIUM/LOW');
            }
        }
        if (a.type === 'FLAG_FOR_DOCTOR') {
            if (!a.message && !a.messageTemplate) {
                throw badReq('FLAG_FOR_DOCTOR requires message or messageTemplate');
            }
        }
    }
}

// ── Patient cohort ──────────────────────────────────────────────────────────

/**
 * Patients in this branch with at least one ACTIVE TreatmentJourney.
 *
 * Two-step lookup because TreatmentJourney.patientId stores User.id while
 * Patient.userId is what links them — direct `treatmentJourneys: { some }`
 * doesn't exist on Patient (the Patient model has the legacy `journeys`
 * relation only).
 */
export async function getActiveBranchPatients(branchId) {
    if (!branchId) return [];
    const journeys = await prisma.treatmentJourney.findMany({
        where: { branchId, status: 'ACTIVE' },
        select: { patientId: true },
    });
    const userIds = [...new Set(journeys.map((j) => j.patientId))];
    if (userIds.length === 0) return [];
    return prisma.patient.findMany({
        where: { branchId, userId: { in: userIds } },
        include: {
            user: { include: { notificationPreference: true } },
        },
    });
}

// ── Cooldowns ───────────────────────────────────────────────────────────────

export async function isOnCooldown(ruleId, patientId, cooldownHours) {
    try {
        const cooldown = await prisma.workflowCooldown.findUnique({
            where: { ruleId_patientId: { ruleId, patientId } },
        });
        if (!cooldown) return false;
        const elapsedHours = (Date.now() - new Date(cooldown.lastFiredAt).getTime()) / 3_600_000;
        return elapsedHours < (cooldownHours || 0);
    } catch {
        return false;
    }
}

export async function updateCooldown(ruleId, patientId) {
    await prisma.workflowCooldown.upsert({
        where:  { ruleId_patientId: { ruleId, patientId } },
        update: { lastFiredAt: new Date() },
        create: { ruleId, patientId, lastFiredAt: new Date() },
    });
}

// Cross-rule cooldown (audit fix #7). If two rules share the same
// triggerType (e.g. "Low Diet Adherence <40%/3d" AND "Low Diet Adherence
// <50%/5d"), the per-rule WorkflowCooldown lets both fire for the same
// patient on the same tick — the patient gets two WhatsApps. This guard
// queries WorkflowRuleLog for any successful fire of the same triggerType
// against this patient within the family-cooldown window, and tells the
// caller to skip if so. Branch-scoped so unrelated branches never
// interfere with each other.
//
// `windowHours` defaults to 24 — same patient shouldn't hear from us on
// the same clinical concern more than once a day, regardless of which
// specific rule matched. Tuneable here if we later expose it per-branch.
const TRIGGER_FAMILY_COOLDOWN_HOURS = 24;
export async function isInTriggerFamilyCooldown(patientId, triggerType, branchId, windowHours = TRIGGER_FAMILY_COOLDOWN_HOURS) {
    if (!patientId || !triggerType) return false;
    try {
        const cutoff = new Date(Date.now() - windowHours * 3_600_000);
        const recent = await prisma.workflowRuleLog.findFirst({
            where: {
                patientId,
                triggeredAt: { gte: cutoff },
                rule: {
                    triggerType,
                    ...(branchId ? { branchId } : {}),
                },
            },
            select: { id: true },
        });
        return !!recent;
    } catch {
        return false;
    }
}

// ── Trigger evaluators ──────────────────────────────────────────────────────
//
// Each returns Array<{ patient, reason }>. Never throws — caller is the
// engine loop which catches per-rule.

export async function evalNoCheckin(branchId, conditionValue) {
    const days = Number(conditionValue?.days) || 0;
    if (days <= 0) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const patients = await getActiveBranchPatients(branchId);
    const results = [];
    for (const patient of patients) {
        const lastCheckin = await prisma.dailyCheckIn.findFirst({
            where: { patientId: patient.id },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
        });
        const noRecent = !lastCheckin || new Date(lastCheckin.createdAt) < cutoff;
        if (noRecent) {
            results.push({ patient, reason: `No check-in submitted in the last ${days} days` });
        }
    }
    return results;
}

export async function evalPainNotImproving(branchId, conditionValue) {
    const days = Number(conditionValue?.days) || 0;
    if (days <= 0) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const patients = await getActiveBranchPatients(branchId);
    const results = [];
    for (const patient of patients) {
        // PatientVital.patientId = User.id
        const vitalLookupId = patient.userId || patient.id;
        const vitals = await prisma.patientVital.findMany({
            where: { patientId: vitalLookupId, type: 'PAIN', recordedAt: { gte: cutoff } },
            orderBy: { recordedAt: 'asc' },
            select: { value: true },
        });
        if (vitals.length < 2) continue;
        const firstPain = vitals[0].value;
        const lastPain  = vitals[vitals.length - 1].value;
        if (lastPain >= firstPain) {
            results.push({
                patient,
                reason: `Pain score has not improved over ${days} days (${firstPain} → ${lastPain})`,
            });
        }
    }
    return results;
}

export async function evalDietAdherenceLow(branchId, conditionValue) {
    const thresholdPercent = Number(conditionValue?.thresholdPercent) || 0;
    const days = Number(conditionValue?.days) || 0;
    if (thresholdPercent <= 0 || days <= 0) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const patients = await getActiveBranchPatients(branchId);
    const results = [];
    for (const patient of patients) {
        const logs = await prisma.dietAdherenceLog.findMany({
            where: { patientId: patient.id, loggedAt: { gte: cutoff } },
            select: { followed: true },
        });
        if (logs.length === 0) {
            // Audit fix #3 — zero logs used to silently skip, hiding the
            // most disengaged patients (exactly the cohort the rule wants
            // to catch). We now treat "no logs" as 0% adherence, but only
            // when the patient has an active DietPrescription that's been
            // running for at least `days` — otherwise we'd nag patients
            // who don't even have a diet plan, which is meaningless.
            const activeRx = await prisma.dietPrescription.findFirst({
                where: { patientId: patient.id, isActive: true, startDate: { lt: cutoff } },
                select: { id: true },
            });
            if (!activeRx) continue;
            results.push({
                patient,
                reason: `No diet adherence logged in the last ${days} days `
                    + `(treated as 0% — below ${thresholdPercent}% threshold)`,
            });
            continue;
        }
        const adherence = Math.round((logs.filter((l) => l.followed).length / logs.length) * 100);
        if (adherence < thresholdPercent) {
            results.push({
                patient,
                reason: `Diet adherence is ${adherence}% over the last ${days} days `
                    + `(below ${thresholdPercent}% threshold)`,
            });
        }
    }
    return results;
}

export async function evalPhaseOverdue(branchId, conditionValue) {
    const days = Number(conditionValue?.days) || 0;
    const taskCompletionBelow = Number(conditionValue?.taskCompletionBelow);
    if (days <= 0 || !Number.isFinite(taskCompletionBelow)) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const patients = await getActiveBranchPatients(branchId);
    const results = [];
    for (const patient of patients) {
        // TreatmentJourney.patientId = User.id; phase status enum has no
        // IN_PROGRESS — ACTIVE is the running state. Filter by startedAt
        // older than cutoff (JourneyPhase has no createdAt column).
        const activePhase = await prisma.journeyPhase.findFirst({
            where: {
                journey: { patientId: patient.userId, status: 'ACTIVE' },
                status: 'ACTIVE',
                startedAt: { lt: cutoff },
            },
            include: { tasks: { select: { id: true } } },
        });
        if (!activePhase) continue;

        const taskIds = activePhase.tasks.map((t) => t.id);
        // TaskCompletion.patientId = User.id
        const completions = taskIds.length > 0
            ? await prisma.taskCompletion.findMany({
                where: { taskId: { in: taskIds }, patientId: patient.userId },
                select: { id: true },
            })
            : [];
        const completionPct = taskIds.length > 0
            ? Math.round((completions.length / taskIds.length) * 100)
            : 0;
        if (completionPct < taskCompletionBelow) {
            results.push({
                patient,
                reason: `Phase "${activePhase.name}" has been running for over ${days} days `
                    + `with only ${completionPct}% tasks completed`,
            });
        }
    }
    return results;
}

export async function evalPrescriptionUncollected(branchId, conditionValue) {
    const days = Number(conditionValue?.days) || 0;
    if (days <= 0) return [];
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const patients = await getActiveBranchPatients(branchId);
    const results = [];
    for (const patient of patients) {
        const unfilled = await prisma.prescription.findFirst({
            where: {
                patientId: patient.id,
                createdAt: { lt: cutoff },
                pharmacyDispenses: { none: {} },
            },
            select: { id: true, createdAt: true },
        });
        if (unfilled) {
            const apptDate = new Date(unfilled.createdAt).toLocaleDateString('en-IN');
            results.push({
                patient,
                reason: `Prescription from ${apptDate} has not been collected after ${days} days`,
            });
        }
    }
    return results;
}

// ── Action executor ─────────────────────────────────────────────────────────

/**
 * Run every action in the rule for the matched patient. One action's failure
 * is captured as `{ success: false, error }` and does NOT abort the others.
 *
 * Returns Array<{ type, success, error?, taskId? }> — persisted as-is into
 * `WorkflowRuleLog.actionsTaken`.
 */
export async function executeActions(rule, patient, reason) {
    const branchName = rule.branch?.name || '';
    const patientName = patient.fullName || patient.user?.email || 'Patient';

    // Resolve the assigned doctor lazily — only when an action needs it
    // (CREATE_FOLLOW_UP_TASK, FLAG_FOR_DOCTOR). Cached for this invocation.
    let _resolvedDoctorId; // undefined = not yet looked up
    async function getAssignedDoctor() {
        if (_resolvedDoctorId !== undefined) return _resolvedDoctorId;
        _resolvedDoctorId = await resolveAssignedDoctorId(patient.id);
        return _resolvedDoctorId;
    }
    let _doctorName;
    async function getDoctorName() {
        if (_doctorName != null) return _doctorName;
        const doctorId = await getAssignedDoctor();
        if (!doctorId) { _doctorName = 'your doctor'; return _doctorName; }
        const d = await prisma.doctor.findUnique({
            where: { id: doctorId },
            select: { fullName: true, user: { select: { email: true } } },
        });
        _doctorName = d?.fullName || d?.user?.email || 'your doctor';
        return _doctorName;
    }

    const days = rule?.conditionValue?.days ?? '';
    const baseVars = {
        patientName,
        reason,
        branchName,
        daysCount: days,
    };

    const actionResults = [];

    for (const action of rule.actions || []) {
        try {
            // doctorName is resolved on demand to keep cohort-wide evaluations cheap.
            const vars = { ...baseVars, doctorName: await getDoctorName() };

            switch (action.type) {
                case 'SEND_WHATSAPP': {
                    // Consent gate — audit fix #4.
                    // Block only when the patient has EXPLICITLY opted out
                    // (notificationPreference.whatsappEnabled === false).
                    // Patients without a NotificationPreference row at all
                    // are treated as opted-in (back-compat: pre-feature
                    // patients never had the chance to toggle, and the
                    // existing automation has been sending to them by phone
                    // number fallback). Explicit opt-OUT now wins.
                    const pref = patient.user?.notificationPreference;
                    if (pref && pref.whatsappEnabled === false) {
                        actionResults.push({
                            type: 'SEND_WHATSAPP',
                            success: false,
                            error: 'Patient has opted out of WhatsApp notifications',
                        });
                        break;
                    }
                    const message = interpolateTemplate(action.messageTemplate || '', vars);
                    const prefNumber  = pref?.whatsappNumber;
                    const fallback    = patient.phoneNumber || patient.primaryPhone;
                    const number      = normalisePhone(prefNumber || fallback);
                    if (!number) {
                        actionResults.push({ type: 'SEND_WHATSAPP', success: false, error: 'No WhatsApp number' });
                        break;
                    }
                    const result = await WhatsAppService.sendText(number, message);
                    actionResults.push({
                        type: 'SEND_WHATSAPP',
                        success: result?.status === 'SENT',
                        ...(result?.status !== 'SENT' ? { error: result?.error || result?.status || 'send returned non-SENT' } : {}),
                    });
                    break;
                }

                case 'SEND_IN_APP': {
                    const message = interpolateTemplate(action.messageTemplate || '', vars);
                    if (!patient.userId) {
                        actionResults.push({ type: 'SEND_IN_APP', success: false, error: 'Patient has no userId' });
                        break;
                    }
                    await notificationService.createNotification({
                        userId:    patient.userId,
                        type:      'WORKFLOW_RULE_PATIENT',
                        title:     'Care Team Message',
                        message,
                        priority:  'INFO',
                        relatedId: rule.id,
                        // Notification has no `link` column — deep-link goes in `data`.
                        data: { link: '/patient-portal', ruleId: rule.id, ruleName: rule.name },
                    });
                    actionResults.push({ type: 'SEND_IN_APP', success: true });
                    break;
                }

                case 'CREATE_FOLLOW_UP_TASK': {
                    const title = interpolateTemplate(action.taskTitle || '', vars);
                    const doctorId = await getAssignedDoctor();
                    if (!doctorId) {
                        actionResults.push({ type: 'CREATE_FOLLOW_UP_TASK', success: false, error: 'No assigned doctor' });
                        break;
                    }
                    const result = await createFollowUpTask({
                        doctorId,
                        patientId:   patient.id,
                        title,
                        description: `Auto-generated by workflow rule "${rule.name}". Reason: ${reason}`,
                        priority:    action.priority || 'MEDIUM',
                        dueDays:     Number.isFinite(action.dueDays) ? action.dueDays : 3,
                        triggerType: 'WORKFLOW_RULE',
                        triggerRef:  rule.id,
                    });
                    actionResults.push({
                        type: 'CREATE_FOLLOW_UP_TASK',
                        success: true,
                        taskId: result?.task?.id,
                        alreadyExisted: !!result?.alreadyExisted,
                    });
                    break;
                }

                case 'FLAG_FOR_DOCTOR': {
                    const message = interpolateTemplate(action.message || action.messageTemplate || '', vars);
                    const doctorId = await getAssignedDoctor();
                    if (!doctorId) {
                        actionResults.push({ type: 'FLAG_FOR_DOCTOR', success: false, error: 'No assigned doctor' });
                        break;
                    }
                    const doctor = await prisma.doctor.findUnique({
                        where:  { id: doctorId },
                        select: { userId: true },
                    });
                    if (!doctor?.userId) {
                        actionResults.push({ type: 'FLAG_FOR_DOCTOR', success: false, error: 'Doctor has no userId' });
                        break;
                    }
                    await notificationService.createNotification({
                        userId:    doctor.userId,
                        type:      'WORKFLOW_RULE_DOCTOR_FLAG',
                        title:     `Patient Flag — ${patientName}`,
                        message,
                        priority:  'HIGH',
                        relatedId: rule.id,
                        data: {
                            link: `/patients/${patient.id}/timeline`,
                            ruleId: rule.id,
                            ruleName: rule.name,
                            patientId: patient.id,
                            reason,
                        },
                    });
                    actionResults.push({ type: 'FLAG_FOR_DOCTOR', success: true });
                    break;
                }

                default:
                    actionResults.push({ type: action.type, success: false, error: 'Unknown action type' });
            }
        } catch (actionErr) {
            // Spec rule: one failed action must not stop the others.
            actionResults.push({ type: action?.type || 'UNKNOWN', success: false, error: actionErr.message });
            logger.warn('[WorkflowEngine] action failed', {
                ruleId: rule.id, type: action?.type, err: actionErr.message,
            });
        }
    }

    return actionResults;
}

// ── Engine entrypoint ───────────────────────────────────────────────────────

/**
 * Evaluate every active workflow rule. Skips PHASE_COMPLETED (event-based).
 * Per-rule and per-patient errors are caught — one bad rule never stops the
 * whole sweep.
 *
 * @param {Object} [opts]
 * @param {string} [opts.branchId]  Restrict to a single branch (used by the
 *                                  manual `evaluate-now` admin endpoint).
 * @returns {Promise<{ rulesEvaluated: number, totalFired: number, perRule: Array }>}
 */
export async function evaluateAllRules(opts = {}) {
    const startedAt = Date.now();
    logger.info('[WorkflowEngine] starting rule evaluation', { branchId: opts.branchId || null });

    const where = { isActive: true };
    if (opts.branchId) where.branchId = opts.branchId;

    const activeRules = await prisma.workflowRule.findMany({
        where,
        include: { branch: true },
    });

    const perRule = [];
    let totalFired = 0;

    for (const rule of activeRules) {
        let firedCount = 0;
        try {
            // PHASE_COMPLETED is event-driven — never evaluated by the cron.
            if (rule.triggerType === 'PHASE_COMPLETED') {
                perRule.push({ ruleId: rule.id, name: rule.name, fired: 0, skipped: 'event-based' });
                continue;
            }

            let matches = [];
            switch (rule.triggerType) {
                case 'NO_CHECKIN':
                    matches = await evalNoCheckin(rule.branchId, rule.conditionValue);
                    break;
                case 'PAIN_NOT_IMPROVING':
                    matches = await evalPainNotImproving(rule.branchId, rule.conditionValue);
                    break;
                case 'DIET_ADHERENCE_LOW':
                    matches = await evalDietAdherenceLow(rule.branchId, rule.conditionValue);
                    break;
                case 'PHASE_OVERDUE':
                    matches = await evalPhaseOverdue(rule.branchId, rule.conditionValue);
                    break;
                case 'PRESCRIPTION_UNCOLLECTED':
                    matches = await evalPrescriptionUncollected(rule.branchId, rule.conditionValue);
                    break;
                default:
                    logger.warn('[WorkflowEngine] unknown trigger', { ruleId: rule.id, triggerType: rule.triggerType });
            }

            for (const { patient, reason } of matches) {
                try {
                    // Per-rule cooldown — `(ruleId, patientId)` keyed.
                    if (await isOnCooldown(rule.id, patient.id, rule.cooldownHours)) continue;
                    // Cross-rule family cooldown — prevents two rules sharing
                    // the same triggerType (e.g. two "Low Diet Adherence"
                    // thresholds) from both messaging the same patient on
                    // the same hourly tick. (Audit fix #7.)
                    if (await isInTriggerFamilyCooldown(patient.id, rule.triggerType, rule.branchId)) continue;

                    const actionResults = await executeActions(rule, patient, reason);

                    // Cooldown is a SUCCESS claim — only stamp it if at
                    // least one action actually went out. Previously every
                    // attempt (success or not) burned the cooldown, which
                    // meant one transient WhatsApp API outage muted the
                    // rule for that patient for `cooldownHours`. (Audit fix #2.)
                    const anySuccess = actionResults.some((r) => r && r.success === true);
                    if (anySuccess) {
                        await updateCooldown(rule.id, patient.id);
                    }

                    // Log every attempt — successful AND failed — so admins
                    // can audit "we tried but X failed" via View Logs.
                    await prisma.workflowRuleLog.create({
                        data: {
                            ruleId:       rule.id,
                            patientId:    patient.id,
                            triggeredAt:  new Date(),
                            actionsTaken: actionResults,
                        },
                    });

                    if (anySuccess) {
                        firedCount++;
                        logger.info('[WorkflowEngine] fired', {
                            ruleId: rule.id, ruleName: rule.name,
                            patientId: patient.id, patientName: patient.fullName,
                        });
                    } else {
                        logger.warn('[WorkflowEngine] all actions failed — cooldown NOT stamped, will retry on next sweep', {
                            ruleId: rule.id, patientId: patient.id,
                            results: actionResults,
                        });
                    }
                } catch (perPatientErr) {
                    logger.warn('[WorkflowEngine] per-patient failure', {
                        ruleId: rule.id, patientId: patient?.id, err: perPatientErr.message,
                    });
                }
            }

            await prisma.workflowRule.update({
                where: { id: rule.id },
                data: {
                    lastEvaluatedAt: new Date(),
                    totalFired: { increment: firedCount },
                },
            });
        } catch (ruleErr) {
            // Per-rule catch — one bad rule never stops the sweep.
            logger.error('[WorkflowEngine] rule evaluation failed', {
                ruleId: rule.id, name: rule.name, err: ruleErr.message,
            });
        }
        perRule.push({ ruleId: rule.id, name: rule.name, fired: firedCount });
        totalFired += firedCount;
    }

    const ms = Date.now() - startedAt;
    logger.info('[WorkflowEngine] sweep complete', {
        rules: activeRules.length, totalFired, ms,
    });
    return { rulesEvaluated: activeRules.length, totalFired, perRule, ms };
}

export default {
    VALID_TRIGGER_TYPES,
    VALID_ACTION_TYPES,
    interpolateTemplate,
    validateConditionValue,
    validateActions,
    getActiveBranchPatients,
    isOnCooldown,
    updateCooldown,
    isInTriggerFamilyCooldown,
    evalNoCheckin,
    evalPainNotImproving,
    evalDietAdherenceLow,
    evalPhaseOverdue,
    evalPrescriptionUncollected,
    executeActions,
    evaluateAllRules,
};
