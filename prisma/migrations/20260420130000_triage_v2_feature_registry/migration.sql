-- ── Triage v2: FeatureRegistry entries ─────────────────────────────────────
-- Adding each v2 behaviour as a hospital-scoped flag so the super-admin console
-- can enable/disable them per tenant. Phase = "TRIAGE_V2". Upsert by `key`.

INSERT INTO "FeatureRegistry" ("id", "key", "displayName", "description", "phase", "minPlan", "isCore", "defaultEnabled", "addedInVersion", "updatedAt")
VALUES
  (
    gen_random_uuid()::text,
    'TRIAGE_RED_FLAGS',
    'Triage — Clinical Red Flags',
    'Forces CRITICAL urgency when hard clinical rules match (chest pain + radiation, thunderclap headache, stroke signs, pregnancy bleeding, anaphylaxis, suicidal ideation, critical vitals). Safety-critical — kept core.',
    'TRIAGE_V2', 'STARTER', true, true, '2026-04-20', CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid()::text,
    'TRIAGE_SPLIT_CONFIDENCE',
    'Triage — Split Confidence',
    'Shows input-completeness and routing-match-strength separately so clinicians can tell low confidence from sparse input vs ambiguous symptoms.',
    'TRIAGE_V2', 'STARTER', false, true, '2026-04-20', CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid()::text,
    'TRIAGE_RETRIAGE',
    'Triage — Patient Re-Triage Flow',
    'Lets a patient update symptoms on an existing triage session and re-score; auto-escalates admin doctors when urgency jumps.',
    'TRIAGE_V2', 'STARTER', false, true, '2026-04-20', CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid()::text,
    'TRIAGE_CONDITION_INTERACTIONS',
    'Triage — Condition × Symptom Interactions',
    'Adds a boost to the composite score for known dangerous combinations (e.g. Diabetes + chest pain, Heart disease + shortness of breath).',
    'TRIAGE_V2', 'PROFESSIONAL', false, true, '2026-04-20', CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid()::text,
    'TRIAGE_AGE_VITALS_CONTEXT',
    'Triage — Age / Pregnancy / Vitals Context',
    'Elderly (≥65) and paediatric (≤5) patients with moderate+ pain get an age-adjusted boost; pregnancy context and mild out-of-range vitals are factored in.',
    'TRIAGE_V2', 'PROFESSIONAL', false, true, '2026-04-20', CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid()::text,
    'TRIAGE_AUTO_HOLD_SLOT',
    'Triage — Auto-Hold Priority Slot',
    'On URGENT/CRITICAL triage, reserves the next available admin-doctor slot for 10 minutes so the patient can one-tap confirm the booking.',
    'TRIAGE_V2', 'PROFESSIONAL', false, true, '2026-04-20', CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid()::text,
    'TRIAGE_DOCTOR_OVERRIDE',
    'Triage — Clinician Override Ledger',
    'Lets DOCTOR / ADMIN_DOCTOR users override urgency or specialty after reviewing a triage; each override is appended to a ledger for weight tuning.',
    'TRIAGE_V2', 'PROFESSIONAL', false, true, '2026-04-20', CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid()::text,
    'TRIAGE_DB_ROUTING',
    'Triage — DB-Backed Specialty Routing',
    'Reads the active SpecialtyRoute table for tag → specialty mapping instead of hardcoded rules. Admin doctors can tune the routing vocabulary without a deploy.',
    'TRIAGE_V2', 'ENTERPRISE', false, true, '2026-04-20', CURRENT_TIMESTAMP
  ),
  (
    gen_random_uuid()::text,
    'TRIAGE_OVERRIDE_STATS',
    'Triage — Override Analytics Dashboard',
    'Exposes aggregate override disagreement stats (per urgency, specialty, factor) for weight-tuning. Gated to ENTERPRISE tenants.',
    'TRIAGE_V2', 'ENTERPRISE', false, false, '2026-04-20', CURRENT_TIMESTAMP
  )
ON CONFLICT ("key") DO UPDATE SET
  "displayName"     = EXCLUDED."displayName",
  "description"     = EXCLUDED."description",
  "phase"           = EXCLUDED."phase",
  "minPlan"         = EXCLUDED."minPlan",
  "isCore"          = EXCLUDED."isCore",
  "defaultEnabled"  = EXCLUDED."defaultEnabled",
  "addedInVersion"  = EXCLUDED."addedInVersion",
  "updatedAt"       = CURRENT_TIMESTAMP;

-- Backfill HospitalFeatureFlag rows for every non-decommissioned hospital so
-- the UI shows them immediately instead of waiting for the nightly sync job.
-- Matches the policy in featureRegistrySync.service.js (enabled = isCore OR defaultEnabled).
INSERT INTO "HospitalFeatureFlag" ("id", "hospitalId", "featureKey", "enabled", "enabledAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  h."id",
  f."key",
  (f."isCore" OR f."defaultEnabled"),
  CASE WHEN (f."isCore" OR f."defaultEnabled") THEN CURRENT_TIMESTAMP ELSE NULL END,
  CURRENT_TIMESTAMP
FROM "Hospital" h
CROSS JOIN "FeatureRegistry" f
WHERE h."status" <> 'DECOMMISSIONED'
  AND f."phase" = 'TRIAGE_V2'
ON CONFLICT ("hospitalId", "featureKey") DO NOTHING;
