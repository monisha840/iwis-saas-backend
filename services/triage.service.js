import prisma from '../lib/prisma.js';
import path from 'path';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';

// ─── Scoring Weights ────────────────────────────────────────────────────────
const WEIGHTS = {
    painIntensity:  0.35,    // max pain score across all regions (0-10)
    regionCount:    0.10,    // number of affected regions
    duration:       0.20,    // longer = higher urgency
    characterFlags: 0.15,   // stabbing/numbness/radiation = higher
    lifestyleFlags: 0.10,   // high stress + poor sleep = higher
    medicalHistory: 0.10,   // comorbidities = higher
};

// Duration scoring map
const DURATION_SCORES = {
    'Just started':   3,
    'Hours':          4,
    'Days':           5,
    'Weeks':          6,
    'Months':         7,
    'Over a year':    8,
    // Legacy mappings
    'Less than 24 hours': 3,
    '1-3 days':       5,
    '4-7 days':       5,
    '1-2 weeks':      6,
    '2-4 weeks':      6,
    'More than 1 month': 7,
};

// High-risk pain character flags
const HIGH_RISK_CHARACTERS = ['Stabbing', 'Numbness', 'Tingling'];

// Specialty routing (tag-based)
const SPECIALTY_ROUTING = [
    { tags: ['joint', 'knee', 'shoulder', 'hip', 'back', 'neck', 'left-knee', 'right-knee', 'left-shoulder', 'right-shoulder', 'left-hip', 'right-hip', 'lower-back'], specialty: 'Orthopaedic & Joint Care' },
    { tags: ['abdomen', 'digestive', 'bowel', 'nausea', 'bloating', 'stomach', 'acid'], specialty: 'Gastroenterology & Digestive Health' },
    { tags: ['chest', 'respiratory', 'breathing', 'cough'], specialty: 'Respiratory & Pulmonary Care' },
    { tags: ['head', 'stress', 'anxiety', 'sleep', 'mental', 'depression'], specialty: 'Mind & Wellness' },
    { tags: ['skin', 'rash', 'hair', 'nail', 'acne'], specialty: 'Dermatology & Skin Care' },
    { tags: ['female', 'menstrual', 'pelvic'], specialty: "Women's Health" },
    { tags: ['metabolic', 'weight', 'thyroid', 'diabetes'], specialty: 'Metabolic & Endocrine Care' },
];

// Medical history risk keywords
const HISTORY_RISK_KEYWORDS = [
    'diabetes', 'hypertension', 'heart', 'cancer', 'surgery', 'stroke',
    'kidney', 'liver', 'asthma', 'epilepsy', 'chronic', 'allergy', 'thyroid',
];

// Comorbidity conditions
const COMORBIDITY_CONDITIONS = ['Diabetes', 'Hypertension', 'Thyroid', 'Heart disease', 'Asthma'];

/**
 * Weighted composite scoring engine for triage.
 * Returns compositeScore (0-10), urgencyLevel, suggestedSpecialty, etc.
 */
