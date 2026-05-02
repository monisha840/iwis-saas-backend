// Voice-note refine service.
//
// Public API: a single async function `refineTranscript(transcript, language)`
// returning `{ refinedTranscript, structured }` — preserved so the existing
// route file (refine.route.js) keeps working unchanged.
//
// Two execution paths:
//   1. GEMINI_API_KEY is set → call Gemini 2.0 Flash, return its JSON
//   2. GEMINI_API_KEY missing OR Gemini call fails → deterministic regex
//      fallback. Same `structured` shape so callers don't branch.
//
// The `structured` shape returned by both paths:
//   {
//     diagnosis: string,
//     treatmentNotes: string,
//     medications: [{ name, dosage, frequency, duration }],
//     dietaryAdvice: string,
//     nextSteps: string,
//     followUpDate: "YYYY-MM-DD" | ""
//   }

import OpenAI from 'openai';
import prisma from '../../lib/prisma.js';

// ───────────────────────────────────────────────────────────────────────────
// Medicine catalog cache
// ───────────────────────────────────────────────────────────────────────────
// The Gemini prompt gets a "your clinic prescribes these medicines" section
// so the model can match a doctor's spoken name against the real catalog
// (and use the canonical spelling instead of whatever the speech recognizer
// produced). We pull straight from Prisma — same source the pharmacy GET
// endpoint /api/pharmacy/medicines reads — to avoid auth/branch-scoping
// concerns and skip an HTTP round-trip.
//
// Cached for 5 minutes so a busy doctor doing back-to-back voice notes
// doesn't hammer the DB. New medicines added by a pharmacist mid-session
// will appear within ~5 minutes without a restart.

const MEDICINE_CACHE_TTL_MS = 5 * 60 * 1000;
let medicineCache = null; // { names: string[], expiresAt: number } | null

async function getMedicineCatalog() {
  if (medicineCache && Date.now() < medicineCache.expiresAt) {
    return medicineCache.names;
  }
  try {
    const rows = await prisma.medicine.findMany({
      select: { name: true },
      orderBy: { name: 'asc' },
    });
    const names = rows.map((r) => r.name).filter((n) => typeof n === 'string' && n.trim().length > 0);
    medicineCache = { names, expiresAt: Date.now() + MEDICINE_CACHE_TTL_MS };
    return names;
  } catch (err) {
    // DB unreachable / Prisma not initialised / table missing → tell the
    // caller we couldn't load the list. The prompt drops the catalog
    // section and Gemini falls back to free-form text matching.
    console.error('[VoiceNote] Could not load medicine catalog, falling back to text matching:', err?.message || err);
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Public entry point
// ───────────────────────────────────────────────────────────────────────────

export async function refineTranscript(transcript, language) {
  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    throw new Error('transcript must be a non-empty string');
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      return await refineWithOpenAI(transcript, language);
    } catch (err) {
      // Don't fail the whole request when OpenAI hiccups — let the doctor at
      // least get the regex extraction. Log so the operator sees the cause.
      console.error('[VoiceNote] OpenAI failed, falling back to regex:', err?.message || err);
    }
  }

  return refineWithRegex(transcript, language);
}

// ───────────────────────────────────────────────────────────────────────────
// OpenAI (gpt-4o-mini) path
// ───────────────────────────────────────────────────────────────────────────

// Detect the dominant language of the transcript so we can hint the LLM up
// front. The browser's Web Speech API can't always be trusted (the user may
// pick "English" but dictate in Tamil), so we infer from the actual text.
//
//   • Any character in the Tamil unicode block (U+0B80–U+0BFF) → "Tamil"
//   • Otherwise, presence of romanized Tamil markers (kaichal, marunthu…) → "Tanglish"
//   • Otherwise → "English"
const TAMIL_UNICODE_REGEX = /[஀-௿]/;
const TANGLISH_MARKERS = [
  'kaichal', 'thalaivaali', 'thalaivali', 'thalai vali', 'vayiru vali', 'vayiru',
  'iraipu', 'marunthu', 'maathirai', 'kalai', 'maalai', 'iravu',
  'saapittavudan', 'saapittarkku mun', 'saapittu', 'saapidu',
  'thanneer', 'unavu', 'otrivu', 'parigaasam',
  'oru murai', 'irandu murai', 'moonu murai', 'munnu murai',
  'naal', 'naalu', 'vaaram', 'maatham',
  'adutha', 'sariyana', 'palli',
];

