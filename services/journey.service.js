import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { notificationService } from './notification.service.js';

export class JourneyService {
    /**
     * Create a new treatment journey for a patient.
     */
    static async createJourney(doctorId, patientId, branchId, journeyData) {
        const { title, condition, targetDate, phases = [], milestones = [] } = journeyData;

        const journey = await prisma.treatmentJourney.create({
            data: {
                patientId,
                doctorId,
                branchId,
                title,
                condition,
                targetDate: targetDate ? new Date(targetDate) : null,
                phases: {
                    create: phases.map((phase, index) => ({
                        name: phase.name,
                        order: phase.order ?? index,
                        durationDays: phase.durationDays,
                        status: index === 0 ? 'ACTIVE' : 'UPCOMING',
                        startedAt: index === 0 ? new Date() : null,
                        tasks: {
                            create: (phase.tasks || []).map(task => ({
                                type: task.type,
                                title: task.title,
                                description: task.description || null,
                                frequency: task.frequency,
                            }))
                        }
                    }))
                },
                milestones: {
                    create: milestones.map(m => ({
                        title: m.title,
                        description: m.description || null,
                        targetDate: m.targetDate ? new Date(m.targetDate) : null,
                        badgeIcon: m.badgeIcon || null,
                    }))
                }
            },
            include: {
                phases: { include: { tasks: true }, orderBy: { order: 'asc' } },
                milestones: true,
            }
        });

        // Notify the patient
        await notificationService.createNotification({
            userId: patientId,
            type: 'JOURNEY_CREATED',
            title: 'New Treatment Journey',
            message: `Your treatment journey "${title}" has been created. Let's begin your wellness path!`,
            priority: 'HIGH',
            data: { journeyId: journey.id },
        });

        logger.info(`[Journey] Created journey ${journey.id} for patient ${patientId}`);
        return journey;
    }

    /**
     * Add a phase to an existing journey.
     */
    static async addPhase(journeyId, phaseData) {
        const journey = await prisma.treatmentJourney.findUnique({
            where: { id: journeyId },
            include: { phases: { orderBy: { order: 'asc' } } }
        });
        if (!journey) throw Object.assign(new Error('Journey not found'), { status: 404 });

        const nextOrder = journey.phases.length > 0
            ? Math.max(...journey.phases.map(p => p.order)) + 1
            : 0;

        return prisma.journeyPhase.create({
            data: {
                journeyId,
                name: phaseData.name,
                order: phaseData.order ?? nextOrder,
                durationDays: phaseData.durationDays,
                tasks: {
                    create: (phaseData.tasks || []).map(task => ({
                        type: task.type,
                        title: task.title,
                        description: task.description || null,
                        frequency: task.frequency,
                    }))
                }
            },
            include: { tasks: true }
        });
    }

    /**
     * Activate the next phase when the current one completes.
     */
    static async activateNextPhase(journeyId) {
        const phases = await prisma.journeyPhase.findMany({
            where: { journeyId },
            orderBy: { order: 'asc' }
        });

        const currentActive = phases.find(p => p.status === 'ACTIVE');
        if (currentActive) {
            await prisma.journeyPhase.update({
                where: { id: currentActive.id },
                data: { status: 'COMPLETED', completedAt: new Date() }
            });
        }

        const nextPhase = phases.find(p => p.status === 'UPCOMING');
        if (nextPhase) {
            await prisma.journeyPhase.update({
                where: { id: nextPhase.id },
                data: { status: 'ACTIVE', startedAt: new Date() }
            });
            return nextPhase;
        }

        // All phases complete — mark journey as completed
        await prisma.treatmentJourney.update({
            where: { id: journeyId },
            data: { status: 'COMPLETED' }
        });

        return null;
    }

