import prisma from '../lib/prisma.js';
import path from 'path';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';
import { SelfExamService } from './selfExam.service.js';

// ─── Scoring Weights ────────────────────────────────────────────────────────
const WEIGHTS = {
    painIntensity:  0.35,
    regionCount:    0.10,
    duration:       0.20,
    characterFlags: 0.15,
    lifestyleFlags: 0.10,
    medicalHistory: 0.10,
};

// Rank map — used to compare urgency jumps on re-triage
const URGENCY_RANK = { ROUTINE: 1, MODERATE: 2, URGENT: 3, CRITICAL: 4 };

// Duration scoring map
const DURATION_SCORES = {
    'Just started':        3,
    'Hours':               4,
    'Days':                5,
    'Weeks':               6,
    'Months':              7,
    'Over a year':         8,
    // Legacy mappings
    'Less than 24 hours':  3,
    '1-3 days':            5,
    '4-7 days':            5,
    '1-2 weeks':           6,
    '2-4 weeks':           6,
    'More than 1 month':   7,
};
// Coarse bucket for acute-on-chronic detection (derived from DURATION_SCORES)
const ACUTE_THRESHOLD = 5;
const CHRONIC_THRESHOLD = 6;
function isAcuteLabel(label) { return (DURATION_SCORES[label] ?? 5) <= ACUTE_THRESHOLD; }
function isChronicLabel(label) { return (DURATION_SCORES[label] ?? 5) >= CHRONIC_THRESHOLD; }

// Swelling indicates inflammation/oedema — elevated clinical risk in
// Ayurvedic assessment. Treated as the same weight tier as Stabbing/Numbness.
const HIGH_RISK_CHARACTERS = ['Stabbing', 'Numbness', 'Tingling', 'Swelling'];

// Fallback routing (used only when the SpecialtyRoute table is empty or unreachable)
const FALLBACK_SPECIALTY_ROUTING = [
    { specialty: 'Orthopaedic & Joint Care',            tags: ['joint','knee','shoulder','hip','back','neck','left-knee','right-knee','left-shoulder','right-shoulder','left-hip','right-hip','lower-back','upper-back','ankle','wrist','elbow'], priority: 10 },
    { specialty: 'Gastroenterology & Digestive Health', tags: ['abdomen','digestive','bowel','nausea','bloating','stomach','acid','constipation','diarrhoea','stomach pain'], priority: 10 },
    { specialty: 'Respiratory & Pulmonary Care',        tags: ['chest','respiratory','breathing','cough','wheeze','shortness of breath'], priority: 10 },
    { specialty: 'Mind & Wellness',                     tags: ['head','stress','anxiety','sleep','mental','depression','panic','insomnia'], priority: 8 },
    { specialty: 'Dermatology & Skin Care',             tags: ['skin','rash','hair','nail','acne','eczema','psoriasis'], priority: 10 },
    { specialty: "Women's Health",                      tags: ['female','menstrual','pelvic','pregnancy','postpartum','menopause'], priority: 12 },
    { specialty: 'Metabolic & Endocrine Care',          tags: ['metabolic','weight','thyroid','diabetes','hormone'], priority: 10 },
];

const HISTORY_RISK_KEYWORDS = [
    'diabetes', 'hypertension', 'heart', 'cancer', 'surgery', 'stroke',
    'kidney', 'liver', 'asthma', 'epilepsy', 'chronic', 'allergy', 'thyroid',
];
const COMORBIDITY_CONDITIONS = ['Diabetes', 'Hypertension', 'Thyroid', 'Heart disease', 'Asthma'];

// ─── Red-Flag Override Rules ────────────────────────────────────────────────
// Any rule that returns true forces urgencyLevel = CRITICAL, regardless of composite score.
// Each rule has a stable id so we can audit why a session was escalated.
// Keep rule logic defensive — missing inputs must never throw.
const RED_FLAG_RULES = [
    {
        id: 'chest_pain_with_radiation',
        description: 'Chest pain radiating to arm/jaw — possible acute coronary syndrome',
        match: ({ regionIds, allCharacters, radiatesToTargets }) => {
            if (!regionIds.some(r => r.includes('chest'))) return false;
            const radiates = radiatesToTargets.some(t => /arm|jaw|neck|shoulder/i.test(String(t ?? '')));
            const stabbing = allCharacters.some(c => /stabbing/i.test(c));
            const crushing = allCharacters.some(c => /crushing/i.test(c));
            return radiates || (stabbing && crushing);
        },
    },
    {
        id: 'chest_pain_with_breathing',
        description: 'Chest pain with shortness of breath',
        match: ({ regionIds, symptomTokens, lifestyleData }) => {
            const chest = regionIds.some(r => r.includes('chest'));
            const sob = symptomTokens.some(s => /shortness of breath|breath(ing|less)|dyspn/i.test(s))
                        || lifestyleData?.breathingDifficulty === true;
            return chest && sob;
        },
    },
    {
        id: 'sudden_severe_headache',
        description: 'Thunderclap headache — possible subarachnoid hemorrhage',
        match: ({ regionIds, maxPainIntensity, onsetPattern, primaryDuration }) => {
            const head = regionIds.some(r => r === 'head' || r.includes('head'));
            if (!head) return false;
            const suddenSevere = maxPainIntensity >= 8 && (onsetPattern === 'Sudden' || primaryDuration === 'Just started' || primaryDuration === 'Hours');
            return suddenSevere;
        },
    },
    {
        id: 'unilateral_weakness_or_numbness',
        description: 'One-sided weakness or numbness — possible stroke',
        match: ({ regionIds, allCharacters }) => {
            const oneSided = regionIds.some(r => /^left-|^right-/.test(r));
            const neuro = allCharacters.some(c => /numbness|tingling|weakness/i.test(c));
            return oneSided && neuro;
        },
    },
    {
        id: 'pregnancy_bleeding_or_severe_abdominal',
        description: 'Pregnancy with bleeding or severe abdominal pain',
        match: ({ isPregnant, regionIds, symptomTokens, maxPainIntensity }) => {
            if (!isPregnant) return false;
            const bleeding = symptomTokens.some(s => /bleed/i.test(s));
            const severeAbdo = regionIds.some(r => r.includes('abdomen') || r.includes('pelvi')) && maxPainIntensity >= 7;
            return bleeding || severeAbdo;
        },
    },
    {
        id: 'anaphylaxis_signs',
        description: 'Allergic reaction with breathing difficulty or throat swelling',
        match: ({ symptomTokens, lifestyleData }) => {
            const allergic = symptomTokens.some(s => /allergic|allergy|hives|swelling|anaphylaxis/i.test(s));
            const airway = symptomTokens.some(s => /throat|breathing|shortness of breath|dyspn/i.test(s))
                           || lifestyleData?.breathingDifficulty === true;
            return allergic && airway;
        },
    },
    {
        id: 'suicidal_ideation',
        description: 'Self-harm or suicidal ideation reported',
        match: ({ symptomTokens, lifestyleData }) => {
            const flagged = symptomTokens.some(s => /suicid|self[- ]?harm|kill myself/i.test(s));
            return flagged || lifestyleData?.suicidalIdeation === true;
        },
    },
    {
        id: 'vitals_critical',
        description: 'Recorded vitals outside safe range (BP / SpO2 / glucose)',
        match: ({ recentVitals }) => {
            if (!recentVitals) return false;
            if (recentVitals.BP_SYSTOLIC && (recentVitals.BP_SYSTOLIC >= 180 || recentVitals.BP_SYSTOLIC <= 90)) return true;
            if (recentVitals.BP_DIASTOLIC && (recentVitals.BP_DIASTOLIC >= 120 || recentVitals.BP_DIASTOLIC <= 50)) return true;
            if (recentVitals.SPO2 && recentVitals.SPO2 <= 92) return true;
            if (recentVitals.GLUCOSE && (recentVitals.GLUCOSE <= 55 || recentVitals.GLUCOSE >= 400)) return true;
            return false;
        },
    },
];

