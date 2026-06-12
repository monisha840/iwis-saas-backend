# IWIS Platform Documentation

**Snapshot: 2026-06-11 · Compiled after the RAG + Extractive-RAG cutover for F06 Voice Health Coach.**

Compiled from the live Prisma schema (80+ models, 90+ enums, 35+ feature flags), the route inventory (67 route files, ~500 endpoints), and the codebase as of commit `6d3b8df` plus the extractive-RAG follow-up work.

---

## 1. Executive summary

- **Tenancy**: Multi-hospital, multi-branch. `Hospital → Branch → User`. Per-tenant feature flags via `HospitalFeatureFlag`. SUPER_ADMIN role transcends scoping.
- **Roles**: 7 roles (SUPER_ADMIN, ADMIN_DOCTOR, ADMIN/BRANCH_ADMIN, DOCTOR, THERAPIST, PHARMACIST, PATIENT). Two-tier gate: hospital flag + branch/role check.
- **Tech**: Node 24 + Express ESM, Prisma 5.22 on PostgreSQL/Supabase, BullMQ on Redis, Socket.IO, React 18 + Vite + TypeScript + Tailwind + shadcn/ui.
- **Status**: 27 test files, **383 unit + integration tests passing**.
- **Recent shipped**: F06 Voice Coach v2 (RAG + Extractive RAG with bilingual corpus, no LLM at runtime when flag is on), F02 Ambient Voice-to-Note, F03 Tongue Pariksha, F04 Predictive Dosha, F05 Behavioural Nudge, F07 Multi-Agent Orchestration, F08 Explainable AI.

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js 24 + Express (ESM) |
| Frontend | React 18 + Vite + TypeScript + Tailwind + shadcn/ui |
| Database | PostgreSQL via Supabase (transaction pooler @ 6543 for runtime, direct @ 5432 for migrations) |
| ORM | Prisma 5.22 |
| Async jobs | BullMQ on Redis (Memurai on dev Windows, Redis 7 in prod) |
| Real-time | Socket.IO (`emitToUser` helper for per-user fanout) |
| Auth | JWT + refresh tokens + optional TOTP MFA |
| File storage | Supabase Storage (clinical photos, audio, PDFs) |
| WhatsApp delivery | Evolution API (self-hosted, BullMQ-queued) |
| Video consult | Daily.co (room provisioning + webhook lifecycle) |
| STT | OpenAI Whisper API (`whisper-1`) |
| TTS (voice coach) | Google Cloud Text-to-Speech (Tamil + English) |
| LLM | OpenAI GPT-4o / GPT-4o-mini (chat completions) — **bypassed for voice coach when `VOICE_COACH_EXTRACTIVE_ONLY` flag is on** |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim, multilingual) |
| Observability | Sentry, Bull-Board at `/admin/queues` |
| API docs | Swagger UI at `/api/docs` |

---

## 3. Repository layout

```
Alshifa_Ayush/
├── alshifa-backend/
│   ├── index.js                       # Express bootstrap, route mounting
│   ├── prisma/
│   │   ├── schema.prisma              # 80+ models
│   │   ├── seed-feature-registry.js   # Idempotent feature flag seeding (npm run seed:feature-registry)
│   │   ├── seed-feature-registry.sql  # Manual seed for MD-owned DBs
│   │   ├── manual-pending-migrations/ # SQL the MD applies on Supabase
│   │   └── migrations/                # Prisma migrations
│   ├── routes/                        # 67 route files
│   ├── services/                      # Business logic
│   │   └── voiceCoach/
│   │       ├── session.service.js     # Per-turn orchestrator
│   │       ├── stt.service.js         # Whisper wrapper + repetition-collapse filter
│   │       ├── llm.service.js         # gpt-4o-mini path (legacy, kept behind flag)
│   │       ├── extractiveResponder.js # NEW. Templated extractive RAG, no LLM
│   │       ├── ragRetriever.js        # Lazy-load corpus + cosine + language + dosha filter
│   │       ├── context.service.js     # Patient context build
│   │       ├── escalation.service.js  # Safety classifier
│   │       ├── tts.service.js         # GCP TTS wrapper
│   │       └── prompts.js             # System prompt + RAG injection
│   ├── data/
│   │   ├── ayurvedicTips.js           # 600 curated English tips (Vata/Pitta/Kapha × 6 ritu + General)
│   │   └── ragCorpus/
│   │       ├── topic-passages.md      # 10 English seed passages (MD-review pending)
│   │       ├── topic-passages-ta.md   # 10 Tamil passages (gpt-4o draft + MD review)
│   │       ├── seed-tips-ta.json      # 600 Tamil tips
│   │       └── corpus.json            # Generated artefact (~35 MB, 1220 passages, gitignored)
│   ├── scripts/
│   │   ├── buildRagIndex.js           # One-off corpus embedding (~$0.001)
│   │   ├── translateCorpusToTamil.js  # One-time gpt-4o Tamil translation (~$1.10)
│   │   └── toggleExtractiveFlag.js    # Per-hospital flip for VOICE_COACH_EXTRACTIVE_ONLY
│   ├── jobs/                          # BullMQ job definitions
│   ├── middleware/                    # auth, validate, audit, errorHandler, featureGate
│   ├── lib/                           # prisma, logger, sentry, redis
│   └── config/
└── alshifa-frontend/
    ├── src/
    │   ├── pages/
    │   ├── components/
    │   │   ├── consultation/
    │   │   ├── patient/
    │   │   ├── doctor/
    │   │   └── ui/                    # shadcn primitives
    │   ├── services/
    │   ├── hooks/
    │   └── lib/
```

---

## 4. Multi-tenant architecture

- **Hospital** is the tenant. Has `slug`, `plan` (STARTER / PROFESSIONAL / ENTERPRISE), `status` (ACTIVE / SUSPENDED / PENDING_SETUP / DECOMMISSIONED).
- **Branch** belongs to a Hospital. Holds bed/room inventory, operating hours, weeklyClosedDays. Per-user `branchId` scopes most queries.
- **FeatureRegistry** is the global catalogue of 35+ feature flags. **HospitalFeatureFlag** carries per-tenant enable/disable.
- `requireFeature('FEATURE_KEY')` middleware gates endpoints. Default off for Phase 2+ AI features; default on for IWIS competitor parity (BRANCH_CAPACITY, CLINICAL_PHOTOS, etc.).
- **SUPER_ADMIN** transcends tenant scoping; sees `/api/super-admin/*` and `/admin/queues`.

### Feature gate logic (utils/featureGate.js)

