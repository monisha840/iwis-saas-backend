/**
 * IWIS Super Admin — FeatureRegistry seed
 * ───────────────────────────────────────
 * Inserts the initial 15 platform features (spec §3.4) into FeatureRegistry.
 * Idempotent: uses upsert on `key`. Safe to run on every deploy.
 *
 * Run: node prisma/seed-feature-registry.js
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FEATURES = [
  // Core — always enabled, all plans
  { key: 'TRIAGE_SYSTEM',           displayName: 'Triage system',             phase: 'CORE',    minPlan: 'STARTER',      isCore: true,  defaultEnabled: true,  description: 'Symptom triage wizard and weighted specialty routing.' },
  { key: 'GAMIFICATION',            displayName: 'Gamification',              phase: 'CORE',    minPlan: 'STARTER',      isCore: true,  defaultEnabled: true,  description: 'Clinician XP, badges, streaks, leaderboard.' },
  { key: 'CARE_GAP_DETECTION',      displayName: 'Care gap detection',        phase: 'CORE',    minPlan: 'STARTER',      isCore: true,  defaultEnabled: true,  description: 'Automated detection of at-risk patients.' },
  { key: 'MULTI_BRANCH',            displayName: 'Multi-branch management',   phase: 'CORE',    minPlan: 'STARTER',      isCore: true,  defaultEnabled: true,  description: 'Branch CRUD, attendance, performance scorecards.' },
  { key: 'REFERRAL_PROGRAM',        displayName: 'Referral rewards',          phase: 'CORE',    minPlan: 'STARTER',      isCore: true,  defaultEnabled: true,  description: 'Patient-to-patient referral + tiered badges.' },

  // Phase 2 — Professional / Enterprise
  { key: 'AMBIENT_VOICE_TO_NOTE',   displayName: 'Ambient voice-to-note',     phase: 'PHASE_2', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'Live consultation speech transcribed into SOAP notes.' },
  { key: 'BEHAVIOURAL_NUDGE_ENGINE',displayName: 'Behavioural nudge engine',  phase: 'PHASE_2', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'Context-aware patient nudges for adherence.' },
  { key: 'EXPLAINABLE_AI',          displayName: 'Explainable AI',            phase: 'PHASE_2', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'Clinician-facing rationale for AI recommendations.' },

  // Phase 3 — Professional / Enterprise
  { key: 'PREDICTIVE_DOSHA_ENGINE', displayName: 'Predictive Dosha engine',   phase: 'PHASE_3', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'AI-assisted Ayurvedic Dosha typing and drift detection.' },
  { key: 'MULTI_AGENT_ORCHESTRATION',displayName: 'Multi-agent orchestration',phase: 'PHASE_3', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'Coordinated AI agents (triage, dosing, follow-up).' },
  { key: 'AYURVEDIC_VOICE_COACH',   displayName: 'Ayurvedic voice coach (Tamil)', phase: 'PHASE_3', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'Tamil-language patient coaching via voice.' },
  { key: 'VOICE_COACH_EXTRACTIVE_ONLY', displayName: 'Voice coach extractive RAG (no LLM)', phase: 'PHASE_3', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'When enabled, voice coach answers via templated extractive RAG with no LLM call. Default off; flip per hospital for cutover.' },
  { key: 'AI_REVENUE_CYCLE',        displayName: 'AI revenue cycle (AYUSH billing)', phase: 'PHASE_3', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'Automated AYUSH claim coding and submission.' },
  { key: 'MULTIMODAL_DIAGNOSTIC_AI',displayName: 'Multimodal diagnostic AI',  phase: 'PHASE_3', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: false, description: 'Image + text + vitals fused diagnostic assist.' },

  // Phase 4 — Enterprise only
  { key: 'PATIENT_DIGITAL_TWIN',    displayName: 'Patient digital twin',      phase: 'PHASE_4', minPlan: 'ENTERPRISE',   isCore: false, defaultEnabled: false, description: 'Simulated patient model for treatment A/B.' },
  { key: 'FEDERATED_LEARNING',      displayName: 'Federated learning',        phase: 'PHASE_4', minPlan: 'ENTERPRISE',   isCore: false, defaultEnabled: false, description: 'Cross-hospital model training without data sharing.' },

  // IWIS Competitor feature additions (phase IWIS_COMPETITOR)
  { key: 'BRANCH_CAPACITY',          displayName: 'Branch capacity (beds & rooms)', phase: 'IWIS_COMPETITOR', minPlan: 'STARTER',      isCore: true,  defaultEnabled: true, description: 'Bed census, room inventory, IPD/OPD toggles, operating hours.' },
  { key: 'THERAPY_ROOM_MANAGEMENT',  displayName: 'Therapy room scheduling',        phase: 'IWIS_COMPETITOR', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'First-class bookable therapy rooms alongside therapist slots.' },
  { key: 'DIET_PRESCRIPTION',        displayName: 'Diet prescription & adherence',  phase: 'IWIS_COMPETITOR', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Structured Pathya-Apathya meal plans with patient adherence tracking.' },
  { key: 'CLINICAL_PHOTOS',          displayName: 'Clinical photos (before/after)', phase: 'IWIS_COMPETITOR', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Staged photo progress with side-by-side comparison UI.' },
  { key: 'THERAPIST_SKILL_MATCHING', displayName: 'Therapist skill matching',       phase: 'IWIS_COMPETITOR', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Rank therapists by required Ayurvedic skills and current load.' },
  { key: 'TREATMENT_PACKAGES',       displayName: 'Treatment packages',             phase: 'IWIS_COMPETITOR', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Bundled multi-day programmes with auto-generated invoices.' },
  { key: 'GROUP_SESSIONS',           displayName: 'Group therapy sessions',         phase: 'IWIS_COMPETITOR', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'One therapist, many patients — yoga, breathing, preparation rituals.' },

  // Operations (phase OPERATIONS)
  { key: 'RESOURCE_SHARING',         displayName: 'Cross-branch resource sharing',  phase: 'OPERATIONS', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Approval workflow for loaning doctors between branches.' },
  { key: 'CENTRALIZED_INVENTORY',    displayName: 'Centralized inventory',          phase: 'OPERATIONS', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Cross-branch medicine stock view and inter-branch transfers.' },
  { key: 'STAFF_ACTIVITY_FEED',      displayName: 'Staff activity feed',            phase: 'OPERATIONS', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Real-time clinician status (login / consulting / break / idle).' },
  { key: 'PERFORMANCE_SCORECARDS',   displayName: 'Performance scorecards',         phase: 'OPERATIONS', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Monthly / quarterly weighted clinician performance reports.' },
  { key: 'STAFF_ATTENDANCE',         displayName: 'Staff attendance & punctuality', phase: 'OPERATIONS', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Clock in / out, punctuality trends, branch attendance reports.' },
  { key: 'STAFF_SKILL_MATRIX',       displayName: 'Staff skill matrix',             phase: 'OPERATIONS', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Certifications, languages, and procedures per clinician with proficiency.' },

  // Clinician Gamification (phase CLINICIAN_GAMIFICATION)
  { key: 'CLINICIAN_XP',             displayName: 'Clinician XP & levels',          phase: 'CLINICIAN_GAMIFICATION', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: '6-tier level system with streak multiplier and XP ledger.' },
  { key: 'SEASONAL_CHALLENGES',      displayName: 'Seasonal challenges',            phase: 'CLINICIAN_GAMIFICATION', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Time-bound metric challenges with XP rewards.' },
  { key: 'ACHIEVEMENT_SHOWCASE',     displayName: 'Achievement showcase',           phase: 'CLINICIAN_GAMIFICATION', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Public profile of badges, XP, streaks.' },
  { key: 'REWARD_STORE',             displayName: 'Reward store',                   phase: 'CLINICIAN_GAMIFICATION', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Redeem zen points / XP for rewards.' },
  { key: 'MENTOR_SESSIONS',          displayName: 'Mentor sessions',                phase: 'CLINICIAN_GAMIFICATION', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Schedule and track mentoring with XP rewards.' },

  // Patient Gamification (phase PATIENT_GAMIFICATION)
  { key: 'HEALTH_QUESTS',            displayName: 'Health quests',                  phase: 'PATIENT_GAMIFICATION', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Multi-step wellness quests with zen-point rewards.' },
  { key: 'HEALTH_AVATAR',            displayName: 'Health avatar / companion',      phase: 'PATIENT_GAMIFICATION', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Virtual plant / pet / character that evolves with adherence.' },
  { key: 'FAMILY_LEADERBOARD',       displayName: 'Family leaderboard',             phase: 'PATIENT_GAMIFICATION', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Family wellness competition with invite codes.' },
  { key: 'REFERRAL_TIERS',           displayName: 'Tiered referral rewards',        phase: 'PATIENT_GAMIFICATION', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Bronze / Silver / Gold / Platinum referral badges and rewards.' },
  { key: 'SOCIAL_PROOF',             displayName: 'Social proof & streaks',         phase: 'PATIENT_GAMIFICATION', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Percentile rank, motivational nudges, streak milestones.' },
  { key: 'UNLOCKABLE_CONTENT',       displayName: 'Unlockable health content',      phase: 'PATIENT_GAMIFICATION', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Level-gated patient content library.' },

  // Communication & Portal (phase COMMUNICATION)
  { key: 'ANNOUNCEMENTS',            displayName: 'Announcements',                  phase: 'COMMUNICATION', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Intra-branch broadcasts with role targeting, pinning, expiry.' },
  { key: 'HANDOFF_NOTES',            displayName: 'Handoff notes',                  phase: 'COMMUNICATION', minPlan: 'STARTER',      isCore: false, defaultEnabled: true, description: 'Structured patient handoff between clinicians.' },
  { key: 'PATIENT_PORTAL',           displayName: 'Patient portal',                 phase: 'COMMUNICATION', minPlan: 'STARTER',      isCore: true,  defaultEnabled: true, description: 'Self-service patient dashboard with aggregated data.' },
  { key: 'VISIT_SUMMARY',            displayName: 'Post-visit summary',             phase: 'COMMUNICATION', minPlan: 'PROFESSIONAL', isCore: false, defaultEnabled: true, description: 'Auto-generated visit summaries with diagnosis, prescriptions, advice.' },
];

async function main() {
  let inserted = 0;
  let updated = 0;

  for (const f of FEATURES) {
    const before = await prisma.featureRegistry.findUnique({ where: { key: f.key } });
    await prisma.featureRegistry.upsert({
      where: { key: f.key },
      create: { ...f, addedInVersion: '1.0.0' },
      update: {
        displayName: f.displayName,
        description: f.description,
        phase: f.phase,
        minPlan: f.minPlan,
        isCore: f.isCore,
        defaultEnabled: f.defaultEnabled,
      },
    });
    if (before) updated++;
    else inserted++;
  }

  // Ensure the default hospital has a flag row for every registry entry.
  const defaultHospital = await prisma.hospital.findUnique({ where: { id: 'hosp_default_alshifa' } });
  if (defaultHospital) {
    for (const f of FEATURES) {
      await prisma.hospitalFeatureFlag.upsert({
        where: { hospitalId_featureKey: { hospitalId: defaultHospital.id, featureKey: f.key } },
        create: {
          hospitalId: defaultHospital.id,
          featureKey: f.key,
          enabled: f.defaultEnabled,
          enabledAt: f.defaultEnabled ? new Date() : null,
        },
        update: {},
      });
    }
    console.log(`[feature-registry] Default hospital flags synced.`);
  }

  console.log(`[feature-registry] inserted=${inserted} updated=${updated} total=${FEATURES.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