export function detectLanguage(transcript) {
  if (!transcript) return 'English';
  if (TAMIL_UNICODE_REGEX.test(transcript)) return 'Tamil';
  const lower = transcript.toLowerCase();
  if (TANGLISH_MARKERS.some((kw) => lower.includes(kw))) return 'Tanglish';
  return 'English';
}

function buildSystemPrompt(languageHint, medicineList) {
  const catalogSection = (medicineList && medicineList.length > 0)
    ? `\n\nCLINIC MEDICINE CATALOG — these are the exact medicines stocked in this clinic. When the doctor speaks a name that matches one of these (case-insensitive, allow for minor speech-recognition spelling errors and Tamil/English transliteration variants), use the CATALOG name verbatim in the medications[].name field so it matches the pharmacy system:\n${medicineList.map((n) => `- ${n}`).join('\n')}\n\nThe catalog is a hint, not a hard limit. If the doctor mentions a medicine NOT in this list (e.g. a Siddha herb or a one-off prescription), still extract it. But when there's a clear correspondence — even with garbled speech — prefer the catalog spelling.`
    : '';

  const today = new Date().toISOString().slice(0, 10);
  return `You are a medical assistant who understands Tamil, Tanglish (Tamil written in English letters), and English.
The doctor may speak in Tamil script (தமிழ்), romanized Tamil (like 'kaichal', 'thalaivaali', 'marunthu'), or a mix of Tamil and English.

Understand the full medical meaning regardless of language.
Always extract and return all fields in English only.

Common Tamil medical terms to understand:
- kaichal / காய்ச்சல் = fever
- thalaivaali / தலைவலி = headache
- vayiru vali / வயிற்று வலி = stomach pain
- iraipu / இரைப்பு = breathlessness
- marunthu / மருந்து = medicine
- kalai / காலை = morning
- maalai / மாலை = evening
- iravu / இரவு = night
- saapittavudan / சாப்பிட்டவுடன் = after food
- saapittarkku mun / சாப்பிடுவதற்கு முன் = before food
- naal / நாள் = days
- vaaram / வாரம் = week
- oru murai / ஒரு முறை = once
- irandu murai / இரண்டு முறை = twice
- moonu murai / மூன்று முறை = three times
- thanneer / தண்ணீர் = water
- unavu / உணவு = food
- otrivu / ஓட்டிவு = rest
- parigaasam / பரிகாசம் = exercise
- adutha steps = next steps
- follow up = review appointment

Tamil anatomy / body-part terms — these are COMPOUND words: read each multi-word phrase as ONE anatomical site, never break it up:
- கால் / kaal = leg (the whole limb)
- கால் முட்டி / kaal mutti = KNEE  ← do NOT translate as "foot" — மூட்டு / muttu = joint, so கால் முட்டி = knee joint specifically
- கை / kai = hand / arm
- கை முட்டி / kai mutti = elbow
- தோள் / thol = shoulder
- தலை / thalai = head
- கழுத்து / kazhuthu = neck
- முதுகு / muthugu = back
- இடுப்பு / iduppu = waist / lower back
- மார்பு / maarbu = chest
- வயிறு / vayiru = stomach / abdomen
- கண் / kann = eye
- காது / kaadhu = ear
- பல் / pal = tooth
- ஈறு / eeru = gum
- தொண்டை / thondai = throat
- நெஞ்சு / nenju = chest / heart region
- முதுகுத்தண்டு / muthuguthandu = spine
- மணிக்கட்டு / manikkattu = wrist
- கணுக்கால் / kanukkaal = ankle

Pain words attach as the second word (வலி / vali = pain). Treat the WHOLE phrase as the diagnosis:
- கால் முட்டி வலி = knee pain (NOT foot pain)
- முதுகு வலி = back pain
- இடுப்பு வலி = lower back pain
- கழுத்து வலி = neck pain
- மார்பு வலி = chest pain
- பல் வலி = toothache
- தொண்டை வலி = sore throat

You must also recognize traditional Siddha and Ayurvedic herbal medicines written in Tamil. These are valid medicines and must be extracted into the medications array.

Common Siddha medicines and herbs to recognize:
- சித்தரத்தை / Chithirathai = Siddha herb (Alpinia galanga)
- தூதுவளை / Thoodhuvalai = Solanum trilobatum herb
- கற்பூரவல்லி / Karpooravalli = Coleus herb
- நிலவேம்பு / Nilavembu = Andrographis herb
- அதிமதுரம் / Athimathuram = Licorice root
- துளசி / Thulasi = Holy basil
- வேப்பிலை / Veppilai = Neem leaves
- சுக்கு / Sukku = Dry ginger
- மிளகு / Milagu = Black pepper
- திப்பிலி / Thippili = Long pepper
- ஓமம் / Omam = Ajwain / Carom seeds
- கடுக்காய் / Kadukkai = Terminalia herb
- நெல்லிக்காய் / Nellikkai = Gooseberry / Amla
Tamil OIL names — these are easily confused. Map them EXACTLY as listed; never substitute one for another:
- விளக்கெண்ணெய் / Vilakkennai / Vilakku ennai = CASTOR OIL (Ricinus communis). Literally "lamp oil" — historically used in oil lamps AND as a Siddha purgative/topical. Do NOT translate as "coconut oil" — that is a common but wrong default.
- ஆமணக்கு எண்ணெய் / Aamanakku ennai = Castor oil (alternative Tamil name; same as Vilakkennai)
- தேங்காய் எண்ணெய் / Thengai ennai / Thenga ennai = Coconut oil (Cocos nucifera)
- நல்லெண்ணெய் / Nallennai / Nalla ennai = Sesame oil / Gingelly oil (Sesamum indicum) — the workhorse Siddha medicinal oil
- கடலை எண்ணெய் / Kadalai ennai = Groundnut / peanut oil (Arachis hypogaea)
- கசகசா எண்ணெய் / Kasakasa ennai = Poppyseed oil
- கடுகு எண்ணெய் / Kadugu ennai = Mustard oil
- அமுக்கரா தைலம் / Amukkara thailam = Ashwagandha-based medicated oil
- குஞ்சி குழம்பு / Kunji kuzhambu = Siddha medicinal oil decoction
- "Vatti" or "Vatti Vaaniyampadi" near an oil name is a regional brand/origin marker (Vaaniyampadi in Tamil Nadu is famous for cold-pressed oils). Preserve in the medication name as a qualifier when stated, e.g. "Castor oil (Vatti Vaaniyampadi விளக்கெண்ணெய்)".

CRITICAL: when the transcript mentions an oil being applied topically (head, joints, body), used internally, or boiled with herbs, ALWAYS extract it as a medication row — not just a treatmentNotes line. The oil's preparation/application method goes into frequency.

- ஆடாதொடை / Adathodai = Justicia adhatoda — Siddha cough/respiratory herb. Speech recognition GARBLES this severely. Map ALL of the following back to "Adathodai (ஆடாதொடை)" when they appear near herb/dosage context:
  · Tamil-mode garbles: "ஆடவரை", "ஆடைகள்", "ஆடைகளை", "ஆடாதொழை", "ஆடாதோடை", "ஆடாதொடை"
  · English-mode garbles when the doctor speaks Tamil with the Eng recogniser on: "Abdul Samad", "Abdul samath", "Adagothai", "Adabodai", "Adavarai", "Adathoda", "Adabhotai", "ada thodai", "ada thoda", "advisor day", "Audio Day"
  Common forms: ஆடாதொடை சூரணம் (Adathodai Choornam — powder), ஆடாதொடை மணப்பாகு (Adathodai Manappagu — syrup).
- கீழாநெல்லி / Keezhanelli = Phyllanthus amarus — liver herb
- வில்வம் / Vilvam = Bael / Aegle marmelos
- அமுக்கரா / Amukkara = Ashwagandha (Tamil name for Withania somnifera)
- திரிபலா / Thiripala = Triphala (three-fruit blend)
- வசம்பு / Vasambu = Acorus calamus
- சீரகம் / Seeragam = Cumin
- கஸ்தூரி மஞ்சள் / Kasthuri Manjal = Wild turmeric
- வசம்பு / Vasambu = Acorus calamus
- குங்கிலியம் / Kungiliyam = Resin herb
- தனியா / Thaniya = Coriander seeds
- கிராம்பு / Kirambu = Cloves
- ஏலக்காய் / Elakkai = Cardamom

Mixing instructions are part of frequency/dosage:
- தேனில் கலந்து = mixed with honey (add to frequency)
- நீரில் கலந்து = mixed with water (add to frequency)
- பாலில் கலந்து = mixed with milk (add to frequency)
- காலை மாலை = morning and evening = twice daily
- சாப்பாட்டிற்கு பின் = after food
- சாப்பாட்டிற்கு முன் = before food

Measurement words in Tamil:
- கிராம் = grams
- மில்லி = ml
- சிட்டிகை = pinch
- கரண்டி = spoon

So for this input:
"சித்தரத்தை 5 கிராம் தேனில் கலந்து காலை மாலை சாப்பாட்டிற்கு பின் அருந்தவும்"

Extract as:
{
  "name": "Chithirathai (சித்தரத்தை)",
  "dosage": "5 grams",
  "frequency": "Twice daily - morning and evening, mixed with honey, after food",
  "duration": ""
}

Always preserve both the Tamil name and English transliteration in the medicine name field like: "Chithirathai (சித்தரத்தை)"

This helps doctors and pharmacists identify the correct herb.

The input language is: ${languageHint}

Today's date is ${today}. Use it as the reference for resolving relative dates.

The input often comes from live speech recognition, so it may have garbled words, missing punctuation, or partial phrases — extract the doctor's *intent*, not the literal noisy text.

Today's date is ${today}. Use it as the reference for resolving relative dates.

Return JSON matching exactly this shape (no extra keys, no markdown fences):

{
  "diagnosis": "<short condition phrase or empty string>",
  "treatmentNotes": "<paragraph describing the approach. Fold any imperative instructions like 'avoid cold water' or 'rest 2 days' into this field as bullet lines>",
  "medications": [
    {
      "name": "<single medication name only>",
      "dosage": "<e.g. 500mg, 1 tablet; empty string if not stated>",
      "frequency": "<e.g. Once daily, Twice daily after food, Thrice daily; combine timing into this string>",
      "duration": "<e.g. 30 days, 2 weeks; empty string if not stated>"
    }
  ],
  "exercisePlan": "<exercise / activity guidance such as 'walk 30 minutes daily', 'avoid heavy lifting', 'yoga twice a week'; empty string if not stated>",
  "dietaryAdvice": "<food guidance or empty string>",
  "nextSteps": "<follow-up actions, labs, lifestyle changes or empty string>",
  "followUpDate": "<YYYY-MM-DD or empty string>"
}

CRITICAL FIELD-PLACEMENT RULES:

- "diagnosis" is the patient's CONDITION or COMPLAINT. Phrases like "patient came with X", "presenting with X", "complaining of X", "patient has X" → put X into diagnosis. Examples: "body pain", "chronic insomnia", "vata imbalance", "fever with cough".

- "medications[].name" is a SINGLE DRUG OR HERB NOUN — never a sentence, never a description, never a symptom. Examples of valid names: "Ashwagandha", "Triphala", "Paracetamol", "Brahmi", "Ibuprofen". Examples of INVALID names: "patient came with body pain", "tablet for pain", "the medicine", "400mg".

- MANDATORY: Any time the transcript mentions a Siddha or Ayurvedic herb listed in the catalogs above (Adathodai, Thoodhuvalai, Karpooravalli, Nilavembu, Thulasi, Veppilai, Sukku, Kadukkai, etc.) — INCLUDING garbled phonetic forms — you MUST emit it as a row in medications[], even when:
  · No dosage is stated (leave dosage = "")
  · No duration is stated (leave duration = "")
  · It's described as a HOME REMEDY (e.g. "boil the leaves and drink", "mix with honey and take", "soak overnight")
  · The preparation method is the only timing detail
  In the home-remedy case, fold the preparation method into the frequency string, e.g.:
    {
      "name": "Adathodai (ஆடாதொடை)",
      "dosage": "",
      "frequency": "Boil leaves in water, drink at night before sleep",
      "duration": ""
    }
  Do NOT relegate the herb to treatmentNotes only because the dosage is unstructured. The prescription preview row IS the herb's home in the form; treatmentNotes captures the wider context (rest, follow-up advice, etc.) but the herb itself belongs in medications[].

- If the transcript mentions a dosage/duration but you cannot identify a clear medication name (e.g. the doctor said "give 400mg for 5 days" without naming the drug), do NOT invent or guess. Return an EMPTY medications array. Put any context like the symptom into diagnosis, and the dosing instruction into treatmentNotes ("400mg for 5 days"). NOTE: this rule is OVERRIDDEN by the mandatory-herb rule above — if a recognisable Siddha/Ayurvedic herb is named, always emit a medication row even if dosage/duration are absent.

- If the speech recognition garbled what looks like a drug name (e.g. "pearon" near "400mg"), prefer to return an empty medications array over guessing the wrong drug. The doctor will fill it in manually.

- EXCEPTION for known Siddha/Ayurvedic herbs: when the garbled token is a near-miss for a herb in the lists above (e.g. "ஆடவரை" / "ஆடைகளை" / "ஆடைகள்" / "Adavarai" / "Abdul Samad" / "Audio Day" → ஆடாதொடை / Adathodai), DO normalise it to the canonical herb name. The phonetic similarity + clinical context (dosage stated, "சூரணம்"/"choornam"/"powder" mentioned, twice-daily timing, etc.) is enough signal. Use the canonical "Name (தமிழ் form)" notation as for all other herbs.

- NEVER extract personal/people names as medications. Reject any candidate whose surface form is a common South Asian person name (e.g. "Abdul X", "X Khan", "X Kumar", "X Sharma", "X Iyer", "X Reddy", "X Singh", "X Samad") UNLESS the surrounding context (dosage in grams/mg, "powder/choornam/syrup/tablet", "morning/evening", "for N days") strongly suggests it's a phonetic garble of a Siddha or Ayurvedic herb in the lists above. In that case, normalise to the herb's canonical name; otherwise drop the candidate (return empty medications) rather than producing a person's name as a drug.

- Numeric-looking noise tokens like "123", "1 2 3", repeated number triplets, or stray "summer 123" / "winter 123" sequences are speech-recognition junk produced when the doctor dictates a number or unit (e.g. "500 grams" → "1 2 3 grams"). Do NOT treat these as part of a medication name. Use the surrounding context to infer the real dose (e.g. "500g" / "5g" / "50g") if the doctor mentioned grams or kilograms; otherwise leave the dosage field empty rather than transcribing the noise.

- "treatmentNotes" is the free-text plan paragraph and any imperative instructions ("avoid cold food", "rest 2 days").

- "dietaryAdvice" covers food/drink guidance ("vegetarian diet", "warm water only").

- "nextSteps" covers reviews, labs, lifestyle changes that aren't a specific drug or diet.

OTHER RULES:
- ALWAYS return values in English, even when the input is Tamil or Tanglish. Translate diagnosis, dietary advice, next steps, and treatment notes into clear English.
- Use standard Sanskrit/English names for Ayurvedic herbs (Ashwagandha, Triphala, Brahmi, etc.) — never transliterate phonetically.
- "1-0-1" / "1-1-1" notation maps to morning-noon-night dosing slots. Translate "1-0-1" to "Twice daily, morning and night"; "1-1-1" to "Thrice daily, morning, noon and night".
- For followUpDate, resolve "in 2 weeks", "review after 30 days", "next month" to an absolute YYYY-MM-DD using today's date as reference. Empty string if no follow-up is stated.
- Combine timing ("after food", "before bed") INTO the medication's frequency string — there is no separate timing field.
- Do not invent fields. If the doctor didn't say it, return an empty string (or empty array).
- Output ONLY the JSON object. No commentary, no code fences.

EXAMPLES:

Input (English): "patient came with pearon body pain for the party day, 400 milligrams 5 days"
Output:
{
  "diagnosis": "Body pain (persistent, several days)",
  "treatmentNotes": "Prescribed medication at 400mg for 5 days (drug name unclear from dictation — please confirm).",
  "medications": [],
  "exercisePlan": "",
  "dietaryAdvice": "",
  "nextSteps": "",
  "followUpDate": ""
}

Input (English): "Patient has chronic insomnia. Prescribe Ashwagandha 500 milligrams twice daily after food for 30 days. Avoid cold water. Vegetarian diet recommended. Walk 30 minutes daily. Review after 2 weeks."
Output:
{
  "diagnosis": "Chronic insomnia",
  "treatmentNotes": "• Avoid cold water",
  "medications": [{"name":"Ashwagandha","dosage":"500mg","frequency":"Twice daily, after food","duration":"30 days"}],
  "exercisePlan": "Walk 30 minutes daily",
  "dietaryAdvice": "Vegetarian diet recommended",
  "nextSteps": "Review after 2 weeks",
  "followUpDate": "<2 weeks from today as YYYY-MM-DD>"
}

Input (Tanglish): "Patient ku kaichal and thalaivaali iruku 3 naal ah. Paracetamol 500 mg irandu murai daily 5 naal. Thanneer niraya kudikanum, oily food saapida vendaam. Adutha vaaram review."
Output:
{
  "diagnosis": "Fever and headache (3 days)",
  "treatmentNotes": "",
  "medications": [{"name":"Paracetamol","dosage":"500mg","frequency":"Twice daily","duration":"5 days"}],
  "exercisePlan": "",
  "dietaryAdvice": "Drink plenty of water; avoid oily food",
  "nextSteps": "Review next week",
  "followUpDate": "<1 week from today as YYYY-MM-DD>"
}

Input (Tamil script): "நோயாளிக்கு காய்ச்சல் மற்றும் தலைவலி இரண்டு நாட்களாக. பாராசிட்டமால் 500 mg ஒரு நாளைக்கு இரண்டு முறை 5 நாட்கள். தண்ணீர் நிறைய குடிக்க வேண்டும். ஒரு வாரம் கழித்து review."
Output:
{
  "diagnosis": "Fever and headache (2 days)",
  "treatmentNotes": "",
  "medications": [{"name":"Paracetamol","dosage":"500mg","frequency":"Twice daily","duration":"5 days"}],
  "exercisePlan": "",
  "dietaryAdvice": "Drink plenty of water",
  "nextSteps": "Review after 1 week",
  "followUpDate": "<1 week from today as YYYY-MM-DD>"
}

Even if the input is entirely in Tamil or Tanglish, you must extract and return all 7 fields in English. Do not return empty fields if the information is present in the transcript in any language.${catalogSection}`;
}

