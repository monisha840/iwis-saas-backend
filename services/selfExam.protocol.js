// Zone → required-exam mapping for the patient self-examination kit.
// Sourced from the IWIS pre-consultation spec. Each protocol item maps
// directly to a SelfExamSubmission child table (or ConstitutionProfile
// for patient-level quizzes).
//
// Kept as plain data so it can be JSON-serialised straight to the frontend
// checklist renderer without extra transforms.

// Which RoM joints + directions apply per zone.
const ROM_SETS = {
    NECK: {
        joints: ['NECK'],
        directions: [
            'NECK_ROTATE_LEFT',
            'NECK_ROTATE_RIGHT',
            'NECK_FLEX',
            'NECK_EXTEND',
            'NECK_LATERAL_LEFT',
            'NECK_LATERAL_RIGHT',
        ],
    },
    SHOULDER: {
        joints: ['SHOULDER_LEFT', 'SHOULDER_RIGHT'],
        directions: [
            'SHOULDER_FLEX_OVERHEAD',
            'SHOULDER_ABDUCT',
            'SHOULDER_CROSS_BODY',
            'SHOULDER_BEHIND_BACK',
            'SHOULDER_EXTERNAL_ROT',
            'SHOULDER_INTERNAL_ROT',
        ],
    },
    KNEE: {
        joints: ['KNEE_LEFT', 'KNEE_RIGHT'],
        directions: ['KNEE_FLEX', 'KNEE_EXTEND'],
    },
};

// Each entry is a checklist — the renderer shows one card per item.
// `critical: true` flags the single exam the patient must not skip (per spec).
//
// Admin / admin-doctor can override any of these per hospital via the
// `SelfExamProtocolOverride` table. Defaults stay the source of truth — an
// override row shadows the default only for the (hospitalId, painZone) pair
// it specifies. Use `loadProtocolsForHospital(hospitalId)` to resolve the
// effective protocol at runtime.
export const DEFAULT_ZONE_PROTOCOLS = {
    HEAD_MIGRAINE: {
        symptomHistory: { critical: true },
        tongue: { days: 3 },
        physicalObservations: ['FACE_EYE'],
        constitutionQuiz: true,
    },
    NECK: {
        symptomHistory: { critical: true },
        rom: ROM_SETS.NECK,
        physicalObservations: ['POSTURE_FULL_BODY'],
        lifestyle: true,
    },
    SHOULDER: {
        symptomHistory: { critical: true },
        rom: ROM_SETS.SHOULDER,
        physicalObservations: ['SHOULDER_SYMMETRY'],
        digestive: true,
        lifestyle: true,
    },
    CHEST: {
        symptomHistory: { critical: true, urgentCareWarning: true },
        stool: { days: 3 },
        urine: { days: 3 },
        physicalObservations: ['GENERAL_APPEARANCE'],
    },
    LOWER_BACK: {
        symptomHistory: true,
        stool: { days: 3, critical: true },
        urine: { days: 3 },
        physicalObservations: ['POSTURE_FULL_BODY'],
        digestive: true,
    },
    ABDOMEN: {
        symptomHistory: true,
        stool: { days: 3, critical: true },
        tongue: { days: 3 },
        digestive: true,
    },
    KNEE: {
        symptomHistory: true,
        tongue: { days: 3, critical: true },
        urine: { days: 3 },
        rom: ROM_SETS.KNEE,
        physicalObservations: ['KNEE_COMPARE'],
        stool: { days: 3 },
        digestive: true,
    },
    WRIST_HAND: {
        symptomHistory: true,
        tongue: { days: 3, critical: true },
        stool: { days: 3 },
        physicalObservations: ['HAND_FLAT'],
        digestive: true,
    },
    GENERALISED_MUSCLE: {
        symptomHistory: { critical: true },
        tongue: { days: 3 },
        physicalObservations: ['GENERAL_APPEARANCE'],
        voice: { days: 1 },
        constitutionQuiz: true,
        digestive: true,
    },
};

// Canonical zone list the frontend can reference.
// Back-compat alias so existing imports don't break.
export const ZONE_PROTOCOLS = DEFAULT_ZONE_PROTOCOLS;

export const ALL_ZONES = Object.keys(DEFAULT_ZONE_PROTOCOLS);

/**
 * Load the effective protocol map for a hospital — defaults, with any
 * `SelfExamProtocolOverride` rows merged on top. Called once per submission
 * render (get / getByAppointment) so the admin UI changes take effect on
 * next fetch.
 *
 * Shape of the returned map matches DEFAULT_ZONE_PROTOCOLS:
 *   { [PainZone]: { symptomHistory, tongue, stool, urine, rom, ... } }
 */
