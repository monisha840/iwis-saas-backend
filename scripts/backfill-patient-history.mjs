/**
 * One-off backfill: create PatientHistoryRecord rows for every COMPLETED
 * TreatmentJourney that doesn't yet have one.
 *
 * Idempotent — re-running is safe because PatientHistoryRecord.journeyId is
 * @unique; the script skips rows that already exist.
 *
 * "Quiet": this writes the snapshot only. No certificate PDF, no WhatsApp
 * delivery, no doctor in-app notification — those are journey-completion
 * side effects that don't make sense to fire weeks after the fact.
 *
 * Run with: node scripts/backfill-patient-history.mjs
 */

import { PrismaClient } from '@prisma/client';
import { aggregateJourneyData, calculateReturnRisk } from '../services/patientHistory.service.js';

const prisma = new PrismaClient();

async function main() {
    const completed = await prisma.treatmentJourney.findMany({
        where: { status: 'COMPLETED' },
        select: { id: true, title: true, patientId: true, updatedAt: true },
    });
    console.log('Found', completed.length, 'COMPLETED journeys total');

    const candidates = [];
    for (const j of completed) {
        const existing = await prisma.patientHistoryRecord.findUnique({
            where: { journeyId: j.id },
        });
        if (!existing) candidates.push(j);
    }
    console.log('Need backfill:', candidates.length);
    console.log('---');

    let created = 0;
    let skipped = 0;
    for (const j of candidates) {
        try {
            const data = await aggregateJourneyData(j.id);
            const risk = calculateReturnRisk(data);

            if (!data.doctorId) {
                console.log('  SKIP', j.title, '(no Doctor profile for journey doctor User)');
                skipped++;
                continue;
            }
            const branchId = data.journey.branchId || data.patient.branchId;
            if (!branchId) {
                console.log('  SKIP', j.title, '(no branch context)');
                skipped++;
                continue;
            }

            // Use the journey's updatedAt as the completion date (best proxy for
            // when the status flipped to COMPLETED) rather than now() — this
            // is retroactive, not real-time.
            const completedDate = data.journey.updatedAt || new Date();
            const startDate = data.journey.startDate;
            const durationDays = Math.max(
                1,
                Math.ceil(
                    (new Date(completedDate).getTime() - new Date(startDate).getTime()) /
                        (1000 * 60 * 60 * 24),
                ),
            );

            const rec = await prisma.patientHistoryRecord.create({
                data: {
                    patientId: data.patientId,
                    journeyId: j.id,
                    doctorId: data.doctorId,
                    branchId,
                    journeyTitle: data.journey.title,
                    condition: data.journey.condition || null,
                    startDate,
                    completedDate,
                    durationDays,
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

            try {
                await prisma.auditLog.create({
                    data: {
                        userId: data.journey.doctorId || null,
                        action: 'PATIENT_HISTORY_RECORD_BACKFILLED',
                        entityType: 'PatientHistoryRecord',
                        entityId: rec.id,
                        newData: {
                            journeyId: j.id,
                            patientId: data.patientId,
                            returnRiskLevel: risk.level,
                            source: 'backfill_script',
                        },
                    },
                });
            } catch (auditErr) {
                // Audit failures shouldn't roll back the record itself.
            }

            console.log(
                '  CREATED',
                j.title,
                '· risk:', risk.level,
                '· pain reduction:', data.painReduction,
                '· tasks:', data.taskCompletionRate + '%',
            );
            created++;
        } catch (err) {
            console.log('  ERROR', j.title, '·', err.message);
            skipped++;
        }
    }

    console.log('---');
    console.log('Backfill complete: created =', created, ', skipped =', skipped);
}

main()
    .then(() => prisma.$disconnect())
    .catch((e) => {
        console.error('FATAL:', e);
        prisma.$disconnect().finally(() => process.exit(1));
    });
