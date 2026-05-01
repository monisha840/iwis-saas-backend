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
     * Activate the next phase when the current one completes. When no
     * upcoming phase exists, the journey itself flips to COMPLETED and the
     * end-of-journey feedback invite is fanned out to the patient.
     */
    static async activateNextPhase(journeyId) {
        const result = await prisma.$transaction(async (tx) => {
            const phases = await tx.journeyPhase.findMany({
                where: { journeyId },
                orderBy: { order: 'asc' }
            });

            const currentActive = phases.find(p => p.status === 'ACTIVE');
            if (currentActive) {
                await tx.journeyPhase.update({
                    where: { id: currentActive.id },
                    data: { status: 'COMPLETED', completedAt: new Date() }
                });
            }

            const nextPhase = phases.find(p => p.status === 'UPCOMING');
            if (nextPhase) {
                await tx.journeyPhase.update({
                    where: { id: nextPhase.id },
                    data: { status: 'ACTIVE', startedAt: new Date() }
                });
                return { nextPhase, completed: false };
            }

            await tx.treatmentJourney.update({
                where: { id: journeyId },
                data: { status: 'COMPLETED' }
            });

            return { nextPhase: null, completed: true };
        });

        // Outside the tx so feedback init failure can't roll back the phase
        // transition — the journey is already completed and that has to stick.
        if (result.completed) {
            await this._onJourneyCompleted(journeyId).catch((err) => {
                logger.error('[Journey] _onJourneyCompleted hook failed', { journeyId, err: err.message });
            });
        }

        return result.nextPhase;
    }

    /**
     * Explicit "mark complete" path used by admin tooling / manual completion
     * from the journey detail page. Idempotent — calling on an already
     * COMPLETED journey re-fires the feedback init (which is itself
     * idempotent on the unique journeyId).
     */
    static async completeJourney(journeyId) {
        const updated = await prisma.treatmentJourney.update({
            where: { id: journeyId },
            data: { status: 'COMPLETED' },
            select: { id: true },
        });
        await this._onJourneyCompleted(updated.id).catch((err) => {
            logger.error('[Journey] _onJourneyCompleted hook failed', { journeyId, err: err.message });
        });
        return updated;
    }

    /**
     * Private hook fired when a journey transitions to COMPLETED. Initialises
     * the feedback record + notifies the patient. Best-effort across both
     * sub-steps so an outage in one channel doesn't block the other.
     */
    static async _onJourneyCompleted(journeyId) {
        const { JourneyFeedbackService } = await import('./journeyFeedback.service.js');

        // 1) Create the pending feedback row (30-day window). Idempotent via
        //    UNIQUE(journeyId).
        const feedback = await JourneyFeedbackService.initFromJourney(journeyId);
        if (!feedback) return;

        // 2) Patient invite — in-app notification + Socket emit. Best-effort.
        const journey = await prisma.treatmentJourney.findUnique({
            where: { id: journeyId },
            select: {
                title: true,
                patientId: true,
                doctor: { select: { fullName: true } },
            },
        });
        if (!journey) return;

        const doctorName = journey.doctor?.fullName || 'your doctor';
        try {
            await notificationService.createNotification({
                userId:   journey.patientId,
                type:     'JOURNEY_FEEDBACK_AVAILABLE',
                title:    'Your treatment journey is complete',
                message:  `Share a quick reflection on your time with ${doctorName} — under two minutes.`,
                priority: 'MEDIUM',
                data:     {
                    journeyId,
                    feedbackId: feedback.id,
                    expiresAt:  feedback.expiresAt,
                    kind:       'journey_feedback_available',
                },
            });
        } catch (err) {
            logger.warn('[Journey] feedback invite notification failed', { journeyId, err: err.message });
        }

        // Real-time prompt to the patient — fired immediately (no queue) since
        // there's no transient state to wait out. The frontend modal listens
        // for `journey_feedback_request` and pops the rating wizard.
        try {
            const { emitToUser } = await import('../websocket/index.js');
            emitToUser(journey.patientId, 'journey_feedback_request', {
                journeyId,
                feedbackId:    feedback.id,
                journeyTitle:  journey.title,
                clinicianName: doctorName,
                expiresAt:     feedback.expiresAt,
            });
        } catch (err) {
            logger.warn('[Journey] journey_feedback_request emit failed', { journeyId, err: err.message });
        }
    }

    /**
     * Log a task completion by a patient.
     *
     * Each task can be completed AT MOST ONCE per calendar day. If the patient
     * has already completed this task today, the prior completion is returned
     * and no zen points are re-awarded — clicking "Done" twice in a row should
     * be a no-op rather than a points farm. Direct API callers get a 409.
     */
    static async completeTask(taskId, patientId, completionData) {
        const task = await prisma.phaseTask.findUnique({
            where: { id: taskId },
            include: { phase: { include: { journey: true } } }
        });
        if (!task) throw Object.assign(new Error('Task not found'), { status: 404 });

        // Day boundary in the server's local timezone. Anything from 00:00 today
        // onward counts as "already done today" and short-circuits.
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const alreadyToday = await prisma.taskCompletion.findFirst({
            where: {
                taskId,
                patientId,
                completedAt: { gte: startOfDay },
            },
            orderBy: { completedAt: 'desc' },
        });
        if (alreadyToday) {
            throw Object.assign(
                new Error('This task is already completed for today. Try again tomorrow.'),
                { status: 409, code: 'TASK_ALREADY_COMPLETED_TODAY', completion: alreadyToday },
            );
        }

        const completion = await prisma.taskCompletion.create({
            data: {
                taskId,
                patientId,
                notes: completionData.notes || null,
                mediaUrl: completionData.mediaUrl || null,
            }
        });

        // Award zen points for task completion. Only fires on a NEW completion —
        // the early-return above means duplicates never reach this branch.
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
            : 50;

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
            : 50;

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
            if (titleLower.includes('50%') && allTasks.length > 0 && completedCount >= allTasks.length * 0.5) achieved = true;
            if (titleLower.includes('all tasks') && allTasks.length > 0 && completedCount >= allTasks.length) achieved = true;
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
