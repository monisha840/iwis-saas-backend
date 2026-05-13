/**
 * Patient History & Health Passport service.
 *
 * Writes an immutable PatientHistoryRecord when a TreatmentJourney transitions
 * to COMPLETED. The record is a frozen clinical snapshot — outcome metrics,
 * return-risk score, certificate delivery state — that survives even if the
 * underlying journey/phase data is later edited.
 *
 * Key schema realities baked into this file:
 *   - TreatmentJourney.patientId is User.id (relation "JourneyPatient"), NOT
 *     Patient.id. We resolve to Patient.id via the User → Patient join.
 *   - TreatmentJourney.doctorId is User.id (relation "JourneyDoctor"), NOT
 *     Doctor.id. We resolve to Doctor.id via Doctor.userId.
 *   - TaskCompletion.patientId is User.id.
 *   - PatientVital.patientId is User.id.
 *   - Appointment.patientId / Prescription.patientId / DietAdherenceLog.patientId
 *     / ClinicalPhoto.patientId are Patient.id.
 *
 * Public surface:
 *   - aggregateJourneyData(journeyId): pulls everything needed for a snapshot
 *   - calculateReturnRisk(data): produces { score, level, notes }
 *   - createHistoryRecord(journeyId): idempotent; also fires certificate gen +
 *     doctor notification + audit log (all best-effort, never throw)
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';
import { WhatsAppService } from './whatsapp.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// pdfkit loaded via dynamic import to match the rest of the codebase's ESM
// PDF generators (healthReport, prescription).
let PDFDocument;
try {
    const mod = await import('pdfkit');
    PDFDocument = mod.default || mod;
} catch (err) {
    throw new Error('pdfkit is not installed. Run: npm install pdfkit');
}

const BRAND_TEAL  = '#0D6E6E';
const MUTED_TEXT  = '#6b7280';
const PAGE_MARGIN = 60;

// ── 1. aggregateJourneyData ──────────────────────────────────────────────────

export async function aggregateJourneyData(journeyId) {
    const journey = await prisma.treatmentJourney.findUnique({
        where: { id: journeyId },
        include: {
            // `patient` here is a User (per the "JourneyPatient" relation),
            // not a Patient. The User → Patient join below gives us the
            // Patient.id and Patient-side fields (fullName, dob, etc.).
            patient: {
                include: {
                    patient: true,
                    notificationPreference: true,
                },
            },
            doctor: {
                include: { doctor: true },
            },
            branch: true,
            phases: {
                include: { tasks: true },
                orderBy: { order: 'asc' },
            },
        },
    });
    if (!journey) {
        const err = new Error(`Journey ${journeyId} not found`);
        err.status = 404;
        throw err;
    }

    // Resolve Patient row (for Patient.id, fullName, dob, gender, etc.).
    const patientRow = journey.patient?.patient;
    if (!patientRow) {
        const err = new Error(`Journey ${journeyId} has no associated Patient profile`);
        err.status = 400;
        throw err;
    }
    const patientId = patientRow.id;        // Patient.id
    const patientUserId = journey.patientId; // User.id (=== journey.patientId)

    // Resolve Doctor.id (for the PatientHistoryRecord.doctorId FK).
    const doctorRow = journey.doctor?.doctor;
    const doctorId = doctorRow?.id || null;

    // Duration
    const startDate = new Date(journey.startDate);
    const completedDate = new Date();
    const durationDays = Math.max(
        1,
        Math.ceil((completedDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)),
    );

    // Phase + task stats
    const totalPhases = journey.phases.length;
    const completedPhases = journey.phases.filter((p) => p.status === 'COMPLETED').length;
    const allTaskIds = journey.phases.flatMap((p) => p.tasks.map((t) => t.id));
    const totalTasks = allTaskIds.length;

    let completedTasks = 0;
    if (allTaskIds.length > 0) {
        completedTasks = await prisma.taskCompletion.count({
            where: {
                taskId: { in: allTaskIds },
                // Task completions are keyed on User.id, not Patient.id.
                patientId: patientUserId,
            },
        });
    }
    const taskCompletionRate = totalTasks > 0
        ? Math.round((completedTasks / totalTasks) * 100)
        : 0;

    // Pain vitals — schema enum has PAIN_SCORE only (not "PAIN").
    const painVitals = await prisma.patientVital.findMany({
        where: {
            patientId: patientUserId, // User.id
            type: 'PAIN_SCORE',
            recordedAt: { gte: startDate },
        },
        orderBy: { recordedAt: 'asc' },
    });
    const painAtStart = painVitals.length > 0 ? painVitals[0].value : null;
    const painAtEnd = painVitals.length > 0
        ? painVitals[painVitals.length - 1].value
        : null;
    const painReduction = (painAtStart !== null && painAtEnd !== null && painAtStart > 0)
        ? Math.round(((painAtStart - painAtEnd) / painAtStart) * 100)
        : null;

    // Wellness — derive from pain (0–10 scale → 100–0). When no pain data,
    // fall back to journey.wellnessScore for the end value so admin sees
    // *something* rather than a null bar.
    const wellnessAtStart = painAtStart !== null
        ? Math.max(0, 100 - painAtStart * 10)
        : null;
    const wellnessAtEnd = painAtEnd !== null
        ? Math.max(0, 100 - painAtEnd * 10)
        : (journey.wellnessScore || null);
    const wellnessChange = (wellnessAtStart !== null && wellnessAtEnd !== null)
        ? Math.round(wellnessAtEnd - wellnessAtStart)
        : null;

    // Appointments (Appointment.patientId is Patient.id).
    const appointments = await prisma.appointment.findMany({
        where: {
            patientId,
            ...(doctorId ? { doctorId } : {}),
            date: { gte: startDate },
        },
    });
    const totalAppointments = appointments.length;
    const attendedAppointments = appointments.filter(
        (a) => a.status === 'COMPLETED',
    ).length;

    // Prescriptions (patientId is Patient.id).
    const prescriptions = await prisma.prescription.findMany({
        where: {
            patientId,
            createdAt: { gte: startDate },
        },
        orderBy: { createdAt: 'desc' },
    });

    // Diet adherence (DietAdherenceLog.patientId is Patient.id, field is `followed`).
    const dietLogs = await prisma.dietAdherenceLog.findMany({
        where: {
            patientId,
            loggedAt: { gte: startDate },
        },
        select: { followed: true },
    });
    const dietAdherencePercent = dietLogs.length > 0
        ? Math.round(
            (dietLogs.filter((l) => l.followed).length / dietLogs.length) * 100,
        )
        : null;

    // Milestones — both achievedAt and isAchieved exist; OR them so a
    // milestone marked via either path counts as achieved.
    const milestones = await prisma.journeyMilestone.findMany({
        where: { journeyId },
    });
    const totalMilestones = milestones.length;
    const achievedMilestones = milestones.filter(
        (m) => m.isAchieved || m.achievedAt,
    ).length;

    // Clinical photos for this journey.
    const photos = await prisma.clinicalPhoto.findMany({
        where: { patientId, journeyId },
        orderBy: { takenAt: 'asc' },
    });
    const beforePhotosCount = photos.filter((p) => p.stage === 'BEFORE').length;
    const afterPhotosCount  = photos.filter((p) => p.stage === 'AFTER').length;

    // Patient profile snapshot.
    const prakriti = patientRow.onboardingData?.prakriti
        || patientRow.onboardingData?.doshaType
        || null;
    const dob = patientRow.dob;
    const patientAge = dob
        ? Math.floor(
            (Date.now() - new Date(dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000),
        )
        : (patientRow.age ?? null);

    return {
        journey,
        patient: patientRow,
        patientId,
        patientUserId,
        doctorId,
        doctorUser: journey.doctor,
        doctorProfile: doctorRow,
        durationDays,
        totalPhases,
        completedPhases,
        totalTasks,
        completedTasks,
        taskCompletionRate,
        painAtStart,
        painAtEnd,
        painReduction,
        wellnessAtStart,
        wellnessAtEnd,
        wellnessChange,
        totalAppointments,
        attendedAppointments,
        totalPrescriptions: prescriptions.length,
        dietAdherencePercent,
        totalMilestones,
        achievedMilestones,
        beforePhotosCount,
        afterPhotosCount,
        prakriti,
        patientAge,
        patientGender: patientRow.gender || null,
        prescriptions,
        milestones,
        appointments,
        photos,
    };
}

// ── 2. calculateReturnRisk ──────────────────────────────────────────────────

export function calculateReturnRisk(data) {
    let score = 0;
    const notes = [];

    // 1. Low diet adherence
    if (data.dietAdherencePercent !== null) {
        if (data.dietAdherencePercent < 60) {
            score += 3;
            notes.push(`Low diet adherence (${data.dietAdherencePercent}%)`);
        } else if (data.dietAdherencePercent < 75) {
            score += 1;
            notes.push(`Moderate diet adherence (${data.dietAdherencePercent}%)`);
        }
    }

    // 2. Low task completion
    if (data.taskCompletionRate < 70) {
        score += 2;
        notes.push(`Task completion below 70% (${data.taskCompletionRate}%)`);
    }

    // 3. Pain not fully resolved
    if (data.painAtEnd !== null && data.painAtEnd > 3) {
        score += 2;
        notes.push(`Pain score still elevated at discharge (${data.painAtEnd}/10)`);
    }

    // 4. Short treatment duration
    if (data.durationDays < 21) {
        score += 1;
        notes.push('Short treatment duration (under 21 days)');
    }

    // 5. Seasonal risk (Vata patients in monsoon/winter — Jul/Aug/Nov/Dec/Jan)
    const month = new Date().getMonth() + 1;
    const isVata = data.prakriti?.toUpperCase().includes('VATA');
    const isHighRiskSeason = [7, 8, 11, 12, 1].includes(month);
    if (isVata && isHighRiskSeason) {
        score += 1;
        notes.push('Vata constitution — high-risk season for recurrence');
    }

    // 6. Missed appointments
    if (data.totalAppointments > 0) {
        const attendanceRate = (data.attendedAppointments / data.totalAppointments) * 100;
        if (attendanceRate < 70) {
            score += 1;
            notes.push(`Low appointment attendance (${Math.round(attendanceRate)}%)`);
        }
    }

    const finalScore = Math.min(score, 10);
    const level = finalScore >= 7 ? 'HIGH' : finalScore >= 4 ? 'MEDIUM' : 'LOW';

    return {
        score: finalScore,
        level,
        notes: notes.join('. '),
    };
}

// ── 3. generateAndSendCertificate ───────────────────────────────────────────

async function generateCertificatePdf(record, data) {
    const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));

    const pageWidth = doc.page.width;

    // Border
    doc.rect(20, 20, pageWidth - 40, doc.page.height - 40)
        .strokeColor(BRAND_TEAL).lineWidth(3).stroke();
    doc.rect(26, 26, pageWidth - 52, doc.page.height - 52)
        .strokeColor('#9FE1CB').lineWidth(1).stroke();

    // Header
    doc.fillColor(BRAND_TEAL).fontSize(28).font('Helvetica-Bold')
        .text('AL-SHIFA', PAGE_MARGIN, 60, { align: 'center', width: pageWidth - PAGE_MARGIN * 2 });
    doc.fillColor(MUTED_TEXT).fontSize(11).font('Helvetica')
        .text('Ayurvedic Health Centre', PAGE_MARGIN, 92, { align: 'center', width: pageWidth - PAGE_MARGIN * 2 });
    doc.moveTo(PAGE_MARGIN, 115).lineTo(pageWidth - PAGE_MARGIN, 115)
        .strokeColor(BRAND_TEAL).lineWidth(1).stroke();

    // Title
    doc.fillColor('#1a1a1a').fontSize(20).font('Helvetica-Bold')
        .text('WELLNESS CERTIFICATE', PAGE_MARGIN, 135, { align: 'center', width: pageWidth - PAGE_MARGIN * 2 });

    // Patient name + journey
    const patientName = data.patient.fullName
        || data.patient.onboardingData?.name
        || 'Patient';
    const completedLabel = new Date(record.completedDate).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'long', year: 'numeric',
    });

    doc.fillColor(MUTED_TEXT).fontSize(12).font('Helvetica')
        .text('This is to certify that', PAGE_MARGIN, 185, { align: 'center', width: pageWidth - PAGE_MARGIN * 2 });
    doc.fillColor(BRAND_TEAL).fontSize(26).font('Helvetica-Bold')
        .text(patientName, PAGE_MARGIN, 208, { align: 'center', width: pageWidth - PAGE_MARGIN * 2 });
    doc.fillColor('#1a1a1a').fontSize(12).font('Helvetica')
        .text(
            `has successfully completed the\n${record.journeyTitle}\nat Al-Shifa Ayurvedic Health Centre\non ${completedLabel}`,
            PAGE_MARGIN, 250,
            { align: 'center', width: pageWidth - PAGE_MARGIN * 2, lineGap: 6 },
        );

    // Outcomes box
    doc.rect(PAGE_MARGIN, 330, pageWidth - PAGE_MARGIN * 2, 100).fill('#E1F5EE');
    doc.fillColor(BRAND_TEAL).fontSize(13).font('Helvetica-Bold')
        .text('Journey Outcomes', PAGE_MARGIN, 345, { align: 'center', width: pageWidth - PAGE_MARGIN * 2 });

    const outcomeBits = [];
    if (record.painReduction !== null) outcomeBits.push(`Pain reduced by ${record.painReduction}%`);
    if (record.taskCompletionRate !== null) outcomeBits.push(`${record.taskCompletionRate}% of treatment tasks completed`);
    if (record.durationDays) outcomeBits.push(`${record.durationDays} days of dedicated treatment`);
    doc.fillColor('#1a1a1a').fontSize(11).font('Helvetica')
        .text(outcomeBits.join('  ·  ') || '—', PAGE_MARGIN, 370, {
            align: 'center',
            width: pageWidth - PAGE_MARGIN * 2,
            lineGap: 4,
        });

    // Signature area
    const doctorName = data.doctorProfile?.fullName
        || data.doctorUser?.email
        || 'Physician';
    doc.fillColor(MUTED_TEXT).fontSize(11).font('Helvetica')
        .text(`Treating Physician: Dr. ${doctorName}`, PAGE_MARGIN, 465, { align: 'center', width: pageWidth - PAGE_MARGIN * 2 })
        .text(data.journey.branch?.name || 'Al-Shifa Ayurvedic Health Centre', PAGE_MARGIN, 485, { align: 'center', width: pageWidth - PAGE_MARGIN * 2 });

    // Footer
    doc.fillColor(MUTED_TEXT).fontSize(9)
        .text(
            'This certificate is generated from clinical records. It confirms completion of an Ayurvedic treatment journey.',
            PAGE_MARGIN, 530,
            { align: 'center', width: pageWidth - PAGE_MARGIN * 2 },
        );

    doc.end();
    return new Promise((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
    });
}

/**
 * Generate the wellness-certificate PDF, persist it, and optionally deliver
 * via WhatsApp.
 *
 * @param {object} record - PatientHistoryRecord row (passed in so callers can
 *                          control which record's PDF gets generated).
 * @param {object} data   - Aggregated journey data (from aggregateJourneyData).
 * @param {object} [opts]
 * @param {boolean} [opts.sendWhatsApp=true] - Set false for admin retroactive
 *   certificate generation; the WhatsApp "congratulations" message would be
 *   confusing for a journey that completed weeks ago. The live journey-
 *   completion hook leaves this at the default so real-time certs still go out.
 */
