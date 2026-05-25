/**
 * Health Report Service (Feature 2) — Ayurvedic PDF generation + WhatsApp delivery.
 *
 * Three exports:
 *   • assembleReportData(appointmentId, patientId, doctorId)
 *       Pulls every artefact already recorded during care (Prakriti, triage,
 *       journey, prescriptions, diet, vitals, next appointment) into a single
 *       object. Never throws — missing pieces come back as null.
 *
 *   • generatePDF(reportData) → Buffer
 *       Branded A4 health report (Helvetica only — no external fonts). Section
 *       layout is fixed: patient → key findings → pain map → notes → journey →
 *       medicines → diet → vitals → next appointment. Page header + page footer
 *       (with page numbers) are drawn via pdfkit's pageAdded + bufferedPageRange
 *       hooks.
 *
 *   • createAndDeliverReport(appointmentId, patientId, doctorId, sendWhatsApp, doctorUserId)
 *       Idempotent per-appointment generator: returns the existing record if
 *       one already exists for the appointmentId. Otherwise assembles data,
 *       writes the PDF to uploads/health-reports/, persists a HealthReport row,
 *       optionally fires WhatsApp document delivery (failure does not abort
 *       the operation), pushes an in-app notification + socket event, and
 *       writes an audit log.
 *
 * Schema-field gotchas (the actual schema differs from common naming):
 *   • Patient.dob          (NOT dateOfBirth)
 *   • Patient.fullName     (NOT name)
 *   • Patient.phoneNumber  (NOT phone)
 *   • Doctor.specialization (US spelling) + Doctor.qualification (singular)
 *   • Appointment.date     (NOT scheduledAt) + Appointment.notes/sessionNotes
 *   • Branch.phone         (NOT contactNumber)
 *   • TriageSession.painRegions / lifestyleData / responses (no chiefComplaint
 *     field; we sniff responses JSON and triageNotes for it)
 *   • TreatmentJourney.targetDate (NOT targetEndDate)
 *   • PhaseStatus.ACTIVE   (NOT IN_PROGRESS)
 *   • PatientVital.patientId references User.id, NOT Patient.id — we pass
 *     patient.userId when querying vitals.
 *   • Prescription.medicationName (NOT medicineName)
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { WhatsAppService } from './whatsapp.service.js';

// pdfkit is shared with prescription.service.js + export.service.js — guard
// the require so a missing install fails with a clear, actionable message
// instead of an opaque "Cannot find module" deep inside the generator.
let PDFDocument;
try {
    const mod = await import('pdfkit');
    PDFDocument = mod.default || mod;
} catch (err) {
    throw new Error('pdfkit is not installed. Run: npm install pdfkit');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Brand tokens (mirror frontend Tailwind theme — primary = #0D6E6E) ───────
const BRAND_TEAL  = '#0D6E6E';
const BRAND_WHITE = '#FFFFFF';
const BODY_TEXT   = '#1a1a1a';
const MUTED_TEXT  = '#6b7280';
const DIVIDER     = '#e5e7eb';
const ALT_ROW     = '#f9fafb';
const PAGE_MARGIN = 50;

const MEAL_ORDER = {
    MORNING_EMPTY: 1,
    BREAKFAST:     2,
    MID_MORNING:   3,
    LUNCH:         4,
    EVENING:       5,
    DINNER:        6,
    BEDTIME:       7,
};

// ─── Small helpers (no UI / no I/O) ─────────────────────────────────────────

function calcAge(dob) {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age >= 0 ? age : null;
}

function fmtDate(d, opts) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleDateString('en-IN', opts || { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtDateTime(d) {
    if (!d) return null;
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', hour12: true,
    });
}

function bmiCategoryOf(bmi) {
    if (bmi == null) return null;
    if (bmi < 18.5) return 'Underweight';
    if (bmi < 25)   return 'Normal';
    if (bmi < 30)   return 'Overweight';
    return 'Obese';
}

// onboardingData is JSON — clinicians enter Prakriti under different keys
// across versions of the form. Try the common ones in order.
function pickPrakriti(patient) {
    if (!patient) return null;
    // Primary source: ConstitutionProfile row (PrakritiType enum, e.g. VATA_PITTA).
    // Underscore-to-space so the PDF reads "Vata Pitta" not "VATA_PITTA".
    const fromProfile = patient.constitutionProfile?.prakriti;
    if (fromProfile && typeof fromProfile === 'string') {
        return fromProfile.replace(/_/g, ' ');
    }
    // Legacy fallback: onboardingData blob (patient-side onboarding form).
    const onboardingData = patient.onboardingData;
    if (onboardingData && typeof onboardingData === 'object') {
        return onboardingData.prakriti
            || onboardingData.doshaType
            || onboardingData.dosha
            || onboardingData.constitution
            || null;
    }
    return null;
}

function pickHeight(onboardingData) {
    if (!onboardingData || typeof onboardingData !== 'object') return null;
    const raw = onboardingData.height ?? onboardingData.heightCm ?? onboardingData.heightInCm;
    const n = typeof raw === 'string' ? parseFloat(raw) : raw;
    return typeof n === 'number' && isFinite(n) && n > 0 ? n : null;
}

// chiefComplaint isn't a column on TriageSession — it lives inside `responses`
// (newer triage flow) or `triageNotes` (older flow). Be defensive about both.
function pickChiefComplaint(triage) {
    if (!triage) return null;
    const r = triage.responses;
    if (r && typeof r === 'object') {
        const direct = r.chiefComplaint || r.chief_complaint || r.complaint || r.mainComplaint;
        if (direct && typeof direct === 'string') return direct;
    }
    // Intentionally NO fallback to `triage.triageNotes` — that field stores
    // clinical reasoning summary (incl. red-flag descriptions like "RED FLAG:
    // Recorded vitals outside safe range"), not the patient's stated reason
    // for the visit. Using it as a fallback would surface the warning string
    // in the report's "Chief Complaint" row. Honest "Not recorded" is the
    // right outcome when the patient never wrote a complaint.
    return null;
}

// painRegions JSON shape varies by triage version — try the common key
// names and clamp the reading to a number.
function pickRegionField(region, candidates) {
    if (!region || typeof region !== 'object') return null;
    for (const k of candidates) {
        if (region[k] != null) return region[k];
    }
    return null;
}

function highestPainScore(painRegions) {
    if (!Array.isArray(painRegions) || painRegions.length === 0) return null;
    let max = -Infinity;
    for (const r of painRegions) {
        const v = pickRegionField(r, ['painIntensity', 'intensity', 'severity', 'score']);
        const n = typeof v === 'string' ? parseFloat(v) : v;
        if (typeof n === 'number' && isFinite(n) && n > max) max = n;
    }
    return max === -Infinity ? null : max;
}

// Normalise a meal's foods JSON (legacy column) into a comma-joined string.
// Each entry can be a plain string or an object with a `name` field.
function joinFoodList(value) {
    if (!Array.isArray(value)) return '';
    return value
        .map((it) => {
            if (typeof it === 'string') return it.trim();
            if (it && typeof it === 'object') return (it.name || it.label || '').toString().trim();
            return '';
        })
        .filter(Boolean)
        .join(', ');
}

// Phone normaliser shared with notification.service.js — strip non-digits,
// drop leading 0, ensure country code (default India = 91).
function normalisePhone(raw) {
    if (!raw) return null;
    let digits = String(raw).replace(/\D/g, '');
    if (digits.startsWith('0')) digits = digits.substring(1);
    if (digits.length < 10) return null;
    return digits.startsWith('91') ? digits : `91${digits}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Function 1 — assembleReportData
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the full report payload for a given appointment / patient / doctor.
 *
 * Wrapped in try/catch — every field returned is present even when missing
 * upstream (set to null). Callers MUST be tolerant of nulls.
 *
 * @param {string|null} appointmentId
 * @param {string} patientId
 * @param {string} doctorId
 */