// ─── Condition × Symptom Interaction Table ──────────────────────────────────
// Flat comorbidity score was too blunt — diabetes+chest pain ≠ thyroid+knee pain.
// Each matched interaction adds a direct boost to the composite score.
const INTERACTION_RULES = [
    { when: { condition: 'Diabetes',       region: /chest/ },                     boost: 2.0, flag: 'interaction_diabetes_chest' },
    { when: { condition: 'Diabetes',       symptom: /numb|tingling|vision/i },    boost: 1.5, flag: 'interaction_diabetes_neuropathy' },
    { when: { condition: 'Hypertension',   region: /chest|head/ },                boost: 2.0, flag: 'interaction_htn_chest_or_head' },
    { when: { condition: 'Heart disease',  region: /chest/ },                     boost: 2.5, flag: 'interaction_cardiac_chest' },
    { when: { condition: 'Heart disease',  symptom: /breathing|shortness|fatigue/i }, boost: 2.0, flag: 'interaction_cardiac_sob' },
    { when: { condition: 'Asthma',         symptom: /breathing|shortness|wheeze|cough/i }, boost: 1.8, flag: 'interaction_asthma_respiratory' },
    { when: { condition: 'Asthma',         region: /chest/ },                     boost: 1.2, flag: 'interaction_asthma_chest' },
    { when: { condition: 'Thyroid',        symptom: /palpitation|weight|fatigue/i }, boost: 1.0, flag: 'interaction_thyroid_metabolic' },
];

// ─── Helpers ────────────────────────────────────────────────────────────────
function normaliseTag(s) {
    return String(s || '').toLowerCase().trim();
}

const DURATION_SCORES_NORMALISED = Object.fromEntries(
    Object.entries(DURATION_SCORES).map(([k, v]) => [k.toLowerCase().trim(), v])
);
function durationOf(label) {
    if (label == null) return 5;
    return DURATION_SCORES[label]
        ?? DURATION_SCORES_NORMALISED[String(label).toLowerCase().trim()]
        ?? 5;
}

/**
 * Pick the *worst* duration across all pain regions (max durationScore), not the first.
 * Also detect acute-on-chronic pattern (one acute + one chronic region = flare).
 */
function resolveDuration(painRegions, fallback) {
    const labels = painRegions.map(r => r.duration).filter(Boolean);
    if (labels.length === 0) return { primaryDuration: fallback || 'Days', durationScore: durationOf(fallback || 'Days'), acuteOnChronic: false };

    let best = labels[0];
    let bestScore = durationOf(best);
    for (const l of labels) {
        const s = durationOf(l);
        if (s > bestScore) { best = l; bestScore = s; }
    }
    const hasAcute = labels.some(isAcuteLabel);
    const hasChronic = labels.some(isChronicLabel);
    return { primaryDuration: best, durationScore: bestScore, acuteOnChronic: hasAcute && hasChronic };
}

function ageOf(patient) {
    // Derive from dob first — patient.age is a denormalised snapshot that goes
    // stale over time (a 25-year-old stored in 2025 is still stored as 25 in 2030).
    // Only fall back to the stored column when dob is missing.
    if (patient?.dob) {
        const diff = Date.now() - new Date(patient.dob).getTime();
        return Math.floor(diff / (365.25 * 24 * 60 * 60 * 1000));
    }
    if (patient?.age) return patient.age;
    return null;
}

function isPregnantFromInputs(patient, existingConditions = [], medicalHistory = '') {
    const conds = [...(existingConditions || [])].map(c => String(c).toLowerCase());
    if (conds.some(c => c.includes('pregnan'))) return true;
    if (/pregnan/i.test(medicalHistory || '')) return true;
    // Respect an explicit patient field if your onboarding captures it
    if (patient?.onboardingData?.pregnant === true) return true;
    return false;
}

/**
 * Pure scoring engine. Input-agnostic; no DB calls.
 * `specialtyRoutes` is injected by the caller (normalised tags, priority-sorted).
 */
