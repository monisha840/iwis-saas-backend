import prisma from '../lib/prisma.js';

/**
 * TimelineService
 * Merges five core patient data models — appointments, prescriptions,
 * daily check-ins, documents, and medication logs — into a single
 * chronologically sorted event stream.
 */
export class TimelineService {
    /**
     * Build a unified timeline for a patient.
     * @param {string} patientId - Patient.id (not User.id)
     * @param {{ from?: string, to?: string }} options - Optional date range filter (ISO strings)
     * @returns {Promise<Array<TimelineEvent>>}
     */
    static async getTimeline(patientId, { from, to } = {}) {
        const dateFilter = {};
        if (from) dateFilter.gte = new Date(from);
        if (to)   dateFilter.lte = new Date(to);

        const hasDateFilter = Object.keys(dateFilter).length > 0;

        // ── Parallel fetch of all five sources ────────────────────────────────
        const [appointments, prescriptions, checkIns, documents, medLogs] = await Promise.all([

            // 1. Appointments
            prisma.appointment.findMany({
                where: {
                    patientId,
                    ...(hasDateFilter ? { date: dateFilter } : {}),
                },
                include: {
                    doctor:   { select: { fullName: true, specialization: true } },
                    therapist:{ select: { fullName: true, specialization: true } },
                    triageSession: { select: { severity: true, suggestedSpecialty: true, compositeScore: true } },
                },
                orderBy: { date: 'desc' },
            }),

            // 2. Prescriptions
            prisma.prescription.findMany({
                where: {
                    patientId,
                    ...(hasDateFilter ? { createdAt: dateFilter } : {}),
                },
                include: {
                    doctor:   { select: { fullName: true } },
                    therapist:{ select: { fullName: true } },
                    medicine: { select: { name: true, category: true } },
                },
                orderBy: { createdAt: 'desc' },
            }),

            // 3. Daily check-ins
            prisma.dailyCheckIn.findMany({
                where: {
                    patientId,
                    ...(hasDateFilter ? { createdAt: dateFilter } : {}),
                },
                orderBy: { createdAt: 'desc' },
            }),

            // 4. Documents
            prisma.document.findMany({
                where: {
                    patientId,
                    ...(hasDateFilter ? { createdAt: dateFilter } : {}),
                },
                orderBy: { createdAt: 'desc' },
            }),

            // 5. Medication logs — join via prescription to verify patient ownership
            prisma.medicationLog.findMany({
                where: {
                    prescription: { patientId },
                    ...(hasDateFilter ? { date: dateFilter } : {}),
                },
                include: {
                    prescription: { select: { medicationName: true, dosage: true, frequency: true } },
                },
                orderBy: { date: 'desc' },
            }),
        ]);

        // ── Shape each source into typed timeline events ──────────────────────
        const events = [
            ...appointments.map(a => ({
                id:       a.id,
                type:     'APPOINTMENT',
                date:     a.date,
                title:    `Appointment — ${a.consultationType}`,
                subtitle: a.doctor?.fullName
                            ? `Dr. ${a.doctor.fullName}`
                            : a.therapist?.fullName
                                ? `${a.therapist.fullName} (Therapist)`
                                : null,
                status:   a.status,
                meta: {
                    consultationType: a.consultationType,
                    consultationMode: a.consultationMode,
                    notes:            a.notes,
                    sessionNotes:     a.sessionNotes,
                    doctor:           a.doctor,
                    therapist:        a.therapist,
                    triage:           a.triageSession,
                },
            })),

            ...prescriptions.map(rx => ({
                id:       rx.id,
                type:     'PRESCRIPTION',
                date:     rx.createdAt,
                title:    `Prescription — ${rx.medicationName}`,
                subtitle: rx.doctor?.fullName
                            ? `Prescribed by Dr. ${rx.doctor.fullName}`
                            : rx.therapist?.fullName
                                ? `Prescribed by ${rx.therapist.fullName}`
                                : null,
                status:   'ACTIVE',
                meta: {
                    medicationName: rx.medicationName,
                    dosage:         rx.dosage,
                    frequency:      rx.frequency,
                    duration:       rx.duration,
                    notes:          rx.notes,
                    medicine:       rx.medicine,
                    sku:            rx.sku,
                },
            })),

            ...checkIns.map(ci => ({
                id:       ci.id,
                type:     'CHECKIN',
                date:     ci.createdAt,
                title:    `Wellness Check-In`,
                subtitle: `Pain: ${ci.painLevel}/10 · Sleep: ${ci.sleepHours}h · Mood: ${ci.mood}`,
                status:   'LOGGED',
                meta: {
                    painLevel:    ci.painLevel,
                    sleepHours:   ci.sleepHours,
                    mood:         ci.mood,
                    mobilityScore:ci.mobilityScore,
                    notes:        ci.notes,
                },
            })),

            ...documents.map(doc => ({
                id:       doc.id,
                type:     'DOCUMENT',
                date:     doc.createdAt,
                title:    `Document — ${doc.category.replace(/_/g, ' ')}`,
                subtitle: doc.fileName,
                status:   'UPLOADED',
                meta: {
                    fileName:     doc.fileName,
                    fileUrl:      doc.fileUrl,
                    fileType:     doc.fileType,
                    fileSize:     doc.fileSize,
                    category:     doc.category,
                    description:  doc.description,
                },
            })),

            ...medLogs.map(ml => ({
                id:       ml.id,
                type:     'MEDICATION',
                date:     ml.date,
                title:    `Medication Log — ${ml.medicationName}`,
                subtitle: ml.taken
                            ? `Taken at ${ml.takenAt ? new Date(ml.takenAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : 'logged'}`
                            : `Skipped`,
                status:   ml.taken ? 'TAKEN' : 'SKIPPED',
                meta: {
                    dosage:  ml.dosage,
                    slot:    ml.slot,
                    taken:   ml.taken,
                    takenAt: ml.takenAt,
                    notes:   ml.notes,
                    prescription: ml.prescription,
                },
            })),
        ];

        // ── Sort all events newest-first ───────────────────────────────────────
        events.sort((a, b) => new Date(b.date) - new Date(a.date));

        return events;
    }
}