async function refineWithOpenAI(transcript, language) {
  // Infer the language from the transcript content rather than trusting the
  // user's tab choice — speech recognition often disagrees with the picker.
  const languageHint = detectLanguage(transcript);

  // Pull the clinic's catalog (cached). null means we couldn't load it; the
  // prompt then drops the catalog section and OpenAI does free-form matching.
  const medicineList = await getMedicineCatalog();

  // 45s upstream timeout — kept under the frontend's 60s fetch abort so the
  // SDK's error fires first and produces a useful message ("Request timed
  // out…") instead of the generic abort one. SDK default is 600s which is
  // far too long for an interactive form.
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45_000 });

  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    // JSON mode forces parseable JSON output. The prompt explicitly mentions
    // "JSON" already, which response_format requires.
    response_format: { type: 'json_object' },
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildSystemPrompt(languageHint, medicineList) },
      {
        role: 'user',
        content: `Tab selection: ${language || 'en'}\nDetected input language: ${languageHint}\n\nTranscript:\n${transcript}`,
      },
    ],
  });

  const text = response.choices?.[0]?.message?.content ?? '';
  let structured;
  try {
    structured = JSON.parse(text);
  } catch (parseErr) {
    throw new Error(`OpenAI returned non-JSON: ${text.slice(0, 200)}`);
  }

  // Coerce the shape so a partial response from the model still passes the
  // contract the route + frontend expect.
  structured = normalizeStructured(structured);

  // Light text refine for the dialog's transcript box. The model's heavy
  // lifting is on the structured side; we don't ask it to rewrite the
  // transcript itself since the doctor reads/edits it directly.
  const refinedTranscript = lightTextRefine(transcript);

  return { refinedTranscript, structured };
}