// Default toggles — everything on. The caller (submitTriage) overrides these
// based on the patient hospital's FeatureRegistry flags. Tests rely on the
// default-on behaviour, so don't flip these silently.
const DEFAULT_FEATURE_TOGGLES = {
    redFlags:         true,
    interactions:     true,
    ageVitals:        true,
    dbRouting:        true,
    splitConfidence:  true,
};

export function computeTriageScore({
    painRegions = [],
    painSeverity,
    duration,
    symptoms = [],
    medicalHistory = '',
    existingConditions = [],
    lifestyleData = {},
    onsetPattern,
    patient = null,
    recentVitals = null,
    specialtyRoutes = null,
    featureToggles = DEFAULT_FEATURE_TOGGLES,
}) {
    const tog = { ...DEFAULT_FEATURE_TOGGLES, ...featureToggles };
    const flags = [];
    const routes = tog.dbRouting && specialtyRoutes && specialtyRoutes.length > 0
        ? specialtyRoutes
        : FALLBACK_SPECIALTY_ROUTING;

    // 1. Pain intensity
    let maxPainIntensity = 0;
    if (painRegions.length > 0) {
        maxPainIntensity = Math.max(...painRegions.map(r => r.intensity || 0));
    } else if (painSeverity !== undefined) {
        maxPainIntensity = Number(painSeverity);
    }
    maxPainIntensity = Math.max(0, Math.min(10, maxPainIntensity));
    const painScore = maxPainIntensity;

    // 2. Region count
    const regionCount = painRegions.length || (painSeverity ? 1 : 0);
    const regionScore = Math.min(10, regionCount * 2.5);

    // 3. Duration (longest across regions; acute-on-chronic detection)
    const { primaryDuration, durationScore, acuteOnChronic } = resolveDuration(painRegions, duration);
    if (acuteOnChronic) flags.push('acute_on_chronic');

    // 4. Character flags
    let characterScore = 0;
    const allCharacters = painRegions.flatMap(r => r.characters || []);
    const hasHighRisk = allCharacters.some(c => HIGH_RISK_CHARACTERS.includes(c));
    const radiatesToTargets = painRegions
        .map(r => (r.radiatesTo == null ? '' : String(r.radiatesTo)).trim())
        .filter(Boolean);
    const hasRadiation = radiatesToTargets.length > 0;
    if (hasHighRisk) { characterScore += 5; flags.push('high_risk_pain_character'); }
    if (hasRadiation) { characterScore += 5; flags.push('radiation_present'); }
    if (allCharacters.length > 3) characterScore = Math.min(10, characterScore + 2);
    characterScore = Math.min(10, characterScore);

    // 5. Lifestyle
    let lifestyleScore = 0;
    const { stressLevel, sleepQuality, bowelRegularity, appetite } = lifestyleData || {};
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
    let compositeScore = (
        painScore      * WEIGHTS.painIntensity +
        regionScore    * WEIGHTS.regionCount +
        durationScore  * WEIGHTS.duration +
        characterScore * WEIGHTS.characterFlags +
        lifestyleScore * WEIGHTS.lifestyleFlags +
        historyScore   * WEIGHTS.medicalHistory
    );

    // ─── Condition × Symptom interactions (additive boost, capped) ──────────
    const regionIds = painRegions.map(r => normaliseTag(r.regionId)).filter(Boolean);
    const symptomTokens = (symptoms || []).map(normaliseTag);
    const interactionFlags = [];
    let interactionBoost = 0;
    if (tog.interactions) {
        for (const rule of INTERACTION_RULES) {
            const condMatch = matchedConditions.some(c => c.toLowerCase() === rule.when.condition.toLowerCase());
            if (!condMatch) continue;
            const regionMatch = rule.when.region ? regionIds.some(r => rule.when.region.test(r)) : true;
            const symptomMatch = rule.when.symptom ? symptomTokens.some(s => rule.when.symptom.test(s)) : true;
            if (rule.when.region && !regionMatch) continue;
            if (rule.when.symptom && !symptomMatch) continue;
            interactionBoost += rule.boost;
            interactionFlags.push(rule.flag);
        }
        interactionBoost = Math.min(3.0, interactionBoost); // cap at +3 so interactions can't alone push to CRITICAL
        compositeScore += interactionBoost;
        flags.push(...interactionFlags);
    }

    // ─── Age / pregnancy / vitals modifiers ─────────────────────────────────
    const age = ageOf(patient);
    const isPregnant = isPregnantFromInputs(patient, existingConditions, medicalHistory);
    let ageBoost = 0;
    if (tog.ageVitals) {
        if (age !== null) {
            if (age >= 65 && maxPainIntensity >= 5) { ageBoost += 1.0; flags.push('elderly_with_pain'); }
            if (age <= 5 && maxPainIntensity >= 4) { ageBoost += 1.0; flags.push('paediatric_concern'); }
        }
        if (isPregnant) { ageBoost += 0.5; flags.push('pregnancy_context'); }

        let vitalsBoost = 0;
        if (recentVitals) {
            if (recentVitals.BP_SYSTOLIC && recentVitals.BP_SYSTOLIC >= 160 && recentVitals.BP_SYSTOLIC < 180) vitalsBoost += 0.5;
            if (recentVitals.SPO2 && recentVitals.SPO2 <= 95 && recentVitals.SPO2 > 92) vitalsBoost += 0.5;
            if (recentVitals.GLUCOSE && (recentVitals.GLUCOSE < 70 || recentVitals.GLUCOSE > 250)) vitalsBoost += 0.5;
        }
        compositeScore += Math.min(3.0, ageBoost + vitalsBoost);
    }

    compositeScore = Number(Math.max(0, Math.min(10, compositeScore)).toFixed(2));

    // Urgency from composite
    let urgencyLevel;
    if (compositeScore >= 8) urgencyLevel = 'CRITICAL';
    else if (compositeScore >= 6) urgencyLevel = 'URGENT';
    else if (compositeScore >= 4) urgencyLevel = 'MODERATE';
    else urgencyLevel = 'ROUTINE';

    // ─── Red-flag override — forces CRITICAL if any rule fires ─────────────
    const ruleCtx = {
        regionIds,
        allCharacters,
        radiatesToTargets,
        symptomTokens,
        lifestyleData: lifestyleData || {},
        maxPainIntensity,
        onsetPattern,
        primaryDuration,
        isPregnant,
        recentVitals,
    };
    const redFlagsMatched = [];
    if (tog.redFlags) {
        for (const rule of RED_FLAG_RULES) {
            try {
                if (rule.match(ruleCtx)) redFlagsMatched.push(rule.id);
            } catch (e) {
                logger.warn(`[Triage] red-flag rule ${rule.id} threw`, { err: e.message });
            }
        }
    }
    const redFlagForced = redFlagsMatched.length > 0;
    if (redFlagForced) {
        urgencyLevel = 'CRITICAL';
        flags.push('red_flag_forced');
    }

    // ─── Specialty routing (exact-tag match, priority-sorted) ──────────────
    const searchTags = new Set([
        ...regionIds,
        ...painRegions.map(r => normaliseTag(r.regionLabel)).filter(Boolean),
        ...symptomTokens,
        ...allCharacters.map(normaliseTag),
    ]);
    let suggestedSpecialty = 'General Consultation';
    let bestMatchCount = 0;
    let bestPriority = -1;
    const alternativeSpecialties = [];

    // Routes come in sorted by priority DESC upstream, but we don't rely on that — check priority explicitly.
    for (const route of routes) {
        const matchCount = (route.tags || []).filter(tag => searchTags.has(normaliseTag(tag))).length;
        if (matchCount === 0) continue;
        const routePriority = route.priority ?? 0;
        const isBetter = matchCount > bestMatchCount
                      || (matchCount === bestMatchCount && routePriority > bestPriority)
                      || (matchCount === bestMatchCount && routePriority === bestPriority
                          && suggestedSpecialty !== 'General Consultation'
                          && route.specialty.localeCompare(suggestedSpecialty) < 0);
        if (isBetter) {
            if (suggestedSpecialty !== 'General Consultation') alternativeSpecialties.push(suggestedSpecialty);
            suggestedSpecialty = route.specialty;
            bestMatchCount = matchCount;
            bestPriority = routePriority;
        } else {
            alternativeSpecialties.push(route.specialty);
        }
    }

    // ─── Split confidence: input completeness × routing match strength ─────
    const inputSignals = [
        painScore > 0,
        regionCount > 0,
        primaryDuration !== 'Days' || !!duration,
        allCharacters.length > 0,
        Object.keys(lifestyleData || {}).length > 0,
        historyScore > 0,
    ];
    const inputCompleteness = Number((inputSignals.filter(Boolean).length / inputSignals.length).toFixed(2));
    const routingMatchStrength = Number((bestMatchCount > 0 ? Math.min(1, bestMatchCount / 3) : 0).toFixed(2));
    const confidenceScore = Number((inputCompleteness * 0.5 + routingMatchStrength * 0.5).toFixed(2));

    // Recommended appointment type
    let recommendedAppointmentType = 'CONSULTATION';
    if (urgencyLevel === 'CRITICAL') recommendedAppointmentType = 'EMERGENCY';
    else if (urgencyLevel === 'URGENT') recommendedAppointmentType = 'PRIORITY_CONSULTATION';

    // Triage notes
    const notes = [];
    if (redFlagForced) {
        const descs = RED_FLAG_RULES.filter(r => redFlagsMatched.includes(r.id)).map(r => r.description);
        notes.push(`RED FLAG: ${descs.join(' | ')}`);
    }
    if (regionCount > 2) notes.push(`Multi-region involvement (${regionCount} areas) suggests systemic evaluation.`);
    if (hasRadiation) notes.push('Radiation present — evaluate for nerve compression.');
    if (hasHighRisk) notes.push('High-risk pain characteristics reported.');
    if (flags.includes('chronic_pain')) notes.push('Chronic pain pattern detected.');
    if (flags.includes('acute_on_chronic')) notes.push('Acute flare on chronic baseline — possible exacerbation.');
    if (flags.includes('high_stress')) notes.push('Elevated stress levels may be contributing factor.');
    if (interactionFlags.length > 0) notes.push(`Comorbidity interactions detected (${interactionFlags.length}).`);
    if (flags.includes('elderly_with_pain')) notes.push('Age-adjusted urgency (≥65).');
    if (flags.includes('paediatric_concern')) notes.push('Age-adjusted urgency (paediatric).');
    const triageNotes = notes.join(' ') || 'Standard evaluation recommended.';

    const classificationMap = {
        CRITICAL: 'Escalation Required',
        URGENT: 'Escalation Required',
        MODERATE: 'Standard',
        ROUTINE: 'Routine',
    };
    const classification = classificationMap[urgencyLevel] || 'Routine';

    // Human-readable reasoning
    const reasoningParts = [];
    if (redFlagForced) {
        reasoningParts.push('One or more clinical red-flags were detected, which automatically escalates this assessment to CRITICAL regardless of other factors.');
    }
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
    if (interactionFlags.length > 0) {
        reasoningParts.push('Specific condition × symptom interactions have further raised the priority.');
    }
    if (flags.includes('high_stress') || flags.includes('poor_sleep')) {
        reasoningParts.push('Elevated stress or poor sleep quality can amplify symptoms and has been factored in.');
    }
    if (isPregnant) reasoningParts.push('Pregnancy context has been considered.');
    reasoningParts.push(`Based on these factors, we recommend ${suggestedSpecialty} with a composite score of ${compositeScore}/10 (${urgencyLevel.toLowerCase()} priority).`);
    const reasoning = reasoningParts.join(' ');

    return {
        compositeScore,
        urgencyLevel,
        suggestedSpecialty,
        confidenceScore,
        inputCompleteness,
        routingMatchStrength,
        alternativeSpecialties: [...new Set(alternativeSpecialties)].slice(0, 3),
        flags: [...new Set(flags)],
        redFlagsMatched,
        redFlagForced,
        recommendedAppointmentType,
        triageNotes,
        classification,
        reasoning,
        breakdown: {
            painScore, regionScore, durationScore, characterScore, lifestyleScore, historyScore,
            interactionBoost, ageBoost,
        },
    };
}

