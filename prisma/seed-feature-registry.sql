-- IWIS Super Admin — FeatureRegistry seed (raw SQL fallback)
-- Equivalent to prisma/seed-feature-registry.js; use this when Prisma client
-- regeneration is blocked on Windows by the running dev server.

INSERT INTO "FeatureRegistry" ("id", "key", "displayName", "description", "phase", "minPlan", "isCore", "defaultEnabled", "addedInVersion", "updatedAt") VALUES
  (gen_random_uuid()::text, 'TRIAGE_SYSTEM',             'Triage system',             'Symptom triage wizard and weighted specialty routing.',  'CORE',    'STARTER',      TRUE,  TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'GAMIFICATION',              'Gamification',              'Clinician XP, badges, streaks, leaderboard.',             'CORE',    'STARTER',      TRUE,  TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'CARE_GAP_DETECTION',        'Care gap detection',        'Automated detection of at-risk patients.',                'CORE',    'STARTER',      TRUE,  TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'MULTI_BRANCH',              'Multi-branch management',   'Branch CRUD, attendance, performance scorecards.',        'CORE',    'STARTER',      TRUE,  TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REFERRAL_PROGRAM',          'Referral rewards',          'Patient-to-patient referral + tiered badges.',            'CORE',    'STARTER',      TRUE,  TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'AMBIENT_VOICE_TO_NOTE',     'Ambient voice-to-note',     'Live consultation speech transcribed into SOAP notes.',   'PHASE_2', 'PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'BEHAVIOURAL_NUDGE_ENGINE',  'Behavioural nudge engine',  'Context-aware patient nudges for adherence.',             'PHASE_2', 'PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'EXPLAINABLE_AI',            'Explainable AI',            'Clinician-facing rationale for AI recommendations.',      'PHASE_2', 'PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PREDICTIVE_DOSHA_ENGINE',   'Predictive Dosha engine',   'AI-assisted Ayurvedic Dosha typing and drift detection.', 'PHASE_3', 'PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'MULTI_AGENT_ORCHESTRATION', 'Multi-agent orchestration', 'Coordinated AI agents (triage, dosing, follow-up).',      'PHASE_3', 'PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'AYURVEDIC_VOICE_COACH',     'Ayurvedic voice coach (Tamil)', 'Tamil-language patient coaching via voice.',          'PHASE_3', 'PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'VOICE_COACH_EXTRACTIVE_ONLY','Voice coach extractive RAG (no LLM)','When enabled, voice coach answers via templated extractive RAG with no LLM call.','PHASE_3','PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'AI_REVENUE_CYCLE',          'AI revenue cycle (AYUSH billing)', 'Automated AYUSH claim coding and submission.',     'PHASE_3', 'PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'MULTIMODAL_DIAGNOSTIC_AI',  'Multimodal diagnostic AI',  'Image + text + vitals fused diagnostic assist.',          'PHASE_3', 'PROFESSIONAL', FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PATIENT_DIGITAL_TWIN',      'Patient digital twin',      'Simulated patient model for treatment A/B.',              'PHASE_4', 'ENTERPRISE',   FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'FEDERATED_LEARNING',        'Federated learning',        'Cross-hospital model training without data sharing.',     'PHASE_4', 'ENTERPRISE',   FALSE, FALSE, '1.0.0', CURRENT_TIMESTAMP),

  -- ── IWIS Competitor feature additions (phase: IWIS_COMPETITOR) ──────────
  (gen_random_uuid()::text, 'BRANCH_CAPACITY',          'Branch capacity (beds & rooms)', 'Bed census, room inventory, IPD/OPD toggles, operating hours.',
   'IWIS_COMPETITOR', 'STARTER',      TRUE,  TRUE,  '1.1.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'THERAPY_ROOM_MANAGEMENT',  'Therapy room scheduling',        'First-class bookable therapy rooms alongside therapist slots.',
   'IWIS_COMPETITOR', 'STARTER',      FALSE, TRUE,  '1.1.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'DIET_PRESCRIPTION',        'Diet prescription & adherence',  'Structured Pathya-Apathya meal plans with patient adherence tracking.',
   'IWIS_COMPETITOR', 'PROFESSIONAL', FALSE, TRUE,  '1.1.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'CLINICAL_PHOTOS',          'Clinical photos (before/after)', 'Staged photo progress with side-by-side comparison UI.',
   'IWIS_COMPETITOR', 'PROFESSIONAL', FALSE, TRUE,  '1.1.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'THERAPIST_SKILL_MATCHING', 'Therapist skill matching',       'Rank therapists by required Ayurvedic skills and current load.',
   'IWIS_COMPETITOR', 'PROFESSIONAL', FALSE, TRUE,  '1.1.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TREATMENT_PACKAGES',       'Treatment packages',             'Bundled multi-day programmes with auto-generated invoices.',
   'IWIS_COMPETITOR', 'PROFESSIONAL', FALSE, TRUE,  '1.1.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'GROUP_SESSIONS',           'Group therapy sessions',         'One therapist, many patients — yoga, breathing, preparation rituals.',
   'IWIS_COMPETITOR', 'PROFESSIONAL', FALSE, TRUE,  '1.1.0', CURRENT_TIMESTAMP),

  -- ── Operations (phase: OPERATIONS) ──────────────────────────────────────
  (gen_random_uuid()::text, 'RESOURCE_SHARING',         'Cross-branch resource sharing',  'Approval workflow for loaning doctors between branches.',
   'OPERATIONS', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'CENTRALIZED_INVENTORY',    'Centralized inventory',          'Cross-branch medicine stock view and inter-branch transfers.',
   'OPERATIONS', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'STAFF_ACTIVITY_FEED',      'Staff activity feed',            'Real-time clinician status (login / consulting / break / idle).',
   'OPERATIONS', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PERFORMANCE_SCORECARDS',   'Performance scorecards',         'Monthly / quarterly weighted clinician performance reports.',
   'OPERATIONS', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'STAFF_ATTENDANCE',         'Staff attendance & punctuality', 'Clock in / out, punctuality trends, branch attendance reports.',
   'OPERATIONS', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'STAFF_SKILL_MATRIX',       'Staff skill matrix',             'Certifications, languages, and procedures per clinician with proficiency.',
   'OPERATIONS', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),

  -- ── Clinician Gamification (phase: CLINICIAN_GAMIFICATION) ──────────────
  (gen_random_uuid()::text, 'CLINICIAN_XP',             'Clinician XP & levels',          '6-tier level system with streak multiplier and XP ledger.',
   'CLINICIAN_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SEASONAL_CHALLENGES',      'Seasonal challenges',            'Time-bound metric challenges with XP rewards.',
   'CLINICIAN_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'ACHIEVEMENT_SHOWCASE',     'Achievement showcase',           'Public profile of badges, XP, streaks.',
   'CLINICIAN_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REWARD_STORE',             'Reward store',                   'Redeem zen points / XP for rewards.',
   'CLINICIAN_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'MENTOR_SESSIONS',          'Mentor sessions',                'Schedule and track mentoring with XP rewards.',
   'CLINICIAN_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),

  -- ── Patient Gamification (phase: PATIENT_GAMIFICATION) ──────────────────
  (gen_random_uuid()::text, 'HEALTH_QUESTS',            'Health quests',                  'Multi-step wellness quests with zen-point rewards.',
   'PATIENT_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'HEALTH_AVATAR',            'Health avatar / companion',      'Virtual plant / pet / character that evolves with adherence.',
   'PATIENT_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'FAMILY_LEADERBOARD',       'Family leaderboard',             'Family wellness competition with invite codes.',
   'PATIENT_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REFERRAL_TIERS',           'Tiered referral rewards',        'Bronze / Silver / Gold / Platinum referral badges and rewards.',
   'PATIENT_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SOCIAL_PROOF',             'Social proof & streaks',         'Percentile rank, motivational nudges, streak milestones.',
   'PATIENT_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'UNLOCKABLE_CONTENT',       'Unlockable health content',      'Level-gated patient content library.',
   'PATIENT_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),

  -- ── Communication & Portal (phase: COMMUNICATION) ───────────────────────
  (gen_random_uuid()::text, 'ANNOUNCEMENTS',            'Announcements',                  'Intra-branch broadcasts with role targeting, pinning, expiry.',
   'COMMUNICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'HANDOFF_NOTES',            'Handoff notes',                  'Structured patient handoff between clinicians.',
   'COMMUNICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'PATIENT_PORTAL',           'Patient portal',                 'Self-service patient dashboard with aggregated data.',
   'COMMUNICATION', 'STARTER',      TRUE,  TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'VISIT_SUMMARY',            'Post-visit summary',             'Auto-generated visit summaries with diagnosis, prescriptions, advice.',
   'COMMUNICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE SET
  "displayName"    = EXCLUDED."displayName",
  "description"    = EXCLUDED."description",
  "phase"          = EXCLUDED."phase",
  "minPlan"        = EXCLUDED."minPlan",
  "isCore"         = EXCLUDED."isCore",
  "defaultEnabled" = EXCLUDED."defaultEnabled",
  "updatedAt"      = CURRENT_TIMESTAMP;

-- Ensure the default hospital has a flag row for every feature, mirroring the
-- FeatureRegistrySync job — never overwrites enabled state for existing rows.
INSERT INTO "HospitalFeatureFlag" ("id", "hospitalId", "featureKey", "enabled", "enabledAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  'hosp_default_alshifa',
  fr."key",
  (fr."isCore" OR fr."defaultEnabled") AS enabled,
  CASE WHEN (fr."isCore" OR fr."defaultEnabled") THEN CURRENT_TIMESTAMP ELSE NULL END,
  CURRENT_TIMESTAMP
FROM "FeatureRegistry" fr
WHERE EXISTS (SELECT 1 FROM "Hospital" h WHERE h."id" = 'hosp_default_alshifa')
ON CONFLICT ("hospitalId", "featureKey") DO NOTHING;
