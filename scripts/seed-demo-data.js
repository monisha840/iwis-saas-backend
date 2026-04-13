/**
 * Al-Shifa Demo Data Seed
 * ────────────────────────
 * Populates the database with realistic demo data to showcase all major features:
 * patients, appointments, prescriptions, pharmacy, wellness check-ins, journeys,
 * chat, referrals, invoices, feedback, retention checklists, leaderboard, and more.
 *
 * Run: node scripts/seed-demo-data.js
 *
 * Safe to re-run — skip-if-exists guards throughout.
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const BRANCH_ID = 'default-branch-id';
const SALT_ROUNDS = 10;

// ── Date helpers (anchored to a fixed demo date) ──────────────────────────────
const BASE = new Date('2026-03-19T10:00:00.000Z');
function daysAgo(n, hour = 10)  { const d = new Date(BASE); d.setDate(d.getDate() - n); d.setHours(hour, 0, 0, 0); return d; }
function daysAhead(n, hour = 10) { const d = new Date(BASE); d.setDate(d.getDate() + n); d.setHours(hour, 0, 0, 0); return d; }

// ── Helpers ───────────────────────────────────────────────────────────────────
async function findOrCreateUser({ email, password, role, profileType, profile }) {
  const existing = await prisma.user.findUnique({
    where: { email },
    include: { doctor: true, therapist: true, patient: true, pharmacist: true },
  });
  if (existing) return existing;

  const hashed = await bcrypt.hash(password, SALT_ROUNDS);
  const profileRelation = buildProfile(profileType, profile);

  const user = await prisma.user.create({
    data: {
      email, password: hashed, role, branchId: BRANCH_ID,
      ...profileRelation,
    },
    include: { doctor: true, therapist: true, patient: true, pharmacist: true },
  });
  await prisma.notificationPreference.create({ data: { userId: user.id } });
  return user;
}

function buildProfile(type, data) {
  switch (type) {
    case 'doctor':     return { doctor:     { create: data } };
    case 'therapist':  return { therapist:  { create: data } };
    case 'patient':    return { patient:    { create: data } };
    case 'pharmacist': return { pharmacist: { create: data } };
    default: throw new Error(`Unknown profileType: ${type}`);
  }
}

function notify(userId, { type, title, message, priority = 'INFO', relatedId = null }) {
  return prisma.notification.create({
    data: { userId, type, title, message, priority, relatedId, isRead: false },
  });
}

// ── 1. Extra patients ─────────────────────────────────────────────────────────
const EXTRA_PATIENTS = [
  {
    email: 'priya@demo.com', password: 'Patient@123', role: 'PATIENT', profileType: 'patient',
    profile: { fullName: 'Priya Sundaram', gender: 'Female', age: 32, phoneNumber: '+91-9000000002',
               therapyType: 'Occupational', patientId: 'PAT-0002', onboardingCompleted: true, zenPoints: 120 },
  },
  {
    email: 'hussain@demo.com', password: 'Patient@123', role: 'PATIENT', profileType: 'patient',
    profile: { fullName: 'Mohammed Hussain', gender: 'Male', age: 55, phoneNumber: '+91-9000000003',
               therapyType: 'Physical', patientId: 'PAT-0003', onboardingCompleted: true, zenPoints: 80 },
  },
  {
    email: 'lakshmi@demo.com', password: 'Patient@123', role: 'PATIENT', profileType: 'patient',
    profile: { fullName: 'Lakshmi Devi', gender: 'Female', age: 28, phoneNumber: '+91-9000000004',
               therapyType: 'Speech', patientId: 'PAT-0004', onboardingCompleted: true, zenPoints: 200 },
  },
  {
    email: 'rajan@demo.com', password: 'Patient@123', role: 'PATIENT', profileType: 'patient',
    profile: { fullName: 'Rajan Kumar', gender: 'Male', age: 65, phoneNumber: '+91-9000000005',
               therapyType: 'Physical', patientId: 'PAT-0005', onboardingCompleted: true, zenPoints: 50 },
  },
];

// ── 2. Extra doctor ───────────────────────────────────────────────────────────
const EXTRA_STAFF = [
  {
    email: 'doctor2@demo.com', password: 'Doctor@123', role: 'DOCTOR', profileType: 'doctor',
    profile: { fullName: 'Dr. Anitha Krishnan', specialization: 'Neurology',
               qualification: 'MBBS, DM (Neurology)', yearsExperience: 8, clinic: 'Al-Shifa Hospital' },
  },
];

// ── 3. Medicines ──────────────────────────────────────────────────────────────
const MEDICINES = [
  { sku: 'MED-001', name: 'Paracetamol 500mg', brand: 'Cipla', category: 'Analgesic', type: 'Tablet', price: 2.5, manufacturer: 'Cipla Ltd', composition: 'Paracetamol 500mg' },
  { sku: 'MED-002', name: 'Ibuprofen 400mg',   brand: 'Abbott', category: 'NSAID',     type: 'Tablet', price: 4.0, manufacturer: 'Abbott India', composition: 'Ibuprofen 400mg' },
  { sku: 'MED-003', name: 'Amoxicillin 500mg', brand: 'Sun Pharma', category: 'Antibiotic', type: 'Capsule', price: 8.5, manufacturer: 'Sun Pharma', composition: 'Amoxicillin Trihydrate 500mg' },
  { sku: 'MED-004', name: 'Metformin 500mg',   brand: 'USV', category: 'Antidiabetic', type: 'Tablet', price: 3.0, manufacturer: 'USV Pvt Ltd', composition: 'Metformin HCl 500mg' },
  { sku: 'MED-005', name: 'Amlodipine 5mg',    brand: 'Pfizer', category: 'Antihypertensive', type: 'Tablet', price: 5.5, manufacturer: 'Pfizer India', composition: 'Amlodipine Besylate 5mg' },
  { sku: 'MED-006', name: 'Omeprazole 20mg',   brand: 'AstraZeneca', category: 'PPI', type: 'Capsule', price: 6.0, manufacturer: 'AstraZeneca India', composition: 'Omeprazole 20mg' },
  { sku: 'MED-007', name: 'Diclofenac Gel 1%', brand: 'Novartis', category: 'NSAID', type: 'Gel', price: 35.0, manufacturer: 'Novartis India', composition: 'Diclofenac Diethylamine 1.16%' },
  { sku: 'MED-008', name: 'Vitamin D3 60000IU', brand: 'Macleods', category: 'Supplement', type: 'Capsule', price: 12.0, manufacturer: 'Macleods Pharma', composition: 'Cholecalciferol 60000IU' },
  { sku: 'MED-009', name: 'Calcium + Magnesium', brand: 'Alkem', category: 'Supplement', type: 'Tablet', price: 9.0, manufacturer: 'Alkem Labs', composition: 'Calcium 500mg + Magnesium 250mg' },
  { sku: 'MED-010', name: 'Atorvastatin 10mg', brand: 'Ranbaxy', category: 'Statin', type: 'Tablet', price: 7.5, manufacturer: 'Ranbaxy Labs', composition: 'Atorvastatin Calcium 10mg' },
];

// ── 4. Exercise videos ────────────────────────────────────────────────────────
const EXERCISE_VIDEOS = [
  { title: 'Shoulder Mobility Exercise', category: 'Shoulder', videoUrl: 'https://example.com/videos/shoulder-mobility.mp4', description: 'Gentle shoulder mobility for rotator cuff rehabilitation.' },
  { title: 'Lower Back Stretching', category: 'Back', videoUrl: 'https://example.com/videos/lower-back-stretch.mp4', description: 'Targeted lower back stretches to reduce pain and improve flexibility.' },
  { title: 'Knee Strengthening', category: 'Knee', videoUrl: 'https://example.com/videos/knee-strengthen.mp4', description: 'Quad and hamstring strengthening for knee stability.' },
  { title: 'Breathing & Relaxation', category: 'Wellness', videoUrl: 'https://example.com/videos/breathing.mp4', description: 'Diaphragmatic breathing techniques for stress and pain management.' },
  { title: 'Balance Training', category: 'Balance', videoUrl: 'https://example.com/videos/balance.mp4', description: 'Progressive balance exercises for post-stroke recovery.' },
];

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  Al-Shifa — Demo Data Seed');
  console.log('══════════════════════════════════════════════════════════\n');

  // ── Look up existing core users ──────────────────────────────────────────
  const adminUser  = await prisma.user.findUnique({ where: { email: 'admin@admin.com' },      include: { doctor: true } });
  const doctorUser = await prisma.user.findUnique({ where: { email: 'doctor@iwis.com' },      include: { doctor: true } });
  const therapistUser = await prisma.user.findUnique({ where: { email: 'therapist@iwis.com' }, include: { therapist: true } });
  const pharmacistUser = await prisma.user.findUnique({ where: { email: 'pharmacist@iwis.com' }, include: { pharmacist: true } });
  const existingPatient = await prisma.user.findUnique({ where: { email: 'patient@iwis.com' },  include: { patient: true } });

  if (!adminUser || !doctorUser || !therapistUser || !pharmacistUser || !existingPatient) {
    console.error('❌  Core users not found. Run `node prisma/seed.js` first.');
    process.exit(1);
  }

  const doctorId    = adminUser.doctor.id;
  const doctor2UserId = null; // filled below
  const therapistId = therapistUser.therapist.id;
  const patientIds  = [existingPatient.patient.id]; // will be extended

  console.log('✔ Core users verified');

  // ── Seed extra staff ─────────────────────────────────────────────────────
  console.log('\n📋 Seeding extra staff…');
  const doctor2User = await findOrCreateUser(EXTRA_STAFF[0]);
  const doctor2Id   = doctor2User.doctor.id;
  console.log(`  ✔ ${doctor2User.email} [${doctor2User.role}]`);

  // ── Seed extra patients ──────────────────────────────────────────────────
  console.log('\n📋 Seeding extra patients…');
  const patientUsers = [];
  for (const p of EXTRA_PATIENTS) {
    const u = await findOrCreateUser(p);
    patientUsers.push(u);
    patientIds.push(u.patient.id);
    console.log(`  ✔ ${u.email} → ${u.patient.fullName}`);
  }

  // Convenience refs
  const [p1, p2, p3, p4] = patientUsers;  // Priya, Hussain, Lakshmi, Rajan
  const p0 = existingPatient;             // Chellakannu (existing)

  // ── Seed medicines ───────────────────────────────────────────────────────
  console.log('\n💊 Seeding medicines…');
  const medicineMap = {};
  for (const med of MEDICINES) {
    const existing = await prisma.medicine.findUnique({ where: { sku: med.sku } });
    if (existing) {
      medicineMap[med.sku] = existing;
      console.log(`  ⏭  ${med.name} (exists)`);
    } else {
      medicineMap[med.sku] = await prisma.medicine.create({ data: med });
      console.log(`  ✔ ${med.name}`);
    }
  }

  // ── Seed medicine stocks ─────────────────────────────────────────────────
  console.log('\n📦 Seeding medicine stocks…');
  const stockData = [
    { sku: 'MED-001', qty: 500, batch: 'BAT-2026-001', expiry: daysAhead(365) },
    { sku: 'MED-002', qty: 200, batch: 'BAT-2026-002', expiry: daysAhead(300) },
    { sku: 'MED-003', qty: 150, batch: 'BAT-2026-003', expiry: daysAhead(280) },
    { sku: 'MED-004', qty: 300, batch: 'BAT-2026-004', expiry: daysAhead(400) },
    { sku: 'MED-005', qty: 180, batch: 'BAT-2026-005', expiry: daysAhead(350) },
    { sku: 'MED-006', qty: 120, batch: 'BAT-2026-006', expiry: daysAhead(320) },
    { sku: 'MED-007', qty: 60,  batch: 'BAT-2026-007', expiry: daysAhead(240) },
    { sku: 'MED-008', qty: 8,   batch: 'BAT-2026-008', expiry: daysAhead(180), minStock: 10 }, // LOW STOCK
    { sku: 'MED-009', qty: 90,  batch: 'BAT-2026-009', expiry: daysAhead(360) },
    { sku: 'MED-010', qty: 220, batch: 'BAT-2026-010', expiry: daysAhead(420) },
  ];
  for (const s of stockData) {
    const med = medicineMap[s.sku];
    const exists = await prisma.medicineStock.findFirst({ where: { medicineId: med.id, batchNumber: s.batch } });
    if (!exists) {
      await prisma.medicineStock.create({
        data: { medicineId: med.id, batchNumber: s.batch, expiryDate: s.expiry,
                quantity: s.qty, minStock: s.minStock ?? 10, branchId: BRANCH_ID },
      });
      console.log(`  ✔ Stock: ${s.sku} (${s.qty} units)`);
    } else {
      console.log(`  ⏭  Stock: ${s.sku} (exists)`);
    }
  }

  // ── Seed exercise videos ─────────────────────────────────────────────────
  console.log('\n🎬 Seeding exercise videos…');
  const videoMap = {};
  for (const v of EXERCISE_VIDEOS) {
    const exists = await prisma.exerciseVideo.findFirst({ where: { title: v.title } });
    videoMap[v.title] = exists ?? await prisma.exerciseVideo.create({ data: v });
    console.log(`  ${exists ? '⏭ ' : '✔'} ${v.title}`);
  }

  // ── Seed appointments ────────────────────────────────────────────────────
  console.log('\n📅 Seeding appointments…');

  const apptDefs = [
    // ─── Completed (past) ───
    { pid: p0.patient.id, did: doctorId,   tid: null,        date: daysAgo(45), status: 'COMPLETED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Initial consultation. Chronic lower back pain. Started physiotherapy plan.' },
    { pid: p0.patient.id, did: null,       tid: therapistId, date: daysAgo(38), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Baseline assessment. Postural analysis done. Home exercise plan provided.' },
    { pid: p0.patient.id, did: doctorId,   tid: therapistId, date: daysAgo(30), status: 'COMPLETED', type: 'COMBINED',  approved: true, mode: 'OFFLINE', notes: 'Combined review. Pain reduced from 7/10 to 4/10. Continue PT.' },
    { pid: p0.patient.id, did: null,       tid: therapistId, date: daysAgo(23), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Good progress. Introduced balance exercises.' },
    { pid: p0.patient.id, did: null,       tid: therapistId, date: daysAgo(16), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Mobilty improvement noted. Reduced pain medication.' },
    { pid: p0.patient.id, did: doctorId,   tid: null,        date: daysAgo(9),  status: 'COMPLETED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Follow-up. Patient doing well. Review in 2 weeks.' },

    { pid: p1.patient.id, did: doctor2Id,  tid: null,        date: daysAgo(40), status: 'COMPLETED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Occupational therapy assessment. Carpal tunnel suspected.' },
    { pid: p1.patient.id, did: null,       tid: therapistId, date: daysAgo(33), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Wrist splinting and nerve glide exercises prescribed.' },
    { pid: p1.patient.id, did: null,       tid: therapistId, date: daysAgo(26), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Significant improvement in grip strength.' },
    { pid: p1.patient.id, did: null,       tid: therapistId, date: daysAgo(19), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Discharged from acute care. Monthly review recommended.' },

    { pid: p2.patient.id, did: doctorId,   tid: null,        date: daysAgo(50), status: 'COMPLETED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Diabetic patient with knee pain. X-ray ordered.' },
    { pid: p2.patient.id, did: doctorId,   tid: null,        date: daysAgo(35), status: 'COMPLETED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Mild osteoarthritis. Physiotherapy recommended. Metformin adjusted.' },
    { pid: p2.patient.id, did: null,       tid: therapistId, date: daysAgo(21), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Hydrotherapy and low-impact exercises. Good tolerance.' },
    { pid: p2.patient.id, did: null,       tid: therapistId, date: daysAgo(7),  status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Continued improvement. Weight management discussed.' },

    { pid: p3.patient.id, did: doctor2Id,  tid: null,        date: daysAgo(28), status: 'COMPLETED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Speech and language initial assessment. Mild dysarthria.' },
    { pid: p3.patient.id, did: null,       tid: therapistId, date: daysAgo(21), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Articulation exercises commenced. Patient very motivated.' },
    { pid: p3.patient.id, did: null,       tid: therapistId, date: daysAgo(14), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Noticeable improvement in speech clarity.' },

    { pid: p4.patient.id, did: doctorId,   tid: null,        date: daysAgo(60), status: 'COMPLETED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Post-stroke rehabilitation intake. Right-sided weakness.' },
    { pid: p4.patient.id, did: null,       tid: therapistId, date: daysAgo(53), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Functional movement assessment. Gait training initiated.' },
    { pid: p4.patient.id, did: null,       tid: therapistId, date: daysAgo(46), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Balance improving. Uses quad cane. Family trained.' },
    { pid: p4.patient.id, did: doctorId,   tid: null,        date: daysAgo(32), status: 'COMPLETED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Excellent functional recovery. Reduced medications.' },
    { pid: p4.patient.id, did: null,       tid: therapistId, date: daysAgo(18), status: 'COMPLETED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Independent walking achieved on flat surfaces.' },

    // ─── Upcoming / pending ───
    { pid: p0.patient.id, did: doctorId,   tid: null,        date: daysAhead(2),  status: 'CONFIRMED', type: 'DOCTOR',    approved: true, mode: 'OFFLINE', notes: 'Routine follow-up.' },
    { pid: p1.patient.id, did: null,       tid: therapistId, date: daysAhead(3),  status: 'CONFIRMED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Monthly maintenance session.' },
    { pid: p2.patient.id, did: null,       tid: therapistId, date: daysAhead(5),  status: 'CONFIRMED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Continued knee physio.' },
    { pid: p3.patient.id, did: null,       tid: therapistId, date: daysAhead(4),  status: 'CONFIRMED', type: 'THERAPIST', approved: true, mode: 'OFFLINE', notes: 'Speech therapy session 8.' },
    { pid: p4.patient.id, did: doctorId,   tid: therapistId, date: daysAhead(7),  status: 'CONFIRMED', type: 'COMBINED',  approved: true, mode: 'OFFLINE', notes: 'Combined 3-month review.' },
    { pid: p0.patient.id, did: null,       tid: therapistId, date: daysAhead(10), status: 'PENDING',   type: 'THERAPIST', approved: false, mode: 'OFFLINE', notes: null },
    { pid: p2.patient.id, did: doctorId,   tid: null,        date: daysAhead(12), status: 'PENDING',   type: 'DOCTOR',    approved: false, mode: 'OFFLINE', notes: null },

    // ─── Cancelled (for realistic data) ───
    { pid: p1.patient.id, did: doctorId,   tid: null,        date: daysAgo(5),  status: 'CANCELLED', type: 'DOCTOR',    approved: false, mode: 'OFFLINE', notes: 'Patient cancelled due to work commitment.' },
    { pid: p4.patient.id, did: null,       tid: therapistId, date: daysAgo(11), status: 'CANCELLED', type: 'THERAPIST', approved: false, mode: 'OFFLINE', notes: 'Therapist unavailable — rescheduled.' },
  ];

  const appointments = [];
  for (const a of apptDefs) {
    const exists = await prisma.appointment.findFirst({
      where: { patientId: a.pid, date: a.date, status: a.status },
    });
    if (exists) {
      appointments.push(exists);
      continue;
    }
    const appt = await prisma.appointment.create({
      data: {
        patientId: a.pid,
        doctorId: a.did,
        therapistId: a.tid,
        date: a.date,
        status: a.status,
        consultationType: a.type,
        consultationMode: a.mode,
        notes: a.notes,
        branchId: BRANCH_ID,
        doctorApproved: a.approved,
        therapistApproved: a.tid ? a.approved : false,
        notificationSent: a.status === 'COMPLETED',
      },
    });
    appointments.push(appt);
  }
  console.log(`  ✔ ${appointments.length} appointments seeded`);

  const completedAppts = appointments.filter(a => a.status === 'COMPLETED');

  // ── Seed prescriptions ────────────────────────────────────────────────────
  console.log('\n📄 Seeding prescriptions…');

  const rxDefs = [
    { pid: p0.patient.id, did: doctorId, tid: null,       medSku: 'MED-002', name: 'Ibuprofen 400mg',   dosage: '400mg', freq: 'Twice daily', dur: '2 weeks', notes: 'Take after meals. For pain management.' },
    { pid: p0.patient.id, did: doctorId, tid: null,       medSku: 'MED-008', name: 'Vitamin D3 60000IU', dosage: '60000IU', freq: 'Once weekly', dur: '8 weeks', notes: 'Low Vitamin D detected on blood test.' },
    { pid: p2.patient.id, did: doctorId, tid: null,       medSku: 'MED-004', name: 'Metformin 500mg',   dosage: '500mg', freq: 'Twice daily', dur: '3 months', notes: 'Continue from previous prescription. Monitor HbA1c.' },
    { pid: p2.patient.id, did: doctorId, tid: null,       medSku: 'MED-005', name: 'Amlodipine 5mg',    dosage: '5mg',   freq: 'Once daily',  dur: '3 months', notes: 'For hypertension management.' },
    { pid: p2.patient.id, did: doctorId, tid: null,       medSku: 'MED-010', name: 'Atorvastatin 10mg', dosage: '10mg',  freq: 'Once at night', dur: '3 months', notes: 'Elevated LDL. Lifestyle changes advised.' },
    { pid: p4.patient.id, did: doctorId, tid: null,       medSku: 'MED-005', name: 'Amlodipine 5mg',    dosage: '5mg',   freq: 'Once daily',  dur: '6 months', notes: 'Post-stroke hypertension management.' },
    { pid: p4.patient.id, did: doctorId, tid: null,       medSku: 'MED-009', name: 'Calcium + Magnesium', dosage: '1 tablet', freq: 'Once daily', dur: '3 months', notes: 'Bone health support for elderly patient.' },
    { pid: p1.patient.id, did: null,    tid: therapistId, medSku: 'MED-007', name: 'Diclofenac Gel 1%', dosage: 'Apply thin layer', freq: '3 times daily', dur: '4 weeks', notes: 'Apply to affected wrist area.' },
    { pid: p3.patient.id, did: doctor2Id, tid: null,      medSku: 'MED-006', name: 'Omeprazole 20mg',   dosage: '20mg',  freq: 'Once daily before breakfast', dur: '4 weeks', notes: 'For reflux-related throat discomfort affecting speech.' },
  ];

  const prescriptions = [];
  for (const rx of rxDefs) {
    const med = medicineMap[rx.medSku];
    const exists = await prisma.prescription.findFirst({
      where: { patientId: rx.pid, medicationName: rx.name, medicineId: med.id },
    });
    if (exists) {
      prescriptions.push(exists);
      continue;
    }
    const p = await prisma.prescription.create({
      data: {
        patientId: rx.pid,
        doctorId: rx.did,
        therapistId: rx.tid,
        medicineId: med.id,
        medicationName: rx.name,
        dosage: rx.dosage,
        frequency: rx.freq,
        duration: rx.dur,
        notes: rx.notes,
        totalQuantity: 30,
        lowStockThreshold: 5,
        branchId: BRANCH_ID,
        sku: med.sku,
      },
    });
    prescriptions.push(p);
  }
  console.log(`  ✔ ${prescriptions.length} prescriptions seeded`);

  // ── Seed daily check-ins (30 days for Chellakannu + 14 days for Priya) ──
  console.log('\n🌡️  Seeding daily check-ins…');

  const checkInPatients = [
    { pid: p0.patient.id, days: 30, painBase: 6, trend: -0.1 },  // improving
    { pid: p1.patient.id, days: 21, painBase: 5, trend: -0.15 }, // improving faster
    { pid: p2.patient.id, days: 14, painBase: 7, trend: -0.08 }, // slower improvement
    { pid: p4.patient.id, days: 25, painBase: 4, trend: -0.05 }, // post-stroke, mild pain
  ];
  const moods = ['Happy', 'Neutral', 'Tired', 'Anxious', 'Good', 'Fair'];
  let checkInCount = 0;
  for (const cp of checkInPatients) {
    for (let i = cp.days; i >= 1; i--) {
      const date = daysAgo(i);
      const existing = await prisma.dailyCheckIn.findFirst({
        where: { patientId: cp.pid, createdAt: { gte: new Date(date.getFullYear(), date.getMonth(), date.getDate()), lt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1) } },
      });
      if (existing) continue;
      const rawPain = cp.painBase + cp.trend * (cp.days - i) + (Math.random() * 1.5 - 0.75);
      const pain = Math.min(10, Math.max(1, Math.round(rawPain)));
      await prisma.dailyCheckIn.create({
        data: {
          patientId: cp.pid,
          painLevel: pain,
          mobilityScore: Math.min(10, Math.max(1, Math.round(10 - pain * 0.6 + Math.random()))),
          sleepHours: parseFloat((5.5 + Math.random() * 3).toFixed(1)),
          mood: moods[Math.floor(Math.random() * moods.length)],
          notes: pain >= 7 ? 'Pain worse than usual today.' : pain <= 3 ? 'Feeling much better.' : null,
          createdAt: date,
        },
      });
      checkInCount++;
    }
  }
  console.log(`  ✔ ${checkInCount} daily check-ins seeded`);

  // ── Seed journeys ────────────────────────────────────────────────────────
  console.log('\n🗺️  Seeding journeys…');

  const journeyDefs = [
    { pid: p0.patient.id, did: doctorId,   tid: therapistId, start: daysAgo(45), status: 'ACTIVE',    total: 12, completed: 6,  goals: 'Reduce lower back pain to ≤2/10. Full ROM restoration. Return to normal daily activities.' },
    { pid: p1.patient.id, did: doctor2Id,  tid: therapistId, start: daysAgo(40), status: 'ACTIVE',    total: 8,  completed: 4,  goals: 'Eliminate carpal tunnel symptoms. Full hand function recovery for office work.' },
    { pid: p2.patient.id, did: doctorId,   tid: therapistId, start: daysAgo(50), status: 'ACTIVE',    total: 16, completed: 4,  goals: 'Manage diabetic knee osteoarthritis. Reduce BMI by 5kg. Independent ambulation.' },
    { pid: p3.patient.id, did: doctor2Id,  tid: therapistId, start: daysAgo(28), status: 'ACTIVE',    total: 10, completed: 3,  goals: 'Improve speech clarity to 90%. Manage dysarthria symptoms.' },
    { pid: p4.patient.id, did: doctorId,   tid: therapistId, start: daysAgo(60), status: 'ACTIVE',    total: 24, completed: 7,  goals: 'Post-stroke rehabilitation. Independent walking indoors. Functional arm use.' },
  ];

  const journeys = [];
  for (const j of journeyDefs) {
    const exists = await prisma.journey.findFirst({ where: { patientId: j.pid, doctorId: j.did } });
    if (exists) {
      journeys.push(exists);
      continue;
    }
    const journey = await prisma.journey.create({
      data: {
        patientId: j.pid, doctorId: j.did, therapistId: j.tid,
        startDate: j.start, status: j.status,
        totalSessions: j.total, completedSessions: j.completed,
        treatmentGoals: j.goals,
        progressNotes: `${j.completed} of ${j.total} sessions completed. Patient showing consistent progress.`,
      },
    });
    journeys.push(journey);
  }
  console.log(`  ✔ ${journeys.length} journeys seeded`);

  // ── Seed medication logs (adherence history) ──────────────────────────────
  console.log('\n💊 Seeding medication logs…');

  const rxChellakannu = prescriptions.find(p => p.patientId === p0.patient.id && p.medicationName === 'Ibuprofen 400mg');
  const rxHussainMetformin = prescriptions.find(p => p.patientId === p2.patient.id && p.medicationName === 'Metformin 500mg');

  let medLogCount = 0;
  const medLogDefs = [
    { rx: rxChellakannu,    pid: p0.patient.id, journey: journeys[0], days: 14, name: 'Ibuprofen 400mg',   dosage: '400mg' },
    { rx: rxHussainMetformin, pid: p2.patient.id, journey: journeys[2], days: 14, name: 'Metformin 500mg', dosage: '500mg' },
  ];

  for (const ml of medLogDefs) {
    if (!ml.rx || !ml.journey) continue;
    for (let i = ml.days; i >= 1; i--) {
      const date = daysAgo(i);
      const exists = await prisma.medicationLog.findFirst({ where: { prescriptionId: ml.rx.id, date } });
      if (exists) continue;
      const taken = Math.random() > 0.15; // 85% adherence
      await prisma.medicationLog.create({
        data: {
          journeyId: ml.journey.id,
          prescriptionId: ml.rx.id,
          date,
          medicationName: ml.name,
          dosage: ml.dosage,
          slot: i % 2 === 0 ? 'Morning' : 'Evening',
          taken,
          takenAt: taken ? new Date(date.getTime() + 2 * 3600 * 1000) : null,
          quantityTaken: taken ? 1 : 0,
        },
      });
      medLogCount++;
    }
  }
  console.log(`  ✔ ${medLogCount} medication logs seeded`);

  // ── Seed pharmacy orders ──────────────────────────────────────────────────
  console.log('\n🏥 Seeding pharmacy orders…');

  const orderDefs = [
    { pid: p2.patient.id, uid: p2.id, rx: rxHussainMetformin, status: 'DELIVERED', urgency: 'NORMAL', items: [{ sku: 'MED-004', qty: 30 }, { sku: 'MED-005', qty: 30 }] },
    { pid: p0.patient.id, uid: p0.id, rx: rxChellakannu, status: 'APPROVED', urgency: 'NORMAL', items: [{ sku: 'MED-002', qty: 20 }] },
    { pid: p4.patient.id, uid: p4.id, rx: null, status: 'PENDING', urgency: 'URGENT', items: [{ sku: 'MED-009', qty: 30 }, { sku: 'MED-005', qty: 30 }] },
    { pid: p1.patient.id, uid: p1.id, rx: null, status: 'DELIVERED', urgency: 'NORMAL', items: [{ sku: 'MED-007', qty: 2 }] },
  ];

  for (const od of orderDefs) {
    const exists = await prisma.pharmacyOrder.findFirst({ where: { patientId: od.pid, status: od.status } });
    if (exists) { console.log(`  ⏭  Order for ${od.pid} (exists)`); continue; }

    const items = od.items.map(i => ({
      medicineId: medicineMap[i.sku].id,
      quantity: i.qty,
      unitPrice: medicineMap[i.sku].price,
      totalPrice: medicineMap[i.sku].price * i.qty,
    }));
    const total = items.reduce((s, i) => s + i.totalPrice, 0);

    await prisma.pharmacyOrder.create({
      data: {
        patientId: od.pid,
        orderedBy: od.uid,
        prescriptionId: od.rx?.id ?? null,
        status: od.status,
        urgency: od.urgency,
        totalAmount: total,
        branchId: BRANCH_ID,
        items: { create: items },
      },
    });
    console.log(`  ✔ Order: ${od.status} for ${od.pid}`);
  }

  // ── Seed pharmacy dispenses ───────────────────────────────────────────────
  console.log('\n💉 Seeding pharmacy dispenses…');
  const dispenseDefs = [
    { pid: p2.patient.id, uid: pharmacistUser.id, rx: rxHussainMetformin, items: [{ sku: 'MED-004', qty: 30 }, { sku: 'MED-005', qty: 30 }] },
    { pid: p1.patient.id, uid: pharmacistUser.id, rx: null, items: [{ sku: 'MED-007', qty: 2 }] },
  ];
  for (const dd of dispenseDefs) {
    const exists = await prisma.pharmacyDispense.findFirst({ where: { patientId: dd.pid, dispensedBy: dd.uid } });
    if (exists) { console.log(`  ⏭  Dispense for ${dd.pid} (exists)`); continue; }
    const items = dd.items.map(i => ({
      medicineId: medicineMap[i.sku].id,
      quantity: i.qty,
      unitPrice: medicineMap[i.sku].price,
      totalPrice: medicineMap[i.sku].price * i.qty,
    }));
    const total = items.reduce((s, i) => s + i.totalPrice, 0);
    await prisma.pharmacyDispense.create({
      data: {
        patientId: dd.pid,
        dispensedBy: dd.uid,
        prescriptionId: dd.rx?.id ?? null,
        status: 'COMPLETED',
        totalAmount: total,
        branchId: BRANCH_ID,
        items: { create: items },
      },
    });
    console.log(`  ✔ Dispense for patient ${dd.pid}`);
  }

  // ── Seed invoices + payments ───────────────────────────────────────────────
  console.log('\n💰 Seeding invoices & payments…');
  const invoiceDefs = [
    { pid: p0.patient.id, items: [{ desc: 'Doctor Consultation', qty: 1, unit: 500 }, { desc: 'Physiotherapy Session x3', qty: 3, unit: 400 }], status: 'PAID' },
    { pid: p2.patient.id, items: [{ desc: 'Doctor Consultation', qty: 2, unit: 500 }, { desc: 'Physiotherapy Session x2', qty: 2, unit: 400 }, { desc: 'Metformin 500mg x30', qty: 30, unit: 3.0 }, { desc: 'Amlodipine 5mg x30', qty: 30, unit: 5.5 }], status: 'PAID' },
    { pid: p4.patient.id, items: [{ desc: 'Rehabilitation Session x4', qty: 4, unit: 600 }, { desc: 'Balance Training Equipment', qty: 1, unit: 800 }], status: 'UNPAID' },
    { pid: p1.patient.id, items: [{ desc: 'Occupational Therapy x4', qty: 4, unit: 450 }, { desc: 'Diclofenac Gel x2', qty: 2, unit: 35 }], status: 'PAID' },
  ];
  for (const inv of invoiceDefs) {
    const exists = await prisma.invoice.findFirst({ where: { patientId: inv.pid, status: inv.status } });
    if (exists) { console.log(`  ⏭  Invoice for ${inv.pid} (exists)`); continue; }
    const items = inv.items.map(i => ({ description: i.desc, quantity: i.qty, unitPrice: i.unit, totalPrice: i.qty * i.unit }));
    const total  = items.reduce((s, i) => s + i.totalPrice, 0);
    const tax    = parseFloat((total * 0.05).toFixed(2));
    const net    = parseFloat((total + tax).toFixed(2));
    const invoice = await prisma.invoice.create({
      data: {
        patientId: inv.pid, totalAmount: total, taxAmount: tax, netAmount: net,
        status: inv.status, dueDate: daysAhead(30), branchId: BRANCH_ID,
        items: { create: items },
      },
    });
    if (inv.status === 'PAID') {
      await prisma.payment.create({
        data: {
          patientId: inv.pid, amount: net, currency: 'INR', status: 'COMPLETED',
          paymentMethod: 'UPI', transactionId: `TXN-${Date.now()}-${inv.pid.slice(0,6)}`,
          description: 'Invoice payment', invoiceId: invoice.id, branchId: BRANCH_ID,
        },
      });
    }
    console.log(`  ✔ Invoice (${inv.status}): ₹${net} for patient`);
  }

  // ── Seed conversations & messages ─────────────────────────────────────────
  console.log('\n💬 Seeding conversations & messages…');

  const convDefs = [
    {
      pid: p0.patient.id, pUserId: p0.id, did: doctorId, dUserId: adminUser.id,
      messages: [
        { from: 'doctor', text: 'Hello Chellakannu, how is your back feeling today?' },
        { from: 'patient', text: 'Much better, Doctor. The exercises are really helping.' },
        { from: 'doctor', text: 'Great to hear! Keep up with the home exercises and we will review next week.' },
        { from: 'patient', text: 'Sure Doctor. Should I continue the Ibuprofen?' },
        { from: 'doctor', text: 'Yes, but only as needed. Avoid taking it daily — try ice packs first.' },
      ],
    },
    {
      pid: p2.patient.id, pUserId: p2.id, tid: therapistId, tUserId: therapistUser.id,
      messages: [
        { from: 'therapist', text: 'Mohammed, please remember to do the knee exercises at home twice daily.' },
        { from: 'patient', text: 'I will. The pain has reduced a lot since I started.' },
        { from: 'therapist', text: 'Excellent progress! Keep monitoring your blood sugar as well.' },
      ],
    },
    {
      pid: p0.patient.id, pUserId: p0.id, pharmacistId: pharmacistUser.pharmacist.id, pharmUserId: pharmacistUser.id,
      messages: [
        { from: 'pharmacist', text: 'Your Ibuprofen refill is ready for collection.' },
        { from: 'patient', text: 'Thank you! I will come this afternoon.' },
      ],
    },
  ];

  for (const cd of convDefs) {
    let conv;
    if (cd.did) {
      conv = await prisma.conversation.findFirst({ where: { patientId: cd.pid, doctorId: cd.did } });
      if (!conv) conv = await prisma.conversation.create({ data: { patientId: cd.pid, doctorId: cd.did, branchId: BRANCH_ID } });
    } else if (cd.tid) {
      conv = await prisma.conversation.findFirst({ where: { patientId: cd.pid, therapistId: cd.tid } });
      if (!conv) conv = await prisma.conversation.create({ data: { patientId: cd.pid, therapistId: cd.tid, branchId: BRANCH_ID } });
    } else {
      conv = await prisma.conversation.findFirst({ where: { patientId: cd.pid, pharmacistId: cd.pharmacistId } });
      if (!conv) conv = await prisma.conversation.create({ data: { patientId: cd.pid, pharmacistId: cd.pharmacistId, branchId: BRANCH_ID } });
    }

    const existingMsgs = await prisma.message.count({ where: { conversationId: conv.id } });
    if (existingMsgs > 0) { console.log(`  ⏭  Conversation messages exist`); continue; }

    for (let i = 0; i < cd.messages.length; i++) {
      const m = cd.messages[i];
      const senderId = m.from === 'patient' ? cd.pUserId
                     : m.from === 'doctor'  ? cd.dUserId
                     : m.from === 'therapist' ? cd.tUserId
                     : cd.pharmUserId;
      await prisma.message.create({
        data: { conversationId: conv.id, senderId, content: m.text, isRead: true,
                createdAt: daysAgo(3, 9 + i) },
      });
    }
    console.log(`  ✔ Conversation with ${cd.messages.length} messages`);
  }

  // ── Seed appointment feedback ──────────────────────────────────────────────
  console.log('\n⭐ Seeding appointment feedback…');

  const feedbackAppts = completedAppts.slice(0, 12);
  const ratings = [5, 5, 4, 5, 4, 4, 5, 3, 5, 4, 5, 4];
  const comments = [
    'Excellent care and very thorough explanation.',
    'Very helpful session. Feeling much better.',
    'Good session. Would prefer slightly longer consultation time.',
    'Doctor was very understanding and professional.',
    'Therapist is wonderful — really explains each exercise.',
    'Great progress this week!',
    'Best clinic I have visited. Highly recommend.',
    'Session was okay. Had to wait 20 minutes.',
    'Dr. Saleem is exceptional. Very knowledgeable.',
    'Very satisfied with the treatment plan.',
    'Mannikam is an excellent therapist. Very patient.',
    'Good follow-up care.',
  ];
  let fbCount = 0;
  for (let i = 0; i < feedbackAppts.length; i++) {
    const appt = feedbackAppts[i];
    const exists = await prisma.appointmentFeedback.findUnique({ where: { appointmentId: appt.id } });
    if (exists) continue;
    await prisma.appointmentFeedback.create({
      data: {
        appointmentId: appt.id,
        patientId: appt.patientId,
        rating: ratings[i % ratings.length],
        comment: comments[i % comments.length],
        branchId: BRANCH_ID,
      },
    });
    fbCount++;
  }
  console.log(`  ✔ ${fbCount} feedback entries seeded`);

  // ── Seed retention checklists ──────────────────────────────────────────────
  console.log('\n✅ Seeding retention checklists…');

  const retentionAppts = completedAppts.filter(a => a.doctorId || a.therapistId).slice(0, 8);
  let retCount = 0;
  for (const appt of retentionAppts) {
    const exists = await prisma.retentionChecklist.findUnique({ where: { appointmentId: appt.id } });
    if (exists) continue;
    const clinicianId = appt.doctorId
      ? (appt.doctorId === doctorId ? adminUser.id : (appt.doctorId === doctor2Id ? doctor2User.id : adminUser.id))
      : therapistUser.id;
    const clinicianRole = appt.doctorId ? 'DOCTOR' : 'THERAPIST';
    await prisma.retentionChecklist.create({
      data: {
        appointmentId: appt.id,
        patientId: appt.patientId,
        clinicianId,
        clinicianRole,
        branchId: BRANCH_ID,
        items: [
          { category: 'MEDICATION_ADHERENCE',  status: Math.random() > 0.2 ? 'COMPLETED' : 'PARTIAL',       notes: null },
          { category: 'EXERCISE_COMPLIANCE',   status: Math.random() > 0.3 ? 'COMPLETED' : 'NOT_FOLLOWED',  notes: 'Patient reports doing exercises 4/7 days.' },
          { category: 'DIET_LIFESTYLE',        status: Math.random() > 0.4 ? 'PARTIAL'   : 'COMPLETED',     notes: null },
          { category: 'FOLLOW_UP_BOOKING',     status: 'COMPLETED', notes: 'Next appointment scheduled.' },
          { category: 'PATIENT_EDUCATION',     status: 'COMPLETED', notes: 'Education materials provided.' },
        ],
      },
    });
    retCount++;
  }
  console.log(`  ✔ ${retCount} retention checklists seeded`);

  // ── Seed referrals ─────────────────────────────────────────────────────────
  console.log('\n🔗 Seeding referrals…');

  const referralDefs = [
    { referrerId: p0.patient.id, referredId: p1.patient.id, code: 'REF-CHELL-001', status: 'COMPLETED', reward: true },
    { referrerId: p0.patient.id, referredId: p2.patient.id, code: 'REF-CHELL-002', status: 'COMPLETED', reward: true },
    { referrerId: p1.patient.id, referredId: p3.patient.id, code: 'REF-PRIYA-001', status: 'REGISTERED', reward: false },
    { referrerId: p2.patient.id, referredId: null,           code: 'REF-HUSS-001',  status: 'PENDING',    reward: false },
  ];
  for (const r of referralDefs) {
    const exists = await prisma.referral.findUnique({ where: { referralCode: r.code } });
    if (!exists) {
      await prisma.referral.create({
        data: { referrerId: r.referrerId, referredId: r.referredId, referralCode: r.code, status: r.status, rewardGranted: r.reward },
      });
      console.log(`  ✔ Referral ${r.code} (${r.status})`);
    } else {
      console.log(`  ⏭  Referral ${r.code} (exists)`);
    }
  }

  // ── Seed triage sessions ───────────────────────────────────────────────────
  console.log('\n🏥 Seeding triage sessions…');
  const triageDefs = [
    {
      pid: p2.patient.id,
      severity: 'MEDIUM',
      specialty: 'Orthopedics',
      escalated: false,
      responses: { painScore: 6, location: 'Knee', duration: '3 months', mobility: 'Limited', history: 'Diabetes, hypertension' },
    },
    {
      pid: p4.patient.id,
      severity: 'HIGH',
      specialty: 'Neurology',
      escalated: true,
      responses: { painScore: 8, location: 'Right arm/leg', duration: 'Since stroke 2 months ago', mobility: 'Severely limited', history: 'Stroke, hypertension' },
    },
    {
      pid: p3.patient.id,
      severity: 'LOW',
      specialty: 'Speech Therapy',
      escalated: false,
      responses: { painScore: 2, location: 'Throat/speech', duration: '6 months', mobility: 'Normal', history: 'No significant history' },
    },
  ];
  for (const t of triageDefs) {
    const exists = await prisma.triageSession.findFirst({ where: { patientId: t.pid } });
    if (!exists) {
      await prisma.triageSession.create({
        data: { patientId: t.pid, responses: t.responses, severity: t.severity,
                suggestedSpecialty: t.specialty, isEscalated: t.escalated, branchId: BRANCH_ID },
      });
      console.log(`  ✔ Triage: ${t.severity} for patient ${t.pid}`);
    } else {
      console.log(`  ⏭  Triage exists for patient ${t.pid}`);
    }
  }

  // ── Seed video prescriptions ───────────────────────────────────────────────
  console.log('\n🎬 Seeding video prescriptions…');
  const videoPxDefs = [
    { pid: p0.patient.id, tid: therapistId, title: 'Lower Back Stretching',  notes: 'Do 3 sets of 10 reps, morning and evening.' },
    { pid: p0.patient.id, tid: therapistId, title: 'Breathing & Relaxation', notes: 'Practice for 10 minutes before sleep.' },
    { pid: p1.patient.id, tid: therapistId, title: 'Shoulder Mobility Exercise', notes: '5 reps each direction, 3 times daily.' },
    { pid: p2.patient.id, tid: therapistId, title: 'Knee Strengthening',     notes: 'Seated quad sets, 3x15 daily.' },
    { pid: p4.patient.id, tid: therapistId, title: 'Balance Training',        notes: 'Practice near wall support. 5 min sessions twice daily.' },
  ];
  let vpCount = 0;
  for (const vp of videoPxDefs) {
    const video = videoMap[vp.title];
    const exists = await prisma.videoPrescription.findFirst({ where: { patientId: vp.pid, videoId: video.id } });
    if (!exists) {
      await prisma.videoPrescription.create({
        data: { patientId: vp.pid, therapistId: vp.tid, videoId: video.id, notes: vp.notes, branchId: BRANCH_ID },
      });
      vpCount++;
    }
  }
  console.log(`  ✔ ${vpCount} video prescriptions seeded`);

  // ── Seed leaderboard config ───────────────────────────────────────────────
  console.log('\n🏆 Seeding leaderboard config…');
  const lbExists = await prisma.leaderboardConfig.findFirst({ where: { isActive: true } });
  if (!lbExists) {
    await prisma.leaderboardConfig.create({
      data: {
        appointmentWeight: 0.25, adherenceWeight: 0.25, responseTimeWeight: 0.15,
        successRateWeight: 0.20, consistencyWeight: 0.15,
        targetAppointments: 40, targetAdherence: 85.0, targetSuccessRate: 75.0,
        targetResponseTime: 30.0, isActive: true,
      },
    });
    console.log('  ✔ Leaderboard config created');
  } else {
    console.log('  ⏭  Leaderboard config exists');
  }

  // ── Seed notifications ────────────────────────────────────────────────────
  console.log('\n🔔 Seeding notifications…');
  const notifDefs = [
    { uid: p0.id, type: 'APPOINTMENT_REMINDER', title: 'Appointment Tomorrow',      message: 'You have a doctor appointment tomorrow at 10:00 AM.', priority: 'HIGH' },
    { uid: p0.id, type: 'PRESCRIPTION_READY',   title: 'Prescription Ready',         message: 'Your Ibuprofen refill is ready for collection at the pharmacy.', priority: 'MEDIUM' },
    { uid: p2.id, type: 'APPOINTMENT_REMINDER', title: 'Upcoming Appointment',        message: 'Physiotherapy session scheduled in 5 days.', priority: 'MEDIUM' },
    { uid: p2.id, type: 'MEDICATION_REMINDER',  title: 'Medication Reminder',         message: 'Time to take your Metformin 500mg.', priority: 'INFO' },
    { uid: p4.id, type: 'APPOINTMENT_REMINDER', title: 'Combined Review in 7 Days',   message: 'Your combined doctor + therapist review is in 7 days.', priority: 'HIGH' },
    { uid: adminUser.id, type: 'LOW_STOCK_ALERT', title: 'Low Stock Alert',           message: 'Vitamin D3 60000IU stock is critically low (8 units remaining).', priority: 'HIGH' },
    { uid: adminUser.id, type: 'TRIAGE_ESCALATION', title: 'High Severity Triage',   message: 'A high-severity triage has been submitted. Immediate review required.', priority: 'HIGH' },
    { uid: therapistUser.id, type: 'NEW_APPOINTMENT', title: 'New Appointment Request', message: 'A new physiotherapy appointment has been requested by Chellakannu.', priority: 'MEDIUM' },
    { uid: doctorUser.id, type: 'PATIENT_FEEDBACK',  title: 'New Patient Feedback',   message: 'Chellakannu rated their last appointment 5 stars.', priority: 'INFO' },
    { uid: pharmacistUser.id, type: 'NEW_ORDER', title: 'Urgent Pharmacy Order',      message: 'An URGENT pharmacy order has been placed for Rajan Kumar.', priority: 'HIGH' },
  ];
  let notifCount = 0;
  for (const n of notifDefs) {
    const exists = await prisma.notification.findFirst({ where: { userId: n.uid, title: n.title } });
    if (!exists) { await notify(n.uid, n); notifCount++; }
  }
  console.log(`  ✔ ${notifCount} notifications seeded`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  ✅  Demo data seed complete!');
  console.log('══════════════════════════════════════════════════════════');
  console.log('\n  New demo patient accounts:');
  console.log('  ─────────────────────────────────────────────────────');
  for (const p of EXTRA_PATIENTS) {
    console.log(`  ${p.profile.fullName.padEnd(22)} ${p.email.padEnd(25)} ${p.password}`);
  }
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  Extra doctor:  doctor2@demo.com    Doctor@123');
  console.log('══════════════════════════════════════════════════════════\n');
}

main()
  .catch(e => { console.error('\n❌ Demo seed failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
