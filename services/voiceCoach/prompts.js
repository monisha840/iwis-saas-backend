/**
 * Static prompt fragments for the Ayurvedic Voice Health Coach.
 *
 * The system prompt is rebuilt fresh for every turn from live patient data
 * (see context.service.js). Nothing about the patient is hardcoded here —
 * this file only owns the rules and the safety reply templates.
 */

const RULES = `RULES — NEVER BREAK THESE:
1. You always know this patient's primary doctor (named above). When asked "who is my doctor", "consultation doctor", "vaidya", etc., answer with the name from ASSIGNED DOCTOR — never say you don't have that information.
2. Always personalise. Use the patient's name. Reference their actual prescriptions, treatment phase, and recent check-ins by name when relevant. Never give generic advice that ignores their data.
3. Never prescribe new medicines. Never tell the patient to stop or change current medicines.
4. If pain is reported as 8/10 or higher, or critical symptoms appear (chest pain, breathlessness, sudden weakness, suicidal thoughts), respond with: "I'm alerting your care team right now" and the system will escalate.
5. Keep every response under 4 sentences — output is read aloud as voice.
6. Respond in the LANGUAGE specified above. Mix Tamil and English naturally if helpful.
7. If the patient asks something outside Ayurvedic / lifestyle / current-treatment scope, gently redirect to those topics.`;

/**
 * Render the system prompt from a context object built by
 * VoiceCoachContextService.buildContext(). Pure function — no I/O.
 */
export function renderSystemPrompt(ctx) {
    const lines = [];
    lines.push(
        `You are the personal Ayurvedic Health Coach for ${ctx.patient.fullName ?? 'this patient'} at Al-Shifa clinic. You are NOT a generic assistant — you have full knowledge of this specific patient's medical profile, listed below.`,
    );
    lines.push('');

    lines.push('PATIENT');
    lines.push(`  Name: ${ctx.patient.fullName ?? 'Unknown'}`);
    if (ctx.patient.age) lines.push(`  Age: ${ctx.patient.age}`);
    lines.push('');

    // ── ASSIGNED DOCTOR — required (context build throws if missing) ──────
    lines.push('ASSIGNED DOCTOR');
    const docName = ctx.doctor.fullName?.startsWith('Dr.')
        ? ctx.doctor.fullName
        : `Dr. ${ctx.doctor.fullName ?? 'Unknown'}`;
    const specBits = [ctx.doctor.specialization, ctx.doctor.qualification].filter(Boolean).join(', ');
    lines.push(`  ${docName}${specBits ? ` — ${specBits}` : ''}`);
    lines.push(`  Assignment: ${ctx.doctor.assignmentType}`);
    lines.push('  → When the patient asks about their doctor, vaidya, or consultation doctor, answer with this exact name.');
    lines.push('');

    // ── Constitution / Prakriti ───────────────────────────────────────────
    if (ctx.constitution) {
        const { prakriti, agniType, satvaRating } = ctx.constitution;
        lines.push('CONSTITUTION (Prakriti)');
        lines.push(`  Primary Type: ${prakriti ?? 'unknown'}`);
        lines.push(`  Digestive Fire (Agni): ${agniType ?? 'unknown'}`);
        if (satvaRating != null) lines.push(`  Satva (mental clarity): ${satvaRating}/10`);
        lines.push('');
    } else {
        lines.push('CONSTITUTION: Prakriti profile not yet recorded.');
        lines.push('');
    }

    // ── Active prescriptions ──────────────────────────────────────────────
    if (ctx.prescriptions.length) {
        lines.push('ACTIVE MEDICATIONS');
        for (const rx of ctx.prescriptions) {
            const notes = rx.notes ? `. ${rx.notes}` : '';
            lines.push(`  - ${rx.medicationName}: ${rx.dosage}, ${rx.frequency}${notes}`);
        }
        lines.push('');
    } else {
        lines.push('ACTIVE MEDICATIONS: None on record.');
        lines.push('');
    }

    // ── Treatment journey + pending tasks ─────────────────────────────────
    if (ctx.activeJourney && ctx.activePhase) {
        lines.push('CURRENT TREATMENT PHASE');
        lines.push(
            `  ${ctx.activePhase.name} (Day ${ctx.activePhase.dayInPhase ?? 1} of ${ctx.activePhase.durationDays ?? '?'})`,
        );
        if (ctx.activePhase.tasks?.length) {
            lines.push('  Pending tasks:');
            for (const t of ctx.activePhase.tasks) {
                const desc = t.description ? `: ${t.description}` : '';
                lines.push(`    - [${t.type}] ${t.title}${desc}`);
            }
        }
        lines.push('');
    } else {
        lines.push('CURRENT TREATMENT PHASE: No active treatment journey assigned.');
        lines.push('');
    }

    // ── Recent check-ins ─────────────────────────────────────────────────
    if (ctx.recentCheckIns.length) {
        lines.push('RECENT CHECK-INS (last 7 days)');
        for (const c of ctx.recentCheckIns) {
            const date = new Date(c.createdAt).toISOString().split('T')[0];
            lines.push(
                `  ${date}: pain ${c.painLevel}/10, sleep ${c.sleepHours}h, mood ${c.mood}`,
            );
        }
        lines.push('');
    }

    // ── Recent vitals ─────────────────────────────────────────────────────
    if (ctx.recentVitals.length) {
        lines.push('LATEST VITALS');
        for (const v of ctx.recentVitals) {
            const date = new Date(v.recordedAt).toISOString().split('T')[0];
            lines.push(`  - ${v.type}: ${v.value} ${v.unit} (${date})`);
        }
        lines.push('');
    }

    // ── Language ─────────────────────────────────────────────────────────
    lines.push(
        `LANGUAGE: respond primarily in ${
            ctx.patient.preferredCoachLang === 'en' ? 'English' : 'Tamil'
        }. Mix Tamil and English naturally if helpful.`,
    );
    lines.push('');
    lines.push(RULES);

    return lines.join('\n');
}

/**
 * Templated safety reply used when the escalation engine decides the model's
 * own response should be discarded for the current turn (HIGH or CRITICAL
 * severity).
 */
export const SAFETY_REPLY = {
    en: "I'm alerting your care team right now — please reach out to the clinic if your symptoms get worse.",
    ta: 'உங்கள் கவனிப்பு குழுவை இப்போதே தொடர்பு கொள்கிறேன் — அறிகுறிகள் மோசமாகினால் கிளினிக்கைத் தொடர்பு கொள்ளவும்.',
};

/**
 * Canned reply when the patient's profile is incomplete (no PRIMARY doctor
 * assigned). Served by session.service.sendMessage on PROFILE_INCOMPLETE
 * without calling the LLM.
 */
export const PROFILE_INCOMPLETE_REPLY = {
    en: "Your profile isn't fully set up yet — please contact your clinic so they can assign your primary doctor. Once that's done, I can help you with your treatment.",
    ta: 'உங்கள் சுயவிவரம் இன்னும் முழுமையாக அமைக்கப்படவில்லை — தயவுசெய்து உங்கள் கிளினிக்கைத் தொடர்பு கொண்டு உங்கள் முதன்மை மருத்துவரை நியமிக்கச் சொல்லுங்கள். அதன் பிறகு நான் உங்கள் சிகிச்சையில் உதவ முடியும்.',
};
