# IWIS Platform Documentation (as of 2026-05-23)

> Comprehensive reference: features, endpoints, workflows, application architecture, roles + permissions, and updated AI roadmap status. Compiled from full schema inspection (80+ models, 90+ enums, 35 feature flags) and route inventory (67 route files, 500+ endpoints) of `alshifa-backend` and `alshifa-frontend`.

## 1. System Overview

### Tech stack

| Layer | Technology |
|---|---|
| Backend runtime | Node.js + Express (ES Modules) |
| Frontend | React 18 + Vite + TypeScript + Tailwind + shadcn/ui |
| Database | PostgreSQL via Supabase (transaction pooler @ 6543 for runtime, direct @ 5432 for migrations) |
| ORM | Prisma 5.22 |
| Async jobs | BullMQ on Redis |
| Real-time | Socket.IO (`emitToUser` helper for fanout) |
| Auth | JWT + Refresh tokens + Optional MFA (TOTP) |
| File storage | Supabase Storage (clinical photos, audio, PDFs) |
| WhatsApp delivery | Evolution API (self-hosted, BullMQ-queued) |
| Video consult | Daily.co (room provisioning + webhook lifecycle) |
| Voice STT | OpenAI Whisper API (`whisper-1`) |
| TTS (voice coach) | Google Cloud Text-to-Speech (Tamil + English) |
| LLM | OpenAI GPT-4o / GPT-4o-mini (chat completions) |
| Observability | Sentry, Bull-Board at `/admin/queues` |
| API docs | Swagger UI at `/api/docs` |

### Repo layout

```
Alshifa_Ayush/
├── alshifa-backend/
│   ├── index.js                    # Express bootstrap, route mounting
│   ├── prisma/
│   │   ├── schema.prisma           # 80+ models, 90+ enums
│   │   └── migrations/             # 60+ migrations
│   ├── routes/                     # 67 route files
│   ├── services/                   # Business logic (consultation, triage, etc.)
│   │   └── voiceCoach/             # STT, context assembly, chat completions
│   ├── jobs/                       # BullMQ job definitions
│   ├── middleware/                 # auth, validate, audit, errorHandler
│   ├── lib/                        # prisma, logger, sentry, redis
│   └── config/                     # env config aggregation
└── alshifa-frontend/
    ├── src/
    │   ├── pages/                  # Top-level pages (role-grouped)
    │   │   ├── patient/            # PatientPortal, EnhancedPatientDashboard, etc.
    │   │   ├── therapist/          # SessionWorkspace
    │   │   ├── DoctorDashboard.tsx
    │   │   ├── TherapistDashboard.tsx
    │   │   └── ConsultationRoom.tsx
    │   ├── components/
    │   │   ├── consultation/       # Snapshot card, intake modal, etc.
    │   │   ├── patient/            # MyVitalsTab, PainMapCard, etc.
    │   │   ├── doctor/             # Patient review tracker, follow-up panel
    │   │   ├── ui/                 # shadcn primitives
    │   │   └── ...
    │   ├── services/               # apiClient wrappers per domain
    │   ├── hooks/                  # useAuth, useFeatureFlag, etc.
    │   └── lib/                    # api-client, format-date, utils
```

### Multi-tenant architecture

- **Hospital** = tenant. Has `slug`, `plan` (STARTER / PROFESSIONAL / ENTERPRISE), `status` (ACTIVE / SUSPENDED / PENDING_SETUP / DECOMMISSIONED).
- **Branch** belongs to a Hospital. Has bed/room inventory, operating hours, weeklyClosedDays. Per-user `branchId` scopes most queries.
- **FeatureRegistry** is the global catalogue of 35+ features. **HospitalFeatureFlag** enables/disables features per tenant.
- `requireFeature('FEATURE_KEY')` middleware gates endpoints behind feature flags. Default off for Phase 2+ AI features; default on for core competitor parity (BRANCH_CAPACITY, CLINICAL_PHOTOS, etc.).
- **Super Admin** role transcends tenant scoping; sees `/api/super-admin/*` and `/admin/queues`.

## 2. Roles & Permissions