export async function generateAndSendCertificate(record, data, opts = {}) {
    const { sendWhatsApp = true } = opts;
    const pdfBuffer = await generateCertificatePdf(record, data);

    // Save PDF to uploads/certificates/ — mirrors uploads/health-reports/
    // layout used by healthReport.service.
    const certDir = path.join(__dirname, '..', 'uploads', 'certificates');
    await fs.promises.mkdir(certDir, { recursive: true });
    const filename = `certificate-${record.patientId}-${Date.now()}.pdf`;
    const absolutePath = path.join(certDir, filename);
    await fs.promises.writeFile(absolutePath, pdfBuffer);
    const relativePath = `uploads/certificates/${filename}`;

    await prisma.patientHistoryRecord.update({
        where: { id: record.id },
        data: { certificatePdfPath: relativePath },
    });

    // WhatsApp delivery — best-effort and opt-out via opts.sendWhatsApp.
    // NotificationPreference.whatsappNumber + `whatsappEnabled` per the
    // schema; if missing, skip silently.
    const pref = data.journey.patient?.notificationPreference;
    const whatsappNumber = pref?.whatsappNumber;
    const whatsappEnabled = !!pref?.whatsappEnabled;
    if (sendWhatsApp && whatsappNumber && whatsappEnabled) {
        try {
            const patientName = data.patient.fullName
                || data.patient.onboardingData?.name
                || 'Patient';
            const firstName = String(patientName).split(' ')[0];
            const result = await WhatsAppService.sendDocument({
                phone:    whatsappNumber,
                document: pdfBuffer.toString('base64'),
                filename: `AlShifa-Wellness-Certificate-${firstName}.pdf`,
                caption:
                    `🌿 Congratulations, ${firstName}!\n\n`
                    + `You have successfully completed your ${record.journeyTitle} at Al-Shifa.\n\n`
                    + (record.painReduction !== null
                        ? `Your pain reduced by ${record.painReduction}% over ${record.durationDays} days.`
                        : `You completed ${record.durationDays} days of treatment.`)
                    + `\n\nYour wellness certificate is attached. We are proud of your journey! 💚\n\n— Al-Shifa Care Team`,
            });
            if (result?.status === 'SENT') {
                await prisma.patientHistoryRecord.update({
                    where: { id: record.id },
                    data: { certificateSent: true, certificateSentAt: new Date() },
                });
            }
        } catch (err) {
            logger.warn('[PatientHistory] WhatsApp certificate delivery failed', { recordId: record.id, err: err.message });
        }
    }
}

