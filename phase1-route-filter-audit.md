# Phase 1 · P1-T6 — Route-level filter audit

**Read-only audit. No filters were added or removed.** The automatic Prisma
extension (P1-T3) is the primary isolation gate; manual `where: { hospitalId }`
/ `where: { branchId }` filters in routes/services are a **second, additive**
layer and were left untouched.

## Coverage summary

| Signal | Files |
|--------|-------|
| Use `hospitalId:` in a query/where | 32 (services/repositories/routes/controllers) |
| Use `branchId:` in a query/where | 77 |
| Reference `req.user.hospitalId` | 13 |
| Reference `req.user.branchId` / `req.branchId` | 23 |
| Route files with **some** tenant/branch handling | 37 of 76 |
| Route files with **no** explicit tenant filter | 39 of 76 (rely on the extension, delegate to a filtering service, or are a gap — see below) |

Branch-level scoping is also enforced for the **DOCTOR** role via
`middleware/branchScope.js` (`requireBranchScoped` + `assertBranchOwnership`),
which is opt-in per route and exempts ADMIN_DOCTOR/ADMIN/BRANCH_ADMIN/etc.

## Route files with no explicit hospitalId/branchId filter

These rely on the automatic extension (fine for hospitalId-bearing models) or
delegate to a service that filters. Some operate on **branchId/Bucket-4** data
and are therefore **not** auto-isolated by the hospitalId extension (see gap):

adherence, announcements, auth, branch, bulk, chat, clinicalIntake, clinicalPhoto,
consultation-context, consultation, dailyTracking, dashboard-summary, dietPrescription,
enhanced-dashboard, followUpTasks, gamification, handoff, healthReports, healthSummary,
message-templates, motivation, notifications, painMap, portal, prescribed-vitals, queue,
referrals, refill, reminder-settings, retention-checklist, slotOptimization, therapistNotes,
therapyOutcomes, timeline, todos, visit-summary, voice-coach, webhooks, wellness

(`auth`, `webhooks` are intentionally pre-/non-tenant; `voice-coach` etc. self-scope by the caller's own id.)

## 🚩 KEY FINDING — branchId / Bucket-4 data is NOT covered by the automatic filter

The Prisma extension auto-scopes **only the 40 models that have a `hospitalId`
column**. The bulk of clinical data is keyed by **`branchId`** (Patient,
Prescription, Appointment, TriageSession, VisitSummary, Invoice, Conversation,
TreatmentJourney, …) or is **Bucket 4** (reachable only through a parent). The
extension does **not** filter these by hospital.

**Concrete exposure:** `GET /api/patient/:patientId/consultation-context`
(routes/consultation-context.js) lets any DOCTOR / ADMIN_DOCTOR / ADMIN /
BRANCH_ADMIN pass **any** `patientId` with no check that the patient is in the
caller's hospital, and none of that route's Prisma reads are hospitalId-scoped.
A clinician in Hospital A could read Hospital B's patient history. (The one raw
vitals query in that route was hospital-guarded in P1-T4, but the surrounding
Prisma reads were not.)

This contradicts the guide's stated goal ("one hospital can never see another's
data, even with a buggy query"). The guide assumed branchId models were
"already-scoped," but `branchScope.js` only covers the DOCTOR role and only on
opt-in routes.

### Recommended follow-up (NOT done in Phase 1, per decision)
1. **Extend the auto-filter to branchId models** — scope branchId-bearing models
   by `branchId IN (SELECT id FROM Branch WHERE hospitalId = <tenant>)`, derived
   from the request tenant. Closes the gap centrally at the same chokepoint.
2. **OR PostgreSQL Row-Level Security (RLS)** as a defense-in-depth layer beneath
   Prisma (the guide already lists RLS as a future hardening step).
3. Add an explicit patient-belongs-to-tenant check on cross-patient routes like
   `consultation-context` regardless.

## What was NOT changed
- No existing filters removed (they remain as the second safety layer).
- No new route filters added (handled by the extension where applicable; the
  gap above is logged for a follow-up phase).