```
Layer 1a: Is the key in FeatureRegistry? If not → fail OPEN (newly built features remain usable until seed lands).
Layer 1b: Hospital flag in HospitalFeatureFlag. Falls back to registry.defaultEnabled.
Layer 2:  Legacy FeatureFlag table — branch + role allow-lists.
```

---

## 5. Roles & Permissions

| Role | Scope | Primary surfaces | What they can do |
|---|---|---|---|
| **SUPER_ADMIN** | Cross-tenant | `/api/super-admin/*`, `/admin/queues` | Hospital CRUD, plan changes, per-hospital feature flag toggles, cross-hospital audit, Bull-Board access |
| **ADMIN_DOCTOR** | Branch lead | `/doctor-admin` dashboard | Everything a DOCTOR can do + staff management, branch analytics, approval workflows, triage override config |
| **ADMIN** / **BRANCH_ADMIN** | Branch ops | `/admin` dashboard | Users CRUD (in-branch), feature flag panel, reports, audit feed, queue board, walk-in booking, reminders |
| **DOCTOR** | Branch clinician | `/doctor` dashboard, `/consultation/:id` | Consultations, prescriptions, triage review, prescribed-vitals, journey planning, voice-note, health reports |
| **THERAPIST** | Branch clinician | `/therapist` dashboard, `/therapist/session/:id` | Therapy sessions (in-clinic + home), SOAP notes, therapy outcomes, group sessions, home-therapy GPS tracking |
| **PHARMACIST** | Branch pharmacy | Pharmacy module | Medicine inventory, dispensing, order management, stock transfers, refill workflow |
| **PATIENT** | Self only | `/patient-portal`, `/triage`, `/self-exam`, `/patient/coach` | Daily check-ins, view records, self-vitals, Prakriti quiz, appointments, gamification, voice coach |

### Gate enforcement pattern

```js
router.post('/foo',
  authMiddleware,                        // JWT verification
  roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR']),
  requireFeature('EXPLAINABLE_AI'),      // hospital-level flag
  handler,
)
```

---

## 6. Core domain models (the spine)

| Model | Key fields | Owns |
|---|---|---|
| **User** | id, email, role, branchId, hospitalId, mfaEnabled | Auth + relationships hub (~100 FKs) |
| **Patient** | id, userId, dob, gender, allergies[], onboardingData JSON, preferredCoachLang, voiceCoachEnabled | All patient-side records |
| **Doctor** | id, userId, fullName, specialization, qualification, registrationNumber | Consultations, prescriptions |
| **Therapist** | id, userId, fullName, gender, languages[], skills | Therapy sessions, home-visit GPS |
| **Appointment** | patientId, doctorId/therapistId, date, status, consultationType, branchId, queuePosition, arrivalStatus, dailyRoomUrl, triageSessionId | Booking lifecycle |
| **TriageSession** | patientId, responses JSON, urgencyLevel, compositeScore, redFlagsMatched[], reasoning, suggestedSpecialty | Symptom-to-specialty routing |
| **Prescription** | patientId, doctorId, medicineId, dosage, frequency, dispensedQty, consumedQty, lifecycle dates | Med order + adherence |
| **PatientVital** | patientId (→ User.id ⚠), type (VitalType enum), value, recordedAt, source | All vital readings |
| **DailyCheckIn** | patientId (→ Patient.id), painLevel, painRegions JSON, sleepHours, mood, mobilityScore | Patient self-report |
| **ConstitutionProfile** | patientId (1:1), prakriti, satvaRating, agniType, quizAnswers | Ayurvedic constitution typing |
| **TreatmentJourney** | patientId (→ User.id ⚠), doctorId, condition, status, wellnessScore + phases/milestones/vitals | Illness-to-wellness plan |
| **VoiceConversation** | patientId, language, escalated, escalationNote, sessionSummary, turnCount | Voice coach sessions |
| **VoiceMessage** | conversationId, role (USER/ASSISTANT/SYSTEM), transcript, detectedIntent, severityFlag | Voice coach turns |
| **CareGap** | patientId, type, severity, predictedAt, resolvedAt | At-risk patient surfacing |
| **OrchestrationEvent** + **OrchestrationAction** | eventType, sourceModel/sourceId, agentName, status, attempts, idempotencyKey | Multi-agent cascade tracking |
| **FeatureRegistry** + **HospitalFeatureFlag** | key, displayName, phase, minPlan, isCore, defaultEnabled, enabled | Per-tenant feature toggles |
| **Hospital** | slug, plan, status, country, timezone | Multi-tenant root |

### Critical relationship gotchas

| Gotcha | Where | Why it matters |
|---|---|---|
| `PatientVital.patientId` → **User.id** (not Patient.id) | schema.prisma | Every new endpoint writing vitals must resolve Patient.id → User.id first |
| `TreatmentJourney.patientId` → **User.id** | TreatmentJourney model | Inconsistent with most patient-centric tables |
| `Appointment.arrivalStatus` mirrors `QueueEntry.arrivalStatus` | Both | Always written in same transaction. Don't update only one. |
| `PatientAssignment` rows are never deleted | Lifecycle | Query `status = 'ACTIVE'` to find current assignment |
| `_prisma_migrations` says all migrations applied but actual schema can drift | Phase-0 issue | Use `prisma migrate diff` to detect |

---

## 7. Feature catalogue (35+ shipped features)

### Core platform (all plans, defaultEnabled: true)

| Flag | What it does |
|---|---|
| `TRIAGE_SYSTEM` | Symptom triage wizard with weighted specialty routing, red-flag detection, composite scoring |
| `GAMIFICATION` | Clinician XP, badges, streaks, leaderboard |
| `CARE_GAP_DETECTION` | At-risk patient detection and critical journey flagging |
| `MULTI_BRANCH` | Branch CRUD, attendance, performance scorecards |
| `REFERRAL_PROGRAM` | Patient-to-patient referral with tiered badges |
| `PATIENT_PORTAL` | Self-service patient dashboard |
| `VISIT_SUMMARY` | Auto-generated post-visit summary |

### IWIS competitor parity (defaultEnabled: true)

| Flag | What it does |
|---|---|
| `BRANCH_CAPACITY` | Bed census, room inventory, IPD/OPD toggles, operating hours |
| `THERAPY_ROOM_MANAGEMENT` | Bookable therapy rooms (SHIRODHARA, ABHYANGA, PANCHAKARMA, STEAM, CONSULTATION, GROUP) |
| `DIET_PRESCRIPTION` | Pathya-Apathya meal plans with adherence tracking |
| `CLINICAL_PHOTOS` | Before/During/After photos × 5 categories with comparison view |
| `THERAPIST_SKILL_MATCHING` | Therapist ranking by Ayurvedic skills |
| `TREATMENT_PACKAGES` | Bundled multi-day programs with auto-invoicing |
| `GROUP_SESSIONS` | Group therapy sessions (yoga, breathing, rituals) |