// ── 4. createHistoryRecord ──────────────────────────────────────────────────

export async function createHistoryRecord(journeyId) {
    // Idempotent — the journeyId column is @unique.
    const existing = await prisma.patientHistoryRecord.findUnique({
        where: { journeyId },
    });
    if (existing) return { record: existing, alreadyExisted: true };

    const data = await aggregateJourneyData(journeyId);
    const risk = calculateReturnRisk(data);

    // doctorId is required on the record. If the journey's doctor User has
    // no Doctor profile attached (shouldn't happen in practice — DOCTOR/
    // ADMIN_DOCTOR roles always have a Doctor row), refuse to create
    // rather than write a row with a fabricated FK.
    if (!data.doctorId) {
        const err = new Error(`Journey ${journeyId} doctor has no Doctor profile — cannot create history record`);
        err.status = 400;
        throw err;
    }

    const branchId = data.journey.branchId
        || data.patient.branchId
        || null;
    if (!branchId) {
        const err = new Error(`Journey ${journeyId} has no branch context — cannot create history record`);
        err.status = 400;
        throw err;
    }

    const record = await prisma.patientHistoryRecord.create({
        data: {
            patientId: data.patientId,
            journeyId,
            doctorId: data.doctorId,
            branchId,
            journeyTitle: data.journey.title,
            condition: data.journey.condition || null,
            startDate: data.journey.startDate,
            completedDate: new Date(),
            durationDays: data.durationDays,
            painAtStart: data.painAtStart,
            painAtEnd: data.painAtEnd,
            painReduction: data.painReduction,
            wellnessAtStart: data.wellnessAtStart,
            wellnessAtEnd: data.wellnessAtEnd,
            wellnessChange: data.wellnessChange,
            totalPhases: data.totalPhases,
            completedPhases: data.completedPhases,
            totalTasks: data.totalTasks,
            completedTasks: data.completedTasks,
            taskCompletionRate: data.taskCompletionRate,
            totalAppointments: data.totalAppointments,
            attendedAppointments: data.attendedAppointments,
            totalPrescriptions: data.totalPrescriptions,
            dietAdherencePercent: data.dietAdherencePercent,
            totalMilestones: data.totalMilestones,
            achievedMilestones: data.achievedMilestones,
            beforePhotosCount: data.beforePhotosCount,
            afterPhotosCount: data.afterPhotosCount,
            zenPointsEarned: 0,
            returnRiskScore: risk.score,
            returnRiskLevel: risk.level,
            returnRiskNotes: risk.notes || null,
            prakriti: data.prakriti,
            patientAge: data.patientAge,
            patientGender: data.patientGender,
        },
    });

    // Certificate generation + delivery — best-effort.
    try {
        await generateAndSendCertificate(record, data);
    } catch (err) {
        logger.error('[PatientHistory] Certificate generation failed', { recordId: record.id, err: err.message });
    }

    // Doctor notification — best-effort.
    try {
        const doctorUserId = data.journey.doctorId; // User.id
        if (doctorUserId) {
            const patientName = data.patient.fullName
                || data.patient.onboardingData?.name
                || 'Patient';
            await notificationService.createNotification({
                userId: doctorUserId,
                type:   'PATIENT_HISTORY_RECORD_CREATED',
                title:  'Patient Journey Completed',
                message:
                    `${patientName} has completed their ${data.journey.title}.`
                    + (data.painReduction !== null ? ` Pain reduced by ${data.painReduction}%.` : '')
                    + (risk.level === 'HIGH' ? ' High return risk — follow-up recommended.' : ''),
                priority: risk.level === 'HIGH' ? 'HIGH' : 'INFO',
                relatedId: record.id,
                data: {
                    patientHistoryRecordId: record.id,
                    journeyId,
                    patientId: data.patientId,
                    returnRiskLevel: risk.level,
                },
            });
        }
    } catch (err) {
        logger.warn('[PatientHistory] Doctor notification failed', { recordId: record.id, err: err.message });
    }

    // Audit log — best-effort.
    try {
        await prisma.auditLog.create({
            data: {
                userId: data.journey.doctorId || null,
                action: 'PATIENT_HISTORY_RECORD_CREATED',
                entityType: 'PatientHistoryRecord',
                entityId: record.id,
                newData: {
                    patientId: data.patientId,
                    journeyId,
                    returnRiskLevel: risk.level,
                    painReduction: data.painReduction,
                },
            },
        });
    } catch (err) {
        logger.warn('[PatientHistory] Audit log failed', { recordId: record.id, err: err.message });
    }

    return { record, alreadyExisted: false, data };
}