export async function assembleReportData(appointmentId, patientId, doctorId) {
    try {
        // Patient + linked NotificationPreference (for WhatsApp number).
        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            include: {
                user: {
                    include: {
                        notificationPreference: true,
                    },
                },
                branch: true,
                // Canonical Prakriti record (filled by self-quiz or by the
                // clinician's Quick Intake modal). Used by pickPrakriti as
                // the primary source — onboardingData is the legacy fallback.
                constitutionProfile: true,
            },
        });

        // Appointment (optional). When missing we still try to render — the
        // PDF gracefully shows "Not recorded" for fields that need it.
        const appointment = appointmentId
            ? await prisma.appointment.findUnique({
                where: { id: appointmentId },
                include: {
                    doctor: { include: { user: true } },
                    branch: true,
                },
            })
            : null;

        // Most recent triage session for the patient.
        const triage = await prisma.triageSession.findFirst({
            where: { patientId },
            orderBy: { createdAt: 'desc' },
        });

        // Active treatment journey + ordered phases. Note: TreatmentJourney
        // stores patientId as User.id (see schema relation) — most patients
        // also have userId, so we try patient.userId first then fall back to
        // patient.id for safety.
        const journeyPatientId = patient?.userId || patientId;
        const journey = await prisma.treatmentJourney.findFirst({
            where: { patientId: journeyPatientId, status: 'ACTIVE' },
            include: { phases: { orderBy: { order: 'asc' } } },
        });

        // Prescriptions written during this appointment.
        const prescriptions = appointmentId
            ? await prisma.prescription.findMany({ where: { appointmentId } })
            : [];

        // Most recent active diet prescription with meals.
        const dietPrescription = await prisma.dietPrescription.findFirst({
            where: { patientId, isActive: true },
            include: { meals: true },
            orderBy: { createdAt: 'desc' },
        });

        // PatientVital.patientId references User.id (not Patient.id) per the
        // schema relation. Use patient.userId; fall back to the supplied
        // patientId only as a last resort (safer than crashing).
        const vitalLookupId = patient?.userId || patientId;
        const allVitals = await prisma.patientVital.findMany({
            where: { patientId: vitalLookupId },
            orderBy: { recordedAt: 'desc' },
        });
        const vitals = {};
        for (const v of allVitals) {
            if (!vitals[v.type]) vitals[v.type] = v;
        }

        // Next confirmed upcoming appointment (any doctor).
        const nextAppointment = await prisma.appointment.findFirst({
            where: {
                patientId,
                status: 'CONFIRMED',
                date: { gt: new Date() },
            },
            include: { doctor: { include: { user: true } }, branch: true },
            orderBy: { date: 'asc' },
        });

        // ── Derived fields ───────────────────────────────────────────────────
        const age    = calcAge(patient?.dob);
        const weight = vitals.WEIGHT?.value ?? null;
        const height = pickHeight(patient?.onboardingData);

        let bmi = null;
        if (weight != null && height != null && height > 0) {
            const m = height / 100;
            bmi = Math.round((weight / (m * m)) * 10) / 10;
        }

        let ibw = null;
        if (height != null) {
            const factor = String(patient?.gender || '').toUpperCase() === 'MALE' ? 0.9 : 0.85;
            ibw = Math.round((height - 100) * factor * 10) / 10;
        }

        const currentPhase = journey?.phases?.find((p) => p.status === 'ACTIVE')
                          ?? journey?.phases?.[0]
                          ?? null;

        const painRegions = Array.isArray(triage?.painRegions) ? triage.painRegions : [];
        const painScore   = highestPainScore(painRegions);

        return {
            patient,
            appointment,
            triage,
            journey,
            prescriptions: prescriptions || [],
            dietPrescription,
            vitals,
            nextAppointment,

            // Derived
            age,
            weight,
            height,
            bmi,
            bmiCategory: bmiCategoryOf(bmi),
            ibw,
            currentPhase,
            highestPainScore: painScore,
            chiefComplaint: pickChiefComplaint(triage),
            prakriti: pickPrakriti(patient),
            painRegions,
        };
    } catch (err) {
        logger.error('[healthReport.assembleReportData] partial failure', {
            err: err.message,
            patientId,
            appointmentId,
        });
        // Per spec: never throw — return a degraded payload with everything
        // null so the PDF generator can still produce a (mostly empty) report.
        return {
            patient: null,
            appointment: null,
            triage: null,
            journey: null,
            prescriptions: [],
            dietPrescription: null,
            vitals: {},
            nextAppointment: null,
            age: null,
            weight: null,
            height: null,
            bmi: null,
            bmiCategory: null,
            ibw: null,
            currentPhase: null,
            highestPainScore: null,
            chiefComplaint: null,
            prakriti: null,
            painRegions: [],
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Function 2 — generatePDF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the assembled report as a PDF buffer.
 *
 * Uses pdfkit's bufferPages mode so we can iterate every page after the
 * content is laid out and stamp a page-N-of-M footer + divider on each one.
 *
 * @param {Object} reportData — output of assembleReportData.
 * @returns {Promise<Buffer>}
 */
export function generatePDF(reportData) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: PAGE_MARGIN,
                bufferPages: true, // required for the post-render footer pass
                info: {
                    Title: 'Al-Shifa Health Consultation Report',
                    Author: 'Al-Shifa Ayurvedic Health Centre',
                    Subject: 'Patient Health Consultation Report',
                },
            });

            const chunks = [];
            doc.on('data', (chunk) => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // ── Helpers (closed over `doc` so they can be called inline) ────
            function addPageHeader() {
                const topY = 30;
                doc.fillColor(BRAND_TEAL).fontSize(18).font('Helvetica-Bold')
                    .text('AL-SHIFA', PAGE_MARGIN, topY);
                doc.fillColor(MUTED_TEXT).fontSize(9).font('Helvetica')
                    .text('Ayurvedic Health Centre', PAGE_MARGIN, topY + 22);

                const branchName    = reportData.appointment?.branch?.name    || reportData.patient?.branch?.name    || '';
                const branchAddress = reportData.appointment?.branch?.address || reportData.patient?.branch?.address || '';
                doc.fillColor(BODY_TEXT).fontSize(9)
                    .text(branchName,    doc.page.width - PAGE_MARGIN - 200, topY,      { width: 200, align: 'right' })
                    .text(branchAddress, doc.page.width - PAGE_MARGIN - 200, topY + 12, { width: 200, align: 'right' });

                doc.moveTo(PAGE_MARGIN, topY + 38)
                    .lineTo(doc.page.width - PAGE_MARGIN, topY + 38)
                    .strokeColor(BRAND_TEAL).lineWidth(1).stroke();

                doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10);
                doc.y = topY + 48;
            }

            function sectionHeader(title) {
                ensureSpace(40);
                const y = doc.y;
                doc.rect(PAGE_MARGIN, y, doc.page.width - PAGE_MARGIN * 2, 22)
                    .fill(BRAND_TEAL);
                doc.fillColor(BRAND_WHITE).fontSize(11).font('Helvetica-Bold')
                    .text(title, PAGE_MARGIN + 8, y + 6);
                doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10);
                doc.y = y + 22;
                doc.moveDown(0.6);
            }

            function dividerLine() {
                doc.moveTo(PAGE_MARGIN, doc.y)
                    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
                    .strokeColor(DIVIDER).lineWidth(0.5).stroke();
                doc.moveDown(0.4);
            }

            function twoColRow(label, value) {
                ensureSpace(20);
                const y = doc.y;
                const mid = doc.page.width / 2;
                doc.fillColor(MUTED_TEXT).font('Helvetica').fontSize(9)
                    .text(label, PAGE_MARGIN, y, { width: mid - PAGE_MARGIN - 8 });
                doc.fillColor(BODY_TEXT).fontSize(9)
                    .text(value || 'Not recorded', mid, y, { width: doc.page.width - mid - PAGE_MARGIN });
                doc.moveDown(0.6);
            }

            function bodyText(text) {
                ensureSpace(18);
                doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10)
                    .text(text || 'Not recorded', PAGE_MARGIN, doc.y, {
                        width: doc.page.width - PAGE_MARGIN * 2,
                    });
                doc.moveDown(0.4);
            }

            function bullet(text) {
                ensureSpace(16);
                doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10)
                    .text(`•  ${text}`, PAGE_MARGIN + 8, doc.y, {
                        width: doc.page.width - PAGE_MARGIN * 2 - 8,
                    });
                doc.moveDown(0.2);
            }

            // Trigger an automatic page break before drawing if the next
            // element wouldn't fit above the footer reserve.
            function ensureSpace(needed) {
                const footerReserve = 60;
                if (doc.y + needed > doc.page.height - footerReserve) {
                    doc.addPage();
                }
            }

            doc.on('pageAdded', addPageHeader);
            // Stamp the first page header manually — pageAdded does not fire
            // for the implicit first page.
            addPageHeader();

            // ── Title block ────────────────────────────────────────────────
            doc.moveDown(0.5);
            doc.fillColor(BRAND_TEAL).font('Helvetica-Bold').fontSize(14)
                .text('HEALTH CONSULTATION REPORT', PAGE_MARGIN, doc.y, {
                    width: doc.page.width - PAGE_MARGIN * 2, align: 'center',
                });
            doc.moveDown(0.2);
            doc.fillColor(MUTED_TEXT).font('Helvetica').fontSize(9)
                .text(`Generated on: ${fmtDate(new Date()) || ''}`, PAGE_MARGIN, doc.y, {
                    width: doc.page.width - PAGE_MARGIN * 2, align: 'center',
                });
            doc.moveDown(0.6);
            dividerLine();

            // ── Section 1: Patient Details ─────────────────────────────────
            sectionHeader('1. Patient Details');
            const patientName = reportData.patient?.fullName || reportData.patient?.user?.email || null;
            const patientPhone = reportData.patient?.phoneNumber || null;
            const patientShortId = reportData.patient?.id ? reportData.patient.id.substring(0, 8).toUpperCase() : null;
            const doctorUser = reportData.appointment?.doctor?.user;
            const doctorName = reportData.appointment?.doctor?.fullName || doctorUser?.name || null;
            const doctorSpec = reportData.appointment?.doctor?.specialization || null;
            const doctorLine = doctorName
                ? (doctorSpec ? `Dr. ${doctorName} (${doctorSpec})` : `Dr. ${doctorName}`)
                : null;
            const branchLine = reportData.appointment?.branch?.name || reportData.patient?.branch?.name || null;

            twoColRow('Patient Name',     patientName);
            twoColRow('Patient ID',       patientShortId);
            twoColRow('Age',              reportData.age != null ? `${reportData.age} years` : null);
            twoColRow('Report Date',      fmtDate(new Date()));
            twoColRow('Gender',           reportData.patient?.gender || null);
            twoColRow('Consulting Doctor', doctorLine);
            twoColRow('Phone',            patientPhone);
            twoColRow('Branch',           branchLine);
            doc.moveDown(0.4);
            dividerLine();

            // ── Section 2: Key Clinical Findings ───────────────────────────
            sectionHeader('2. Key Clinical Findings');
            twoColRow('Height',           reportData.height != null ? `${reportData.height} cm` : null);
            twoColRow('Weight',           reportData.weight != null ? `${reportData.weight} kg` : null);
            twoColRow('BMI',              reportData.bmi != null
                ? `${reportData.bmi}${reportData.bmiCategory ? ` (${reportData.bmiCategory})` : ''}`
                : null);
            twoColRow('Ideal Body Weight', reportData.ibw != null ? `${reportData.ibw} kg` : null);
            twoColRow('Chief Complaint',  reportData.chiefComplaint);
            twoColRow('Prakriti / Dosha', reportData.prakriti || 'Not assessed');
            twoColRow('Pain Score at Presentation',
                reportData.highestPainScore != null ? `${reportData.highestPainScore}/10` : null);
            twoColRow('Urgency Level',    reportData.triage?.urgencyLevel || 'Not assessed');
            doc.moveDown(0.4);
            dividerLine();

            // ── Section 3: Pain Map Findings ───────────────────────────────
            sectionHeader('3. Pain Map Findings');
            const regions = reportData.painRegions || [];
            if (regions.length > 0) {
                for (const r of regions) {
                    const region    = pickRegionField(r, ['region', 'bodyPart', 'name', 'regionLabel', 'label']) || 'Unspecified region';
                    const intensity = pickRegionField(r, ['painIntensity', 'intensity', 'severity', 'score']);
                    const character = pickRegionField(r, ['painCharacter', 'character', 'characters', 'quality']);
                    const duration  = pickRegionField(r, ['duration', 'painDuration', 'sinceWhen']);
                    const charText  = Array.isArray(character) ? character.join(', ') : character;
                    const parts = [`Pain: ${intensity != null ? `${intensity}/10` : 'Not recorded'}`];
                    if (charText) parts.push(String(charText));
                    if (duration) parts.push(String(duration));
                    bullet(`${region} — ${parts.join(' — ')}`);
                }
            } else {
                bodyText('No specific pain regions recorded');
            }
            doc.moveDown(0.4);
            dividerLine();

            // ── Section 4: Consultation Notes ──────────────────────────────
            sectionHeader('4. Consultation Notes');
            const notes = reportData.appointment?.notes
                       || reportData.appointment?.sessionNotes
                       || null;
            bodyText(notes || 'No consultation notes recorded');
            doc.moveDown(0.4);
            dividerLine();

            // ── Section 5: Active Treatment Journey ────────────────────────
            sectionHeader('5. Active Treatment Journey');
            if (reportData.journey) {
                const j = reportData.journey;
                const phaseCount = j.phases?.length ?? 0;
                bullet(`Journey: ${j.title || 'Untitled'}`);
                if (reportData.currentPhase) {
                    bullet(`Current Phase: ${reportData.currentPhase.name} (Phase ${reportData.currentPhase.order} of ${phaseCount})`);
                }
                bullet(`Started: ${fmtDate(j.startDate) || 'Unknown'} → Target: ${fmtDate(j.targetDate) || 'Ongoing'}`);
            } else {
                bodyText('No active treatment journey assigned');
            }
            doc.moveDown(0.4);
            dividerLine();

            // ── Section 6: Medicines Prescribed ────────────────────────────
            sectionHeader('6. Medicines Prescribed');
            if (Array.isArray(reportData.prescriptions) && reportData.prescriptions.length > 0) {
                drawMedicineTable(doc, reportData.prescriptions);
            } else {
                bodyText('No medicines prescribed in this consultation');
            }
            doc.moveDown(0.4);
            dividerLine();

            // ── Section 7: Diet Recommendation ─────────────────────────────
            sectionHeader('7. Diet Recommendation');
            if (reportData.dietPrescription) {
                const d = reportData.dietPrescription;
                bullet(`Plan: ${d.title || 'Untitled'} — ${d.doshaTarget || 'general'}-pacifying diet`);
                const meals = (d.meals || []).slice().sort((a, b) =>
                    (MEAL_ORDER[a.mealTime] || 99) - (MEAL_ORDER[b.mealTime] || 99));
                for (const m of meals) {
                    const eatList   = joinFoodList(m.foods);
                    const avoidList = joinFoodList(m.avoidFoods);
                    bodyText(`${m.mealTime}: ${eatList || 'No specific foods listed'}`);
                    if (avoidList) {
                        doc.fillColor(MUTED_TEXT).fontSize(9)
                            .text(`Avoid: ${avoidList}`, PAGE_MARGIN + 12, doc.y, {
                                width: doc.page.width - PAGE_MARGIN * 2 - 12,
                            });
                        doc.moveDown(0.3);
                        doc.fillColor(BODY_TEXT).fontSize(10);
                    }
                }
            } else {
                bodyText('Diet recommendations to be provided by your care team');
            }
            doc.moveDown(0.4);
            dividerLine();

            // ── Section 8: Vitals Snapshot ─────────────────────────────────
            sectionHeader('8. Vitals Snapshot');
            const colWidth = (doc.page.width - PAGE_MARGIN * 2) / 2;
            const vitalsStartY = doc.y;
            const v = reportData.vitals || {};

            // Left column — measured vitals
            doc.fillColor(BRAND_TEAL).font('Helvetica-Bold').fontSize(10)
                .text('Latest Recorded Vitals', PAGE_MARGIN, vitalsStartY);
            doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(9);
            let leftY = vitalsStartY + 16;
            const writeLeft = (label, vital, unit) => {
                const value = vital ? `${vital.value}${unit || ''} (${fmtDate(vital.recordedAt) || ''})` : 'Not recorded';
                doc.fillColor(MUTED_TEXT).text(label, PAGE_MARGIN, leftY, { width: colWidth - 10 });
                doc.fillColor(BODY_TEXT).text(value, PAGE_MARGIN, leftY + 11, { width: colWidth - 10 });
                leftY += 28;
            };
            // Keys must match the VitalType enum values (PAIN_SCORE, SLEEP_HOURS,
            // WEIGHT, MOOD). Previously read v.PAIN / v.SLEEP which never
            // matched, so these rows printed "Not recorded" even after a
            // doctor recorded the readings.
            writeLeft('Pain Level',    v.PAIN_SCORE,  '/10');
            writeLeft('Weight',        v.WEIGHT,      ' kg');
            writeLeft('Sleep Hours',   v.SLEEP_HOURS, ' hrs');
            writeLeft('Mood',          v.MOOD,        '/5');

            // Right column — lifestyle (from triage.lifestyleData)
            doc.fillColor(BRAND_TEAL).font('Helvetica-Bold').fontSize(10)
                .text('Lifestyle (from triage)', PAGE_MARGIN + colWidth, vitalsStartY);
            doc.font('Helvetica').fontSize(9);
            const lifestyle = reportData.triage?.lifestyleData || {};
            let rightY = vitalsStartY + 16;
            const writeRight = (label, value) => {
                doc.fillColor(MUTED_TEXT).text(label, PAGE_MARGIN + colWidth, rightY, { width: colWidth - 10 });
                doc.fillColor(BODY_TEXT).text(value || 'Not recorded', PAGE_MARGIN + colWidth, rightY + 11, { width: colWidth - 10 });
                rightY += 28;
            };
            // "Sleep Rating (1-5)" disambiguates from the left column's
            // measured "Sleep Hours" so the two adjacent sleep rows aren't
            // confusingly both labelled "Sleep Quality".
            writeRight('Sleep Rating (1-5)', lifestyle.sleepQuality);
            writeRight('Stress Level',       lifestyle.stressLevel);
            writeRight('Exercise',           lifestyle.exerciseFrequency);
            writeRight('Diet Type',          lifestyle.dietQuality || lifestyle.dietType);

            // Push the cursor below whichever column ended lower.
            doc.y = Math.max(leftY, rightY);
            doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10);
            doc.moveDown(0.3);
            dividerLine();

            // ── Section 9: Next Appointment ────────────────────────────────
            sectionHeader('9. Next Appointment');
            if (reportData.nextAppointment) {
                const na = reportData.nextAppointment;
                const nDoctor = na.doctor?.fullName || na.doctor?.user?.email || 'your doctor';
                const nDate   = fmtDateTime(na.date) || 'date not set';
                const nBranch = na.branch?.name || '';
                bodyText(`Dr. ${nDoctor} — ${nDate}${nBranch ? ` — ${nBranch}` : ''}`);
            } else {
                bodyText('Your next appointment will be scheduled by your care team');
            }
            doc.moveDown(0.4);

            // ── Footer pass: page numbers + horizontal rule on every page ──
            const range = doc.bufferedPageRange();
            const pageCount = range.count;
            for (let i = 0; i < pageCount; i++) {
                doc.switchToPage(range.start + i);
                const footerY = doc.page.height - 40;
                doc.moveTo(PAGE_MARGIN, footerY - 8)
                    .lineTo(doc.page.width - PAGE_MARGIN, footerY - 8)
                    .strokeColor(BRAND_TEAL).lineWidth(0.5).stroke();
                doc.fillColor(MUTED_TEXT).font('Helvetica').fontSize(8)
                    .text(`Page ${i + 1} of ${pageCount}`,
                        PAGE_MARGIN, footerY,
                        { align: 'center', width: doc.page.width - PAGE_MARGIN * 2 });
                doc.text('Al-Shifa Ayurvedic Health Centre · Confidential Health Document',
                    PAGE_MARGIN, footerY + 10,
                    { align: 'center', width: doc.page.width - PAGE_MARGIN * 2 });
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// Medicine table helper — extracted so the main builder stays readable.
function drawMedicineTable(doc, prescriptions) {
    const cols = [
        { label: 'Medicine',  width: 190, key: 'medicationName' },
        { label: 'Dosage',    width: 90,  key: 'dosage' },
        { label: 'Frequency', width: 100, key: 'frequency' },
        { label: 'Duration',  width: 90,  key: 'duration' },
    ];
    const tableX = PAGE_MARGIN;
    const tableW = cols.reduce((s, c) => s + c.width, 0);
    const rowH   = 22;
    const headerY = doc.y;

    // Header row
    doc.rect(tableX, headerY, tableW, rowH).fill(BRAND_TEAL);
    doc.fillColor(BRAND_WHITE).font('Helvetica-Bold').fontSize(9);
    let x = tableX;
    for (const c of cols) {
        doc.text(c.label, x + 6, headerY + 7, { width: c.width - 12 });
        x += c.width;
    }

    // Data rows
    let rowY = headerY + rowH;
    doc.font('Helvetica').fontSize(9);
    prescriptions.forEach((p, idx) => {
        // Page-break check: if next row would clip the footer, start a new page.
        if (rowY + rowH > doc.page.height - 60) {
            doc.addPage();
            rowY = doc.y;
        }
        if (idx % 2 === 1) {
            doc.rect(tableX, rowY, tableW, rowH).fill(ALT_ROW);
        }
        doc.fillColor(BODY_TEXT);
        let cx = tableX;
        for (const c of cols) {
            const val = p[c.key] ?? '';
            doc.text(String(val), cx + 6, rowY + 7, { width: c.width - 12, ellipsis: true });
            cx += c.width;
        }
        rowY += rowH;
    });
    doc.y = rowY + 4;
}

// ─────────────────────────────────────────────────────────────────────────────
// Function 3 — createAndDeliverReport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * End-to-end: assemble → generate PDF → write to disk → persist row →
 * (optionally) deliver via WhatsApp → in-app notification → socket emit →
 * audit log.
 *
 * Idempotent on appointmentId: if a HealthReport already exists for this
 * appointment, the existing row is returned and no PDF is regenerated.
 *
 * WhatsApp failure is logged + reported in the return value but does NOT
 * abort the operation — the report row is still created.
 *
 * @param {string|null} appointmentId
 * @param {string} patientId
 * @param {string} doctorId        — Doctor.id (NOT User.id of the doctor)
 * @param {boolean} sendWhatsApp
 * @param {string} doctorUserId    — User.id of the doctor (for the audit log)
 */
export async function createAndDeliverReport(
    appointmentId,
    patientId,
    doctorId,
    sendWhatsApp,
    doctorUserId,
) {
    // 1. Idempotency — return existing if already generated for this appointment.
    if (appointmentId) {
        const existing = await prisma.healthReport.findFirst({ where: { appointmentId } });
        if (existing) {
            return { report: existing, alreadyExisted: true, whatsappDelivered: false, whatsappError: null };
        }
    }

    // 2. Assemble payload (never throws).
    const reportData = await assembleReportData(appointmentId, patientId, doctorId);

    // 3. Generate PDF buffer. A failure here is fatal — propagate up.
    const pdfBuffer = await generatePDF(reportData);

    // 4. Persist PDF to disk under uploads/health-reports/. Path scheme
    //    matches existing uploads/* layout.
    const reportsDir = path.join(__dirname, '..', 'uploads', 'health-reports');
    let pdfRelativePath = null;
    let absolutePath    = null;
    try {
        await fs.promises.mkdir(reportsDir, { recursive: true });
        const filename = `report-${patientId}-${Date.now()}.pdf`;
        absolutePath = path.join(reportsDir, filename);
        await fs.promises.writeFile(absolutePath, pdfBuffer);
        // Use forward slashes in the stored path so it's portable across OSes.
        pdfRelativePath = `uploads/health-reports/${filename}`;
    } catch (err) {
        logger.error('[healthReport] PDF write failed', { err: err.message, reportsDir });
        // Spec rule #5: do NOT create the DB record if PDF write fails.
        const wrap = new Error('Failed to write PDF to disk');
        wrap.status = 500;
        throw wrap;
    }

    // 5. Persist HealthReport row. Branch is mandatory in the schema —
    //    fall back through appointment.branchId → patient.branchId.
    const branchId = reportData.appointment?.branchId
                  ?? reportData.patient?.branchId
                  ?? null;
    if (!branchId) {
        // Schema requires branchId — surface a clear error rather than the
        // raw Prisma "Argument branchId is missing" message.
        const wrap = new Error('Cannot create health report — patient and appointment have no branch assigned');
        wrap.status = 400;
        throw wrap;
    }

    const report = await prisma.healthReport.create({
        data: {
            patientId,
            doctorId,
            appointmentId: appointmentId || null,
            branchId,
            // Snapshot the assembled payload so the historical view stays
            // stable even if upstream models are edited later. Strip Prisma
            // model objects down via JSON round-trip to keep the column size
            // manageable and remove any Date wrapper objects.
            reportData: JSON.parse(JSON.stringify(reportData)),
            pdfPath: pdfRelativePath,
            pdfSizeBytes: pdfBuffer.length,
            sentViaWhatsApp: false,
        },
    });

    // 6. WhatsApp delivery (best-effort).
    let whatsappDelivered = false;
    let whatsappError     = null;

    if (sendWhatsApp) {
        try {
            const prefNumber  = reportData.patient?.user?.notificationPreference?.whatsappNumber;
            const fallback    = reportData.patient?.phoneNumber;
            const whatsappRaw = prefNumber || fallback;
            const whatsappNumber = normalisePhone(whatsappRaw);

            if (!whatsappNumber) {
                whatsappError = 'No WhatsApp number on file for this patient';
            } else {
                const doctorName  = reportData.appointment?.doctor?.fullName
                                 || reportData.appointment?.doctor?.user?.email
                                 || 'your doctor';
                const patientName = reportData.patient?.fullName
                                 || reportData.patient?.user?.email
                                 || 'Patient';
                const reportDate  = fmtDate(new Date()) || '';
                const branchName  = reportData.appointment?.branch?.name || 'Al-Shifa';

                const result = await WhatsAppService.sendDocument({
                    phone:    whatsappNumber,
                    document: pdfBuffer.toString('base64'),
                    filename: `AlShifa-Health-Report-${reportDate.replace(/ /g, '-')}.pdf`,
                    caption:  `📋 *Your Al-Shifa Health Report*\n\n`
                            + `Dear ${patientName},\n\n`
                            + `Your consultation report from Dr. ${doctorName} is ready.\n\n`
                            + `Date: ${reportDate}\n`
                            + `Branch: ${branchName}\n\n`
                            + `View and download it in your Al-Shifa app.`,
                });

                if (result?.status === 'SENT') {
                    await prisma.healthReport.update({
                        where: { id: report.id },
                        data: { sentViaWhatsApp: true, whatsappSentAt: new Date() },
                    });
                    whatsappDelivered = true;
                } else if (result?.status === 'SKIPPED') {
                    whatsappError = 'WhatsApp gateway not configured (skipped)';
                } else {
                    whatsappError = result?.error || 'WhatsApp delivery returned non-SENT status';
                }
            }
        } catch (err) {
            // Do not throw — WhatsApp failure must not abort the operation.
            whatsappError = err?.message || 'WhatsApp delivery failed';
            logger.warn('[healthReport] WhatsApp delivery failed', { err: whatsappError, reportId: report.id });
        }
    }

    // 7. In-app notification to the patient (best-effort).
    try {
        const recipientUserId = reportData.patient?.userId;
        if (recipientUserId) {
            const doctorName = reportData.appointment?.doctor?.fullName
                            || reportData.appointment?.doctor?.user?.email
                            || 'Your doctor';
            await prisma.notification.create({
                data: {
                    userId:    recipientUserId,
                    type:      'HEALTH_REPORT_READY',
                    title:     'Health Report Ready',
                    message:   `Your consultation report from Dr. ${doctorName} is ready to view.`,
                    priority:  'INFO',
                    relatedId: report.id,
                    // Notification has no `link` column — surface deep link
                    // through the existing `data` Json column.
                    data: { link: '/patient-portal?tab=reports', reportId: report.id },
                },
            });
        }
    } catch (err) {
        logger.warn('[healthReport] in-app notification failed', { err: err.message, reportId: report.id });
    }

    // 8. Socket.IO emit (best-effort, only after socket layer is initialised).
    try {
        const { emitToUser } = await import('../websocket/index.js');
        const recipientUserId = reportData.patient?.userId;
        if (recipientUserId) {
            const doctorName = reportData.appointment?.doctor?.fullName
                            || reportData.appointment?.doctor?.user?.email
                            || 'Your doctor';
            emitToUser(recipientUserId, 'health_report_ready', {
                reportId: report.id,
                doctorName,
                createdAt: report.createdAt,
            });
        }
    } catch (err) {
        logger.warn('[healthReport] socket emit failed', { err: err.message, reportId: report.id });
    }

    // 9. Audit log (best-effort).
    try {
        await prisma.auditLog.create({
            data: {
                userId: doctorUserId || null,
                action: 'HEALTH_REPORT_GENERATED',
                entityType: 'HealthReport',
                entityId: report.id,
                newData: { patientId, appointmentId: appointmentId || null, sentViaWhatsApp: whatsappDelivered },
            },
        });
    } catch (err) {
        logger.warn('[healthReport] audit log failed', { err: err.message, reportId: report.id });
    }

    return { report, alreadyExisted: false, whatsappDelivered, whatsappError };
}

// ═════════════════════════════════════════════════════════════════════════════
// FEATURE 4 — Patient Progress Report (End of Journey Phase)
//
// Three additional exports that piggy-back on the same disk layout, the same
// HealthReport table (discriminated by `reportType`), and the same WhatsApp
// document path used by the consultation report. The schema-field gotchas
// listed at the top of this file apply here too — JourneyPhase has no
// `createdAt`, TaskCompletion.patientId references User.id, etc.
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// Function 4 — assemblePhaseProgressData
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate everything that happened during a JourneyPhase into a single
 * payload used by the PDF generator and the WhatsApp summary.
 *
 * Wrapped in try/catch — every field returned is present even when missing
 * upstream (set to null or 0). Callers MUST be tolerant of nulls.
 *
 * @param {string} phaseId
 * @param {string} patientId  — Patient.id
 * @param {string} doctorId   — Doctor.id (used only for the audit chain;
 *                              the canonical doctor is journey.doctor)
 */
export async function assemblePhaseProgressData(phaseId, patientId, doctorId) {
    try {
        // ── Phase + journey + relations ──────────────────────────────────────
        // TreatmentJourney.patientId references User.id (NOT Patient.id) —
        // its `patient` relation hands back a User row, not a Patient row.
        // We therefore fetch the Patient row separately by Patient.id below.
        const phase = await prisma.journeyPhase.findUnique({
            where: { id: phaseId },
            include: {
                journey: {
                    include: {
                        doctor: { include: { doctor: true } }, // User → Doctor
                        phases: { orderBy: { order: 'asc' } },
                    },
                },
                tasks: true,
            },
        });
        if (!phase) {
            const e = new Error('Journey phase not found');
            e.status = 404;
            throw e;
        }
        const journey = phase.journey;

        const patient = await prisma.patient.findUnique({
            where: { id: patientId },
            include: {
                user: { include: { notificationPreference: true } },
                branch: true,
            },
        });

        // Doctor model lookup — journey.doctor is a User; we want Doctor row
        // for fullName / specialization. Fall back to the Doctor we resolved
        // through the User → Doctor relation above.
        const doctorRow = journey?.doctor?.doctor
                       || await prisma.doctor.findUnique({ where: { id: doctorId } }).catch(() => null);

        // Branch — patient's branch wins; fall back to journey.branch.
        const branch = patient?.branch
                    || (journey?.branchId
                        ? await prisma.branch.findUnique({ where: { id: journey.branchId } }).catch(() => null)
                        : null);

        // ── Phase window — JourneyPhase has no `createdAt`. Fall back to
        //    journey.startDate when startedAt is null (legacy phases).
        const phaseStart = phase.startedAt || journey?.startDate || null;
        const phaseEnd   = phase.completedAt || new Date();

        // ── Task completion stats ────────────────────────────────────────────
        // TaskCompletion.patientId references User.id — use patient.userId.
        const completionPatientId = patient?.userId || patientId;
        const allTaskIds = (phase.tasks || []).map(t => t.id);
        const completions = allTaskIds.length > 0
            ? await prisma.taskCompletion.findMany({
                where: { taskId: { in: allTaskIds }, patientId: completionPatientId },
            })
            : [];
        const tasksTotal   = allTaskIds.length;
        const tasksDone    = completions.length;
        const tasksPercent = tasksTotal > 0 ? Math.round((tasksDone / tasksTotal) * 100) : 0;

        // ── Pain vitals during the phase window ──────────────────────────────
        // PatientVital.patientId references User.id — use patient.userId.
        const vitalPatientId = patient?.userId || patientId;
        const painVitals = phaseStart
            ? await prisma.patientVital.findMany({
                where: {
                    patientId: vitalPatientId,
                    type: 'PAIN',
                    recordedAt: { gte: phaseStart, lte: phaseEnd },
                },
                orderBy: { recordedAt: 'asc' },
            })
            : [];

        const painAtStart = painVitals.length > 0 ? painVitals[0].value : null;
        const painAtEnd   = painVitals.length > 0 ? painVitals[painVitals.length - 1].value : null;
        // % reduction guard: avoid divide-by-zero when patient started pain-free.
        const painReduction = painAtStart !== null && painAtEnd !== null && painAtStart > 0
            ? Math.round(((painAtStart - painAtEnd) / painAtStart) * 100)
            : null;

        // ── Wellness score — schema has TreatmentJourney.wellnessScore (a
        //    single rolling Float) but no per-day series. We derive a
        //    start-vs-end from pain instead, matching the spec's proxy. The
        //    inversion is intentionally clamped at [0, 100].
        const wellnessAtStart = painAtStart !== null ? Math.max(0, Math.min(100, 100 - (painAtStart * 10))) : null;
        const wellnessAtEnd   = painAtEnd   !== null ? Math.max(0, Math.min(100, 100 - (painAtEnd   * 10))) : null;
        const wellnessImprovement = wellnessAtStart !== null && wellnessAtEnd !== null
            ? wellnessAtEnd - wellnessAtStart
            : null;

        // ── Diet adherence during the phase window ───────────────────────────
        // DietAdherenceLog.patientId references Patient.id (correct here).
        const dietLogs = phaseStart
            ? await prisma.dietAdherenceLog.findMany({
                where: {
                    patientId,
                    loggedAt: { gte: phaseStart, lte: phaseEnd },
                },
            })
            : [];
        const dietTotal             = dietLogs.length;
        const dietFollowed          = dietLogs.filter(l => l.followed).length;
        const dietAdherencePercent  = dietTotal > 0 ? Math.round((dietFollowed / dietTotal) * 100) : null;

        // ── Milestones achieved during this phase's window ───────────────────
        const milestonesAchieved = phaseStart
            ? await prisma.journeyMilestone.findMany({
                where: {
                    journeyId: journey.id,
                    achievedAt: { gte: phaseStart, lte: phaseEnd },
                },
                orderBy: { achievedAt: 'asc' },
            })
            : [];

        // ── Before / after photos for this phase ─────────────────────────────
        // ClinicalPhoto.patientId references Patient.id (correct).
        const photos = await prisma.clinicalPhoto.findMany({
            where: {
                patientId,
                phaseId,
                stage: { in: ['BEFORE', 'AFTER'] },
            },
            orderBy: { takenAt: 'asc' },
        });
        const beforePhotos = photos.filter(p => p.stage === 'BEFORE');
        const afterPhotos  = photos.filter(p => p.stage === 'AFTER');
        const hasPhotos    = beforePhotos.length > 0 && afterPhotos.length > 0;

        // ── Next phase (by order) ────────────────────────────────────────────
        const allPhases = journey?.phases || [];
        const nextPhase = allPhases.find(p => p.order === phase.order + 1) || null;

        // ── Next upcoming confirmed appointment ──────────────────────────────
        // Appointment.date (NOT scheduledAt). patientId references Patient.id.
        const nextAppointment = await prisma.appointment.findFirst({
            where: {
                patientId,
                status: 'CONFIRMED',
                date: { gt: new Date() },
            },
            include: { doctor: true, branch: true },
            orderBy: { date: 'asc' },
        });

        return {
            patient,
            doctor: doctorRow,
            branch,
            journey,
            phase,
            nextPhase,
            nextAppointment,
            stats: {
                tasksTotal,
                tasksDone,
                tasksPercent,
                painAtStart,
                painAtEnd,
                painReduction,
                wellnessAtStart,
                wellnessAtEnd,
                wellnessImprovement,
                dietAdherencePercent,
                dietTotal,
                dietFollowed,
            },
            milestonesAchieved,
            hasPhotos,
            beforePhotos,
            afterPhotos,
            painVitals,
        };
    } catch (err) {
        logger.error('[healthReport.assemblePhaseProgressData] failed', {
            err: err.message,
            phaseId,
            patientId,
        });
        // Mirror the consultation-report contract: never throw on partial
        // data — return an empty payload so the caller can decide.
        if (err.status === 404) throw err; // genuine 404 should propagate
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Function 5 — generateProgressPDF
//
// Celebratory progress PDF — visually distinct from the clinical
// consultation report (hero banner + 2x2 metric grid). Helpers intentionally
// duplicate the closure-scoped helpers inside generatePDF() to keep that
// existing function untouched (Feature 2 risk avoidance).
// ─────────────────────────────────────────────────────────────────────────────

export function generateProgressPDF(progressData) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margin: PAGE_MARGIN,
                bufferPages: true,
                info: {
                    Title: 'Al-Shifa Phase Progress Report',
                    Author: 'Al-Shifa Ayurvedic Health Centre',
                    Subject: 'Patient Phase Progress Summary',
                },
            });

            const chunks = [];
            doc.on('data', (c) => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const HERO_TEAL    = '#0D6E6E';
            const TILE_BG      = '#e6f7f7';
            const TILE_BORDER  = '#0D6E6E';
            const POSITIVE     = '#15803d'; // emerald-700 — matches frontend wellness colour
            const NEUTRAL_GREY = '#9ca3af';

            // ── Page header (mirrors the consultation report header) ────────
            function addPageHeader() {
                const topY = 30;
                doc.fillColor(BRAND_TEAL).fontSize(18).font('Helvetica-Bold')
                    .text('AL-SHIFA', PAGE_MARGIN, topY);
                doc.fillColor(MUTED_TEXT).fontSize(9).font('Helvetica')
                    .text('Ayurvedic Health Centre', PAGE_MARGIN, topY + 22);

                const branchName    = progressData.branch?.name    || '';
                const branchAddress = progressData.branch?.address || '';
                doc.fillColor(BODY_TEXT).fontSize(9)
                    .text(branchName,    doc.page.width - PAGE_MARGIN - 200, topY,      { width: 200, align: 'right' })
                    .text(branchAddress, doc.page.width - PAGE_MARGIN - 200, topY + 12, { width: 200, align: 'right' });

                doc.moveTo(PAGE_MARGIN, topY + 38)
                    .lineTo(doc.page.width - PAGE_MARGIN, topY + 38)
                    .strokeColor(BRAND_TEAL).lineWidth(1).stroke();

                doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10);
                doc.y = topY + 48;
            }

            function ensureSpace(needed) {
                const footerReserve = 60;
                if (doc.y + needed > doc.page.height - footerReserve) {
                    doc.addPage();
                }
            }

            function sectionHeader(title) {
                ensureSpace(40);
                const y = doc.y;
                doc.rect(PAGE_MARGIN, y, doc.page.width - PAGE_MARGIN * 2, 22).fill(BRAND_TEAL);
                doc.fillColor(BRAND_WHITE).fontSize(11).font('Helvetica-Bold')
                    .text(title, PAGE_MARGIN + 8, y + 6);
                doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10);
                doc.y = y + 22;
                doc.moveDown(0.6);
            }

            function dividerLine() {
                doc.moveTo(PAGE_MARGIN, doc.y)
                    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
                    .strokeColor(DIVIDER).lineWidth(0.5).stroke();
                doc.moveDown(0.4);
            }

            function bodyText(text) {
                ensureSpace(18);
                doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10)
                    .text(text || 'Not recorded', PAGE_MARGIN, doc.y, {
                        width: doc.page.width - PAGE_MARGIN * 2,
                    });
                doc.moveDown(0.4);
            }

            function bullet(text, color) {
                ensureSpace(16);
                doc.fillColor(color || BODY_TEXT).font('Helvetica').fontSize(10)
                    .text(text, PAGE_MARGIN + 8, doc.y, {
                        width: doc.page.width - PAGE_MARGIN * 2 - 8,
                    });
                doc.moveDown(0.2);
            }

            doc.on('pageAdded', addPageHeader);
            addPageHeader();

            // ── Hero banner ─────────────────────────────────────────────────
            const heroY = doc.y + 4;
            const heroH = 90;
            doc.rect(PAGE_MARGIN, heroY, doc.page.width - PAGE_MARGIN * 2, heroH).fill(HERO_TEAL);
            doc.fillColor(BRAND_WHITE).font('Helvetica-Bold').fontSize(18)
                .text('🌿 Phase Complete!', PAGE_MARGIN, heroY + 12, {
                    width: doc.page.width - PAGE_MARGIN * 2, align: 'center',
                });
            doc.font('Helvetica-Bold').fontSize(14)
                .text(progressData.phase?.name || 'Treatment Phase', PAGE_MARGIN, heroY + 36, {
                    width: doc.page.width - PAGE_MARGIN * 2, align: 'center',
                });
            doc.font('Helvetica').fontSize(11).fillColor('#d1f5f5')
                .text(progressData.journey?.title || '', PAGE_MARGIN, heroY + 56, {
                    width: doc.page.width - PAGE_MARGIN * 2, align: 'center',
                });
            const completedOn = fmtDate(progressData.phase?.completedAt || new Date()) || '';
            doc.fillColor('#a7eaea').fontSize(10)
                .text(`Completed on ${completedOn}`, PAGE_MARGIN, heroY + 72, {
                    width: doc.page.width - PAGE_MARGIN * 2, align: 'center',
                });
            doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(10);
            doc.y = heroY + heroH + 10;

            // Patient line
            const patientName = progressData.patient?.fullName
                             || progressData.patient?.user?.email
                             || 'Patient';
            doc.fillColor(MUTED_TEXT).fontSize(9)
                .text(`For ${patientName}`, PAGE_MARGIN, doc.y, {
                    width: doc.page.width - PAGE_MARGIN * 2, align: 'center',
                });
            doc.moveDown(0.6);
            dividerLine();

            // ── Section: Your Progress This Phase ───────────────────────────
            sectionHeader('Your Progress This Phase');
            const stats = progressData.stats || {};

            // 2×2 metric tile grid.
            function drawTile(col, row, title, mainValue, subText, mainColor) {
                const tileW = (doc.page.width - PAGE_MARGIN * 2 - 12) / 2;
                const tileH = 80;
                const x = PAGE_MARGIN + col * (tileW + 12);
                const y = doc.y + row * (tileH + 10);

                doc.save();
                doc.rect(x, y, tileW, tileH).fill(TILE_BG);
                doc.lineWidth(1).strokeColor(TILE_BORDER).rect(x, y, tileW, tileH).stroke();
                doc.restore();

                doc.fillColor(MUTED_TEXT).font('Helvetica-Bold').fontSize(9)
                    .text(title.toUpperCase(), x + 12, y + 10, { width: tileW - 24 });

                doc.fillColor(mainColor || BRAND_TEAL).font('Helvetica-Bold').fontSize(20)
                    .text(mainValue, x + 12, y + 24, { width: tileW - 24 });

                doc.fillColor(BODY_TEXT).font('Helvetica').fontSize(9)
                    .text(subText || '', x + 12, y + 54, { width: tileW - 24 });
            }

            ensureSpace(180);
            const gridStartY = doc.y;

            // Tile 1 — Pain Score
            const painMain = (stats.painAtStart !== null && stats.painAtEnd !== null)
                ? `${stats.painAtStart} → ${stats.painAtEnd}`
                : 'Not recorded';
            const painSub = stats.painReduction !== null
                ? `${stats.painReduction}% reduction`
                : 'No pain readings logged';
            const painColor = stats.painReduction !== null && stats.painReduction > 0 ? POSITIVE : NEUTRAL_GREY;
            drawTile(0, 0, 'Pain Score', painMain, painSub, painColor);

            // Tile 2 — Wellness Score
            const wellMain = (stats.wellnessAtStart !== null && stats.wellnessAtEnd !== null)
                ? `${stats.wellnessAtStart} → ${stats.wellnessAtEnd}`
                : 'Not recorded';
            const wellSub = stats.wellnessImprovement !== null
                ? `${stats.wellnessImprovement >= 0 ? '+' : ''}${stats.wellnessImprovement} points improvement`
                : 'No wellness data';
            const wellColor = stats.wellnessImprovement !== null && stats.wellnessImprovement > 0 ? POSITIVE : NEUTRAL_GREY;
            drawTile(1, 0, 'Wellness Score', wellMain, wellSub, wellColor);

            // Tile 3 — Tasks Completed
            const tasksMain = stats.tasksTotal > 0
                ? `${stats.tasksDone} / ${stats.tasksTotal}`
                : 'No tasks';
            const tasksSub  = stats.tasksTotal > 0
                ? `${stats.tasksPercent}% completion rate`
                : 'No tasks assigned for this phase';
            drawTile(0, 1, 'Tasks Completed', tasksMain, tasksSub, BRAND_TEAL);

            // Tile 4 — Diet Adherence
            const dietMain = stats.dietAdherencePercent !== null
                ? `${stats.dietAdherencePercent}%`
                : 'Not recorded';
            const dietSub = stats.dietAdherencePercent !== null
                ? `${stats.dietFollowed} of ${stats.dietTotal} meals followed`
                : 'No diet adherence logged';
            drawTile(1, 1, 'Diet Adherence', dietMain, dietSub, BRAND_TEAL);

            doc.y = gridStartY + 2 * 80 + 10 + 6;
            doc.moveDown(0.4);
            dividerLine();

            // ── Section: Milestones Achieved ────────────────────────────────
            sectionHeader('Milestones Achieved');
            if (Array.isArray(progressData.milestonesAchieved) && progressData.milestonesAchieved.length > 0) {
                for (const m of progressData.milestonesAchieved) {
                    bullet(`✓  ${m.title}`, POSITIVE);
                }
            } else {
                bodyText('No milestones recorded for this phase');
            }
            doc.moveDown(0.4);
            dividerLine();

            // ── Section: Visual Progress (only when both BEFORE and AFTER) ─
            if (progressData.hasPhotos) {
                sectionHeader('Visual Progress');
                bodyText('Before and after photos are available in your Al-Shifa portal.');
                bodyText('Open the Health Reports section to view your visual progress comparison.');
                doc.moveDown(0.4);
                dividerLine();
            }

            // ── Section: What's Next ────────────────────────────────────────
            sectionHeader("What's Next");
            const journeyStatus = progressData.journey?.status;
            if (progressData.nextPhase) {
                const np = progressData.nextPhase;
                bullet(`Next Phase: ${np.name}`);
                bullet(np.startedAt
                    ? `Started: ${fmtDate(np.startedAt)}`
                    : 'Starting: Your doctor will activate your next phase');
                bullet(`Duration: ${np.durationDays || '—'} days`);
            } else if (journeyStatus === 'COMPLETED') {
                bullet('🎉  You have completed your full treatment journey!', POSITIVE);
                bodyText('Your doctor will review your outcomes and advise on maintenance care.');
            } else {
                bodyText('Your doctor will advise on next steps.');
            }
            doc.moveDown(0.4);
            dividerLine();

            // ── Section: Next Appointment ───────────────────────────────────
            sectionHeader('Next Appointment');
            if (progressData.nextAppointment) {
                const na = progressData.nextAppointment;
                const nDoctor = na.doctor?.fullName || 'your doctor';
                const nDate   = fmtDateTime(na.date) || 'date not set';
                const nBranch = na.branch?.name || '';
                bodyText(`Dr. ${nDoctor} — ${nDate}${nBranch ? ` — ${nBranch}` : ''}`);
            } else {
                bodyText('To be scheduled');
            }
            doc.moveDown(0.4);

            // ── Footer (page number + confidentiality line per page) ────────
            const range = doc.bufferedPageRange();
            const pageCount = range.count;
            for (let i = 0; i < pageCount; i++) {
                doc.switchToPage(range.start + i);
                const footerY = doc.page.height - 40;
                doc.moveTo(PAGE_MARGIN, footerY - 8)
                    .lineTo(doc.page.width - PAGE_MARGIN, footerY - 8)
                    .strokeColor(BRAND_TEAL).lineWidth(0.5).stroke();
                doc.fillColor(MUTED_TEXT).font('Helvetica').fontSize(8)
                    .text(`Page ${i + 1} of ${pageCount}`, PAGE_MARGIN, footerY, {
                        align: 'center', width: doc.page.width - PAGE_MARGIN * 2,
                    });
                doc.text('Al-Shifa Ayurvedic Health Centre · Confidential Health Document',
                    PAGE_MARGIN, footerY + 10,
                    { align: 'center', width: doc.page.width - PAGE_MARGIN * 2 });
            }

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Function 6 — createAndDeliverProgressReport
//
// End-to-end: assemble → render → write → persist (reportType=PHASE_PROGRESS)
// → WhatsApp document → in-app notifications (patient + doctor) →
// socket emit → audit log. Idempotent on (journeyPhaseId, PHASE_PROGRESS) so
// the auto-trigger and a manual re-trigger can never produce duplicates.
// ─────────────────────────────────────────────────────────────────────────────