| Role | Scope | Primary surfaces | What they can do |
|---|---|---|---|
| **SUPER_ADMIN** | Cross-tenant | `/api/super-admin/*`, `/admin/queues` | Hospital CRUD, plan changes, feature flag toggles, global audit |
| **ADMIN_DOCTOR** | Branch lead | `/doctor-admin` dashboard | Everything a DOCTOR can do + staff management, branch-level analytics, approval workflows |
| **ADMIN** / **BRANCH_ADMIN** | Branch ops | `/admin` dashboard | Users CRUD (in-branch), feature flag panel, reports, audit feed, operational tasks |
| **DOCTOR** | Branch clinician | `/doctor` dashboard, `/consultation/:id` | Consultations, prescriptions, triage review, prescribed-vitals, journey planning, voice-note, health reports |
| **THERAPIST** | Branch clinician | `/therapist` dashboard, `/therapist/session/:id` | Therapy sessions (in-clinic + home), SOAP notes, therapy outcomes, group sessions, home-therapy GPS tracking |
| **PHARMACIST** | Branch pharmacy | Pharmacy module | Medicine inventory, dispensing, order management, stock transfers, refill workflow |
| **PATIENT** | Self | `/patient-portal`, `/triage`, `/self-exam` | Daily check-ins, view records, self-vitals, prakriti quiz, appointments, gamification, voice coach |

### Role-gate enforcement pattern

```javascript
authMiddleware                                 // JWT verification
roleMiddleware(['DOCTOR', 'ADMIN_DOCTOR'])      // Allow-list check
requireFeature('EXPLAINABLE_AI')                // Hospital-level feature flag
// → route handler
```

## 3. Core Domain Models (the spine)

| Model | Key fields | Owns |
|---|---|---|
| **User** | id, email, role, branchId, hospitalId, mfaEnabled | Auth + relationships hub (100+ FKs) |
| **Patient** | id, userId, dob, gender, prakriti (via ConstitutionProfile), allergies[], onboardingData JSON | All patient-side records |
| **Doctor** | id, userId, fullName, specialization, qualification, registrationNumber | Consultations, prescriptions |
| **Therapist** | id, userId, fullName, gender, languages[], skills | Therapy sessions, home-visit GPS |
| **Appointment** | patientId, doctorId/therapistId, date, status, consultationType, branchId, queuePosition, arrivalStatus, dailyRoomUrl | Booking lifecycle |
| **TriageSession** | patientId, responses JSON, urgencyLevel, compositeScore, redFlagsMatched[], reasoning, suggestedSpecialty | Symptom-to-specialty routing |
| **Prescription** | patientId, doctorId, medicineId, dosage, frequency, dispensedQty, consumedQty, lifecycle dates | Med order + adherence |
| **PatientVital** | patientId (→ User.id ⚠️), type (VitalType enum), value, recordedAt, source | All vital readings |
| **DailyCheckIn** | patientId (→ Patient.id), painLevel, painRegions JSON, sleepHours, mood, mobilityScore | Patient self-report |
| **ConstitutionProfile** | patientId (1:1), prakriti, satvaRating, agniType, quizAnswers | Ayurvedic constitution typing |
| **TreatmentJourney** | patientId (→ User.id ⚠️), doctorId, condition, status, wellnessScore + phases/milestones/vitals | Illness-to-wellness plan |
| **Hospital** | slug, plan, status, country, timezone | Multi-tenant root |

### Critical relationship gotchas

| Gotcha | Where | Why it matters |
|---|---|---|
| `PatientVital.patientId` → **User.id** (not Patient.id) | schema.prisma:1802 | Every new endpoint writing vitals must resolve Patient.id → User.id first |
| `TreatmentJourney.patientId` → **User.id** | TreatmentJourney model | Inconsistent with most patient-centric tables |
| `Appointment.arrivalStatus` mirrors `QueueEntry.arrivalStatus` | Both | Always written in same transaction. Don't update only one. |
| `PatientAssignment` rows are never deleted | Lifecycle | Query `status = 'ACTIVE'` to find current assignment |
| `Appointment.triageSessionId` is `@unique` but optional | Many appointments have no triage (walk-ins, follow-ups) |
| `ConsultationFeedback` has both legacy MCQ and new rating flows | Two parallel response shapes | Service layer must handle both |
| `_prisma_migrations` says all migrations applied but actual schema can drift | Phase 0 issue we hit earlier | Use `prisma migrate diff` to detect |