### Operations

| Flag | What it does |
|---|---|
| `RESOURCE_SHARING` | Cross-branch doctor loan workflow (PENDING → COMPLETED) |
| `CENTRALIZED_INVENTORY` | Cross-branch medicine stock + transfer requests |
| `STAFF_ACTIVITY_FEED` | Real-time clinician status (login / consulting / break) |
| `PERFORMANCE_SCORECARDS` | Monthly/quarterly clinician performance reports |
| `STAFF_ATTENDANCE` | Clock in/out, punctuality trends |
| `STAFF_SKILL_MATRIX` | Certifications, languages, procedures per clinician |
| `ANNOUNCEMENTS` | Intra-branch broadcasts (role-targeted, pin, expiry) |
| `HANDOFF_NOTES` | Structured patient handoff between clinicians |

### Gamification

`CLINICIAN_XP`, `SEASONAL_CHALLENGES`, `ACHIEVEMENT_SHOWCASE`, `REWARD_STORE`, `MENTOR_SESSIONS` (clinician)
`HEALTH_QUESTS`, `HEALTH_AVATAR`, `FAMILY_LEADERBOARD`, `REFERRAL_TIERS`, `SOCIAL_PROOF`, `UNLOCKABLE_CONTENT` (patient)

### AI features (status as of 2026-06-11)

| Flag | Phase | Status |
|---|---|---|
| `AMBIENT_VOICE_TO_NOTE` | 2 | Shipped |
| `AYURVEDIC_VOICE_COACH` | 2 | Shipped at `/api/voice-coach` |
| **`VOICE_COACH_EXTRACTIVE_ONLY`** | 2 | **NEW. Shipped 2026-06-11.** When ON, voice coach uses templated extractive RAG with no LLM call. Off by default; flip per hospital via `node scripts/toggleExtractiveFlag.js on`. |
| `BEHAVIOURAL_NUDGE_ENGINE` | 2 | Shipped (LLM-personalised Monday Motivation + NudgeLog feedback loop) |
| `EXPLAINABLE_AI` | 2 | Shipped (Why? popover on Appointments page + Care Gaps table) |
| `MULTI_AGENT_ORCHESTRATION` | 2 | Shipped (critical-triage cascade — careGap + pharmacy + slotHold + dashboardSummariser agents) |
| `PREDICTIVE_DOSHA_ENGINE` | 3 | Shipped (rule-based v1, daily forecast cron) |
| `MULTIMODAL_DIAGNOSTIC_AI` | 3 | Shipped (tongue analysis via gpt-4o vision) |
| `AI_REVENUE_CYCLE` | 3 | Pending (blocked on ABDM external API) |
| `PATIENT_DIGITAL_TWIN` | 4 | Pending (needs outcome history) |
| `FEDERATED_LEARNING` | 4 | Pending (no Python ML stack) |

---

## 8. Backend API reference (key endpoints by domain)

67 route files mount under `/api/*` from `index.js`. Below: the spine routes by domain. Full inventory: `routes/` directory; Swagger at `/api/docs`.

### Auth & users

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /api/auth/register` | public | Patient signup |
| `POST /api/auth/login` | public | JWT issue (with optional MFA challenge) |
| `POST /api/auth/refresh` | (refresh token) | Rotate access token |
| `POST /api/auth/logout` / `logout-all` | auth | Revoke refresh tokens |
| `POST /api/auth/forgot-password` / `reset-password` | public | Token-based reset |
| `POST /api/auth/mfa/{setup,verify-setup,validate,disable}` | auth | TOTP MFA lifecycle |
| `GET /api/user/me` | auth | Self profile + feature flags |
| `GET /api/user/features` | auth | Active feature flags for caller's hospital |
| `GET /api/user/list-{doctors,therapists,patients,pharmacists}` | role-gated | Staff/patient directories |
| `POST /api/user/create-user` | ADMIN_DOCTOR, ADMIN | Staff onboarding |
| `POST /api/user/assign-patient` / `unassign-patient` | ADMIN_DOCTOR | PatientAssignment lifecycle |

### Appointments

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/appointments` | all clinicians + PATIENT | List w/ filters (scoped by role) |
| `POST /api/appointments` | PATIENT, ADMIN, ADMIN_DOCTOR | Book appointment |
| `POST /api/appointments/walk-in` | ADMIN, ADMIN_DOCTOR | Walk-in booking (skips approval) |
| `GET /api/appointments/available-slots` | all | Slot search with branch + clinician filters |
| `PUT /api/appointments/:id/approve` / `reject` | DOCTOR, THERAPIST, ADMIN_DOCTOR | Approval workflow |
| `POST /api/appointments/hold` | auth | Temporarily reserve a slot during booking |
| `GET /api/appointments/:id/follow-up` / `PUT` | DOCTOR, THERAPIST | Follow-up schedule attachment |

### Consultations & clinical notes

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /api/consultations/session/:appointmentId/start` | DOCTOR, ADMIN_DOCTOR | Start session, flip status to IN_PROGRESS |
| `POST /api/consultations/session/:appointmentId/notes` | DOCTOR, ADMIN_DOCTOR, THERAPIST | Save sessionNotes |
| `POST /api/consultations/session/:appointmentId/complete` | DOCTOR, ADMIN_DOCTOR | Complete + persist follow-up |
| `GET /api/visit-summary/appointment/:id` | auth | Visit summary read |
| `POST /api/visit-summary/appointment/:id` | DOCTOR, ADMIN_DOCTOR | Author visit summary |
| `POST /api/visit-summary/:id/send` | DOCTOR, ADMIN_DOCTOR | Send to patient portal |
| `GET /api/patient-history/:patientId` | clinicians | Full immutable patient passport |
| `POST /api/voice-note/refine` | DOCTOR, ADMIN_DOCTOR | Voice-dictated text → structured clinical note (LLM) |

### Triage

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /api/triage` | PATIENT | Submit triage form, get urgencyLevel + suggestedSpecialty |
| `POST /api/triage/:id/retriage` | PATIENT (feature: TRIAGE_RETRIAGE) | Update existing triage |
| `POST /api/triage/upload` / `:sessionId/media` | PATIENT | Attach photos/docs to triage session |
| `GET /api/triage/my-sessions` | PATIENT | Patient's own triage history |
| `GET /api/triage/sessions/:id` | DOCTOR, ADMIN_DOCTOR | Clinician inspect |
| `POST /api/triage/:id/review` | DOCTOR, ADMIN_DOCTOR (feature: TRIAGE_DOCTOR_OVERRIDE) | Override urgency/specialty + audit trail |
| `GET /api/triage/overrides/stats` | ADMIN_DOCTOR | Override disagreement analytics |
| `GET/PUT /api/triage/specialty-routes` | ADMIN_DOCTOR (feature: TRIAGE_DB_ROUTING) | Configure zone → specialty vocabulary |