// ─── Data helpers (DB) ──────────────────────────────────────────────────────
async function loadActiveSpecialtyRoutes() {
    try {
        const rows = await prisma.specialtyRoute.findMany({
            where: { isActive: true },
            orderBy: [{ priority: 'desc' }, { specialty: 'asc' }],
        });
        if (!rows || rows.length === 0) return null;
        return rows.map(r => ({
            specialty: r.specialty,
            tags: (r.tags || []).map(normaliseTag),
            priority: r.priority,
        }));
    } catch (err) {
        logger.warn('[Triage] SpecialtyRoute load failed; falling back to in-code routing', { err: err.message });
        return null;
    }
}

const TRIAGE_FEATURE_KEYS = {
    redFlags:        'TRIAGE_RED_FLAGS',
    interactions:    'TRIAGE_CONDITION_INTERACTIONS',
    ageVitals:       'TRIAGE_AGE_VITALS_CONTEXT',
    dbRouting:       'TRIAGE_DB_ROUTING',
    splitConfidence: 'TRIAGE_SPLIT_CONFIDENCE',
    retriage:        'TRIAGE_RETRIAGE',
    autoHold:        'TRIAGE_AUTO_HOLD_SLOT',
    override:        'TRIAGE_DOCTOR_OVERRIDE',
    overrideStats:   'TRIAGE_OVERRIDE_STATS',
};

