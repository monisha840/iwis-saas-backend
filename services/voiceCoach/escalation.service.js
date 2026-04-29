/**
 * Voice Coach — severity scoring and escalation fan-out.
 *
 * Two responsibilities:
 *   1. `evaluate(transcript)` is a pure function that scores a single user
 *      turn and returns { severity, intent, signal }. Phase B uses regex +
 *      keyword matching; future phases can layer a classifier without
 *      changing the call sites.
 *   2. `notifyAssignedDoctor({...})` runs the side-effect fan-out for
 *      HIGH/CRITICAL turns: writes a Notification row through the existing
 *      notificationService, attaches the action descriptors the frontend
 *      uses to render the doctor's response buttons (see plan §6.5), and
 *      writes an AuditLog row.
 *
 * No CareGap model is involved — see plan §6 for the rationale.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { notificationService } from '../notification.service.js';
import { AuditService } from '../audit.service.js';
import { emitToRole } from '../../websocket/index.js';

// ── Severity classifier ─────────────────────────────────────────────────────

const CRITICAL_PATTERNS = [
    /chest pain/i,
    /can(?:'|no)t breathe/i,
    /short(?:ness)? of breath/i,
    /breathless/i,
    /slurred speech/i,
    /sudden weakness/i,
    /numb(?:ness)? on one side/i,
    /face droop/i,
    /pass(?:ing|ed) out/i,
    /faint(?:ed|ing)?/i,
    /suicid/i,
    /kill (?:my|me)self/i,
    /can(?:'|no)t move/i,
    /vomit(?:ing)? blood/i,
];

const MEDICATION_ABANDONED_PATTERNS = [
    /stopped (?:taking|the)/i,
    /haven(?:'|no)?t taken/i,
    // Match "skipping" / "skip" / "skipped" anywhere within ~40 chars of a
    // medication-y noun, so phrasings like "skipping my evening dose" or
    // "I skip the morning tablets" all trigger.
    /\bskip(?:ping|ped|s)?\b[\s\S]{0,40}\b(?:medicine|medication|medications|herb|herbs|dose|doses|tablet|tablets|pill|pills|kashayam|churnam|triphala)\b/i,
    /not taking (?:my|the) (?:medicine|medication|herb|dose|tablet|pill)/i,
];

const BOOKING_PATTERNS = [
    /(?:talk|speak) to (?:a |the )?doctor/i,
    /(?:book|schedule) (?:an? )?appointment/i,
    /need to see (?:my |a |the )?doctor/i,
];

// Match "pain (was|is|went|got) (...) (8|9|10) (out of 10|/10)?" and similar
// loose phrasings. A standalone number ≥ 8 within 6 words of "pain" is the
// trigger.
function detectHighPainSignal(text) {
    const lower = text.toLowerCase();
    if (!/pain/.test(lower)) return null;
    // numeric on a 0-10 scale
    const match = lower.match(/(\d{1,2})\s*(?:\/\s*10|out of\s*10)?/g);
    if (!match) return null;
    for (const candidate of match) {
        const n = parseInt(candidate, 10);
        if (Number.isFinite(n) && n >= 8 && n <= 10) {
            // crude proximity check — within 30 chars of "pain"
            const idxPain = lower.indexOf('pain');
            const idxNum = lower.indexOf(candidate);
            if (idxNum >= 0 && Math.abs(idxNum - idxPain) <= 30) return n;
        }
    }
    return null;
}

/**
 * Pure function. Score a single user transcript.
 *
 * Returns: { severity, intent, signal }
 *   severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'
 *   intent:   'EMERGENCY' | 'MEDICATION_ABANDONED' | 'SYMPTOM_REPORT' |
 *             'BOOKING_REQUEST' | 'GENERAL'
 *   signal:   short human-readable string (used in the notification body)
 */
export function evaluate(userTranscript) {
    const text = String(userTranscript || '');

    for (const re of CRITICAL_PATTERNS) {
        if (re.test(text)) {
            return {
                severity: 'CRITICAL',
                intent: 'EMERGENCY',
                signal: `Possible emergency phrase detected: "${(text.match(re) || [''])[0]}"`,
            };
        }
    }

    for (const re of MEDICATION_ABANDONED_PATTERNS) {
        if (re.test(text)) {
            return {
                severity: 'HIGH',
                intent: 'MEDICATION_ABANDONED',
                signal: `Patient indicated they have stopped or are skipping medication`,
            };
        }
    }

    const painLevel = detectHighPainSignal(text);
    if (painLevel !== null) {
        return {
            severity: 'HIGH',
            intent: 'SYMPTOM_REPORT',
            signal: `Pain reported at ${painLevel}/10`,
        };
    }

    for (const re of BOOKING_PATTERNS) {
        if (re.test(text)) {
            return {
                severity: 'LOW',
                intent: 'BOOKING_REQUEST',
                signal: `Patient asked about seeing a doctor`,
            };
        }
    }

    return { severity: 'NONE', intent: 'GENERAL', signal: '' };
}