export async function loadProtocolsForHospital(hospitalId) {
    if (!hospitalId) return { ...DEFAULT_ZONE_PROTOCOLS };

    // Lazy import to avoid circular dep when this module is loaded from the
    // prisma side (selfExam.service → selfExam.protocol → prisma).
    const { default: prisma } = await import('../lib/prisma.js');
    const overrides = await prisma.selfExamProtocolOverride.findMany({
        where: { hospitalId },
        select: { painZone: true, config: true },
    });

    const merged = { ...DEFAULT_ZONE_PROTOCOLS };
    for (const row of overrides) {
        if (row.config && typeof row.config === 'object') {
            merged[row.painZone] = row.config;
        }
    }
    return merged;
}

/**
 * Map a free-text TriageSession painRegions entry (e.g. "left-knee",
 * "lower-back", "forehead") onto the canonical PainZone enum.
 * Returns null for regions that don't match the 9 spec zones.
 */
export function mapRegionToZone(regionId) {
    if (!regionId || typeof regionId !== 'string') return null;
    const s = regionId.toLowerCase();

    if (/(head|forehead|temple|skull|occiput|migraine)/.test(s)) return 'HEAD_MIGRAINE';
    if (/neck|cervical/.test(s)) return 'NECK';
    if (/shoulder/.test(s)) return 'SHOULDER';
    if (/chest|sternum|heart/.test(s)) return 'CHEST';
    if (/(lower.?back|lumbar|kati|pristha|sacrum)/.test(s)) return 'LOWER_BACK';
    if (/(abdomen|stomach|belly|umbilical|navel|epigastric|udara)/.test(s)) return 'ABDOMEN';
    if (/knee|patella/.test(s)) return 'KNEE';
    if (/(wrist|hand|finger|palm|carpal)/.test(s)) return 'WRIST_HAND';
    if (/(whole.?body|generalised|general muscle|fibro|all over|body.?ache)/.test(s)) {
        return 'GENERALISED_MUSCLE';
    }
    return null;
}

/**
 * Collapse a TriageSession.painRegions array (shape:
 *   [{ regionId, intensity, ... }, ...])
 * into a de-duplicated list of canonical PainZone values.
 */
export function zonesFromPainRegions(painRegions) {
    if (!Array.isArray(painRegions)) return [];
    const set = new Set();
    for (const r of painRegions) {
        const zone = mapRegionToZone(r?.regionId || r?.regionLabel);
        if (zone) set.add(zone);
    }
    return Array.from(set);
}

/**
 * Build the submission checklist for a set of zones. Returns an array of
 * { key, zone, type, ... } items the frontend can render and the completion
 * calculator can check against.
 *
 * Keys are stable (zone + task type + day) so they round-trip through the
 * client without re-generation.
 */
/**
 * Build the full checklist for a set of zones.
 *
 * @param {string[]} zones - canonical PainZone values the patient has.
 * @param {object}   [protocolsByZone] - effective protocol map (defaults
 *   with admin overrides merged in). Defaults to `DEFAULT_ZONE_PROTOCOLS`
 *   so existing callers don't have to change. Use `loadProtocolsForHospital`
 *   to get the hospital-specific merged map.
 */