function computeTriageScore({
    painRegions = [],
    painSeverity,
    duration,
    symptoms = [],
    medicalHistory = '',
    existingConditions = [],
    lifestyleData = {},
}) {
    const flags = [];

    // 1. Pain intensity — max pain across all body map regions, or direct painSeverity
    let maxPainIntensity = 0;
    if (painRegions.length > 0) {
        maxPainIntensity = Math.max(...painRegions.map(r => r.intensity || 0));
    } else if (painSeverity !== undefined) {
        maxPainIntensity = Number(painSeverity);
    }
    maxPainIntensity = Math.max(0, Math.min(10, maxPainIntensity));
    const painScore = maxPainIntensity;

    // 2. Region count score (normalized to 0-10)
    const regionCount = painRegions.length || (painSeverity ? 1 : 0);
    const regionScore = Math.min(10, regionCount * 2.5);

    // 3. Duration score
    const primaryDuration = painRegions[0]?.duration || duration || 'Days';
    const durationScore = DURATION_SCORES[primaryDuration] ?? 5;

    // 4. Character flags
    let characterScore = 0;
    const allCharacters = painRegions.flatMap(r => r.characters || []);
    const hasHighRisk = allCharacters.some(c => HIGH_RISK_CHARACTERS.includes(c));
    const hasRadiation = painRegions.some(r => r.radiatesTo);
    if (hasHighRisk) { characterScore += 5; flags.push('high_risk_pain_character'); }
    if (hasRadiation) { characterScore += 5; flags.push('radiation_present'); }
    if (allCharacters.length > 3) characterScore = Math.min(10, characterScore + 2);
    characterScore = Math.min(10, characterScore);

    // 5. Lifestyle flags
    let lifestyleScore = 0;
    const { stressLevel, sleepQuality, bowelRegularity, appetite } = lifestyleData;
    if (stressLevel && stressLevel >= 7) { lifestyleScore += 4; flags.push('high_stress'); }
    if (sleepQuality && sleepQuality <= 2) { lifestyleScore += 3; flags.push('poor_sleep'); }
    if (bowelRegularity === 'Constipated') lifestyleScore += 2;
    if (appetite === 'Reduced') lifestyleScore += 1;
    lifestyleScore = Math.min(10, lifestyleScore);

    // 6. Medical history
    let historyScore = 0;
    const historyLower = (medicalHistory || '').toLowerCase();
    const matchedKeywords = HISTORY_RISK_KEYWORDS.filter(kw => historyLower.includes(kw));
    historyScore += matchedKeywords.length * 2;
    const matchedConditions = (existingConditions || []).filter(c => COMORBIDITY_CONDITIONS.includes(c));
    historyScore += matchedConditions.length * 2;
    historyScore = Math.min(10, historyScore);
    if (matchedConditions.length > 0) flags.push('comorbidities');
    if (maxPainIntensity >= 6 && durationScore >= 6) flags.push('chronic_pain');

    // Weighted composite (0-10)
    const compositeScore = Number((
        painScore      * WEIGHTS.painIntensity +
        regionScore    * WEIGHTS.regionCount +
        durationScore  * WEIGHTS.duration +
        characterScore * WEIGHTS.characterFlags +
        lifestyleScore * WEIGHTS.lifestyleFlags +
        historyScore   * WEIGHTS.medicalHistory
    ).toFixed(2));

    // Urgency level
    let urgencyLevel;
    if (compositeScore >= 8) urgencyLevel = 'CRITICAL';
    else if (compositeScore >= 6) urgencyLevel = 'URGENT';
    else if (compositeScore >= 4) urgencyLevel = 'MODERATE';
    else urgencyLevel = 'ROUTINE';

    // Specialty routing (tag-based matching)
    const searchTags = [
        ...painRegions.map(r => r.regionId?.toLowerCase()),
        ...painRegions.map(r => r.regionLabel?.toLowerCase()),
        ...(symptoms || []).map(s => s.toLowerCase()),
        ...(allCharacters).map(c => c.toLowerCase()),
    ].filter(Boolean);

    let suggestedSpecialty = 'General Consultation';
    let bestMatchCount = 0;
    const alternativeSpecialties = [];

    for (const route of SPECIALTY_ROUTING) {
        const matchCount = route.tags.filter(tag =>
            searchTags.some(st => st.includes(tag) || tag.includes(st))
        ).length;
        if (matchCount > bestMatchCount) {
            if (suggestedSpecialty !== 'General Consultation') {
                alternativeSpecialties.push(suggestedSpecialty);
            }
            bestMatchCount = matchCount;
            suggestedSpecialty = route.specialty;
        } else if (matchCount > 0 && matchCount === bestMatchCount) {
            alternativeSpecialties.push(route.specialty);
        }
    }

    // Confidence score (0-1)
    const totalInputs = [painScore > 0, regionCount > 0, primaryDuration !== 'Days', allCharacters.length > 0, Object.keys(lifestyleData).length > 0, historyScore > 0].filter(Boolean).length;
    const inputCompleteness = totalInputs / 6;
    const tagMatchStrength = bestMatchCount > 0 ? Math.min(1, bestMatchCount / 3) : 0.3;
    const confidenceScore = Number((inputCompleteness * 0.5 + tagMatchStrength * 0.5).toFixed(2));

    // Recommended appointment type
    let recommendedAppointmentType = 'CONSULTATION';
    if (urgencyLevel === 'CRITICAL') recommendedAppointmentType = 'EMERGENCY';
    else if (urgencyLevel === 'URGENT') recommendedAppointmentType = 'PRIORITY_CONSULTATION';

    // Triage notes
    const notes = [];
    if (regionCount > 2) notes.push(`Multi-region involvement (${regionCount} areas) suggests systemic evaluation.`);
    if (hasRadiation) notes.push('Radiation present — evaluate for nerve compression.');
    if (hasHighRisk) notes.push('High-risk pain characteristics reported.');
    if (flags.includes('chronic_pain')) notes.push('Chronic pain pattern detected.');
    if (flags.includes('high_stress')) notes.push('Elevated stress levels may be contributing factor.');
    const triageNotes = notes.join(' ') || 'Standard evaluation recommended.';

    // Human-readable classification label
    const classificationMap = {
        CRITICAL: 'Escalation Required',
        URGENT: 'Escalation Required',
        MODERATE: 'Standard',
        ROUTINE: 'Routine',
    };
    const classification = classificationMap[urgencyLevel] || 'Routine';

    // Assessment reasoning — synthesize a human-readable explanation from the scoring
    const reasoningParts = [];

    if (painScore >= 7) {
        reasoningParts.push(`Your reported pain intensity (${painScore}/10) indicates a significant level of discomfort requiring prompt attention.`);
    } else if (painScore >= 4) {
        reasoningParts.push(`Your pain intensity (${painScore}/10) suggests moderate discomfort that warrants clinical evaluation.`);
    } else if (painScore > 0) {
        reasoningParts.push(`Your pain intensity (${painScore}/10) is within a manageable range.`);
    }

    if (regionCount > 1) {
        reasoningParts.push(`Pain across ${regionCount} body regions suggests a broader evaluation may be needed.`);
    }

    if (durationScore >= 7) {
        reasoningParts.push(`The prolonged duration of your symptoms (${primaryDuration.toLowerCase()}) is a key factor in the assessment.`);
    } else if (durationScore >= 5) {
        reasoningParts.push(`The duration of your symptoms (${primaryDuration.toLowerCase()}) has been factored into the assessment.`);
    }

    if (hasHighRisk) {
        reasoningParts.push('Certain pain characteristics you reported (such as stabbing, numbness, or tingling) raise the clinical priority.');
    }
    if (hasRadiation) {
        reasoningParts.push('The fact that your pain radiates to other areas warrants nerve-related evaluation.');
    }
    if (matchedConditions.length > 0) {
        reasoningParts.push(`Your existing conditions (${matchedConditions.join(', ')}) have been considered as they may influence treatment.`);
    }
    if (flags.includes('high_stress') || flags.includes('poor_sleep')) {
        reasoningParts.push('Elevated stress or poor sleep quality can amplify symptoms and has been factored in.');
    }

    reasoningParts.push(`Based on these factors, we recommend ${suggestedSpecialty} with a composite score of ${compositeScore}/10 (${urgencyLevel.toLowerCase()} priority).`);

    const reasoning = reasoningParts.join(' ');

    return {
        compositeScore,
        urgencyLevel,
        suggestedSpecialty,
        confidenceScore,
        alternativeSpecialties: [...new Set(alternativeSpecialties)].slice(0, 3),
        flags,
        recommendedAppointmentType,
        triageNotes,
        classification,
        reasoning,
        breakdown: { painScore, regionScore, durationScore, characterScore, lifestyleScore, historyScore },
    };
}