function normalizeStructured(raw) {
  const out = {
    diagnosis: typeof raw?.diagnosis === 'string' ? raw.diagnosis : '',
    treatmentNotes: typeof raw?.treatmentNotes === 'string' ? raw.treatmentNotes : '',
    medications: Array.isArray(raw?.medications)
      ? raw.medications.map((m) => ({
          name: typeof m?.name === 'string' ? m.name : '',
          dosage: typeof m?.dosage === 'string' ? m.dosage : '',
          frequency: typeof m?.frequency === 'string' ? m.frequency : '',
          duration: typeof m?.duration === 'string' ? m.duration : '',
        }))
      : [],
    exercisePlan: typeof raw?.exercisePlan === 'string' ? raw.exercisePlan : '',
    dietaryAdvice: typeof raw?.dietaryAdvice === 'string' ? raw.dietaryAdvice : '',
    nextSteps: typeof raw?.nextSteps === 'string' ? raw.nextSteps : '',
    followUpDate: typeof raw?.followUpDate === 'string' ? raw.followUpDate : '',
  };
  // Reject obviously wrong followUpDate values (model hallucinations).
  if (out.followUpDate && !/^\d{4}-\d{2}-\d{2}$/.test(out.followUpDate)) {
    out.followUpDate = '';
  }
  return out;
}