## 4. Feature Catalogue (35+ shipped features)

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

### Clinician gamification
`CLINICIAN_XP`, `SEASONAL_CHALLENGES`, `ACHIEVEMENT_SHOWCASE`, `REWARD_STORE`, `MENTOR_SESSIONS`

### Patient gamification
`HEALTH_QUESTS`, `HEALTH_AVATAR`, `FAMILY_LEADERBOARD`, `REFERRAL_TIERS`, `SOCIAL_PROOF`, `UNLOCKABLE_CONTENT`

### AI features (Phase 2–4, defaultEnabled: false until shipped)

| Flag | Phase | Status |
|---|---|---|
| `AMBIENT_VOICE_TO_NOTE` | 2 | ✅ Shipped |
| `AYURVEDIC_VOICE_COACH` | 3 → 2 ↓ | ✅ Shipped at `/api/voice-coach` |
| `BEHAVIOURAL_NUDGE_ENGINE` | 2 | ✅ Shipped — LLM-personalised Monday Motivation + NudgeLog feedback loop |
| `EXPLAINABLE_AI` | 2 | ✅ Shipped — "Why?" popover on Appointments page + Care Gaps table |
| `MULTI_AGENT_ORCHESTRATION` | 3 → 2 ↓ | ✅ Shipped — 4 agents fan out on `triage.critical.submitted` |
| `PREDICTIVE_DOSHA_ENGINE` | 3 | ✅ Shipped — nightly cron at 02:00 IST emits DoshaForecast + alert |
| `MULTIMODAL_DIAGNOSTIC_AI` | 3 | ✅ Shipped — Jihva Pariksha step in daily check-in + GPT-4o vision |
| `PATIENT_DIGITAL_TWIN` | 4 → 2 ↑ | ✅ Shipped — consolidated panel on ConsultationRoom right column |
| `AI_REVENUE_CYCLE` | 3 | Pending (blocked on ABDM API) |
| `FEDERATED_LEARNING` | 4 | Pending (no Python ML stack yet) |

**6 features shipped in the 2026-06-09 sprint.** All gated by hospital-level `HospitalFeatureFlag`, defaultEnabled=false. Test plan + verification log in `_sprint_2026-06-09_AI_features.md` (if present), or run `npm test` in both repos for 360 unit tests.

## 5. Backend API Reference (organized by domain)

> 67 route files mounted in `index.js` → ~500 endpoints. Spine routes below.

### Auth & users
- `POST /api/auth/register` (public) — Patient signup
- `POST /api/auth/login` (public) — JWT issue with optional MFA
- `POST /api/auth/refresh` — Rotate access token
- `POST /api/auth/{logout,logout-all}` — Revoke refresh tokens
- `POST /api/auth/{forgot-password,reset-password}` (public) — Token-based reset
- `POST /api/auth/mfa/{setup,verify-setup,validate,disable}` — TOTP MFA
- `GET /api/user/me` — Self profile + feature flags
- `GET /api/user/list-{doctors,therapists,patients,pharmacists}` — Staff/patient directories
- `POST /api/user/create-user` (ADMIN_DOCTOR, ADMIN) — Staff onboarding
- `POST /api/user/{assign-patient,unassign-patient}` (ADMIN_DOCTOR) — PatientAssignment

### Appointments
- `GET /api/appointments` — List (scoped by role)
- `POST /api/appointments` (PATIENT, ADMIN, ADMIN_DOCTOR) — Book
- `POST /api/appointments/walk-in` (ADMIN, ADMIN_DOCTOR) — Walk-in
- `GET /api/appointments/available-slots`
- `PUT /api/appointments/:id/{approve,reject}` (DOCTOR, THERAPIST, ADMIN_DOCTOR)
- `POST /api/appointments/hold` — Temporarily reserve a slot
- `GET/PUT /api/appointments/:id/follow-up` (DOCTOR, THERAPIST)

### Consultations & clinical notes
- `POST /api/consultations/session/:appointmentId/{start,notes,complete}` (DOCTOR, ADMIN_DOCTOR)
- `GET/POST /api/visit-summary/appointment/:id`
- `POST /api/visit-summary/:id/send`
- `GET /api/patient-history/:patientId`
- `POST /api/voice-note/refine` (DOCTOR, ADMIN_DOCTOR) — Voice → structured note (LLM)

