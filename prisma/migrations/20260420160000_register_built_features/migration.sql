-- Registers all built features that were missing from FeatureRegistry so they
-- surface in the Super Admin Features tab. Idempotent via ON CONFLICT DO UPDATE.
--
-- Scope (29 keys):
--   IWIS competitor (7)   : BRANCH_CAPACITY, THERAPY_ROOM_MANAGEMENT, DIET_PRESCRIPTION,
--                           CLINICAL_PHOTOS, THERAPIST_SKILL_MATCHING, TREATMENT_PACKAGES,
--                           GROUP_SESSIONS
--   Operations (6)        : RESOURCE_SHARING, CENTRALIZED_INVENTORY, STAFF_ACTIVITY_FEED,
--                           PERFORMANCE_SCORECARDS, STAFF_ATTENDANCE, STAFF_SKILL_MATRIX
--   Clinician XP (6)      : CLINICIAN_XP, SEASONAL_CHALLENGES, TEAM_QUESTS,
--                           ACHIEVEMENT_SHOWCASE, REWARD_STORE, MENTOR_SESSIONS
--   Patient gamification  : HEALTH_QUESTS, HEALTH_AVATAR, FAMILY_LEADERBOARD,
--                           REFERRAL_TIERS, SOCIAL_PROOF, UNLOCKABLE_CONTENT
--   Communication (4)     : ANNOUNCEMENTS, HANDOFF_NOTES, PATIENT_PORTAL, VISIT_SUMMARY

INSERT INTO "FeatureRegistry" ("id", "key", "displayName", "description", "phase", "minPlan", "isCore", "defaultEnabled", "addedInVersion", "updatedAt") VALUES
  -- ── IWIS Competitor (phase: IWIS_COMPETITOR) ─────────────────────────────
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
  (gen_random_uuid()::text, 'TREATMENT_PACKAGES',       'Treatment packages',             'Bundled multi-day programmes with auto-generated invoices and session tracking.',
   'IWIS_COMPETITOR', 'PROFESSIONAL', FALSE, TRUE,  '1.1.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'GROUP_SESSIONS',           'Group therapy sessions',         'One therapist, many patients — yoga, breathing, preparation rituals.',
   'IWIS_COMPETITOR', 'PROFESSIONAL', FALSE, TRUE,  '1.1.0', CURRENT_TIMESTAMP),

  -- ── Operations (phase: OPERATIONS) ───────────────────────────────────────
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

  -- ── Clinician Gamification (phase: CLINICIAN_GAMIFICATION) ───────────────
  (gen_random_uuid()::text, 'CLINICIAN_XP',             'Clinician XP & levels',          '6-tier level system with streak multiplier and XP ledger.',
   'CLINICIAN_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SEASONAL_CHALLENGES',      'Seasonal challenges',            'Time-bound metric challenges with XP rewards.',
   'CLINICIAN_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'TEAM_QUESTS',              'Team quests',                    'Branch-wide cooperative goals with shared XP rewards.',
   'CLINICIAN_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'ACHIEVEMENT_SHOWCASE',     'Achievement showcase',           'Public profile of badges, XP, streaks.',
   'CLINICIAN_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REWARD_STORE',             'Reward store',                   'Redeem zen points / XP for rewards.',
   'CLINICIAN_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'MENTOR_SESSIONS',          'Mentor sessions',                'Schedule and track mentoring with XP rewards.',
   'CLINICIAN_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),

  -- ── Patient Gamification (phase: PATIENT_GAMIFICATION) ───────────────────
  (gen_random_uuid()::text, 'HEALTH_QUESTS',            'Health quests',                  'Multi-step wellness quests with zen-point rewards.',
   'PATIENT_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'HEALTH_AVATAR',            'Health avatar / companion',      'Virtual plant / pet / character that evolves with adherence.',
   'PATIENT_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'FAMILY_LEADERBOARD',       'Family leaderboard',             'Family wellness competition with invite codes.',
   'PATIENT_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'REFERRAL_TIERS',           'Tiered referral rewards',        'Bronze→Silver→Gold→Platinum referral badges and rewards.',
   'PATIENT_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'SOCIAL_PROOF',             'Social proof & streaks',         'Percentile rank, motivational nudges, streak milestones.',
   'PATIENT_GAMIFICATION', 'STARTER',      FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'UNLOCKABLE_CONTENT',       'Unlockable health content',      'Level-gated patient content library.',
   'PATIENT_GAMIFICATION', 'PROFESSIONAL', FALSE, TRUE,  '1.0.0', CURRENT_TIMESTAMP),

  -- ── Communication & Portal (phase: COMMUNICATION) ────────────────────────
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

-- Backfill HospitalFeatureFlag rows so Super Admin sees toggles immediately,
-- without waiting for the nightly sync job (services/featureRegistrySync).
-- Uses the same rule as the sync job: enabled = (isCore OR defaultEnabled).
-- Skips already-existing rows so no operator-changed toggle is overwritten.
INSERT INTO "HospitalFeatureFlag" ("id", "hospitalId", "featureKey", "enabled", "enabledAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  h."id",
  fr."key",
  (fr."isCore" OR fr."defaultEnabled") AS enabled,
  CASE WHEN (fr."isCore" OR fr."defaultEnabled") THEN CURRENT_TIMESTAMP ELSE NULL END,
  CURRENT_TIMESTAMP
FROM "Hospital" h
CROSS JOIN "FeatureRegistry" fr
WHERE h."status" <> 'DECOMMISSIONED'
  AND fr."key" IN (
    'BRANCH_CAPACITY','THERAPY_ROOM_MANAGEMENT','DIET_PRESCRIPTION','CLINICAL_PHOTOS',
    'THERAPIST_SKILL_MATCHING','TREATMENT_PACKAGES','GROUP_SESSIONS',
    'RESOURCE_SHARING','CENTRALIZED_INVENTORY','STAFF_ACTIVITY_FEED',
    'PERFORMANCE_SCORECARDS','STAFF_ATTENDANCE','STAFF_SKILL_MATRIX',
    'CLINICIAN_XP','SEASONAL_CHALLENGES','TEAM_QUESTS','ACHIEVEMENT_SHOWCASE',
    'REWARD_STORE','MENTOR_SESSIONS',
    'HEALTH_QUESTS','HEALTH_AVATAR','FAMILY_LEADERBOARD','REFERRAL_TIERS',
    'SOCIAL_PROOF','UNLOCKABLE_CONTENT',
    'ANNOUNCEMENTS','HANDOFF_NOTES','PATIENT_PORTAL','VISIT_SUMMARY'
  )
ON CONFLICT ("hospitalId", "featureKey") DO NOTHING;