export async function createAndDeliverProgressReport(phaseId, patientId, doctorId) {
    // 1. Idempotency on (phase, type).
    const existing = await prisma.healthReport.findFirst({
        where: { journeyPhaseId: phaseId, reportType: 'PHASE_PROGRESS' },
    });
    if (existing) {
        return { report: existing, alreadyExisted: true, whatsappDelivered: false, whatsappError: null };
    }

    // 2. Assemble payload.
    const progressData = await assemblePhaseProgressData(phaseId, patientId, doctorId);
    if (!progressData) {
        const e = new Error('Failed to assemble progress data');
        e.status = 500;
        throw e;
    }

    // 3. Generate PDF (fatal failure propagates).
    const pdfBuffer = await generateProgressPDF(progressData);

    // 4. Persist PDF — same disk layout as the consultation report.
    const reportsDir = path.join(__dirname, '..', 'uploads', 'health-reports');
    let pdfRelativePath = null;
    try {
        await fs.promises.mkdir(reportsDir, { recursive: true });
        const filename = `progress-${patientId}-phase-${phaseId}-${Date.now()}.pdf`;
        await fs.promises.writeFile(path.join(reportsDir, filename), pdfBuffer);
        pdfRelativePath = `uploads/health-reports/${filename}`;
    } catch (err) {
        logger.error('[healthReport.progress] PDF write failed', { err: err.message, reportsDir });
        const wrap = new Error('Failed to write progress PDF to disk');
        wrap.status = 500;
        throw wrap;
    }

    // 5. Persist HealthReport row (reportType=PHASE_PROGRESS). Branch is
    //    schema-required; fall back through patient.branchId → journey.branchId
    //    → doctor.user.branchId.
    const branchId = progressData.branch?.id
                  || progressData.patient?.branchId
                  || progressData.journey?.branchId
                  || null;
    if (!branchId) {
        const wrap = new Error('Cannot create progress report — no branch resolved');
        wrap.status = 400;
        throw wrap;
    }

    const report = await prisma.healthReport.create({
        data: {
            patientId,
            doctorId,
            journeyPhaseId: phaseId,
            branchId,
            reportType: 'PHASE_PROGRESS',
            // Stats are the most useful slice to surface on the patient list
            // card without re-rendering the PDF — store them as the JSON
            // payload (full progressData would balloon the column).
            reportData: JSON.parse(JSON.stringify({
                stats:       progressData.stats,
                phaseName:   progressData.phase?.name || null,
                phaseOrder:  progressData.phase?.order ?? null,
                journeyTitle: progressData.journey?.title || null,
                hasPhotos:   progressData.hasPhotos,
                milestonesAchievedCount: progressData.milestonesAchieved?.length ?? 0,
            })),
            pdfPath: pdfRelativePath,
            pdfSizeBytes: pdfBuffer.length,
            sentViaWhatsApp: false,
        },
    });

    // 6. WhatsApp delivery — best-effort (failure does NOT abort).
    let whatsappDelivered = false;
    let whatsappError     = null;

    const prefNumber  = progressData.patient?.user?.notificationPreference?.whatsappNumber;
    const fallback    = progressData.patient?.phoneNumber || progressData.patient?.primaryPhone;
    const whatsappNumber = normalisePhone(prefNumber || fallback);

    if (!whatsappNumber) {
        whatsappError = 'No WhatsApp number on file';
    } else {
        try {
            const phaseName   = progressData.phase?.name || 'this phase';
            const patientName = progressData.patient?.fullName
                             || progressData.patient?.user?.email
                             || 'Patient';
            const doctorName  = progressData.doctor?.fullName
                             || progressData.journey?.doctor?.email
                             || 'your doctor';
            const stats       = progressData.stats || {};

            // Compose the same celebratory text used in the WhatsApp caption.
            let message = `🌿 *Phase Complete — ${phaseName}!*\n\n`;
            message += `Dear ${patientName},\n\n`;
            message += `You have completed *${phaseName}* of your treatment journey. Here is your progress summary:\n\n`;

            if (stats.painAtStart !== null && stats.painAtEnd !== null) {
                const emoji = (stats.painReduction || 0) > 0 ? '✅' : '➡️';
                message += `*Pain Score:* ${stats.painAtStart} → ${stats.painAtEnd} ${emoji}\n`;
                if ((stats.painReduction || 0) > 0) {
                    message += `_(${stats.painReduction}% reduction)_\n`;
                }
            }
            if (stats.wellnessAtStart !== null && stats.wellnessAtEnd !== null) {
                message += `*Wellness Score:* ${stats.wellnessAtStart} → ${stats.wellnessAtEnd} ✅\n`;
            }
            if (stats.dietAdherencePercent !== null) {
                message += `*Diet Adherence:* ${stats.dietAdherencePercent}%\n`;
            }
            message += `*Tasks Completed:* ${stats.tasksDone}/${stats.tasksTotal} (${stats.tasksPercent}%)\n\n`;

            if (progressData.nextPhase) {
                message += `*Next Phase:* ${progressData.nextPhase.name}\n`;
            }
            if (progressData.nextAppointment) {
                const apptDate = new Date(progressData.nextAppointment.date).toLocaleDateString('en-IN', {
                    day: '2-digit', month: 'short', year: 'numeric',
                });
                const apptTime = new Date(progressData.nextAppointment.date).toLocaleTimeString('en-IN', {
                    hour: '2-digit', minute: '2-digit', hour12: true,
                });
                const apptDoctor = progressData.nextAppointment.doctor?.fullName || doctorName;
                message += `*Next Appointment:* Dr. ${apptDoctor} — ${apptDate} at ${apptTime}\n`;
            }
            message += `\nYour full progress report has been attached. Keep up the great work! 💪`;

            const result = await WhatsAppService.sendDocument({
                phone:    whatsappNumber,
                document: pdfBuffer.toString('base64'),
                filename: `AlShifa-Progress-Report-${(phaseName || 'phase').replace(/\s+/g, '-')}.pdf`,
                caption:  message,
            });

            if (result?.status === 'SENT') {
                await prisma.healthReport.update({
                    where: { id: report.id },
                    data:  { sentViaWhatsApp: true, whatsappSentAt: new Date() },
                });
                whatsappDelivered = true;
            } else if (result?.status === 'SKIPPED') {
                whatsappError = 'WhatsApp gateway not configured (skipped)';
            } else {
                whatsappError = result?.error || 'WhatsApp delivery returned non-SENT status';
            }
        } catch (err) {
            whatsappError = err?.message || 'WhatsApp delivery failed';
            logger.warn('[healthReport.progress] WhatsApp delivery failed', { err: whatsappError, reportId: report.id });
        }
    }

    // 7. In-app notification — patient.
    try {
        const recipientUserId = progressData.patient?.userId;
        if (recipientUserId) {
            const phaseName = progressData.phase?.name || 'your phase';
            const stats     = progressData.stats || {};
            const trail     = stats.painReduction !== null && stats.painReduction > 0
                ? ` Pain reduced by ${stats.painReduction}%.`
                : '';
            const { notificationService } = await import('./notification.service.js');
            await notificationService.createNotification({
                userId:    recipientUserId,
                type:      'PHASE_PROGRESS_REPORT_READY',
                title:     `Phase Complete — ${phaseName}`,
                message:   `Your progress report for ${phaseName} is ready.${trail}`,
                priority:  'INFO',
                relatedId: report.id,
                data: {
                    link: '/patient-portal?tab=reports',
                    reportId: report.id,
                    phaseId,
                    reportType: 'PHASE_PROGRESS',
                },
            });
        }
    } catch (err) {
        logger.warn('[healthReport.progress] patient notification failed', { err: err.message, reportId: report.id });
    }

    // 8. In-app notification — assigned doctor.
    try {
        const doctorUserId = progressData.journey?.doctorId; // TreatmentJourney.doctorId stores User.id
        if (doctorUserId) {
            const phaseName   = progressData.phase?.name || 'their phase';
            const patientName = progressData.patient?.fullName || 'Your patient';
            const stats       = progressData.stats || {};
            const { notificationService } = await import('./notification.service.js');
            await notificationService.createNotification({
                userId:    doctorUserId,
                type:      'PATIENT_PHASE_COMPLETED',
                title:     `Patient Completed Phase — ${phaseName}`,
                message:   `${patientName} has completed ${phaseName}. Tasks: ${stats.tasksDone}/${stats.tasksTotal}.${
                    stats.painAtStart !== null && stats.painAtEnd !== null
                        ? ` Pain: ${stats.painAtStart}→${stats.painAtEnd}.`
                        : ''
                }`,
                priority:  'MEDIUM',
                relatedId: report.id,
                data: {
                    link: `/patients/${patientId}/timeline`,
                    reportId: report.id,
                    phaseId,
                },
            });
        }
    } catch (err) {
        logger.warn('[healthReport.progress] doctor notification failed', { err: err.message, reportId: report.id });
    }

    // 9. Socket emit — patient room.
    try {
        const { emitToUser } = await import('../websocket/index.js');
        const recipientUserId = progressData.patient?.userId;
        if (recipientUserId) {
            emitToUser(recipientUserId, 'progress_report_ready', {
                reportId: report.id,
                phaseName: progressData.phase?.name || null,
                phaseId,
                stats: progressData.stats,
                createdAt: report.createdAt,
            });
        }
    } catch (err) {
        logger.warn('[healthReport.progress] socket emit failed', { err: err.message, reportId: report.id });
    }

    // 10. Audit log.
    try {
        await prisma.auditLog.create({
            data: {
                userId: progressData.journey?.doctorId || progressData.patient?.userId || null,
                action: 'PHASE_PROGRESS_REPORT_GENERATED',
                entityType: 'HealthReport',
                entityId: report.id,
                newData: { patientId, phaseId, sentViaWhatsApp: whatsappDelivered },
            },
        });
    } catch (err) {
        logger.warn('[healthReport.progress] audit log failed', { err: err.message, reportId: report.id });
    }

    return { report, alreadyExisted: false, whatsappDelivered, whatsappError };
}

export default {
    assembleReportData,
    generatePDF,
    createAndDeliverReport,
    // Feature 4 additions
    assemblePhaseProgressData,
    generateProgressPDF,
    createAndDeliverProgressReport,
};