export function buildChecklist(zones, protocolsByZone = DEFAULT_ZONE_PROTOCOLS) {
    const items = [];
    const addedConstitution = { added: false };

    for (const zone of zones) {
        const p = protocolsByZone[zone];
        if (!p) continue;

        if (p.symptomHistory) {
            items.push({
                key: `${zone}:SYMPTOM_HISTORY`,
                zone,
                type: 'SYMPTOM_HISTORY',
                critical: p.symptomHistory?.critical === true,
                urgentCareWarning: p.symptomHistory?.urgentCareWarning === true,
            });
        }

        if (p.tongue) {
            for (let d = 1; d <= p.tongue.days; d++) {
                items.push({
                    key: `${zone}:TONGUE:${d}`,
                    zone,
                    type: 'TONGUE',
                    dayIndex: d,
                    critical: d === 1 && p.tongue.critical === true,
                });
            }
        }

        if (p.stool) {
            for (let d = 1; d <= p.stool.days; d++) {
                items.push({
                    key: `${zone}:STOOL:${d}`,
                    zone,
                    type: 'STOOL',
                    dayIndex: d,
                    critical: d === 1 && p.stool.critical === true,
                });
            }
        }

        if (p.urine) {
            for (let d = 1; d <= p.urine.days; d++) {
                items.push({
                    key: `${zone}:URINE:${d}`,
                    zone,
                    type: 'URINE',
                    dayIndex: d,
                });
            }
        }

        if (p.rom) {
            for (const joint of p.rom.joints) {
                for (const direction of p.rom.directions) {
                    // Only add directions that belong to this joint family —
                    // spares the frontend from rendering nonsense like
                    // "knee-flex" on a shoulder row.
                    const isNeck = joint === 'NECK' && direction.startsWith('NECK_');
                    const isShoulder = joint.startsWith('SHOULDER_') && direction.startsWith('SHOULDER_');
                    const isKnee = joint.startsWith('KNEE_') && direction.startsWith('KNEE_');
                    if (!(isNeck || isShoulder || isKnee)) continue;

                    items.push({
                        key: `${zone}:ROM:${joint}:${direction}`,
                        zone,
                        type: 'ROM',
                        joint,
                        direction,
                    });
                }
            }
        }

        if (p.physicalObservations) {
            for (const obsType of p.physicalObservations) {
                items.push({
                    key: `${zone}:PHYSICAL:${obsType}`,
                    zone,
                    type: 'PHYSICAL',
                    observationType: obsType,
                });
            }
        }

        if (p.voice) {
            items.push({
                key: `${zone}:VOICE:1`,
                zone,
                type: 'VOICE',
                dayIndex: 1,
            });
        }

        if (p.digestive) {
            items.push({ key: `${zone}:DIGESTIVE`, zone, type: 'DIGESTIVE' });
        }

        if (p.lifestyle) {
            items.push({ key: `${zone}:LIFESTYLE`, zone, type: 'LIFESTYLE' });
        }

        if (p.constitutionQuiz && !addedConstitution.added) {
            items.push({ key: 'CONSTITUTION', zone: null, type: 'CONSTITUTION' });
            addedConstitution.added = true;
        }
    }

    // De-duplicate by key (digestive/lifestyle/constitution can be requested
    // by more than one zone).
    const seen = new Set();
    return items.filter((i) => {
        if (seen.has(i.key)) return false;
        seen.add(i.key);
        return true;
    });
}

/**
 * Given a submission with its child rows loaded, return per-checklist-item
 * completion status. Frontend uses this to render the done/todo checklist.
 */
export function computeCompletion(submission, checklist) {
    if (!submission) return { items: [], completedCount: 0, totalCount: 0 };

    const symptomByZone = new Map((submission.symptomHistory || []).map((r) => [r.painZone, r]));
    const tongueByDay   = new Map((submission.tongueObservations || []).map((r) => [r.dayIndex, r]));
    const stoolByDay    = new Map((submission.stoolLogs || []).map((r) => [r.dayIndex, r]));
    const urineByDay    = new Map((submission.urineLogs || []).map((r) => [r.dayIndex, r]));
    const romByKey      = new Map(
        (submission.romMeasurements || []).map((r) => [`${r.joint}:${r.direction}`, r])
    );
    const physicalByType = new Map(
        (submission.physicalObservations || []).map((r) => [r.observationType, r])
    );
    const voiceByDay    = new Map((submission.voiceObservations || []).map((r) => [r.dayIndex, r]));

    const items = checklist.map((item) => {
        let complete = false;
        switch (item.type) {
            case 'SYMPTOM_HISTORY':
                complete = symptomByZone.has(item.zone);
                break;
            case 'TONGUE':
                complete = tongueByDay.has(item.dayIndex);
                break;
            case 'STOOL':
                complete = stoolByDay.has(item.dayIndex);
                break;
            case 'URINE':
                complete = urineByDay.has(item.dayIndex);
                break;
            case 'ROM':
                complete = romByKey.has(`${item.joint}:${item.direction}`);
                break;
            case 'PHYSICAL':
                complete = physicalByType.has(item.observationType);
                break;
            case 'VOICE':
                complete = voiceByDay.has(item.dayIndex);
                break;
            case 'DIGESTIVE':
                complete = !!submission.digestiveProfile;
                break;
            case 'LIFESTYLE':
                complete = !!submission.lifestyleContext;
                break;
            case 'CONSTITUTION':
                // ConstitutionProfile lives on Patient, not submission —
                // caller must set `submission._constitutionCompleted` if true.
                complete = !!submission._constitutionCompleted;
                break;
        }
        return { ...item, complete };
    });

    const completedCount = items.filter((i) => i.complete).length;
    return { items, completedCount, totalCount: items.length };
}