### Voice Health Coach (F06 — fully shipped including extractive RAG)

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /api/voice-coach/sessions` | PATIENT (feature: AYURVEDIC_VOICE_COACH) | Start a session |
| `POST /api/voice-coach/sessions/:id/end` | PATIENT | End a session |
| `GET /api/voice-coach/sessions?take=N` | PATIENT | List past sessions |
| `POST /api/voice-coach/sessions/:id/audio-message` | PATIENT | Push-to-talk: multipart audio in, transcript + reply + TTS mp3 base64 out |
| `POST /api/voice-coach/sessions/:id/message` | PATIENT | Text-mode (no audio) |
| `POST /api/voice-coach/sessions/:id/doctor-note` | DOCTOR | Doctor injects a note for the patient |
| `PUT /api/voice-coach/preferences` | PATIENT | Set preferredCoachLang etc. |

### Per-turn pipeline (after extractive cutover)

```
audio (multipart) → Whisper STT (whisper-1, verbose_json, repetition-collapse filter)
       ↓
escalation.service.js classifier
       ├── severity HIGH/CRITICAL → SAFETY_REPLY template + notifyAssignedDoctor → return
       │
       └── severity NONE/LOW → check hospital flag VOICE_COACH_EXTRACTIVE_ONLY
                     ├── flag ON  → ExtractiveResponderService.generateReply
                     │              1. detectPersonalIntent (doctor/prescription/appointment/treatment_phase)
                     │                 → if hit: render from ctx, skip retrieval
                     │              2. retrievePassages(query, {topK:1, minSim:0.2, language})
                     │                 - language filter (en / ta)
                     │                 - dosha-tag soft filter (vata/pitta/kapha)
                     │                 - topic-passage score bonus over tips
                     │              3. pickRelevantSentences via keyword overlap
                     │              4. renderHit / renderNoHit template
                     │              → reply text (no LLM)
                     │
                     └── flag OFF → VoiceCoachLLMService.generateReply (legacy)
                                    1. retrievePassages(query, {topK:4, minSim:0.2})
                                    2. renderSystemPrompt(ctx, retrieved) — injects passages
                                    3. gpt-4o-mini chat completion
                                    → reply text + retrievedPassageIds in log
       ↓
persist VoiceMessage (USER + ASSISTANT)
       ↓
TTS (GCP Text-to-Speech) → mp3 base64 inline
       ↓
client renders text + autoplays audio
```

### Patients & profiles

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/patients` | clinicians | Patient list (branch-scoped) |
| `POST /api/patients/guest` | ADMIN, ADMIN_DOCTOR | Walk-in guest creation (no email/auth) |
| `GET /api/patients/:id/timeline` | clinicians | Aggregated clinical timeline |
| `GET /api/patients/:patientId/full-details` | clinicians | Static digital-twin endpoint |
| `GET /api/patients/:id/pain-map` | clinicians | Aggregated pain regions |
| `GET /api/patient/pain/my-map` | PATIENT | Patient self-view |
| `GET /api/patient/health-summary` | PATIENT | Self health summary |
| `GET /api/patients/:patientId/health-summary` | clinicians | Clinician view |
| `POST /api/patient/self-vitals` | PATIENT | Self-log Height/Weight/Pain/Sleep/Mood |
| `POST /api/patients/:patientId/vitals` | clinicians | Clinician records vitals |
| `POST /api/patients/:patientId/constitution` | clinicians | Clinician sets Prakriti |
| `PATCH /api/patients/:patientId/lifestyle-snapshot` | clinicians | Lifestyle observations |
| `GET/POST /api/patients/:patientId/prescribed-vitals` | DOCTOR, ADMIN_DOCTOR | Doctor prescribes patient-logged vitals |

### Prescriptions & pharmacy

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/prescriptions/search` | clinicians + PHARMACIST | Medicine search |
| `POST /api/prescriptions` / `add` / `batch-add` | DOCTOR, THERAPIST, ADMIN_DOCTOR | Create Rx |
| `POST /api/prescriptions/:id/discontinue` | DOCTOR, ADMIN_DOCTOR | End Rx with reason |
| `GET /api/prescriptions/:id/adherence` | clinicians + PATIENT-self | Adherence stats |
| `GET /api/prescriptions/:id/pdf` | clinicians + PATIENT-self | Branded Rx PDF |
| `GET/POST /api/pharmacy/medicines` | PHARMACIST + clinicians | Medicine catalogue CRUD |
| `POST /api/pharmacy/dispense` / `batch-dispense` | PHARMACIST | Dispensing flow |
| `GET /api/pharmacy/stock/low` | PHARMACIST + ADMIN | Low-stock alerts |
| `POST /api/pharmacy/orders` / `GET` / `PATCH /:id/status` | PHARMACIST + PATIENT-self | Pharmacy order lifecycle |
| `POST /api/refills` | PATIENT | Refill request |
| `PUT /api/refills/:id/{approve,fulfill}` | PHARMACIST, DOCTOR | Refill approval |

### Wellness & daily tracking

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /api/wellness/check-in` | PATIENT | 3-step daily check-in (pain, sleep, mood) |
| `GET /api/wellness/check-in/today` | PATIENT | Today's check-in status |
| `GET /api/wellness/stats` | PATIENT | Streaks + adherence stats |
| `POST /api/daily-tracking/{water,measurements,activity,meal-photos,full-day-bonus}` | PATIENT | 5-step daily tracking |
| `GET /api/daily-tracking/summary` | PATIENT | Aggregated tracking summary |

