import prisma from '../lib/prisma.js';
import path from 'path';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';

// ─── Triage Configuration ────────────────────────────────────────────────────
// Each factor contributes a weighted sub-score to a 0–10 composite triageScore.
// Weights must sum to 1.0.
const TRIAGE_CONFIG = {
    WEIGHTS: {
        painSeverity: 0.50,   // Primary clinical signal — half the total weight
        duration:     0.20,   // Chronic conditions are clinically more serious
        symptomCount: 0.15,   // Multiple concurrent symptoms increase complexity
        historyRisk:  0.15,   // Relevant medical history keywords raise baseline risk
    },

    // Duration buckets → normalised 0–10 sub-score
    DURATION_SCORES: {
        'Less than 24 hours': 2,
        '1-3 days':           4,
        '4-7 days':           5,
        '1-2 weeks':          6,
        '2-4 weeks':          7,
        'More than 1 month':  9,
    },

    // High-risk history keywords — each match adds 1 point (capped at 10)
    HISTORY_RISK_KEYWORDS: [
        'diabetes', 'hypertension', 'heart', 'cancer', 'surgery', 'stroke',
        'kidney', 'liver', 'asthma', 'epilepsy', 'chronic', 'allergy',
    ],

    // Thresholds applied to the composite triageScore (0–10)
    THRESHOLDS: {
        HIGH:   8.0,   // ≥ 8  → Senior Specialist / Escalation
        MEDIUM: 4.5,   // ≥ 4.5 → Specialist
        // < 4.5 → Standard / General Physician
    },

    SEVERITY_LABELS: {
        HIGH:   { label: 'Senior Specialist', severity: 'HIGH',   classification: 'Escalation Required' },
        MEDIUM: { label: 'Specialist',         severity: 'MEDIUM', classification: 'Specialist Required' },
        LOW:    { label: 'Standard',           severity: 'LOW',    classification: 'Standard' },
    },

    // Symptom → specialty lookup (first match used for suggested specialty)
    SPECIALTY_MAP: {
        'Back Pain':      'Orthopedic',       'Joint Pain':   'Orthopedic',
        'Stomach Pain':   'Gastroenterologist','Acid Reflux':  'Gastroenterologist',
        'Skin Rash':      'Dermatologist',     'Acne':         'Dermatologist',
        'Headache':       'Neurologist',       'Dizziness':    'Neurologist',
        'Anxiety':        'Therapist',         'Depression':   'Therapist',
        'Cough':          'General Physician', 'Fever':        'General Physician',
    },
};

// ─── Composite Score Engine ───────────────────────────────────────────────────
/**
 * Computes a weighted 0–10 composite triageScore from four clinical factors.
 * Returns { triageScore, confidenceScore, breakdown, reasoning[] }.
 */
function computeTriageScore({ painSeverity, duration, symptoms = [], medicalHistory = '' }) {
    const w = TRIAGE_CONFIG.WEIGHTS;
    const reasoning = [];

    // 1. Pain Severity (0–10 direct from input)
    const painScore = Math.max(0, Math.min(10, Number(painSeverity)));
    reasoning.push(`Pain severity ${painScore}/10 (weight ${w.painSeverity * 100}%).`);

    // 2. Duration sub-score (0–10 via lookup table)
    const durationScore = TRIAGE_CONFIG.DURATION_SCORES[duration] ?? 3;
    reasoning.push(`Duration "${duration}" maps to sub-score ${durationScore}/10 (weight ${w.duration * 100}%).`);

    // 3. Symptom count sub-score — each additional symptom exponentially increases complexity
    //    Capped at 5 symptoms → 10 points to avoid over-weighting large lists
    const symptomCount = Array.isArray(symptoms) ? symptoms.length : 0;
    const symptomScore = Math.min(10, symptomCount * 2);
    if (symptomCount > 0) {
        reasoning.push(`${symptomCount} symptom(s) reported → sub-score ${symptomScore}/10 (weight ${w.symptomCount * 100}%).`);
    }

    // 4. Medical history risk score — keyword matching (0–10, capped)
    const historyLower = (medicalHistory || '').toLowerCase();
    const matchedKeywords = TRIAGE_CONFIG.HISTORY_RISK_KEYWORDS.filter(kw => historyLower.includes(kw));
    const historyScore = Math.min(10, matchedKeywords.length * 2.5);
    if (matchedKeywords.length > 0) {
        reasoning.push(`Medical history contains risk keywords (${matchedKeywords.join(', ')}) → sub-score ${historyScore}/10 (weight ${w.historyRisk * 100}%).`);
    }

    // 5. Weighted composite
    const triageScore = Number(
        (painScore   * w.painSeverity +
         durationScore * w.duration +
         symptomScore  * w.symptomCount +
         historyScore  * w.historyRisk).toFixed(2)
    );

    // 6. Confidence score — how far the composite is from the nearest threshold border
    //    Perfect confidence = 10 when the score is deep within a tier.
    const thresholds = [TRIAGE_CONFIG.THRESHOLDS.HIGH, TRIAGE_CONFIG.THRESHOLDS.MEDIUM, 0];
    const nearestBorder = thresholds.reduce((min, t) => Math.min(min, Math.abs(triageScore - t)), Infinity);
    const confidenceScore = Math.round(Math.min(100, (nearestBorder / 2) * 100));

    return { triageScore, confidenceScore, breakdown: { painScore, durationScore, symptomScore, historyScore }, reasoning };
}