### Triage
- `POST /api/triage` (PATIENT) — Submit
- `POST /api/triage/:id/retriage` (PATIENT, feature TRIAGE_RETRIAGE)
- `POST /api/triage/upload` / `:sessionId/media`
- `GET /api/triage/my-sessions` (PATIENT)
- `GET /api/triage/sessions/:id` (clinicians)
- `POST /api/triage/:id/review` (DOCTOR, ADMIN_DOCTOR, feature TRIAGE_DOCTOR_OVERRIDE)
- `GET /api/triage/overrides/stats` (ADMIN_DOCTOR)
- `GET/PUT /api/triage/specialty-routes` (ADMIN_DOCTOR, feature TRIAGE_DB_ROUTING)

### Patients & profiles
- `GET /api/patients` (clinicians) — Branch-scoped list
- `POST /api/patients/guest` (ADMIN, ADMIN_DOCTOR) — Walk-in guest
- `GET /api/patients/:id/timeline`
- `GET /api/patients/:patientId/full-details` — Static digital-twin
- `GET /api/patients/:id/pain-map`
- `GET /api/patient/pain/my-map` (PATIENT)
- `GET /api/patient/health-summary` (PATIENT)
- `GET /api/patients/:patientId/health-summary` (clinicians)
- `POST /api/patient/self-vitals` (PATIENT) — Self-log
- `POST /api/patients/:patientId/vitals` (clinicians)
- `POST /api/patients/:patientId/constitution` (clinicians) — Set Prakriti
- `PATCH /api/patients/:patientId/lifestyle-snapshot` (clinicians)
- `GET/POST /api/patients/:patientId/prescribed-vitals`

### Prescriptions & pharmacy
- `GET /api/prescriptions/search`
- `POST /api/prescriptions` / `add` / `batch-add` (DOCTOR, THERAPIST, ADMIN_DOCTOR)
- `POST /api/prescriptions/:id/discontinue`
- `GET /api/prescriptions/:id/{adherence,pdf}`
- `GET/POST /api/pharmacy/medicines` (PHARMACIST + clinicians)
- `POST /api/pharmacy/dispense` / `batch-dispense` (PHARMACIST)
- `GET /api/pharmacy/stock/low`
- `POST /api/pharmacy/orders` (PATIENT) / `PATCH /:id/status` (PHARMACIST)
- `POST /api/refills` (PATIENT)
- `PUT /api/refills/:id/{approve,fulfill}` (PHARMACIST, DOCTOR)

### Wellness & daily tracking
- `POST /api/wellness/check-in` (PATIENT) — 3-step daily, also flips NudgeLog feedback flag
- `GET /api/wellness/check-in/today`
- `GET /api/wellness/stats`
- `POST /api/wellness/check-in/tongue-photo` (PATIENT, **feature MULTIMODAL_DIAGNOSTIC_AI**) — F03 Jihva Pariksha; multipart `photo` + `checkInId`, ≤5 MB JPEG/PNG/WEBP; runs GPT-4o vision analysis inline; creates TongueObservation row; upserts PatientCriticalFlag when non-balanced + confidence > 0.6
- `POST /api/daily-tracking/{water,measurements,activity,meal-photos,full-day-bonus}` (PATIENT)
- `GET /api/daily-tracking/summary`

### Therapy
- `GET/POST /api/consultations/availability` (THERAPIST)
- `POST /api/therapist-notes` (THERAPIST) — SOAP
- `POST /api/therapy-outcomes` (THERAPIST)
- `GET /api/therapy-outcomes/me` (PATIENT)
- `POST /api/home-therapy/request` (DOCTOR, ADMIN_DOCTOR)
- `PATCH /api/home-therapy/sessions/:id/{accept,location-ping,start,complete,cancel}` (THERAPIST)
- `GET/POST /api/therapy-rooms` (ADMIN_DOCTOR, ADMIN)
- `POST /api/group-sessions` / `POST /:id/{enroll,attend}` (THERAPIST, ADMIN_DOCTOR)