### Therapy

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/consultations/availability` / `POST` | THERAPIST | Weekly availability config |
| `POST /api/therapist-notes` | THERAPIST | SOAP-format note |
| `POST /api/therapy-outcomes` | THERAPIST | Per-session pain/mobility/swelling scores |
| `GET /api/therapy-outcomes/me` | PATIENT | Trend view |
| `POST /api/home-therapy/request` | DOCTOR, ADMIN_DOCTOR | Doctor authors home-therapy prescription |
| `PATCH /api/home-therapy/sessions/:id/{accept,location-ping,start,complete,cancel}` | THERAPIST | Home visit lifecycle + GPS pings |
| `GET /api/therapy-rooms` / `POST /bookings` | ADMIN, ADMIN_DOCTOR | Therapy room scheduling |
| `POST /api/group-sessions` / `GET` / `POST /:id/{enroll,attend}` | THERAPIST, ADMIN_DOCTOR | Group session lifecycle |

### Diet

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /api/diet-prescriptions` | DOCTOR, ADMIN_DOCTOR, THERAPIST | Author diet plan with meals |
| `GET /api/diet-prescriptions/patient/:id` | clinicians + PATIENT-self | List by patient |
| `POST /api/diet-prescriptions/:id/adherence` | PATIENT | Log meal-by-meal adherence |
| `GET /api/diet-packages` / `POST` / `PUT /:id/{approve,reject}` | ADMIN_DOCTOR, ADMIN | Diet package templates with approval workflow |
| `GET /api/ayurvedic-foods` / `recipes` | clinicians + PATIENT | Food + recipe catalogue |

### Queue management

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /api/queue/arrive` | ADMIN, ADMIN_DOCTOR | Mark patient arrived |
| `POST /api/queue/start-consultation` / `end-consultation` | DOCTOR | Consultation timestamps |
| `POST /api/queue/mark-absent` / `mark-contacted` | ADMIN, ADMIN_DOCTOR | Absent flow |
| `GET /api/queue/board` | clinicians | Live queue board state |

### Health reports & PDF

| Endpoint | Roles | Purpose |
|---|---|---|
| `POST /api/health-reports/generate` | DOCTOR, ADMIN_DOCTOR | Generate branded PDF + WhatsApp delivery |
| `GET /api/health-reports/patient/:id` | clinicians + PATIENT-self | List historical reports |
| `POST /api/health-reports/:id/resend` | DOCTOR, ADMIN_DOCTOR | Resend via WhatsApp |

### Communication

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET/POST /api/chat/conversations` | PATIENT + clinician | 1:1 patient-clinician chat |
| `POST /api/chat/conversations/:id/messages` | PATIENT + clinician | Send message |
| `GET/POST /api/staff-chat/threads` | clinicians | Staff DMs + group threads |
| `GET /api/notifications` | auth | In-app notifications |
| `PUT /api/notifications/preferences` | auth | Per-user notification settings |

### Self-exam + constitution

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/self-exam/zones` | PATIENT | List body zones for self-mapping |
| `POST /api/self-exam` | PATIENT | Submit self-exam form |
| `GET /api/self-exam/constitution/me` | PATIENT | Read own Prakriti profile |
| `POST /api/self-exam/constitution` | PATIENT | Submit Prakriti quiz |
| `POST /api/self-exam/upload-asset` | PATIENT | Attach photos/audio to self-exam |

### Care gaps + critical journey

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/care-gaps` | clinicians (feature: CARE_GAP_DETECTION) | List at-risk patients with reasons |
| `POST /api/care-gaps/:id/resolve` | clinicians | Mark gap resolved with note |
| `GET /api/critical-journey` | DOCTOR, ADMIN_DOCTOR | High-risk escalation queue |
| `PATCH /api/critical-journey/:id` | DOCTOR, ADMIN_DOCTOR | Update flag severity/status |

