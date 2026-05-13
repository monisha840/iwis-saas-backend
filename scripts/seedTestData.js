/**
 * Sheizen Test Data Seed
 * ──────────────────────
 * Populates the minimum data required to exercise all 5 Sheizen features
 * (healthReport, followUpTask, workflowEngine, progressReport, foodDatabase).
 * Idempotent — safe to run multiple times.
 *
 * Field names follow the actual Prisma schema; the source spec used a few
 * placeholder names (e.g. assignedDoctorId, scheduledAt, IN_PROGRESS) that
 * don't exist on the real models. Mappings applied:
 *   - Patient assignment → PatientAssignment row (PRIMARY/ACTIVE)
 *   - Appointment.scheduledAt → Appointment.date
 *   - JourneyPhase IN_PROGRESS → ACTIVE (PhaseStatus enum)
 *   - PatientVital "PAIN" → PAIN_SCORE; "SLEEP" → SLEEP_HOURS (VitalType enum)
 *   - TreatmentJourney.patientId / doctorId → User.id (relation points at User)
 *
 * Run:  npm run seed:test
 */

import dotenv from 'dotenv';
dotenv.config();

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const SALT_ROUNDS = 10;
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  console.log('\n=========================================');
  console.log('  Sheizen Test Data Seed');
  console.log('=========================================\n');

  // ── SECTION 1 — Branch ────────────────────────────────────────────────────
  let branch = await prisma.branch.findFirst({ where: { isActive: true } });
  if (!branch) {
    // Branch.hospitalId is NOT NULL in the schema, so make sure a hospital
    // exists before we create the branch.
    let hospital = await prisma.hospital.findFirst();
    if (!hospital) {
      hospital = await prisma.hospital.create({
        data: {
          name: 'Al-Shifa Test Hospital',
          slug: 'al-shifa-test',
          contactEmail: 'admin@alshifa-test.com',
        },
      });
      console.log('✓ Hospital created:', hospital.id);
    }
    branch = await prisma.branch.create({
      data: {
        name: 'Al-Shifa Chennai Test Branch',
        address: '123 Test Street, Chennai',
        phone: '+919876543210',
        email: 'chennai@alshifa-test.com',
        hospitalId: hospital.id,
        isActive: true,
      },
    });
    console.log('✓ Branch created:', branch.id);
  } else {
    console.log('✓ Existing branch reused:', branch.name, '(', branch.id, ')');
  }

  // ── SECTION 2 — Doctor + Patient users (with profiles) ────────────────────
  let doctorUser = await prisma.user.findUnique({
    where: { email: 'testdoctor@alshifa.com' },
    include: { doctor: true },
  });
  if (!doctorUser) {
    const password = await bcrypt.hash('Test@1234', SALT_ROUNDS);
    doctorUser = await prisma.user.create({
      data: {
        email: 'testdoctor@alshifa.com',
        password,
        role: 'DOCTOR',
        emailVerifiedAt: new Date(),
        branchId: branch.id,
        doctor: {
          create: {
            fullName: 'Dr. Arjun Kumar',
            specialization: 'Ayurvedic Medicine',
            qualification: 'BAMS, MD Ayurveda',
            yearsExperience: 10,
            registrationNumber: 'TEST-DOC-001',
            phoneNumber: '+919876543210',
          },
        },
      },
      include: { doctor: true },
    });
    console.log('✓ Doctor user + profile created:', doctorUser.email);
  } else {
    console.log('✓ Doctor user reused:', doctorUser.email);
  }
  const doctor = doctorUser.doctor;

  let patientUser = await prisma.user.findUnique({
    where: { email: 'testpatient@alshifa.com' },
    include: { patient: true },
  });
  if (!patientUser) {
    const password = await bcrypt.hash('Test@1234', SALT_ROUNDS);
    patientUser = await prisma.user.create({
      data: {
        email: 'testpatient@alshifa.com',
        password,
        role: 'PATIENT',
        emailVerifiedAt: new Date(),
        branchId: branch.id,
        patient: {
          create: {
            fullName: 'Priya Sharma',
            dob: new Date('1990-05-15'),
            gender: 'FEMALE',
            phoneNumber: '+919876543211',
            patientId: 'TEST-PAT-001',
            branchId: branch.id,
            onboardingCompleted: true,
            onboardingData: {
              prakriti: 'Vata',
              height: 165,
              weight: 58,
              doshaType: 'VATA',
            },
            allergies: [],
          },
        },
      },
      include: { patient: true },
    });
    console.log('✓ Patient user + profile created:', patientUser.email);
  } else {
    console.log('✓ Patient user reused:', patientUser.email);
  }
  const patient = patientUser.patient;

  // The schema doesn't expose Patient.assignedDoctorId — assignment lives
  // on the canonical PatientAssignment join table.
  const existingAssignment = await prisma.patientAssignment.findFirst({
    where: { patientId: patient.id, doctorId: doctor.id, status: 'ACTIVE' },
  });
  if (!existingAssignment) {
    await prisma.patientAssignment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        type: 'PRIMARY',
        status: 'ACTIVE',
        assignedById: doctorUser.id,
      },
    });
    console.log('✓ PatientAssignment (PRIMARY/ACTIVE) created');
  }

  // ── SECTION 3 — NotificationPreference for the patient ────────────────────
  const existingPref = await prisma.notificationPreference.findUnique({
    where: { userId: patientUser.id },
  });
  if (!existingPref) {
    await prisma.notificationPreference.create({
      data: {
        userId: patientUser.id,
        whatsappEnabled: true,
        whatsappNumber: '+919876543211',
        pushEnabled: true,
        appointmentReminders: true,
        prescriptionUpdates: true,
        medicationReminders: true,
      },
    });
    console.log('✓ Patient NotificationPreference created');
  }
  // Doctor preference too — defaults are fine, just ensure the row exists so
  // downstream notification dispatchers don't crash on a missing record.
  const doctorPref = await prisma.notificationPreference.findUnique({
    where: { userId: doctorUser.id },
  });
  if (!doctorPref) {
    await prisma.notificationPreference.create({ data: { userId: doctorUser.id } });
  }

  // ── SECTION 4 — Completed Appointment (drives F02 PDF report) ─────────────
  let completedAppointment = await prisma.appointment.findFirst({
    where: { patientId: patient.id, doctorId: doctor.id, status: 'COMPLETED' },
  });
  if (!completedAppointment) {
    completedAppointment = await prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        branchId: branch.id,
        date: new Date(Date.now() - 2 * DAY),
        status: 'COMPLETED',
        consultationType: 'DOCTOR',
        notes:
          'Patient presents with chronic lower back pain (Vata imbalance). Recommended Abhyanga therapy and Ashwagandha supplementation. Sleep quality poor — advised Brahmi oil head massage before bed. Diet to be adjusted to Vata-pacifying foods.',
        sessionNotes:
          'Vata constitution confirmed. Pain pattern consistent with stress + sedentary lifestyle.',
        doctorApproved: true,
      },
    });
    console.log('✓ Completed appointment created:', completedAppointment.id);
  } else {
    console.log('✓ Completed appointment reused:', completedAppointment.id);
  }

  // ── SECTION 5 — Prescriptions linked to that appointment ──────────────────
  const existingRx = await prisma.prescription.findFirst({
    where: { appointmentId: completedAppointment.id },
  });
  if (!existingRx) {
    await prisma.prescription.createMany({
      data: [
        {
          patientId: patient.id,
          doctorId: doctor.id,
          appointmentId: completedAppointment.id,
          branchId: branch.id,
          medicationName: 'Ashwagandha',
          dosage: '500mg',
          frequency: 'Twice daily',
          duration: '30 days',
        },
        {
          patientId: patient.id,
          doctorId: doctor.id,
          appointmentId: completedAppointment.id,
          branchId: branch.id,
          medicationName: 'Brahmi',
          dosage: '250mg',
          frequency: 'Once daily at night',
          duration: '30 days',
        },
      ],
    });
    console.log('✓ Prescriptions created (Ashwagandha + Brahmi)');
  }

  // ── SECTION 6 — Patient Vitals (BMI for F02, pain trend for F04) ──────────
  // PatientVital.patientId references User.id (relation `patient User @...`),
  // not the Patient table — feeding the Patient.id here breaks foreign keys.
  const existingVital = await prisma.patientVital.findFirst({
    where: { patientId: patientUser.id },
  });
  if (!existingVital) {
    const now = Date.now();
    await prisma.patientVital.createMany({
      data: [
        // Weight (the BMI calc multiplies against onboardingData.height)
        { patientId: patientUser.id, type: 'WEIGHT',     value: 58, unit: 'kg',    recordedAt: new Date(now - 7  * DAY) },
        // Pain trend — high → low so F04's "pain reduced" milestone fires
        { patientId: patientUser.id, type: 'PAIN_SCORE', value: 8,  unit: '/10',   recordedAt: new Date(now - 14 * DAY) },
        { patientId: patientUser.id, type: 'PAIN_SCORE', value: 7,  unit: '/10',   recordedAt: new Date(now - 10 * DAY) },
        { patientId: patientUser.id, type: 'PAIN_SCORE', value: 6,  unit: '/10',   recordedAt: new Date(now - 7  * DAY) },
        { patientId: patientUser.id, type: 'PAIN_SCORE', value: 4,  unit: '/10',   recordedAt: new Date(now - 3  * DAY) },
        { patientId: patientUser.id, type: 'SLEEP_HOURS', value: 5, unit: 'hours', recordedAt: new Date(now - 5  * DAY) },
        { patientId: patientUser.id, type: 'MOOD',        value: 3, unit: '/5',    recordedAt: new Date(now - 5  * DAY) },
      ],
    });
    console.log('✓ Patient vitals seeded (weight + pain trend + sleep + mood)');
  }

  // ── SECTION 7 — Triage Session (F02 pain map source) ──────────────────────
  // Schema has no chiefComplaint / bodyRegions / lifestyle / allergies cols
  // on TriageSession — the equivalents are triageNotes / painRegions /
  // lifestyleData, plus Patient.allergies (already empty array above).
  const existingTriage = await prisma.triageSession.findFirst({
    where: { patientId: patient.id },
  });
  if (!existingTriage) {
    await prisma.triageSession.create({
      data: {
        patientId: patient.id,
        branchId: branch.id,
        responses: {
          chiefComplaint: 'Chronic lower back pain with stiffness, worse in the morning',
          medicalHistory: 'No major surgeries. Mild anxiety.',
          allergies: 'None known',
        },
        severity: 'MODERATE',
        compositeScore: 7.5,
        urgencyLevel: 'MODERATE',
        triageNotes:
          'Chronic lower back pain with stiffness, worse in the morning',
        painRegions: [
          {
            regionId: 'lower-back',
            regionLabel: 'Lower Back',
            intensity: 8,
            characters: ['Aching'],
            radiates: true,
            radiatesTo: 'left-hip',
          },
          {
            regionId: 'left-hip',
            regionLabel: 'Left Hip',
            intensity: 5,
            characters: ['Stiffness'],
            radiates: false,
          },
        ],
        lifestyleData: {
          sleepQuality: 'Poor',
          stressLevel: 'High',
          exerciseFrequency: 'Rarely',
          dietQuality: 'Fair',
        },
        flags: [],
        alternativeSpecialties: [],
        redFlagsMatched: [],
      },
    });
    console.log('✓ Triage session created');
  }

  // ── SECTION 8 — TreatmentJourney + phases + tasks (F04) ───────────────────
  // TreatmentJourney.patientId / doctorId are User.id, not Patient.id.
  let journey = await prisma.treatmentJourney.findFirst({
    where: { patientId: patientUser.id, status: 'ACTIVE' },
  });
  if (!journey) {
    journey = await prisma.treatmentJourney.create({
      data: {
        patientId: patientUser.id,
        doctorId: doctorUser.id,
        branchId: branch.id,
        title: 'Vata Imbalance Treatment',
        condition: 'Chronic lower back pain · Vata imbalance',
        status: 'ACTIVE',
        startDate: new Date(Date.now() - 14 * DAY),
        targetDate: new Date(Date.now() + 60 * DAY),
      },
    });
    console.log('✓ Treatment journey created:', journey.id);
  } else {
    console.log('✓ Treatment journey reused:', journey.id);
  }

  // Phase 1 — COMPLETED
  let phase1 = await prisma.journeyPhase.findFirst({
    where: { journeyId: journey.id, order: 1 },
  });
  if (!phase1) {
    phase1 = await prisma.journeyPhase.create({
      data: {
        journeyId: journey.id,
        name: 'Initial Detox',
        order: 1,
        status: 'COMPLETED',
        durationDays: 7,
        startedAt: new Date(Date.now() - 14 * DAY),
        completedAt: new Date(Date.now() - 7 * DAY),
      },
    });
  }

  // Phase 2 — ACTIVE  (PhaseStatus enum has no IN_PROGRESS; ACTIVE is the
  // running-phase value the F04 service expects to flip to COMPLETED).
  let phase2 = await prisma.journeyPhase.findFirst({
    where: { journeyId: journey.id, order: 2 },
  });
  if (!phase2) {
    phase2 = await prisma.journeyPhase.create({
      data: {
        journeyId: journey.id,
        name: 'Panchakarma Therapy',
        order: 2,
        status: 'ACTIVE',
        durationDays: 14,
        startedAt: new Date(Date.now() - 7 * DAY),
      },
    });
    console.log('✓ Phase 2 ACTIVE created (=IN_PROGRESS):', phase2.id);
  }

  // Phase 3 — UPCOMING
  let phase3 = await prisma.journeyPhase.findFirst({
    where: { journeyId: journey.id, order: 3 },
  });
  if (!phase3) {
    phase3 = await prisma.journeyPhase.create({
      data: {
        journeyId: journey.id,
        name: 'Maintenance & Lifestyle',
        order: 3,
        status: 'UPCOMING',
        durationDays: 30,
      },
    });
  }

  // Phase 2 tasks + 2 completions (PhaseTask requires `frequency`).
  const existingTasks = await prisma.phaseTask.findMany({
    where: { phaseId: phase2.id },
  });
  if (existingTasks.length === 0) {
    await prisma.phaseTask.createMany({
      data: [
        { phaseId: phase2.id, type: 'THERAPY',    title: 'Abhyanga massage session',     description: 'Full body warm oil massage',           frequency: 'Twice weekly' },
        { phaseId: phase2.id, type: 'DIET',       title: 'Follow Vata-pacifying diet',   description: 'Avoid cold and dry foods',             frequency: 'Daily' },
        { phaseId: phase2.id, type: 'MEDICATION', title: 'Take Ashwagandha',             description: '500mg twice daily with warm milk',     frequency: 'Twice daily' },
        { phaseId: phase2.id, type: 'LIFESTYLE',  title: 'Morning breathing exercise',   description: '10 min pranayama before breakfast',    frequency: 'Daily' },
      ],
    });
    const allTasks = await prisma.phaseTask.findMany({
      where: { phaseId: phase2.id },
      orderBy: { title: 'asc' },
    });
    // TaskCompletion.patientId is also User.id per the schema relation.
    await prisma.taskCompletion.createMany({
      data: allTasks.slice(0, 2).map((t) => ({
        taskId: t.id,
        patientId: patientUser.id,
        completedAt: new Date(Date.now() - 3 * DAY),
        notes: 'Completed as instructed',
      })),
    });
    console.log('✓ Phase 2 tasks created (4 tasks, 2 completed)');
  }

  // ── SECTION 9 — Diet prescription + meals + adherence logs (~40%) ────────
  let dietPrescription = await prisma.dietPrescription.findFirst({
    where: { patientId: patient.id, isActive: true },
  });
  if (!dietPrescription) {
    dietPrescription = await prisma.dietPrescription.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        title: 'Vata-Pacifying Diet Plan',
        doshaTarget: 'VATA',
        category: 'SATTVIC',
        isActive: true,
        startDate: new Date(Date.now() - 14 * DAY),
      },
    });

    await prisma.dietMeal.createMany({
      data: [
        {
          dietPrescriptionId: dietPrescription.id,
          mealTime: 'BREAKFAST',
          foods: [
            { name: 'Warm oatmeal', quantity: '1', unit: 'bowl' },
            { name: 'Ghee', quantity: '1', unit: 'tsp' },
          ],
          avoidFoods: [{ name: 'Cold milk' }, { name: 'Raw salad' }],
        },
        {
          dietPrescriptionId: dietPrescription.id,
          mealTime: 'LUNCH',
          foods: [
            { name: 'Rice', quantity: '1', unit: 'cup' },
            { name: 'Moong dal', quantity: '1', unit: 'cup' },
            { name: 'Cooked vegetables', quantity: '1', unit: 'cup' },
          ],
          avoidFoods: [{ name: 'Fried foods' }, { name: 'Beans' }],
        },
        {
          dietPrescriptionId: dietPrescription.id,
          mealTime: 'DINNER',
          foods: [
            { name: 'Khichdi', quantity: '1', unit: 'bowl' },
            { name: 'Warm soup', quantity: '1', unit: 'cup' },
          ],
          avoidFoods: [{ name: 'Heavy meats' }, { name: 'Cold foods' }],
        },
      ],
    });

    // Last 7 days × 3 meals = 21 logs. ~40% followed → trips F03 low-adherence rule.
    const adherenceLogs = [];
    for (let i = 7; i >= 1; i--) {
      const logDate = new Date(Date.now() - i * DAY);
      ['BREAKFAST', 'LUNCH', 'DINNER'].forEach((mealTime, idx) => {
        adherenceLogs.push({
          dietPrescriptionId: dietPrescription.id,
          patientId: patient.id,
          date: logDate,
          mealTime,
          followed: idx === 0 && i % 3 === 0,
          loggedAt: logDate,
        });
      });
    }
    // skipDuplicates guards against the @@unique constraint on
    // (dietPrescriptionId, patientId, mealTime, date).
    await prisma.dietAdherenceLog.createMany({
      data: adherenceLogs,
      skipDuplicates: true,
    });
    console.log('✓ Diet prescription + 3 meals + 21 adherence logs (~40%)');
  }

  // ── SECTION 10 — DailyCheckIn absence (F03 trigger) ──────────────────────
  // We deliberately don't create check-ins. Just confirm the absence.
  const recentCheckin = await prisma.dailyCheckIn.findFirst({
    where: {
      patientId: patient.id,
      createdAt: { gte: new Date(Date.now() - 3 * DAY) },
    },
  });
  if (recentCheckin) {
    console.log(
      '⚠ Warning: a recent check-in exists for this patient; the NO_CHECKIN ' +
      'workflow rule will not fire until 3 days have passed without one.',
    );
  } else {
    console.log('✓ No recent check-in — NO_CHECKIN workflow rule will fire');
  }

  // ── SECTION 11 — Journey milestones (F04 PDF section) ────────────────────
  const existingMilestone = await prisma.journeyMilestone.findFirst({
    where: { journeyId: journey.id },
  });
  if (!existingMilestone) {
    await prisma.journeyMilestone.createMany({
      data: [
        {
          journeyId: journey.id,
          title: 'Pain reduced to 5/10',
          description: 'Pain vital reading below 5',
          isAchieved: true,
          achievedAt: new Date(Date.now() - 3 * DAY),
        },
        {
          journeyId: journey.id,
          title: 'Complete Initial Detox Phase',
          description: 'Phase 1 status = COMPLETED',
          isAchieved: true,
          achievedAt: new Date(Date.now() - 7 * DAY),
        },
        {
          journeyId: journey.id,
          title: 'Full Recovery',
          description: 'Pain vital reading below 2 for 7 days',
          isAchieved: false,
        },
      ],
    });
    console.log('✓ Journey milestones created (3, 2 achieved)');
  }

  // ── SECTION 12 — Upcoming appointment (F02 next-appointment block) ───────
  const existingUpcoming = await prisma.appointment.findFirst({
    where: {
      patientId: patient.id,
      status: 'CONFIRMED',
      date: { gt: new Date() },
    },
  });
  if (!existingUpcoming) {
    await prisma.appointment.create({
      data: {
        patientId: patient.id,
        doctorId: doctor.id,
        branchId: branch.id,
        date: new Date(Date.now() + 3 * DAY),
        status: 'CONFIRMED',
        consultationType: 'DOCTOR',
      },
    });
    console.log('✓ Upcoming appointment created (3 days from now)');
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n=========================================');
  console.log('TEST DATA SEED COMPLETE');
  console.log('=========================================');
  console.log('Login credentials:');
  console.log('  DOCTOR:  testdoctor@alshifa.com / Test@1234');
  console.log('  PATIENT: testpatient@alshifa.com / Test@1234');
  console.log('\nData created:');
  console.log('  Branch ID:                ', branch.id);
  console.log('  Doctor ID:                ', doctor.id);
  console.log('  Doctor User ID:           ', doctorUser.id);
  console.log('  Patient ID:               ', patient.id);
  console.log('  Patient User ID:          ', patientUser.id);
  console.log('  Completed Appointment ID: ', completedAppointment.id);
  console.log('  Active Journey ID:        ', journey.id);
  console.log('  ACTIVE Phase ID (=IN_PROGRESS):', phase2.id);
  console.log('\nReady to test:');
  console.log('  F02: Generate report for appointment', completedAppointment.id);
  console.log('  F03: Run Evaluate Now — NO_CHECKIN rule fires for patient', patient.id);
  console.log('  F04: Complete phase', phase2.id, 'to trigger progress report');
  console.log('  F05: Submit triage with pain ≥ 7 as patient', patientUser.email);
  console.log('=========================================\n');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