function lightTextRefine(transcript) {
  return transcript
    .replace(/\s+/g, ' ')
    .replace(/\s*([,.;])\s*/g, '$1 ')
    .trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Regex fallback — best-effort, ships working without an API key.
// Same output shape as the Gemini path so callers don't branch.
// ───────────────────────────────────────────────────────────────────────────

function refineWithRegex(transcript, _language) {
  const structured = parseTranscriptRegex(transcript);
  return { refinedTranscript: lightTextRefine(transcript), structured };
}

function parseTranscriptRegex(transcript) {
  const result = {
    diagnosis: '',
    treatmentNotes: '',
    medications: [],
    exercisePlan: '',
    dietaryAdvice: '',
    nextSteps: '',
    followUpDate: '',
  };
  if (!transcript) return result;

  // Header-style extraction for the free-text fields.
  result.diagnosis = matchHeader(transcript, /\b(?:diagnosis|condition)[:\-]\s*([^.\n;]+)/i);
  const treatmentNotesHeader = matchHeader(transcript, /\b(?:treatment notes?|treatment plan)[:\-]\s*([^.\n;]+(?:\.[^.\n;]+)*)/i);
  result.dietaryAdvice = matchHeader(transcript, /\b(?:diet(?:ary)?(?: advice)?|food)[:\-]\s*([^.\n;]+(?:\.[^.\n;]+)*)/i);
  result.nextSteps = matchHeader(transcript, /\b(?:next steps?|plan|follow-?up plan|schedule)[:\-]\s*([^.\n;]+(?:\.[^.\n;]+)*)/i);
  result.followUpDate = extractFollowUpDate(transcript);

  const segments = transcript.split(/[,;\n।]+/).map((s) => s.trim()).filter(Boolean);

  const dosageUnits = ['mg', 'ml', 'g', 'mcg', 'iu', 'drops', 'tablets', 'caps', 'tsp', 'tbsp', 'கிராம்', 'மில்லி'];
  const dosageRegex = new RegExp(`(\\d+(?:\\.\\d+)?\\s*(?:${dosageUnits.join('|')}))`, 'i');
  const durationRegex = /(\d+)\s*(days|weeks|months|நாள்|வாரம்|மாதம்)/i;
  const dosingNotationRegex = /\b([012])\s*-\s*([012])\s*-\s*([012])\b/;
  const formKeywords = /(tablet|capsule|cap|syrup|kashayam|choornam|lehyam|tailam|ghrita|arishta|asava|powder|drops)/i;
  const instructionsRegex = /(avoid|reduce|increase|drink|eat|rest|sleep|walk|exercise|stop|start|continue|do not|don't|வேண்டாம்|தவிர்|குடி|சாப்பிடு)/i;

  const collectedInstructions = [];
  const ambiguousDosingNotes = [];

  for (const segment of segments) {
    const lowerSeg = segment.toLowerCase();
    const dosageMatch = segment.match(dosageRegex);
    const notationMatch = segment.match(dosingNotationRegex);
    const formMatch = segment.match(formKeywords);

    const looksLikeMedication = !!dosageMatch || !!notationMatch || !!formMatch;
    if (!looksLikeMedication) {
      if (instructionsRegex.test(segment)) {
        collectedInstructions.push(segment);
      }
      continue;
    }

    const dosage = dosageMatch ? dosageMatch[0] : '';
    let name;
    if (dosageMatch) {
      name = segment.split(dosageRegex)[0].trim();
    } else if (notationMatch) {
      name = segment.split(dosingNotationRegex)[0].trim();
    } else if (formMatch) {
      name = segment.split(formKeywords)[0].trim();
    } else {
      name = '';
    }

    // Sanity check: medication names are short nouns. Anything > 5 words
    // is almost certainly a misparse on prose without sentence delimiters
    // (e.g. "patient came by fever and body pain for the past 3 days").
    // Fall through to noting the dosing in treatmentNotes rather than
    // producing a junk row the doctor has to clear by hand.
    const wordCount = name ? name.split(/\s+/).filter(Boolean).length : 0;
    if (wordCount > 5) {
      const durationMatchEarly = segment.match(durationRegex);
      const durFrag = durationMatchEarly ? `${durationMatchEarly[1]} ${durationMatchEarly[2]}` : '';
      ambiguousDosingNotes.push(
        `Dosing mentioned: ${dosage}${durFrag ? ', for ' + durFrag : ''} (drug name unclear — please confirm)`,
      );
      continue;
    }

    if (!name) name = 'Unknown Medication';

    const frequencyParts = [];

    if (notationMatch) {
      const morning = parseInt(notationMatch[1], 10) > 0;
      const noon = parseInt(notationMatch[2], 10) > 0;
      const night = parseInt(notationMatch[3], 10) > 0;
      const slots = [morning && 'morning', noon && 'noon', night && 'night'].filter(Boolean);
      const count = slots.length;
      const freq = count === 3 ? 'Thrice daily' : count === 2 ? 'Twice daily' : count === 1 ? 'Once daily' : '';
      if (freq) frequencyParts.push(freq);
      if (slots.length) frequencyParts.push(slots.join(', '));
    } else {
      if (lowerSeg.includes('once daily') || lowerSeg.includes('once a day') || lowerSeg.includes('ஒரு முறை')) {
        frequencyParts.push('Once daily');
      } else if (lowerSeg.includes('twice daily') || lowerSeg.includes('two times') || lowerSeg.includes('இரண்டு முறை')) {
        frequencyParts.push('Twice daily');
      } else if (lowerSeg.includes('thrice') || lowerSeg.includes('three times') || lowerSeg.includes('மூன்று முறை')) {
        frequencyParts.push('Thrice daily');
      } else if (/(every \d+ hours)/i.test(lowerSeg)) {
        const m = lowerSeg.match(/(every \d+ hours)/i)[0];
        frequencyParts.push(m.charAt(0).toUpperCase() + m.slice(1));
      } else {
        // Doctors writing twice-daily commonly say either "morning + night" or
        // "morning + evening" (காலை மாலை). Treat both pairs as Twice daily.
        const hasMorning = lowerSeg.includes('morning') || lowerSeg.includes('காலை');
        const hasEvening = lowerSeg.includes('evening') || lowerSeg.includes('மாலை');
        const hasNight = lowerSeg.includes('night') || lowerSeg.includes('bedtime') || lowerSeg.includes('இரவு');
        const slotsHit = [hasMorning, hasEvening, hasNight].filter(Boolean).length;
        if (slotsHit >= 2) frequencyParts.push(slotsHit === 3 ? 'Thrice daily' : 'Twice daily');
        else if (hasMorning) frequencyParts.push('Once daily');
      }

      const timingPieces = [];
      if (lowerSeg.includes('morning') || lowerSeg.includes('காலை')) timingPieces.push('morning');
      if (lowerSeg.includes('afternoon') || lowerSeg.includes('மதியம்')) timingPieces.push('afternoon');
      if (lowerSeg.includes('evening') || lowerSeg.includes('மாலை')) timingPieces.push('evening');
      if (lowerSeg.includes('night') || lowerSeg.includes('bedtime') || lowerSeg.includes('இரவு')) timingPieces.push('night');
      // Mixing instructions: Tamil (தேனில் கலந்து) and English variants.
      if (segment.includes('தேனில்') || lowerSeg.includes('with honey')) timingPieces.push('mixed with honey');
      if (segment.includes('நீரில்') || lowerSeg.includes('with water') || lowerSeg.includes('warm water')) timingPieces.push('with water');
      if (segment.includes('பாலில்') || lowerSeg.includes('with milk')) timingPieces.push('with milk');
      // Before/after food in English and Tamil (சாப்பாட்டிற்கு பின்/முன்).
      if (lowerSeg.includes('after food') || lowerSeg.includes('after meal') || segment.includes('சாப்பாட்டிற்கு பின்')) timingPieces.push('after food');
      else if (lowerSeg.includes('before food') || lowerSeg.includes('before meal') || segment.includes('சாப்பாட்டிற்கு முன்')) timingPieces.push('before food');
      if (timingPieces.length) frequencyParts.push(timingPieces.join(', '));
    }

    const durationMatch = segment.match(durationRegex);
    const duration = durationMatch ? `${durationMatch[1]} ${durationMatch[2]}` : '';

    result.medications.push({
      name,
      dosage,
      frequency: frequencyParts.join(' · '),
      duration,
    });
  }

  // Fold instructions + ambiguous-dosing fragments into treatmentNotes since
  // the simplified shape has no separate fields for them.
  const allBulletLines = [
    ...collectedInstructions.map((i) => `• ${i}`),
    ...ambiguousDosingNotes.map((n) => `• ${n}`),
  ];
  const bullets = allBulletLines.join('\n');
  if (bullets) {
    result.treatmentNotes = treatmentNotesHeader
      ? `${treatmentNotesHeader}\n${bullets}`
      : bullets;
  } else {
    result.treatmentNotes = treatmentNotesHeader;
  }

  return result;
}

function matchHeader(text, regex) {
  const m = text.match(regex);
  return m && m[1] ? m[1].trim() : '';
}

function extractFollowUpDate(text) {
  // Resolve "follow-up in N days/weeks/months" / "review after N..." against
  // today's date. The frontend's <Input type="date"> needs YYYY-MM-DD.
  const m = text.match(/\b(?:follow-?up|review)(?:\s+(?:in|after))?\s+(\d+)\s*(day|days|week|weeks|month|months)\b/i);
  if (!m) return '';
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const date = new Date();
  if (unit.startsWith('day')) date.setDate(date.getDate() + n);
  else if (unit.startsWith('week')) date.setDate(date.getDate() + n * 7);
  else if (unit.startsWith('month')) date.setMonth(date.getMonth() + n);
  return date.toISOString().slice(0, 10);
}