### Multi-agent orchestration (F07)

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/orchestration/briefings?status=UNREAD` | DOCTOR, ADMIN_DOCTOR | Orchestrated-action cards on dashboard |
| `PATCH /api/orchestration/briefings/:id/dismiss` | DOCTOR, ADMIN_DOCTOR | Mark briefing read |
| `GET /api/orchestration/events/:id/actions` | ADMIN, SUPER_ADMIN | Trace which agents fired for an event |

### Admin / audit / super-admin

| Endpoint | Roles | Purpose |
|---|---|---|
| `GET /api/audit-logs` | ADMIN_DOCTOR, ADMIN | Sensitive-action audit trail |
| `GET /api/feature-flags` / `PUT` | ADMIN_DOCTOR, ADMIN | Hospital-level feature toggle panel |
| `GET /api/super-admin/hospitals` / `POST` / `PUT /:id` | SUPER_ADMIN | Hospital CRUD |
| `PUT /api/super-admin/hospitals/:id/features/:flag` | SUPER_ADMIN | Per-hospital feature override |
| `GET /api/super-admin/audit` | SUPER_ADMIN | Cross-hospital audit |
| `/admin/queues` | SUPER_ADMIN | Bull-Board UI |
| `/api/docs` | auth | Swagger UI |

---

## 9. BullMQ jobs & background workers

| Queue / Worker | Trigger | What it does |
|---|---|---|
| `notification` | Per-event publish | Fan-out to NotificationDelivery records (push, WhatsApp, in-app) |
| `whatsapp` | Per-message publish | Rate-limited send via Evolution API; idempotent on `whatsappSentAt` |
| `daily-cards` | Cron 07:00 IST | Generates DailyMotivationCard per active patient (prakriti × season) + WhatsApp delivery |
| `health-report` | API call from Generate Report button | Renders branded PDF + Supabase upload + WhatsApp delivery |
| `attendance-roll` | Cron daily | Computes per-clinician attendance, marks LATE / ABSENT |
| `cleanup-uploads` | Cron nightly | Removes orphaned files in Supabase storage |
| `consultation-feedback-request` | 30s after appointment.complete | Triggers feedback prompt to patient |
| `home-therapy-brief` | Cron 07:00 IST | Daily home-therapy session brief + WhatsApp alerts to therapists |
| `orchestration-*` (4 queues: careGap, pharmacy, slotHold, dashboard) | Per `triage.critical.submitted` event | Multi-agent cascade |
| `dosha-forecast` | Cron 20:30 IST | Predictive Dosha imbalance scoring (F04) |
| `care-gap-detection` | Cron 07:00 IST | Scan inactive patients, write CareGap rows |
| `critical-journey-scan` | Every 4 hours | Re-evaluate high-risk patients |
| `workflow-engine-evaluation` | Hourly | Trigger automated workflow rules |
| `streak-at-risk` | Cron 20:00 IST | Push streak-loss-imminent nudges |
| `monday-motivation` | Cron Monday 10:00 IST | Weekly motivation card |
| `feature-registry-sync` | Cron 02:30 IST | Refresh registry from seed (idempotent) |

30+ scheduled jobs total — see boot log for full list.

---

## 10. Frontend pages by role

### Patient

| Route | Component | Purpose |
|---|---|---|
| `/patient` | `EnhancedPatientDashboard` | Today view: vitals tiles, appointments, motivation card |
| `/patient-portal` | `PatientPortal` | 7-tab records: Appointments, Prescriptions, My Vitals, My Progress, Visit Summaries, Health Reports, My Tips |
| `/patient/consultation` | `PatientConsultation` | Patient-side video room |
| `/patient/coach` | Voice Coach | F06 — push-to-talk + reply with TTS, English/Tamil toggle |
| `/self-exam` | `SelfExaminationKit` | Multi-step self-exam quiz (Prakriti, body zones) |
| `/health-quests` | `HealthQuests` | Active quests + progress |
| `/family-leaderboard` | `FamilyLeaderboard` | Family wellness comparison |
| `/health-avatar` | `HealthAvatar` | Virtual companion |
| `/health-content` | `HealthContentLibrary` | Unlockable content |
| `/social-proof` | `SocialProofDashboard` | Percentile + streak milestones |
| `/referral-rewards` | `ReferralRewards` | Referral code + tier badges |
| `/triage` | (triage wizard) | Submit triage |
| (Modal) | `DailyCheckIn` | 3-step daily check-in wizard |
| (Modal) | `LogVitalsModal` | Self-log vitals |

### Doctor / Admin Doctor

| Route | Component | Purpose |
|---|---|---|
| `/doctor` | `DoctorDashboard` | Today's queue, patients at-risk, performance widgets, OrchestratedActionsCard |
| `/doctor-admin` | (admin-doctor dashboard) | Doctor view + staff management surfaces |
| `/consultation/:appointmentId` | `ConsultationRoom` | Three-column: history rail / video or offline center / notes + snapshot + diet + retention |
| `/appointments` | (list) | Queue with filters |
| `/patients` | (directory) | Branch-scoped patient list |
| `/patients/:id` | (detail drawer) | Patient detail incl. timeline, vitals, journey |
| `/prescriptions` | (Rx surface) | Search + history |
| `/care-gaps` | (Care Gaps module) | At-risk patient list with reasons |
| `/critical-journey` | (escalation queue) | High-risk patient queue |
| `/handoff` | (handoff drafts) | Draft / sent / archived handoffs |

### Therapist

| Route | Component | Purpose |
|---|---|---|
| `/therapist` | `TherapistDashboard` | Today's queue + therapy outcomes |
| `/therapist/session/:appointmentId` | `SessionWorkspace` | SOAP-style note + outcome scoring |
| `/therapist/package-sessions` | (package log) | Sessions under a treatment package |
| `/home-therapy` | (queue + GPS) | Home-visit sessions with GPS pings |
| `/group-sessions` | (manager) | Schedule + roster + attendance |

### Pharmacist

| Route / surface | Purpose |
|---|---|
| Pharmacy dashboard | Medicine inventory, low-stock alerts |
| Dispense surface | Per-prescription dispense flow |
| Orders inbox | Pending orders / approvals |
| Stock transfer | Cross-branch transfer initiation + tracking |

### Admin / Branch Admin

| Route / surface | Purpose |
|---|---|
| `/admin` | Branch dashboard + audit feed |
| Users management | Create / edit doctors, therapists, pharmacists, patients |
| Feature flag panel | Hospital-level toggle UI |
| Reports | Revenue, performance scorecards, custom report builder |
| Specialty routes | Triage zone → specialty config |
| Reminder settings | Channel + cadence per reminder kind |

### Super Admin

| Route / surface | Purpose |
|---|---|
| Hospital CRUD | Create / suspend / decommission hospitals |
| Plan tier | STARTER / PROFESSIONAL / ENTERPRISE per hospital |
| Feature registry | Global flag definitions + per-hospital overrides |
| Cross-hospital audit | Platform-level audit feed |
| `/admin/queues` | Bull-Board (BullMQ inspection) |

---

## 11. Workflows by role

### Patient daily workflow (engagement loop)

1. **07:00 IST** — DailyMotivationCard cron pushes prakriti × season tip via WhatsApp.
2. **Morning** — Patient opens app → EnhancedPatientDashboard shows: appointments today, vitals tiles, streak status, daily challenge.
3. **Daily check-in** — DailyCheckIn modal: pain (body-map), sleep, mood, mobility. Triggers ZenPoints reward.
4. **5-step daily tracking** — Water, activity, meal photos, body measurements, full-day bonus.
5. **Optional self-log** — LogVitalsModal for Height/Weight/Pain/Sleep/Mood.
6. **Prakriti quiz** — One-time self-exam at `/self-exam`.
7. **Voice coach** — `/patient/coach` for Tamil/English health questions 24/7.
8. **Triage if symptomatic** — Submit triage → routes to suggested specialty.
9. **Book appointment** — Slot picker → hold → confirm.
10. **Pre-consultation** — Self-exam protocol submitted before visit.

### Doctor consultation workflow

1. **DoctorDashboard** — Today's queue, OrchestratedActionsCard, Patients-at-Risk tile, Care Gaps shortcuts.
2. **Click queued patient** → `ConsultationRoom`:
   - **Left**: PatientHistoryPanel tabs (prescriptions, appointments, summaries, triage, pain, journey).
   - **Center**: Video iframe (ONLINE) or Offline placeholder.
   - **Right**: Clinical Notes textarea + Visit Summary + Patient Snapshot + Diet + Retention.
3. **+ Record** on snapshot → RecordIntakeModal (Vitals / Prakriti / Lifestyle).
4. **Save Notes** during session.
5. **Generate Health Report** — branded PDF + WhatsApp.
6. **Complete Session** → FollowUpSchedulerModal → submit follow-up decision.
7. **VisitSummaryModal** — Author diagnosis, prescriptions, exercise plan, send to portal.
8. **Auto-generated**: HandoffNote draft, FollowUpTask.

### Therapist session workflow

1. **TherapistDashboard** — Today's therapy queue.
2. **Click session** → `SessionWorkspace`:
   - Patient context panel
   - SOAP-format TherapistSessionNote
   - TherapyOutcome scoring (pain, mobility, swelling delta)
3. **Save** → patient's My Progress tab populates.
4. **Home therapy**: location pings every 10s while en-route → Arrived → In session → Completed.

### Admin Doctor weekly workflow

1. Review **PerformanceScorecards** for branch clinicians.
2. **Approve appointment holds** for clinicians needing approval.
3. **TriageOverride stats** — adjust specialty routing if weights are off.
4. **Care Gaps** review → assign follow-ups.
5. **Critical Journey** queue review → escalate or resolve flags.
6. **Staff Attendance** review.

### Pharmacist workflow

1. **Low-stock alert** → reorder via stock transfer or new MedicineStock entry.
2. **Incoming order** → review prescription → dispense items → PharmacyDispense + DispenseItem rows.
3. **Refill request** received → check Rx status → approve or reject.
4. **Stock transfer** between branches → PENDING → APPROVED → IN_TRANSIT → RECEIVED.

### Super Admin workflow

1. Hospital onboarding: create Hospital → set plan → seed Branch + initial users → toggle features.
2. Per-hospital feature flag changes (e.g. enable AYURVEDIC_VOICE_COACH or VOICE_COACH_EXTRACTIVE_ONLY).
3. Suspend / decommission hospital lifecycle.
4. Cross-hospital audit + Bull-Board inspection.

---

## 12. External integrations

| Service | Purpose | Auth | Module |
|---|---|---|---|
| **Evolution API** (self-hosted) | WhatsApp send (text + document) | `apikey` header | `services/whatsapp.service.js` |
| **Daily.co** | Video room provisioning + webhook lifecycle | `DAILY_API_KEY` | `services/video.service.js` + `routes/webhooks.js` |
| **OpenAI Whisper** | Audio → text | `OPENAI_API_KEY` | `services/voiceCoach/stt.service.js` |
| **OpenAI GPT-4o / GPT-4o-mini** | Chat completions (voice coach pre-cutover; voice-note structuring) | `OPENAI_API_KEY` | `services/voiceCoach/llm.service.js`, `services/voiceNote/refine.service.js` |
| **OpenAI Embeddings** (`text-embedding-3-small`) | Corpus + query embeddings for RAG | `OPENAI_API_KEY` | `scripts/buildRagIndex.js`, `services/voiceCoach/ragRetriever.js` |
| **Google Cloud TTS** | Text → speech for voice coach | `GCP_TTS_API_KEY` | `services/voiceCoach/tts.service.js` |
| **Supabase Storage** | Clinical photos, audio, PDFs, exports | `SUPABASE_SERVICE_KEY` | Direct from Node SDK |
| **Razorpay** | Patient payments | webhooks + REST | `services/payment.service.js` |
| **Sentry** | Error reporting | `SENTRY_DSN` | `lib/sentry.js` |
| **Redis** / **Memurai (Windows)** | BullMQ broker + cache | `REDIS_URL` | `services/queue.service.js` + `services/cache.service.js` |

---

## 13. F06 Voice Health Coach v2 — Extractive RAG (shipped 2026-06-11)

### What it is

The voice coach now answers patient questions by retrieving from a curated Ayurvedic knowledge base and templating a reply — **with no LLM call at runtime when the `VOICE_COACH_EXTRACTIVE_ONLY` hospital flag is on**. gpt-4o-mini code remains in the codebase behind the flag for instant rollback.

### Corpus

- **1,220 passages embedded** with OpenAI `text-embedding-3-small` (1536-dim, multilingual).
  - 610 English: 600 daily-life tips (curated) + 10 long topic passages (LLM-drafted + MD-review pending).
  - 610 Tamil: 600 tips (gpt-4o one-time translation from English) + 10 long passages (gpt-4o one-time translation, MD-review pending).
- **Storage**: single `data/ragCorpus/corpus.json` file (~35 MB). Gitignored — rebuild with `node scripts/buildRagIndex.js --embed --include-unreviewed`.
- **One-time build cost**: ~$1.10 for Tamil translation + ~$0.001 for embeddings.
- **Per-query cost**: ~$0.000001 for query embedding. **Zero LLM cost.**

### Per-turn pipeline (extractive mode)

1. **STT** — Whisper transcribes the audio. Multi-layer repetition-collapse filter strips garbage transcripts (char-level n-gram + phrase-level + comma-separated chunk detection). Empty transcript → STT_EMPTY response and "couldn't make out what you said" toast.
2. **Escalation classifier** — `escalation.service.js` checks for HIGH/CRITICAL severity (chest pain, suicidal ideation, etc.). If hit → safety template + notify assigned doctor; bypass everything else.
3. **Personal-intent detection** — Before retrieval, regex-detect patient-data queries: "who is my doctor", "what medicines am I taking", "next appointment", "treatment phase" (English + Tamil patterns). Answer directly from `ctx.doctor.fullName`, `ctx.prescriptions`, etc. — no embedding, no retrieval.
4. **Corpus retrieval** — `ragRetriever.retrievePassages(query, {topK:1, minSim:0.2, language})`:
   - Language filter (English-only passages for English queries; Tamil for Tamil).
   - Dosha-tag soft filter — when query contains "vata"/"pitta"/"kapha" (English or Tamil), restrict to passages tagged with that dosha.
   - Topic-passage score bonus (+0.05) so long classical passages are preferred over short tips.
   - 60s query embedding cache.
   - Brute-force cosine over the filtered subset (~50 ms for 610 passages).
5. **Sentence picking** — Pick top 2 sentences from the retrieved passage via keyword overlap with the query.
6. **Template render** — Slot patient name + snippet + source citation:
   - English: `"${name}, ${snippet}. (Source: Charaka Sutrasthana 6)"`
   - Tamil: `"${name}, ${snippet}. (மூலம்: Charaka Sutrasthana 6)"`
   - Tips without sources get a generic citation (*"Ayurvedic daily-living guidance"* / *"பாரம்பரிய ஆயுர்வேத வாழ்க்கைமுறை வழிகாட்டுதல்"*).
   - Citation budget reserved first; snippet truncated to fit MAX_REPLY_CHARS (600).
7. **TTS** — GCP Text-to-Speech, mp3 base64 inline in API response.

### Feature flag rollout

| Command | Effect |
|---|---|
| `node scripts/toggleExtractiveFlag.js status` | Show current state for the lone hospital |
| `node scripts/toggleExtractiveFlag.js on` | Switch to extractive immediately — next voice turn uses it |
| `node scripts/toggleExtractiveFlag.js off` | Rollback to gpt-4o-mini LLM path — no restart needed |
| `node scripts/toggleExtractiveFlag.js on --hospitalId=hosp_xyz` | Target a specific hospital when multiple exist |

### Cost & dependency impact (per turn, 1000 turns/day)

| Line item | LLM path (flag off) | Extractive path (flag on) |
|---|---|---|
| Whisper STT | ~$0.00100 | ~$0.00100 |
| Query embedding | ~$0.000001 | ~$0.000001 |
| LLM chat completion | ~$0.00018 | **$0** |
| Google TTS | ~$0.00002 | ~$0.00002 |
| **Per-turn total** | **~$0.00120** | **~$0.00102 (−15%)** |
| **Monthly @ 30k turns** | $36 | $30.60 |

OpenAI dependency drops from **2 calls/turn (chat + embedding)** to **1 call/turn (embedding only)** when extractive is on. Further phases can replace the embedding with a local Sentence Transformers model.

### What's NOT in extractive mode (by design)

- **Multi-passage synthesis** — the LLM previously fused 2-3 retrieved passages into one reply; extractive picks one.
- **Prose-style personalisation** — the LLM wove the patient's prescription + check-ins into reply text; extractive only templates in the patient's name. Personal-intent detection covers explicit personal questions.
- **Novel out-of-corpus questions** — the LLM could attempt any question; extractive returns a polite "no curated reference" fallback for queries below the similarity threshold.

### Open follow-ups (not blocking)

- MD reviews the 10 Tamil + 10 English topic passages (currently `unreviewed: true`). After sign-off, flip the flag in the source markdown and rebuild.
- MD applies the deferred SQL at `prisma/manual-pending-migrations/2026_add_voice_message_retrieved_passage_ids.sql` to persist retrieved passage IDs on `VoiceMessage` rows (currently audit-only in app logs).
- Whisper Tamil quality remains imperfect. A future swap to `whisper.cpp` or AssemblyAI/Google Cloud STT would help.

---

## 14. AI features roadmap (status as of 2026-06-11)

| # | Feature | Existing % | Phase | Status |
|---|---|---|---|---|
| 02 | Ambient Voice-to-Note | 70% | 2 | Shipped |
| 06 | Voice Health Coach | 65% → **95%** | 2 | **Shipped — RAG + Extractive cutover ready (flag-gated)** |
| 05 | Behavioural Nudge Engine | 75% | 2 | Shipped (DailyMotivationCard + NudgeLog feedback loop) |
| 07 | Multi-Agent Orchestration | 70% | 2 | Shipped (critical-triage cascade) |
| 08 | Explainable AI | 65% | 2 | Shipped (Why? popover on Appointments + Care Gaps) |
| 04 | Predictive Dosha | 65% | 3 | Shipped (rule-based v1) |
| 03 | Multimodal Diagnostic (Tongue) | 50% | 3 | Shipped (gpt-4o vision) |
| 10 | AI Revenue Cycle | 40% | 3 | Pending (blocked on ABDM external API) |
| 01 | Patient Digital Twin | 55% | 4 | Pending (needs outcome history) |
| 09 | Federated Learning | 25% | 4 | Pending (no Python ML stack) |

---

## 15. Operational gotchas

| Gotcha | Where it surfaces | Mitigation |
|---|---|---|
| ES module imports are hoisted above `dotenv.config()` | `index.js` startup | Use `import 'dotenv/config'` as the first import |
| `_prisma_migrations` table says applied but DDL never ran | Phase 0 schema drift | Use `prisma migrate diff` to detect |
| `bg-card` is white in light theme | UI cards on white columns | Use `bg-secondary/30` for visibility |
| Flex column with `min-h-0 + overflow-y-auto` compresses children | ConsultationRoom right column | Add `shrink-0` to load-bearing card wrappers |
| Vite HMR can miss new file additions on OneDrive paths | Dev only | Hard refresh + delete `node_modules/.vite` cache |
| WhatsApp gateway "not configured" despite `.env` set | Boot config | `dotenv` must run before config module evaluates |
| `PatientVital.patientId` references `User.id` not `Patient.id` | Schema | Resolve `Patient.id → userId` before insert |
| Redis ECONNREFUSED on Windows dev | Boot | Install Memurai (https://www.memurai.com/get-memurai) |
| Whisper repetition-collapse hallucination on Tamil short audio | STT | Multi-layer collapse filter in `stt.service.js` |
| Patient-personal questions in extractive RAG | Voice coach | `detectPersonalIntent` short-circuits retrieval |
| FeatureRegistry seed isn't auto-run on boot | New flag rollout | `npm run seed:feature-registry` is a manual step |

---

## 16. Setup / dev environment (Windows)

```powershell
# 1. Install Node 24 + npm
# 2. Install Memurai (Redis for Windows)
#    https://www.memurai.com/get-memurai
#    Service starts automatically; verify with:
Test-NetConnection localhost -Port 6379

