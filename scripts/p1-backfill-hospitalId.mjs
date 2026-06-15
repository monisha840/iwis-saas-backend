// scripts/p1-backfill-hospitalId.mjs
//
// Phase 1 (P1-T2): backfill the new nullable `hospitalId` on the 28 Bucket 3
// anchor tables by tracing each row to its hospital through its parent.
//
// READ-ONLY by default (dry run). Set APPLY=true to actually write.
//   node scripts/p1-backfill-hospitalId.mjs            # dry run — shows what WOULD change
//   APPLY=true node scripts/p1-backfill-hospitalId.mjs # apply
//
// Resolution always traces to an ULTIMATE anchor (User.hospitalId or
// Branch.hospitalId via Patient) so it does not depend on other anchor tables
// having been backfilled first (order-independent). Rows whose parent itself
// has a null hospital are reported as "unresolvable" and left null (the column
// stays nullable until T8).
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.env.APPLY === 'true';

// ── small caches so we don't re-query the same parents ───────────────────────
const userHosp = new Map();   // userId   -> hospitalId|null
const patientHosp = new Map(); // patientId -> hospitalId|null

async function byUser(userId) {
  if (!userId) return null;
  if (userHosp.has(userId)) return userHosp.get(userId);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { hospitalId: true } });
  const h = u?.hospitalId ?? null;
  userHosp.set(userId, h);
  return h;
}

async function byPatient(patientId) {
  if (!patientId) return null;
  if (patientHosp.has(patientId)) return patientHosp.get(patientId);
  const p = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { branchId: true, userId: true, branch: { select: { hospitalId: true } } },
  });
  let h = p?.branch?.hospitalId ?? null;       // prefer Patient.branchId -> Branch.hospitalId
  if (!h && p?.userId) h = await byUser(p.userId); // fallback Patient.userId -> User.hospitalId
  patientHosp.set(patientId, h);
  return h;
}

// Polymorphic "clinician/participant" id: try Doctor.id, Therapist.id, then User.id.
async function byParticipant(id) {
  if (!id) return null;
  const d = await prisma.doctor.findUnique({ where: { id }, select: { userId: true } });
  if (d) return byUser(d.userId);
  const t = await prisma.therapist.findUnique({ where: { id }, select: { userId: true } });
  if (t) return byUser(t.userId);
  const u = await prisma.user.findUnique({ where: { id }, select: { hospitalId: true } });
  if (u) return u.hospitalId ?? null;
  return null;
}

async function byNotification(notificationId) {
  if (!notificationId) return null;
  const n = await prisma.notification.findUnique({ where: { id: notificationId }, select: { userId: true } });
  return n ? byUser(n.userId) : null;
}

async function byStaffThread(threadId) {
  if (!threadId) return null;
  const t = await prisma.staffThread.findUnique({ where: { id: threadId }, select: { hospitalId: true } });
  return t?.hospitalId ?? null;
}

async function byVoiceConversation(conversationId) {
  if (!conversationId) return null;
  const c = await prisma.voiceConversation.findUnique({ where: { id: conversationId }, select: { patientId: true } });
  return c ? byPatient(c.patientId) : null;
}