// ── Escalation fan-out ─────────────────────────────────────────────────────

/**
 * Fire a notification to the patient's assigned doctor (or branch fallback).
 * No-op for severities below HIGH.
 *
 * @param {Object} params
 * @param {Object} params.patient        — Patient row with id, userId, fullName, phoneNumber, branchId
 * @param {string} params.conversationId — VoiceConversation.id
 * @param {string} params.severity       — from evaluate()
 * @param {string} params.intent         — from evaluate()
 * @param {string} params.signal         — from evaluate()
 * @param {string} params.userTranscript — last user turn (excerpt is included in payload)
 */
export async function notifyAssignedDoctor({
    patient,
    conversationId,
    severity,
    intent,
    signal,
    userTranscript,
}) {
    if (severity !== 'HIGH' && severity !== 'CRITICAL') return null;

    const recipientUserId = await _resolveRecipient(patient);
    if (!recipientUserId) {
        logger.warn('[VoiceCoachEscalation] no recipient for escalation', {
            patientId: patient.id,
            severity,
            intent,
        });
        return null;
    }

    // Best-effort — escalation must never fail the originating coach turn.
    try {
        const notification = await notificationService.createNotification({
            userId: recipientUserId,
            type: 'VOICE_COACH_ESCALATION',
            title:
                severity === 'CRITICAL'
                    ? `CRITICAL: ${patient.fullName ?? 'Patient'} from voice coach`
                    : `High-priority signal from ${patient.fullName ?? 'patient'}`,
            message: `${patient.fullName ?? 'Patient'} — ${signal}`,
            // NotificationPriority enum is HIGH|MEDIUM|LOW|INFO — no CRITICAL
            // value exists. Both HIGH and CRITICAL severities map to HIGH
            // priority on the notification record; the actual severity is in
            // data.severity for the frontend's EscalationActionPanel to render
            // the right urgency styling.
            priority: 'HIGH',
            relatedId: conversationId,
            data: {
                patientId: patient.id,
                conversationId,
                severity,
                intent,
                signal,
                transcriptExcerpt: String(userTranscript).slice(0, 280),
                actions: [
                    { kind: 'CALL_PATIENT', phone: patient.phoneNumber || null },
                    { kind: 'WHATSAPP_NOTE', conversationId },
                    {
                        kind: 'SCHEDULE_FOLLOWUP',
                        patientId: patient.id,
                        urgent: severity === 'CRITICAL',
                    },
                ],
            },
        });

        // CRITICAL also pings any on-call ADMIN so a single missed doctor
        // notification doesn't strand the patient.
        if (severity === 'CRITICAL') {
            try {
                emitToRole('ADMIN', 'voice_coach.critical', {
                    patientId: patient.id,
                    conversationId,
                    signal,
                });
            } catch (wsErr) {
                logger.warn('[VoiceCoachEscalation] admin emit failed', {
                    error: wsErr.message,
                });
            }
        }

        // Audit trail — never throws (see audit.service.js).
        AuditService.log({
            userId: patient.userId,
            action: 'VOICE_COACH_ESCALATION',
            entityType: 'VoiceConversation',
            entityId: conversationId,
            newData: { severity, intent, signal },
        }).catch(() => {});

        return notification;
    } catch (err) {
        logger.error('[VoiceCoachEscalation] notify failed', err, {
            patientId: patient.id,
            severity,
        });
        return null;
    }
}

/**
 * Resolve the User.id of the doctor the notification should land on.
 *   1. PRIMARY active assignment (preferred)
 *   2. Any ACTIVE assignment (fallback)
 *   3. BRANCH_ADMIN of the patient's branch (last-resort fallback so
 *      escalations don't get lost when the patient has no doctor assigned)
 */
async function _resolveRecipient(patient) {
    if (!patient?.id) return null;

    const assignment = await prisma.patientAssignment.findFirst({
        where: { patientId: patient.id, status: 'ACTIVE' },
        orderBy: [{ type: 'asc' /* PRIMARY < CONSULTING < TEMPORARY */ }, { assignedAt: 'desc' }],
        include: { doctor: { select: { userId: true } } },
    });
    if (assignment?.doctor?.userId) return assignment.doctor.userId;

    if (patient.branchId) {
        const branchAdmin = await prisma.user.findFirst({
            where: { role: 'BRANCH_ADMIN', branchId: patient.branchId, deletedAt: null },
            select: { id: true },
        });
        if (branchAdmin?.id) return branchAdmin.id;
    }

    return null;
}

// ── Static-class wrapper for symmetry with the rest of the module ──────────

export class VoiceCoachEscalationService {
    static evaluate = evaluate;
    static notifyAssignedDoctor = notifyAssignedDoctor;
}

export default VoiceCoachEscalationService;