### Diet
- `POST /api/diet-prescriptions` (clinicians)
- `GET /api/diet-prescriptions/patient/:id`
- `POST /api/diet-prescriptions/:id/adherence` (PATIENT)
- `GET/POST /api/diet-packages` / `PUT /:id/{approve,reject}` (ADMIN_DOCTOR)
- `GET /api/ayurvedic-foods` / `recipes`

### Queue management
- `POST /api/queue/arrive` (ADMIN, ADMIN_DOCTOR)
- `POST /api/queue/start-consultation` / `end-consultation` (DOCTOR)
- `POST /api/queue/mark-absent` / `mark-contacted`
- `GET /api/queue/board`

### Health reports & PDF
- `POST /api/health-reports/generate` (DOCTOR, ADMIN_DOCTOR)
- `GET /api/health-reports/patient/:id`
- `POST /api/health-reports/:id/resend`

### Communication
- `GET/POST /api/chat/conversations`
- `POST /api/chat/conversations/:id/messages`
- `GET/POST /api/staff-chat/threads`
- `GET /api/notifications` / `PUT /:id/read` / `PUT /read-all`
- `GET/PUT /api/notifications/preferences`
- `POST /api/voice-coach/session` (PATIENT, feature AYURVEDIC_VOICE_COACH)

### Self-exam + Constitution
- `GET /api/self-exam/zones`
- `POST /api/self-exam` (PATIENT)
- `GET/POST /api/self-exam/constitution/me` (PATIENT)
- `POST /api/self-exam/upload-asset`

### Care gaps + critical journey
- `GET /api/care-gaps` (clinicians, feature CARE_GAP_DETECTION)
- `POST /api/care-gaps/:id/resolve`
- `GET /api/critical-journey` (DOCTOR, ADMIN_DOCTOR)
- `PATCH /api/critical-journey/:id`

### Admin / audit / super-admin
- `GET /api/audit-logs` (ADMIN_DOCTOR, ADMIN)
- `GET/PUT /api/feature-flags` (ADMIN_DOCTOR, ADMIN) — branch/role-scoped `FeatureFlag` table
- `GET/POST /api/super-admin/hospitals` (SUPER_ADMIN)
- `PUT /api/super-admin/hospitals/:id/features/:flag` (SUPER_ADMIN) — **hospital-scoped `HospitalFeatureFlag` table — this is what `useTenantFeatures.has()` reads**
- `GET /api/super-admin/audit`
- `/admin/queues` — Bull-Board UI
- `/api/docs` — Swagger UI

### AI feature endpoints (sprint 2026-06-09)
All gated by `HospitalFeatureFlag` per feature key.

- `GET /api/triage/sessions/:id` — F08 explainability surface (compositeScore, urgencyLevel, redFlagsMatched, redFlagForced, confidenceScore, inputCompleteness, routingMatchStrength, alternativeSpecialties, triageNotes). Auth-only — patients can read own, clinicians can read any.
- `GET /api/patients/:patientId/dosha-forecast` (DOCTOR/ADMIN_DOCTOR, **feature PREDICTIVE_DOSHA_ENGINE**) — F04, returns last 10 forecasts ordered by `generatedAt desc`. Hospital-scoped.
- `GET /api/patients/:patientId/tongue-observations` (DOCTOR/ADMIN_DOCTOR, **feature MULTIMODAL_DIAGNOSTIC_AI**) — F03, last 30 observations newest-first.
- `GET /api/patients/:patientId/digital-twin` (DOCTOR/ADMIN_DOCTOR, **feature PATIENT_DIGITAL_TWIN**) — F01, single-call payload with painTrend/sleepTrend/moodTrend/mobilityTrend (30 d), doshaBalance (sum=100), latest forecast, tongue summary, active medication count + first 3, journey + cohort count with privacy floor 5.
- (Side-effect channel) `POST /api/triage` and `/api/triage/submit` — F07; on URGENT/CRITICAL urgency + **feature MULTI_AGENT_ORCHESTRATION**, emits `triage.critical.submitted` event after the response. 4 agents fan out in parallel via Promise.allSettled.

## 6. BullMQ Jobs & Background Workers