# 3. Backend setup
cd alshifa-backend
npm install
# .env file with DATABASE_URL, JWT_SECRET, OPENAI_API_KEY, REDIS_URL, etc.
npx prisma generate
npm run seed:feature-registry
npm run dev

# 4. Frontend setup (separate terminal)
cd alshifa-frontend
npm install
npm run dev

# 5. (One-time per dev env) Build RAG corpus
cd alshifa-backend
node scripts/translateCorpusToTamil.js --do-translate    # ~$1.10
node scripts/buildRagIndex.js --embed --include-unreviewed  # ~$0.001

# 6. Toggle extractive flag for testing
node scripts/toggleExtractiveFlag.js on
```

---

## 17. Test surface

- 27 test files, 383 tests passing.
- Run all: `npx vitest run` (~3 seconds).
- New since RAG cutover: `tests/unit/ragRetriever.test.js` (20 tests), `tests/unit/extractiveResponder.test.js` (43 tests).
- Coverage areas: auth, journey feedback, journey, triage, search, daily check-in, home therapy, nudge engine, multi-agent, digital twin, explainable AI, tongue analysis, smart insights, prescription frequency, leaderboard, rate limiting, badge service, message templates, scheduler, voice coach (STT + LLM + Extractive Responder + Retriever).

---

## 18. Pending items requiring MD attention

| # | Item | Where | Effort |
|---|---|---|---|
| 1 | Review 10 English topic passages for clinical accuracy | `data/ragCorpus/topic-passages.md` (flagged `unreviewed: true`) | ~2 hours |
| 2 | Review 10 Tamil topic passages | `data/ragCorpus/topic-passages-ta.md` (flagged `unreviewed: true`) | ~3 hours |
| 3 | Spot-check 600 Tamil daily tips | `data/ragCorpus/seed-tips-ta.json` | ~2 hours |
| 4 | Apply deferred SQL to add `VoiceMessage.retrievedPassageIds` column | `prisma/manual-pending-migrations/2026_add_voice_message_retrieved_passage_ids.sql` | 2 minutes via Supabase SQL editor |
| 5 | Decide rollout cadence for `VOICE_COACH_EXTRACTIVE_ONLY` (per-hospital, all-tenants, etc.) | N/A (governance) | Discussion |

---

## 19. Documentation maintenance

This document reflects state as of **2026-06-11** (commit `6d3b8df` + extractive-RAG follow-up). Compiled from:
- Live Prisma schema (80+ models, 90+ enums, 35+ feature flags)
- Live route inventory (67 route files)
- Existing IWIS Platform Reference v2026-05-19
- Code review of `services/voiceCoach/` after R1–R5 + XR1–XR2 work
- 27 passing test files (383 tests total)

When schema or routes change meaningfully, refresh the affected section. Re-run the Explore agent prompts that produced this content to regenerate the inventory.