export class TriageService {
    static async submitTriage(userId, data) {
        const {
            painArea, painSeverity, duration, symptoms, medicalHistory, medications,
            documentIds, painRegions, chiefComplaint, existingConditions, lifestyleData,
            onsetPattern, allergies, currentMedications,
        } = data;

        const triageResult = computeTriageScore({
            painRegions: painRegions || [],
            painSeverity,
            duration,
            symptoms,
            medicalHistory,
            existingConditions,
            lifestyleData: lifestyleData || {},
        });

        const patientRecord = await prisma.patient.findUnique({ where: { userId } });
        if (!patientRecord) throw new Error('Patient profile not found');

        // Map urgency to severity for backward compatibility
        const severityMap = { CRITICAL: 'HIGH', URGENT: 'HIGH', MODERATE: 'MEDIUM', ROUTINE: 'LOW' };
        const severity = severityMap[triageResult.urgencyLevel] || 'LOW';

        const triageSession = await prisma.triageSession.create({
            data: {
                patientId: patientRecord.id,
                branchId: patientRecord.branchId,
                severity,
                suggestedSpecialty: triageResult.suggestedSpecialty,
                isEscalated: triageResult.urgencyLevel === 'CRITICAL' || triageResult.urgencyLevel === 'URGENT',
                compositeScore: triageResult.compositeScore,
                urgencyLevel: triageResult.urgencyLevel,
                confidenceScore: triageResult.confidenceScore,
                alternativeSpecialties: triageResult.alternativeSpecialties,
                flags: triageResult.flags,
                triageNotes: triageResult.triageNotes,
                painRegions: painRegions || null,
                lifestyleData: lifestyleData || null,
                responses: {
                    painArea, painSeverity, duration, symptoms, medicalHistory,
                    medications, chiefComplaint, existingConditions,
                    onsetPattern, allergies, currentMedications,
                    triageScore: triageResult.compositeScore,
                    confidenceScore: triageResult.confidenceScore,
                    classification: triageResult.classification,
                    reasoning: triageResult.reasoning,
                    breakdown: triageResult.breakdown,
                }
            }
        });

        logger.info(
            `[Triage] Patient: ${patientRecord.id} | Score: ${triageResult.compositeScore} | ` +
            `Urgency: ${triageResult.urgencyLevel} | Specialty: ${triageResult.suggestedSpecialty}`
        );

        // Notify Admin Doctors for URGENT/CRITICAL
        if (triageResult.urgencyLevel === 'CRITICAL' || triageResult.urgencyLevel === 'URGENT') {
            const branchFilter = patientRecord.branchId ? { branchId: patientRecord.branchId } : {};
            const adminDoctors = await prisma.user.findMany({
                where: { role: 'ADMIN_DOCTOR', ...branchFilter },
                select: { id: true }
            });

            for (const admin of adminDoctors) {
                await notificationService.createNotification({
                    userId: admin.id,
                    type: 'TRIAGE_ESCALATION',
                    title: 'High Priority Triage Escalation',
                    message: `A ${triageResult.urgencyLevel} triage assessment from ${patientRecord.fullName || 'a patient'}. Score: ${triageResult.compositeScore}/10. Specialty: ${triageResult.suggestedSpecialty}.`,
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
            ...triageResult,
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

    static async getSessionById(sessionId, userId, userRole) {
        const session = await prisma.triageSession.findUnique({
            where: { id: sessionId },
            include: { patient: true, documents: true, appointment: true }
        });

        if (!session) {
            const error = new Error('Triage session not found');
            error.status = 404;
            throw error;
        }

        // IDOR protection: patients can only view their own sessions
        if (userRole === 'PATIENT') {
            const patientRecord = await prisma.patient.findUnique({ where: { userId } });
            if (!patientRecord || session.patientId !== patientRecord.id) {
                const error = new Error('Forbidden');
                error.status = 403;
                throw error;
            }
        }

        return session;
    }
}

// Export for testing
export { computeTriageScore };