| Queue / Worker | Trigger | What it does |
|---|---|---|
| `notification` | Per-event publish | Fan-out to Notification rows + socket emit (`emitToUser`) |
| `whatsapp` | Per-message publish | Rate-limited send via Evolution API; idempotent on `whatsappSentAt` |
| `monday-motivation` | Cron `0 10 * * 1` (10:00 IST Mondays) | F05 — per-patient LLM-personalised nudge when BEHAVIOURAL_NUDGE_ENGINE on; falls back to static AYURVEDIC_TIPS template otherwise. Writes NudgeLog row. |
| `dosha-forecast` | Cron `30 20 * * *` (02:00 IST nightly) | F04 — scans every active patient at flag-enabled hospitals; writes DoshaForecast + upserts PatientCriticalFlag + notifies assigned doctor when score > 1.5. **IST-aware day boundary** for idempotency. |
| `health-report` | Generate Report button | Branded PDF → Supabase → WhatsApp |
| `attendance-roll` | Cron daily | Marks LATE / ABSENT per clinician |
| `cleanup-uploads` | Cron nightly | Removes orphaned Supabase files |
| `consultation-feedback-request` | 30s after appt.complete | Triggers feedback prompt |
| `home-therapy-brief` | Cron 07:00 IST | Home-therapy brief + WhatsApp to therapists |
| `eventRegistry` (in-process) | `emitEvent('triage.critical.submitted', …)` from triage route | F07 — fans out to careGapAgent + pharmacyAgent + slotHoldAgent + dashboardSummariser via Promise.allSettled. Never throws. |

## 7. Frontend pages by role

### Patient
- `/patient` → `EnhancedPatientDashboard`
- `/patient-portal` → `PatientPortal` (7 tabs: Appointments, Prescriptions, My Vitals, My Progress, Visit Summaries, Health Reports, My Tips)
- `/patient/consultation` → `PatientConsultation`
- `/self-exam` → `SelfExaminationKit`
- `/health-quests` → `HealthQuests`
- `/family-leaderboard`, `/health-avatar`, `/health-content`, `/social-proof`, `/referral-rewards`, `/contact-clinics`, `/triage`
- Modals: `DailyCheckIn`, `LogVitalsModal`

### Doctor / Admin Doctor
- `/doctor` → `DoctorDashboard`
- `/doctor-admin` → Admin Doctor view
- `/consultation/:appointmentId` → `ConsultationRoom` (three-column: history rail / video center / clinical notes + snapshot + diet + retention)
- `/appointments`, `/patients`, `/patients/:id`, `/prescriptions`, `/care-gaps`, `/critical-journey`, `/handoff`

### Therapist
- `/therapist` → `TherapistDashboard`
- `/therapist/session/:appointmentId` → `SessionWorkspace`
- `/therapist/package-sessions`, `/home-therapy`, `/group-sessions`

### Pharmacist
- Pharmacy dashboard, dispense surface, orders inbox, stock transfer

### Admin / Branch Admin
- `/admin`, Users management, Feature flag panel, Reports, Specialty routes, Reminder settings

### Super Admin
- Hospital CRUD, plan tier, feature registry, cross-hospital audit, `/admin/queues` (Bull-Board)

## 8. Workflows by role

### Patient daily workflow (engagement loop)
1. **07:00 IST** — DailyMotivationCard cron pushes prakriti × season tip via WhatsApp
2. **Morning** — App opens to EnhancedPatientDashboard (appointments, vitals tiles, streak, daily challenge)
3. **Daily check-in** — 3-step modal (body-map pain / sleep / mood) → ZenPoints reward
4. **5-step daily tracking** — Water, activity, meal photos, body measurements, full-day bonus
5. **Optional self-log** — LogVitalsModal for Height/Weight/Pain/Sleep/Mood
6. **Prakriti quiz** — One-time self-exam at `/self-exam`
7. **Voice coach** — Tamil/English Q&A 24/7
8. **Triage if symptomatic** — Routes to suggested specialty
9. **Book appointment** — Slot picker → hold → confirm
10. **Pre-consultation** — Self-exam protocol submitted before visit