/**
 * Resolve Triage v2 feature toggles for a hospital. Falls back to all-on if
 * the registry row isn't present (e.g. test env) — never blocks triage.
 */
async function loadTriageFeatureToggles(hospitalId) {
    const toggles = { ...DEFAULT_FEATURE_TOGGLES, autoHold: true, retriage: true, override: true };
    if (!hospitalId) return toggles;
    try {
        const rows = await prisma.hospitalFeatureFlag.findMany({
            where: {
                hospitalId,
                featureKey: { in: Object.values(TRIAGE_FEATURE_KEYS) },
            },
            include: { feature: { select: { isCore: true } } },
        });
        const byKey = Object.fromEntries(rows.map(r => [r.featureKey, r]));
        for (const [tog, key] of Object.entries(TRIAGE_FEATURE_KEYS)) {
            const row = byKey[key];
            if (!row) continue; // no row → keep default-on (nightly sync fills gaps)
            toggles[tog] = row.feature?.isCore ? true : row.enabled;
        }
    } catch (err) {
        logger.warn('[Triage] feature toggle load failed; using defaults', { err: err.message });
    }
    return toggles;
}

async function loadRecentVitals(userId) {
    if (!userId) return null;
    try {
        const rows = await prisma.patientVital.findMany({
            where: { patientId: userId },
            orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
            take: 30,
        });
        if (!rows || rows.length === 0) return null;
        // Keep only the most recent per type, discard if > 30 days old
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const byType = {};
        for (const v of rows) {
            if (new Date(v.recordedAt).getTime() < cutoff) continue;
            if (!byType[v.type]) byType[v.type] = v.value;
        }
        return byType;
    } catch (err) {
        logger.warn('[Triage] recent vitals load failed', { err: err.message });
        return null;
    }
}

// ─── Auto-hold next priority slot for URGENT/CRITICAL ───────────────────────
// Round-robin across admin doctors in the branch so a single clinician doesn't
// accumulate every priority hold. Tries each in turn; first one with a free slot wins.
async function autoHoldPrioritySlot({ branchId, userId, urgencyLevel }) {
    if (urgencyLevel !== 'URGENT' && urgencyLevel !== 'CRITICAL') return null;
    try {
        const adminDoctorUsers = await prisma.user.findMany({
            where: { role: 'ADMIN_DOCTOR', deletedAt: null, ...(branchId ? { branchId } : {}) },
            select: { id: true },
        });
        if (adminDoctorUsers.length === 0) return null;

        // Pick a starting index based on current time — spreads load across instances
        // without needing a DB counter. Not a perfect round-robin but good enough.
        const startIdx = Math.floor(Date.now() / 1000) % adminDoctorUsers.length;
        const ordered = [
            ...adminDoctorUsers.slice(startIdx),
            ...adminDoctorUsers.slice(0, startIdx),
        ];

        const { AvailabilityService } = await import('./availability.service.js');
        const { AppointmentService } = await import('./appointment.service.js');

        for (const admin of ordered) {
            const doctor = await prisma.doctor.findFirst({
                where: { userId: admin.id },
                select: { id: true },
            });
            if (!doctor) continue;
            const suggestion = await AvailabilityService.findNextAvailableSlot(doctor.id, new Date());
            if (!suggestion) continue;

            const slotTime = suggestion.time || suggestion.startTime;
            const slotDate = suggestion.date ? new Date(suggestion.date) : new Date();
            try {
                await AppointmentService.holdSlot(
                    doctor.id,
                    slotDate.toISOString().slice(0, 10),
                    slotTime,
                    userId,
                );
                return { clinicianId: doctor.id, date: slotDate, time: slotTime };
            } catch (holdErr) {
                // 409 from holdSlot → slot already held by someone else. Try next doctor.
                if (holdErr.status !== 409) throw holdErr;
            }
        }
        return null;
    } catch (err) {
        // Hold is best-effort — never block triage submission on this
        logger.warn('[Triage] auto-hold priority slot failed', { err: err.message });
        return null;
    }
}