    /**
     * Log a task completion by a patient.
     */
    static async completeTask(taskId, patientId, completionData) {
        const task = await prisma.phaseTask.findUnique({
            where: { id: taskId },
            include: { phase: { include: { journey: true } } }
        });
        if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });

        const completion = await prisma.taskCompletion.create({
            data: {
                taskId,
                patientId,
                notes: completionData.notes || null,
                mediaUrl: completionData.mediaUrl || null,
            }
        });

        // Award zen points for task completion
        await prisma.patient.updateMany({
            where: { userId: patientId },
            data: { zenPoints: { increment: 10 } }
        });

        // Recompute wellness score
        const journeyId = task.phase.journeyId;
        await this.computeWellnessScore(journeyId);

        // Check milestone achievements
        await this.checkMilestoneAchievement(journeyId);

        return completion;
    }

    /**
     * Record a patient vital reading.
     */
    static async recordVital(patientId, vitalData) {
        const vital = await prisma.patientVital.create({
            data: {
                patientId,
                journeyId: vitalData.journeyId || null,
                type: vitalData.type,
                value: vitalData.value,
                unit: vitalData.unit,
                source: vitalData.source || 'manual',
            }
        });

        // Award zen points for vital logging
        await prisma.patient.updateMany({
            where: { userId: patientId },
            data: { zenPoints: { increment: 5 } }
        });

        // Recompute wellness score if linked to a journey
        if (vitalData.journeyId) {
            await this.computeWellnessScore(vitalData.journeyId);
        }

        return vital;
    }

    /**
     * Compute the wellness score for a journey (0-100).
     * Formula:
     *   taskAdherence * 40 + vitalTrend * 30 + milestoneProgress * 20 + appointmentAttendance * 10
     */
    static async computeWellnessScore(journeyId) {
        const journey = await prisma.treatmentJourney.findUnique({
            where: { id: journeyId },
            include: {
                phases: {
                    include: {
                        tasks: { include: { completions: true } }
                    }
                },
                milestones: true,
                vitals: { where: { type: 'PAIN_SCORE' }, orderBy: { recordedAt: 'asc' } },
            }
        });
        if (!journey) return 0;

        // 1. Task adherence rate (% of tasks with at least 1 completion)
        const allTasks = journey.phases.flatMap(p => p.tasks);
        const completedTasks = allTasks.filter(t => t.completions.length > 0);
        const taskAdherenceRate = allTasks.length > 0
            ? (completedTasks.length / allTasks.length) * 100
            : 0;

        // 2. Vital trend (pain score reduction, normalized 0-100)
        let vitalTrend = 50; // neutral default
        if (journey.vitals.length >= 2) {
            const first = journey.vitals[0].value;
            const last = journey.vitals[journey.vitals.length - 1].value;
            // Lower pain = better. Max improvement is 10 points reduction.
            const improvement = first - last;
            vitalTrend = Math.max(0, Math.min(100, (improvement / 10) * 100));
        }

        // 3. Milestone progress (% achieved)
        const totalMilestones = journey.milestones.length;
        const achievedMilestones = journey.milestones.filter(m => m.isAchieved).length;
        const milestoneProgress = totalMilestones > 0
            ? (achievedMilestones / totalMilestones) * 100
            : 0;

        // 4. Appointment attendance
        const appointments = await prisma.appointment.findMany({
            where: {
                patientId: journey.patientId,
                date: { gte: journey.startDate },
                status: { in: ['COMPLETED', 'NO_SHOW', 'CANCELLED'] },
            }
        });
        const attended = appointments.filter(a => a.status === 'COMPLETED').length;
        const attendanceRate = appointments.length > 0
            ? (attended / appointments.length) * 100
            : 100; // No appointments yet = perfect

        // Weighted formula
        const wellnessScore = Number((
            (taskAdherenceRate * 0.40) +
            (vitalTrend * 0.30) +
            (milestoneProgress * 0.20) +
            (attendanceRate * 0.10)
        ).toFixed(1));

        // Update the journey
        await prisma.treatmentJourney.update({
            where: { id: journeyId },
            data: { wellnessScore }
        });

        return {
            wellnessScore,
            breakdown: {
                taskAdherence: Math.round(taskAdherenceRate),
                vitalTrend: Math.round(vitalTrend),
                milestoneProgress: Math.round(milestoneProgress),
                appointmentAttendance: Math.round(attendanceRate),
            }
        };
    }

    /**
     * Get journey timeline (all events in chronological order).
     */
    static async getJourneyTimeline(journeyId) {
        const journey = await prisma.treatmentJourney.findUnique({
            where: { id: journeyId },
            include: {
                phases: {
                    include: { tasks: { include: { completions: true } } },
                    orderBy: { order: 'asc' }
                },
                milestones: { orderBy: { achievedAt: 'asc' } },
                vitals: { orderBy: { recordedAt: 'asc' } },
            }
        });
        if (!journey) throw Object.assign(new Error('Journey not found'), { status: 404 });

        const events = [];

        // Journey start
        events.push({ type: 'journey_started', date: journey.startDate, title: `Journey started: ${journey.title}` });

        // Phase transitions
        for (const phase of journey.phases) {
            if (phase.startedAt) events.push({ type: 'phase_started', date: phase.startedAt, title: `Phase started: ${phase.name}` });
            if (phase.completedAt) events.push({ type: 'phase_completed', date: phase.completedAt, title: `Phase completed: ${phase.name}` });

            for (const task of phase.tasks) {
                for (const completion of task.completions) {
                    events.push({ type: 'task_completed', date: completion.completedAt, title: `Task completed: ${task.title}`, data: { notes: completion.notes } });
                }
            }
        }

        // Milestones
        for (const m of journey.milestones) {
            if (m.isAchieved && m.achievedAt) {
                events.push({ type: 'milestone_achieved', date: m.achievedAt, title: `Milestone: ${m.title}`, data: { badgeIcon: m.badgeIcon } });
            }
        }

        // Vitals
        for (const v of journey.vitals) {
            events.push({ type: 'vital_recorded', date: v.recordedAt, title: `${v.type}: ${v.value} ${v.unit}` });
        }

        // Sort chronologically
        events.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        return events;
    }

    /**
     * Check if any milestones should be auto-achieved.
     */
    static async checkMilestoneAchievement(journeyId) {
        const journey = await prisma.treatmentJourney.findUnique({
            where: { id: journeyId },
            include: {
                milestones: { where: { isAchieved: false } },
                phases: {
                    include: { tasks: { include: { completions: true } } },
                    orderBy: { order: 'asc' }
                },
                vitals: { where: { type: 'PAIN_SCORE' }, orderBy: { recordedAt: 'desc' }, take: 7 },
            }
        });
        if (!journey) return;

        const allTasks = journey.phases.flatMap(p => p.tasks);
        const completedCount = allTasks.filter(t => t.completions.length > 0).length;
        const completedPhases = journey.phases.filter(p => p.status === 'COMPLETED').length;
        const latestPain = journey.vitals[0]?.value;

        for (const milestone of journey.milestones) {
            let achieved = false;
            const titleLower = milestone.title.toLowerCase();

            // Auto-detect milestone criteria from title
            if (titleLower.includes('pain-free') && latestPain !== undefined && latestPain <= 1) achieved = true;
            if (titleLower.includes('first week') && completedCount >= 7) achieved = true;
            if (titleLower.includes('50%') && completedCount >= allTasks.length * 0.5) achieved = true;
            if (titleLower.includes('all tasks') && completedCount >= allTasks.length) achieved = true;
            if (titleLower.includes('phase complete') && completedPhases > 0) achieved = true;
            // Target date milestone: if past the date and journey is progressing
            if (milestone.targetDate && new Date() >= new Date(milestone.targetDate) && completedCount > 0) achieved = true;

            if (achieved) {
                await prisma.journeyMilestone.update({
                    where: { id: milestone.id },
                    data: { isAchieved: true, achievedAt: new Date() }
                });

                // Award 100 zen points
                await prisma.patient.updateMany({
                    where: { userId: journey.patientId },
                    data: { zenPoints: { increment: 100 } }
                });

                // Notify patient
                await notificationService.createNotification({
                    userId: journey.patientId,
                    type: 'MILESTONE_ACHIEVED',
                    title: `Milestone Achieved: ${milestone.title}`,
                    message: `Congratulations! You've reached a milestone in your wellness journey. +100 Zen Points!`,
                    priority: 'MEDIUM',
                    data: { journeyId, milestoneId: milestone.id },
                });

                logger.info(`[Journey] Milestone achieved: ${milestone.title} for journey ${journeyId}`);
            }
        }
    }

    /**
     * Get journeys for a patient.
     */
    static async getPatientJourneys(patientId) {
        return prisma.treatmentJourney.findMany({
            where: { patientId },
            include: {
                phases: { orderBy: { order: 'asc' } },
                milestones: true,
                doctor: true,
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    /**
     * Get a single journey with full details.
     */
    static async getJourneyById(journeyId) {
        const journey = await prisma.treatmentJourney.findUnique({
            where: { id: journeyId },
            include: {
                phases: {
                    include: {
                        tasks: {
                            include: { completions: { orderBy: { completedAt: 'desc' } } }
                        }
                    },
                    orderBy: { order: 'asc' }
                },
                milestones: { orderBy: { targetDate: 'asc' } },
                vitals: { orderBy: { recordedAt: 'desc' }, take: 30 },
                doctor: true,
            }
        });

        if (!journey) throw Object.assign(new Error('Journey not found'), { status: 404 });
        return journey;
    }

    /**
     * Get vitals for a journey (chart data).
     */
    static async getJourneyVitals(journeyId, type, days = 30) {
        const since = new Date();
        since.setDate(since.getDate() - days);

        const where = { journeyId, recordedAt: { gte: since } };
        if (type) where.type = type;

        return prisma.patientVital.findMany({
            where,
            orderBy: { recordedAt: 'asc' },
        });
    }
}