### Doctor consultation workflow
1. **DoctorDashboard** — Today's queue, Patients-at-Risk tile, Care Gaps shortcuts
2. **Click queued patient** → `ConsultationRoom`:
   - Left rail: PatientHistoryPanel (tabbed: prescriptions, appointments, summaries, triage, pain, journey)
   - Center: Video iframe or Offline placeholder
   - Right: Clinical Notes + Visit Summary + Patient Snapshot + Diet Prescription + Retention Checklist
3. **+ Record** → RecordIntakeModal (Vitals / Prakriti / Lifestyle tabs)
4. **Save Notes** during session
5. **Generate Health Report** → PDF + WhatsApp to patient
6. **Complete Session** → FollowUpSchedulerModal → submits follow-up decision
7. **VisitSummaryModal** — Author diagnosis + prescriptions + advice, send to patient portal
8. **Auto-generated**: HandoffNote draft, FollowUpTask for doctor

### Therapist session workflow
1. TherapistDashboard — today's queue + outcomes
2. Click session → `SessionWorkspace`: patient context, SOAP note (Subjective/Objective/Assessment/Plan), TherapyOutcome scoring
3. Save SOAP + outcome → patient's "My Progress" tab populates
4. Home therapy: GPS pings every 10s en-route → arrived → in session → completed

### Admin Doctor weekly workflow
1. Review PerformanceScorecards for branch clinicians
2. Approve appointment holds (PENDING_DOCTOR_APPROVAL)
3. TriageOverride stats → adjust specialty routing weights
4. Care Gaps review → assign follow-ups
5. Critical Journey review → escalate or resolve
6. Staff Attendance review

### Pharmacist workflow
1. Low-stock alert → reorder or stock transfer
2. Incoming order → review Rx → dispense items → PharmacyDispense rows
3. Refill request → check Rx active/expired → approve or reject
4. Stock transfer between branches: PENDING → APPROVED → IN_TRANSIT → RECEIVED

### Super Admin workflow
1. Hospital onboarding: create → set plan → seed Branch + users → toggle features
2. Per-hospital feature flag changes
3. Suspend / decommission hospital lifecycle
4. Cross-hospital audit + Bull-Board inspection

## 9. External integrations

| Service | Purpose | Auth | Module |
|---|---|---|---|
| Evolution API (self-hosted) | WhatsApp send | `apikey` header | `services/whatsapp.service.js` |
| Daily.co | Video rooms + webhooks | `DAILY_API_KEY` | `services/video.service.js` + `routes/webhooks.js` |
| OpenAI Whisper | STT (Tamil + English) | `OPENAI_API_KEY` | `services/voiceCoach/stt.service.js` |
| OpenAI GPT-4o | Chat completions, voice-note structuring | `OPENAI_API_KEY` | `services/voiceCoach/` |
| Google Cloud TTS | Voice coach replies | `GCP_TTS_API_KEY` | `services/voiceCoach/tts.service.js` |
| Supabase Storage | Photos, audio, PDFs | `SUPABASE_SERVICE_KEY` | Node SDK direct |
| Razorpay | Patient payments | webhooks + REST | `services/payment.service.js` |
| Sentry | Error reporting | `SENTRY_DSN` | `lib/sentry.js` |
| Redis | BullMQ broker + cache | `REDIS_URL` | `services/queue.service.js` + `services/cache.service.js` |

## 10. AI Features Roadmap

| # | Feature | Phase | Status |
|---|---|---|---|
| 02 | Ambient Voice-to-Note | 2 | ✅ Shipped |
| 06 | Voice Health Coach | 2 | ✅ Shipped |
| 05 | Behavioural Nudge Engine | 2 | ✅ Shipped (2026-06-09) — LLM personalised + NudgeLog feedback |
| 07 | Multi-Agent Orchestration | 2 | ✅ Shipped (2026-06-09) — 4 agents on `triage.critical.submitted` |
| 08 | Explainable AI | 2 | ✅ Shipped (2026-06-09) — "Why?" popover on Appointments + Care Gaps |
| 04 | Predictive Dosha | 3 | ✅ Shipped (2026-06-09) — nightly DoshaForecast cron |
| 03 | Multimodal Diagnostic | 3 | ✅ Shipped (2026-06-09) — Jihva Pariksha step in daily check-in |
| 01 | Patient Digital Twin | 4 | ✅ Shipped (2026-06-09) — consolidated panel on ConsultationRoom |
| 10 | AI Revenue Cycle | 3 | Pending (blocked on ABDM external API) |
| 09 | Federated Learning | 4 | Pending (no Python ML stack yet) |