// ── per-model config: delegate, fields to select, resolver(row) -> hospitalId ─
const PLAN = [
  { model: 'doctor',                 select: { userId: true },          resolve: r => byUser(r.userId) },
  { model: 'therapist',              select: { userId: true },          resolve: r => byUser(r.userId) },
  { model: 'pharmacist',             select: { userId: true },          resolve: r => byUser(r.userId) },
  { model: 'journey',                select: { patientId: true },       resolve: r => byPatient(r.patientId) },
  { model: 'auditLog',               select: { userId: true },          resolve: r => byUser(r.userId) },
  { model: 'notification',           select: { userId: true },          resolve: r => byUser(r.userId) },
  { model: 'notificationDelivery',   select: { notificationId: true },  resolve: r => byNotification(r.notificationId) },
  { model: 'notificationPreference', select: { userId: true },          resolve: r => byUser(r.userId) },
  { model: 'announcement',           select: { authorId: true },        resolve: r => byUser(r.authorId) },
  { model: 'message',                select: { senderId: true },        resolve: r => byUser(r.senderId) },
  { model: 'staffMessage',           select: { threadId: true },        resolve: r => byStaffThread(r.threadId) },
  { model: 'staffThreadMember',      select: { threadId: true },        resolve: r => byStaffThread(r.threadId) },
  { model: 'voiceConversation',      select: { patientId: true },       resolve: r => byPatient(r.patientId) },
  { model: 'voiceMessage',           select: { conversationId: true },  resolve: r => byVoiceConversation(r.conversationId) },
  { model: 'dietPrescription',       select: { patientId: true },       resolve: r => byPatient(r.patientId) },
  { model: 'clinicalPhoto',          select: { patientId: true },       resolve: r => byPatient(r.patientId) },
  { model: 'packageEnrolment',       select: { patientId: true },       resolve: r => byPatient(r.patientId) },
  { model: 'referral',               select: { referrerId: true },      resolve: r => byPatient(r.referrerId) },
  { model: 'bulkOperation',          select: { initiatedBy: true },     resolve: r => byUser(r.initiatedBy) },
  { model: 'availability',           select: { therapistId: true },     resolve: r => byParticipant(r.therapistId) },
  { model: 'blockedSlot',            select: { doctorId: true, therapistId: true }, resolve: r => byParticipant(r.doctorId || r.therapistId) },
  { model: 'patientAssignment',      select: { patientId: true },       resolve: r => byPatient(r.patientId) },
  { model: 'leaderboardAudit',       select: { participantId: true },   resolve: r => byParticipant(r.participantId) },
  { model: 'clinicianStreak',        select: { participantId: true },   resolve: r => byParticipant(r.participantId) },
  { model: 'gamificationAnomaly',    select: { participantId: true },   resolve: r => byParticipant(r.participantId) },
  { model: 'adaptiveTarget',         select: { participantId: true },   resolve: r => byParticipant(r.participantId) },
  { model: 'performanceScorecard',   select: { clinicianId: true },     resolve: r => byParticipant(r.clinicianId) },
  { model: 'seasonalChallengeProgress', select: { participantId: true }, resolve: r => byParticipant(r.participantId) },
];

async function main() {
  console.log(`\n=== P1 hospitalId backfill — ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'} ===\n`);
  let totalNull = 0, totalResolved = 0, totalUnresolved = 0;

  for (const { model, select, resolve } of PLAN) {
    const delegate = prisma[model];
    const nullRows = await delegate.findMany({ where: { hospitalId: null }, select: { id: true, ...select } });
    if (nullRows.length === 0) {
      console.log(`  ${model.padEnd(26)} : 0 null rows`);
      continue;
    }
    let resolved = 0, unresolved = 0;
    for (const row of nullRows) {
      const hospitalId = await resolve(row);
      if (hospitalId) {
        resolved++;
        if (APPLY) await delegate.update({ where: { id: row.id }, data: { hospitalId } });
      } else {
        unresolved++;
      }
    }
    totalNull += nullRows.length; totalResolved += resolved; totalUnresolved += unresolved;
    const tag = unresolved > 0 ? `  ⚠️ ${unresolved} UNRESOLVABLE (left null)` : '';
    console.log(`  ${model.padEnd(26)} : ${nullRows.length} null -> ${resolved} ${APPLY ? 'updated' : 'resolvable'}${tag}`);
  }

  console.log(`\n  TOTAL: ${totalNull} null rows | ${totalResolved} ${APPLY ? 'updated' : 'resolvable'} | ${totalUnresolved} unresolvable`);
  console.log(APPLY ? '\nApplied. Re-run dry mode to confirm 0 resolvable remain.' : '\nDry run only — set APPLY=true to write.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