// ─── Service ────────────────────────────────────────────────────────────────
export class TriageService {
    static async submitTriage(userId, data) {
        const {
            painArea, painSeverity, duration, symptoms, medicalHistory, medications,
            documentIds, painRegions, chiefComplaint, existingConditions, lifestyleData,
            onsetPattern, allergies, currentMedications,
            isPregnant, recentVitals: triageVitals,
        } = data;

        const patientRecord = await prisma.patient.findUnique({
            where: { userId },
            include: { user: { select: { hospitalId: true } } },
        });
        if (!patientRecord) throw new Error('Patient profile not found');

        const hospitalId = patientRecord.user?.hospitalId ?? null;
        const [specialtyRoutes, storedVitals, featureToggles] = await Promise.all([
            loadActiveSpecialtyRoutes(),
            loadRecentVitals(userId),
            loadTriageFeatureToggles(hospitalId),
        ]);

        // Triage-time vitals take precedence over stored (they're fresher).
        // Any profile-level pregnancy flag can also be overridden by what the patient reports now.
        const mergedVitals = { ...(storedVitals || {}), ...(triageVitals || {}) };
        const patientForScoring = isPregnant === undefined
            ? patientRecord
            : { ...patientRecord, onboardingData: { ...(patientRecord.onboardingData || {}), pregnant: isPregnant } };

        const triageResult = computeTriageScore({
            painRegions: painRegions || [],
            painSeverity,
            duration,
            symptoms,
            medicalHistory,
            existingConditions,
            lifestyleData: lifestyleData || {},
            onsetPattern,
            patient: patientForScoring,
            recentVitals: Object.keys(mergedVitals).length ? mergedVitals : null,
            specialtyRoutes,
            featureToggles,
        });

        const severityMap = { CRITICAL: 'HIGH', URGENT: 'HIGH', MODERATE: 'MEDIUM', ROUTINE: 'LOW' };
        const severity = severityMap[triageResult.urgencyLevel] || 'LOW';

        // Auto-hold priority slot (best-effort) before creating the session.
        // Skipped for tenants where TRIAGE_AUTO_HOLD_SLOT is disabled.
        const held = featureToggles.autoHold
            ? await autoHoldPrioritySlot({
                branchId: patientRecord.branchId,
                userId,
                urgencyLevel: triageResult.urgencyLevel,
            })
            : null;

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
                inputCompleteness: triageResult.inputCompleteness,
                routingMatchStrength: triageResult.routingMatchStrength,
                alternativeSpecialties: triageResult.alternativeSpecialties,
                flags: triageResult.flags,
                redFlagsMatched: triageResult.redFlagsMatched,
                redFlagForced: triageResult.redFlagForced,
                triageNotes: triageResult.triageNotes,
                painRegions: painRegions || null,
                lifestyleData: lifestyleData || null,
                heldSlotClinicianId: held?.clinicianId || null,
                heldSlotDate: held?.date || null,
                heldSlotTime: held?.time || null,
                responses: {
                    painArea, painSeverity, duration, symptoms, medicalHistory,
                    medications, chiefComplaint, existingConditions,
                    onsetPattern, allergies, currentMedications,
                    triageScore: triageResult.compositeScore,
                    confidenceScore: triageResult.confidenceScore,
                    inputCompleteness: triageResult.inputCompleteness,
                    routingMatchStrength: triageResult.routingMatchStrength,
                    classification: triageResult.classification,
                    reasoning: triageResult.reasoning,
                    breakdown: triageResult.breakdown,
                }
            }
        });

        logger.info(
            `[Triage] Patient: ${patientRecord.id} | Score: ${triageResult.compositeScore} | ` +
            `Urgency: ${triageResult.urgencyLevel} | Specialty: ${triageResult.suggestedSpecialty} | ` +
            `RedFlags: ${triageResult.redFlagsMatched.join(',') || 'none'}`
        );

        if (triageResult.urgencyLevel === 'CRITICAL' || triageResult.urgencyLevel === 'URGENT') {
            await TriageService._notifyAdminDoctors(patientRecord, triageSession, triageResult);
        }

        if (documentIds && documentIds.length > 0) {
            await prisma.document.updateMany({
                where: { id: { in: documentIds } },
                data: { triageSessionId: triageSession.id }
            });
        }

        // Persist triage-reported vitals so they flow into wellness trends.
        // Best-effort — if PatientVital schema rejects a type we skip that one, not the whole submit.
        if (triageVitals && Object.keys(triageVitals).length > 0) {
            const unitByType = {
                BP_SYSTOLIC: 'mmHg', BP_DIASTOLIC: 'mmHg',
                SPO2: '%', GLUCOSE: 'mg/dL', HEART_RATE: 'bpm',
            };
            const validTypes = ['BP_SYSTOLIC', 'BP_DIASTOLIC', 'SPO2', 'GLUCOSE']; // HEART_RATE not in VitalType enum
            const rows = Object.entries(triageVitals)
                .filter(([k, v]) => validTypes.includes(k) && typeof v === 'number')
                .map(([type, value]) => ({
                    patientId: userId,
                    type,
                    value,
                    unit: unitByType[type] || '',
                    source: 'triage',
                }));
            if (rows.length > 0) {
                try { await prisma.patientVital.createMany({ data: rows }); }
                catch (err) { logger.warn('[Triage] persist triage vitals failed', { err: err.message }); }
            }
        }

        // IWIS self-examination protocol — create the DRAFT submission so the
        // patient sees a pre-consultation checklist as soon as triage completes.
        // Awaited so the DRAFT exists before the response is returned (prevents
        // a race where the post-triage screen renders before the kit exists).
        // Errors are logged and swallowed — triage submit must not fail from this.
        let selfExamSubmissionId = null;
        try {
            const sub = await SelfExamService.initFromTriage(triageSession.id);
            selfExamSubmissionId = sub?.id ?? null;
        } catch (err) {
            logger.warn('[Triage] self-exam auto-init failed', {
                triageSessionId: triageSession.id,
                err: err.message,
            });
        }

        return {
            ...triageSession,
            ...triageResult,
            heldSlot: held,
            selfExamSubmissionId,
        };
    }

    /**
     * Re-run scoring on an existing session with updated inputs.
     * Tracks urgency jumps so care teams know the patient worsened since the original.
     */
    static async reTriage(sessionId, userId, data) {
        const session = await prisma.triageSession.findUnique({
            where: { id: sessionId },
            include: { patient: true },
        });
        if (!session) {
            const err = new Error('Triage session not found'); err.status = 404; throw err;
        }
        // IDOR: only the owning patient can re-triage
        const patientRecord = await prisma.patient.findUnique({ where: { userId } });
        if (!patientRecord || session.patientId !== patientRecord.id) {
            const err = new Error('Forbidden'); err.status = 403; throw err;
        }

        // Cooldown — prevents re-triage spam that would otherwise re-notify every
        // branch admin-doctor on each submission. 15 minutes is a balance between
        // letting the patient correct honest mistakes and avoiding notification DoS.
        const RETRIAGE_COOLDOWN_MS = 15 * 60 * 1000;
        const lastTouch = session.updatedAt || session.createdAt;
        const msSinceLast = Date.now() - new Date(lastTouch).getTime();
        if ((session.reviewCount || 0) > 0 && msSinceLast < RETRIAGE_COOLDOWN_MS) {
            const wait = Math.ceil((RETRIAGE_COOLDOWN_MS - msSinceLast) / 60000);
            const err = new Error(`Please wait ${wait} more minute(s) before updating this assessment again.`);
            err.status = 429;
            throw err;
        }

        const userRow = await prisma.user.findUnique({ where: { id: userId }, select: { hospitalId: true } });
        const [specialtyRoutes, recentVitals, featureToggles] = await Promise.all([
            loadActiveSpecialtyRoutes(),
            loadRecentVitals(userId),
            loadTriageFeatureToggles(userRow?.hospitalId),
        ]);

        // Merge prior session responses with new inputs so the patient can send partial updates
        const prior = session.responses || {};
        const merged = {
            painRegions: data.painRegions ?? session.painRegions ?? [],
            painSeverity: data.painSeverity ?? prior.painSeverity,
            duration: data.duration ?? prior.duration,
            symptoms: data.symptoms ?? prior.symptoms ?? [],
            medicalHistory: data.medicalHistory ?? prior.medicalHistory ?? '',
            existingConditions: data.existingConditions ?? prior.existingConditions ?? [],
            lifestyleData: { ...(session.lifestyleData || {}), ...(data.lifestyleData || {}) },
            onsetPattern: data.onsetPattern ?? prior.onsetPattern,
        };

        const mergedVitals = { ...(recentVitals || {}), ...(data.recentVitals || {}) };
        const patientForScoring = data.isPregnant === undefined
            ? session.patient
            : { ...session.patient, onboardingData: { ...(session.patient?.onboardingData || {}), pregnant: data.isPregnant } };

        const result = computeTriageScore({
            ...merged,
            patient: patientForScoring,
            recentVitals: Object.keys(mergedVitals).length ? mergedVitals : null,
            specialtyRoutes,
            featureToggles,
        });

        const previousRank = URGENCY_RANK[session.urgencyLevel] || 1;
        const newRank = URGENCY_RANK[result.urgencyLevel] || 1;
        const escalated = newRank > previousRank;
        const deEscalated = newRank < previousRank;

        const severityMap = { CRITICAL: 'HIGH', URGENT: 'HIGH', MODERATE: 'MEDIUM', ROUTINE: 'LOW' };

        const updated = await prisma.triageSession.update({
            where: { id: sessionId },
            data: {
                reviewCount: { increment: 1 },
                previousScore: session.compositeScore,
                previousUrgencyLevel: session.urgencyLevel,
                escalatedAfterUpdate: escalated,
                deEscalatedAfterUpdate: deEscalated,
                compositeScore: result.compositeScore,
                urgencyLevel: result.urgencyLevel,
                severity: severityMap[result.urgencyLevel] || 'LOW',
                suggestedSpecialty: result.suggestedSpecialty,
                confidenceScore: result.confidenceScore,
                inputCompleteness: result.inputCompleteness,
                routingMatchStrength: result.routingMatchStrength,
                alternativeSpecialties: result.alternativeSpecialties,
                flags: result.flags,
                redFlagsMatched: result.redFlagsMatched,
                redFlagForced: result.redFlagForced,
                triageNotes: result.triageNotes,
                isEscalated: result.urgencyLevel === 'CRITICAL' || result.urgencyLevel === 'URGENT',
                painRegions: merged.painRegions,
                lifestyleData: merged.lifestyleData,
                responses: {
                    ...prior,
                    ...merged,
                    triageScore: result.compositeScore,
                    confidenceScore: result.confidenceScore,
                    inputCompleteness: result.inputCompleteness,
                    routingMatchStrength: result.routingMatchStrength,
                    classification: result.classification,
                    reasoning: result.reasoning,
                    breakdown: result.breakdown,
                    retriagedAt: new Date().toISOString(),
                },
            }
        });

        if (escalated) {
            logger.warn(`[Triage] Re-triage ESCALATED session ${sessionId}: ${session.urgencyLevel} → ${result.urgencyLevel}`);
            await TriageService._notifyAdminDoctors(session.patient, updated, result, { reTriaged: true });
        }

        // Self-exam kit: only URGENT/CRITICAL trigger creation. If the original
        // triage didn't qualify but the re-triage escalated into that band, we
        // still want the kit to appear. initFromTriage is idempotent on
        // triageSessionId, so this is safe to call even when a kit already exists.
        await SelfExamService.initFromTriage(sessionId).catch((err) => {
            logger.warn('[Triage] self-exam init on re-triage failed', {
                sessionId, err: err.message,
            });
        });

        return { ...updated, ...result, escalatedAfterUpdate: escalated, deEscalatedAfterUpdate: deEscalated };
    }

    /**
     * Clinician review / override. Captures disagreement per factor so weights
     * can be tuned from real data (feedback loop).
     */
    static async doctorReview(sessionId, reviewerUser, payload) {
        if (!['DOCTOR', 'ADMIN_DOCTOR'].includes(reviewerUser.role)) {
            const err = new Error('Only clinicians can review triage'); err.status = 403; throw err;
        }
        const session = await prisma.triageSession.findUnique({ where: { id: sessionId } });
        if (!session) { const err = new Error('Triage session not found'); err.status = 404; throw err; }

        const { overriddenUrgencyLevel, overriddenSpecialty, reason, factorDisagreement } = payload;
        const validUrgency = ['ROUTINE', 'MODERATE', 'URGENT', 'CRITICAL'];
        if (overriddenUrgencyLevel && !validUrgency.includes(overriddenUrgencyLevel)) {
            const err = new Error('Invalid urgencyLevel override'); err.status = 400; throw err;
        }

        const [updated, _override] = await prisma.$transaction([
            prisma.triageSession.update({
                where: { id: sessionId },
                data: {
                    reviewedByUserId: reviewerUser.id,
                    reviewedAt: new Date(),
                    overriddenUrgencyLevel: overriddenUrgencyLevel ?? null,
                    overriddenSpecialty: overriddenSpecialty ?? null,
                    overrideReason: reason ?? null,
                }
            }),
            prisma.triageOverride.create({
                data: {
                    triageSessionId: sessionId,
                    reviewerUserId: reviewerUser.id,
                    originalUrgencyLevel: session.urgencyLevel,
                    overriddenUrgencyLevel: overriddenUrgencyLevel ?? null,
                    originalSpecialty: session.suggestedSpecialty,
                    overriddenSpecialty: overriddenSpecialty ?? null,
                    reason: reason ?? null,
                    factorDisagreement: factorDisagreement ?? null,
                }
            }),
        ]);
        return updated;
    }

    /**
     * Disagreement-rate aggregate across overrides — drives weight-tuning decisions.
     * Returns per-urgency and per-factor breakdowns for the last `days` window.
     */
    static async getOverrideStats({ days = 30 } = {}) {
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const rows = await prisma.triageOverride.findMany({
            where: { createdAt: { gte: since } },
            select: {
                originalUrgencyLevel: true,
                overriddenUrgencyLevel: true,
                originalSpecialty: true,
                overriddenSpecialty: true,
                factorDisagreement: true,
            },
        });
        const urgencyMismatches = {};
        const specialtyMismatches = {};
        const factorCounts = {};
        for (const r of rows) {
            if (r.overriddenUrgencyLevel && r.overriddenUrgencyLevel !== r.originalUrgencyLevel) {
                const key = `${r.originalUrgencyLevel || 'unknown'}→${r.overriddenUrgencyLevel}`;
                urgencyMismatches[key] = (urgencyMismatches[key] || 0) + 1;
            }
            if (r.overriddenSpecialty && r.overriddenSpecialty !== r.originalSpecialty) {
                const key = `${r.originalSpecialty || 'unknown'}→${r.overriddenSpecialty}`;
                specialtyMismatches[key] = (specialtyMismatches[key] || 0) + 1;
            }
            if (r.factorDisagreement && typeof r.factorDisagreement === 'object') {
                for (const [factor, val] of Object.entries(r.factorDisagreement)) {
                    factorCounts[factor] = (factorCounts[factor] || 0) + (val ? 1 : 0);
                }
            }
        }
        return {
            windowDays: days,
            totalOverrides: rows.length,
            urgencyMismatches,
            specialtyMismatches,
            factorDisagreement: factorCounts,
        };
    }

    // ── Specialty route admin surface ──────────────────────────────────────
    static async listSpecialtyRoutes() {
        return prisma.specialtyRoute.findMany({ orderBy: [{ priority: 'desc' }, { specialty: 'asc' }] });
    }

    static async upsertSpecialtyRoute(data) {
        const { specialty, tags, priority, isActive } = data;
        const normalisedTags = (tags || []).map(normaliseTag).filter(Boolean);
        return prisma.specialtyRoute.upsert({
            where: { specialty },
            update: {
                tags: normalisedTags,
                priority: priority ?? 0,
                isActive: isActive ?? true,
            },
            create: {
                specialty,
                tags: normalisedTags,
                priority: priority ?? 0,
                isActive: isActive ?? true,
            },
        });
    }

    static async deleteSpecialtyRoute(id) {
        return prisma.specialtyRoute.delete({ where: { id } });
    }

    // ── Upload / read helpers (unchanged public API) ───────────────────────
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
            include: { patient: true, documents: true, appointment: true, overrides: true }
        });

        if (!session) { const error = new Error('Triage session not found'); error.status = 404; throw error; }

        if (userRole === 'PATIENT') {
            const patientRecord = await prisma.patient.findUnique({ where: { userId } });
            if (!patientRecord || session.patientId !== patientRecord.id) {
                const error = new Error('Forbidden'); error.status = 403; throw error;
            }
        }
        return session;
    }

    // ── internal ───────────────────────────────────────────────────────────
    static async _notifyAdminDoctors(patientRecord, triageSession, triageResult, opts = {}) {
        const branchFilter = patientRecord.branchId ? { branchId: patientRecord.branchId } : {};
        const adminDoctors = await prisma.user.findMany({
            where: { role: 'ADMIN_DOCTOR', deletedAt: null, ...branchFilter },
            select: { id: true }
        });
        const prefix = opts.reTriaged ? 'Re-triage escalation' : 'High Priority Triage Escalation';
        await Promise.all(adminDoctors.map(admin => notificationService.createNotification({
            userId: admin.id,
            type: 'TRIAGE_ESCALATION',
            title: prefix,
            message: `A ${triageResult.urgencyLevel} triage assessment from ${patientRecord.fullName || 'a patient'}. Score: ${triageResult.compositeScore}/10. Specialty: ${triageResult.suggestedSpecialty}.${triageResult.redFlagForced ? ' [RED FLAG]' : ''}`,
            priority: 'HIGH',
            data: {
                triageSessionId: triageSession.id,
                patientId: patientRecord.id,
                redFlagsMatched: triageResult.redFlagsMatched,
                reTriaged: !!opts.reTriaged,
            }
        })));
    }
}