export class TriageService {
    static async submitTriage(userId, data) {
        const { painArea, painSeverity, duration, symptoms, medicalHistory, medications, documentIds } = data;

        // ── 1. Multi-Factor Composite Scoring Engine ─────────────────────────
        const { triageScore, confidenceScore, breakdown, reasoning } =
            computeTriageScore({ painSeverity, duration, symptoms, medicalHistory });

        // ── 2. Tier Classification from composite score ───────────────────────
        let tierKey;
        if (triageScore >= TRIAGE_CONFIG.THRESHOLDS.HIGH) {
            tierKey = 'HIGH';
            reasoning.push(`Composite score ${triageScore}/10 ≥ ${TRIAGE_CONFIG.THRESHOLDS.HIGH} threshold → Escalation Required.`);
        } else if (triageScore >= TRIAGE_CONFIG.THRESHOLDS.MEDIUM) {
            tierKey = 'MEDIUM';
            reasoning.push(`Composite score ${triageScore}/10 ≥ ${TRIAGE_CONFIG.THRESHOLDS.MEDIUM} threshold → Specialist Required.`);
        } else {
            tierKey = 'LOW';
            reasoning.push(`Composite score ${triageScore}/10 below ${TRIAGE_CONFIG.THRESHOLDS.MEDIUM} threshold → Standard Consultation.`);
        }

        const { label, severity, classification } = TRIAGE_CONFIG.SEVERITY_LABELS[tierKey];

        // ── 3. Specialty Mapping (first symptom match wins) ───────────────────
        let suggestedSpecialty = 'General Physician';
        if (Array.isArray(symptoms)) {
            for (const symptom of symptoms) {
                if (TRIAGE_CONFIG.SPECIALTY_MAP[symptom]) {
                    suggestedSpecialty = TRIAGE_CONFIG.SPECIALTY_MAP[symptom];
                    break;
                }
            }
        }

        const patientRecord = await prisma.patient.findUnique({ where: { userId } });
        if (!patientRecord) throw new Error('Patient profile not found');

        const triageSession = await prisma.triageSession.create({
            data: {
                patientId: patientRecord.id,
                severity,
                suggestedSpecialty,
                isEscalated: tierKey === 'HIGH',
                responses: {
                    ...data,
                    triageScore,
                    confidenceScore,
                    breakdown,
                    classification,
                    reasoning: reasoning.join(' | ')
                }
            }
        });

        logger.info(
            `[Triage Decision] Patient: ${patientRecord.id} | ` +
            `CompositeScore: ${triageScore} (confidence ${confidenceScore}%) | ` +
            `Tier: ${tierKey} | Classification: ${classification}`
        );

        // Notify Admin Doctors if priority is HIGH or Escalated
        if (severity === 'HIGH' || triageSession.isEscalated) {
            // If the patient has no branch, notify ALL admin doctors (branch-less filter
            // with { branchId: null } would return zero results if all admins are branch-assigned).
            const branchFilter = patientRecord.branchId ? { branchId: patientRecord.branchId } : {};
            const adminDoctors = await prisma.user.findMany({
                where: { role: 'ADMIN_DOCTOR', ...branchFilter },
                select: { id: true }
            });

            for (const admin of adminDoctors) {
                await notificationService.createNotification({
                    userId: admin.id,
                    type: 'TRIAGE_ESCALATION',
                    title: '🚨 High Priority Triage Escalation',
                    message: `A new high-severity triage assessment has been submitted by ${patientRecord.fullName || 'a patient'}. Immediate review required.`,
                    priority: 'HIGH',
                    data: { triageSessionId: triageSession.id, patientId: patientRecord.id }
                });
            }
        }

        if (documentIds && documentIds.length > 0) {
            await prisma.document.updateMany({
                where: { id: { in: documentIds } },
                data: { triageSessionId: triageSession.id }
            });
        }

        return {
            ...triageSession,
            classification,
            triageScore,
            confidenceScore,
            breakdown,
            reasoning: reasoning.join(' | ')
        };
    }

    static async uploadDocument(userId, file, data) {
        const patientRecord = await prisma.patient.findUnique({ where: { userId } });
        if (!patientRecord) throw new Error('Patient profile not found');

        const { category, description } = data;

        return prisma.document.create({
            data: {
                patientId: patientRecord.id,
                uploadedBy: userId,
                fileName: file.originalname,
                fileUrl: `/uploads/documents/${file.filename}`,
                fileType: path.extname(file.originalname).substring(1).toUpperCase(),
                fileSize: file.size,
                category: category || 'MEDICAL_RECORD',
                description: description || ''
            }
        });
    }

    static async getMySessions(userId) {
        const patientRecord = await prisma.patient.findUnique({ where: { userId } });
        if (!patientRecord) throw new Error('Patient profile not found');

        return prisma.triageSession.findMany({
            where: { patientId: patientRecord.id },
            orderBy: { createdAt: 'desc' },
            include: { appointment: true }
        });
    }
}