### Sprint 2026-06-09 follow-ups (filed, not blocking)

| # | Item | Where |
|---|---|---|
| F09 | PatientCriticalFlag.reasons race condition | `careGapAgent`, `doshaCron`, `tongueAnalysis` route all read-modify-write the same JSON column. Needs row-level lock or atomic JSON ops. |
| F10 | `buildTongueSummary` IMPROVING branch logic | Re-balance trajectories (BALANCED→VATA→BALANCED) currently fall through to STABLE. Needs product input on correct rules. |
| F13 | `dashboardSummariser` rich card payload | autoActions object is computed but never persisted on the Notification row. Extend `enqueueInAppNotification` to accept `data` payload. |
| F14 | CareGapDashboard `hasDoshaForecast` chip | Backend never populates this on care-gap rows; chip never renders. Add per-row dosha-forecast presence check in CareGapService.listGaps. |
| Reuse | DOSHA_COLOUR duplicated in 5 frontend files | Consolidate to `src/lib/doshaTheme.ts`. |
| Reuse | PatientCriticalFlag reasons-merge in 3 services | Extract to `services/patientCriticalFlag.service.js`. |
| Reuse | `makeFeatureCache` duplicates `featureGate.isFeatureAvailable` with subtly different fail modes | Add a `makeCachedFeatureGate(featureKey)` to `utils/featureGate.js`. |
| Altitude | Two DailyCheckIn components (wellness + patient) | Consolidate; F03 Step 5 copy-pasted between them and one had a 401 bug the other didn't. |
| Altitude | NotificationPanel 30-case switch + `data.link` short-circuit | Retire the switch; require emitters to set `data.link`. |
| Altitude | TongueObservation half-extended schema | Migrate legacy enum columns to strings or split into two tables. |

## 11. Operational gotchas (lessons learned)

| Gotcha | Where it surfaces | Mitigation |
|---|---|---|
| ES module imports are hoisted above `dotenv.config()` | `index.js` startup | Use `import 'dotenv/config'` as the first import — not `import dotenv; dotenv.config()` |
| `_prisma_migrations` table says applied but DDL never ran | Schema drift | Use `prisma migrate diff` to detect; apply missing DDL idempotently |
| `bg-card` is white in light theme | UI cards on white columns | Use `bg-secondary/30` or another tinted shade for visibility |
| Flex column with `min-h-0 + overflow-y-auto` compresses children | ConsultationRoom right column | Add `shrink-0` to load-bearing card wrappers |
| Vite HMR can miss new file additions on OneDrive paths | Dev | Hard refresh + sometimes restart Vite + delete `node_modules/.vite` cache |
| WhatsApp gateway "not configured" despite `.env` set | Config | `dotenv` must run before config module evaluates |
| Patient self-reported data in `DailyCheckIn` doesn't appear in vitals | healthSummary | Service must merge `DailyCheckIn` into `latestVitals` with source label |
| `PatientVital.patientId` references `User.id` not `Patient.id` | Schema | Resolve `Patient.id → userId` before insert |

## 12. Documentation maintenance

State as of **2026-06-09** (sprint commit), drawing from:
- IWIS Platform Reference v2026-05-19 (covering fixes 1–39)
- Sprint 2026-06-09 — 6 AI features shipped (F01, F03, F04, F05, F07, F08)
- Live Prisma schema (82+ models including `NudgeLog`, `DoshaForecast`, extended `TongueObservation`)
- Live route inventory (67+ route files, ~500 endpoints + 4 new AI endpoints)
- Code review pass: 9-angle review surfaced 15 findings, 11 critical fixes shipped in same sprint commit

When schema or routes change meaningfully, refresh the affected section.

### Test surface
- Backend: `cd alshifa-backend && npm test` → 319 unit tests across 25 files (Vitest), 80% coverage threshold on `services/**`
- Frontend: `cd alshifa-frontend && npm test` → 41 unit tests including aiFeatures.test.tsx component tests
- Combined: **360 unit tests** passing at commit. No real OpenAI / Supabase / Evolution traffic in tests.
