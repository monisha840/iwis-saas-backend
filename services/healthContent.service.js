import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { ZenPointsService } from './zenPoints.service.js';

/**
 * HealthContentService — unlockable health content library.
 *
 * Content is gated by patient level and zen points.
 * Patients unlock content as they progress through the gamification system.
 */
export class HealthContentService {
    /**
     * Get the full content library with locked/unlocked status based on patient's level and points.
     */
    static async getContentLibrary(patientId) {
        const [patient, allContent, myUnlocks] = await Promise.all([
            prisma.patient.findUnique({
                where: { id: patientId },
                select: { zenPoints: true }
            }),
            prisma.healthContent.findMany({
                where: { isActive: true },
                orderBy: [{ requiredLevel: 'asc' }, { requiredPoints: 'asc' }]
            }),
            prisma.contentUnlock.findMany({
                where: { patientId },
                select: { contentId: true, unlockedAt: true }
            })
        ]);

        if (!patient) throw new Error('Patient not found');

        const level = ZenPointsService.getLevel(patient.zenPoints);
        const unlockedMap = new Map(myUnlocks.map(u => [u.contentId, u.unlockedAt]));

        return allContent.map(c => {
            const isUnlocked = unlockedMap.has(c.id);
            const meetsLevel = level.tier >= c.requiredLevel;
            const meetsPoints = patient.zenPoints >= c.requiredPoints;
            const canUnlock = meetsLevel && meetsPoints && !isUnlocked;

            return {
                id: c.id,
                title: c.title,
                description: c.description,
                type: c.type,
                contentUrl: isUnlocked ? c.contentUrl : null,
                thumbnail: c.thumbnail,
                category: c.category,
                requiredLevel: c.requiredLevel,
                requiredPoints: c.requiredPoints,
                isUnlocked,
                unlockedAt: unlockedMap.get(c.id) || null,
                canUnlock,
                meetsLevel,
                meetsPoints
            };
        });
    }

    /**
     * Unlock a specific piece of content.
     */
    static async unlockContent(patientId, contentId) {
        const [patient, content] = await Promise.all([
            prisma.patient.findUnique({
                where: { id: patientId },
                select: { zenPoints: true }
            }),
            prisma.healthContent.findUnique({ where: { id: contentId } })
        ]);

        if (!patient) throw new Error('Patient not found');
        if (!content) throw new Error('Content not found');
        if (!content.isActive) throw new Error('Content is no longer available');

        // Check if already unlocked
        const existing = await prisma.contentUnlock.findUnique({
            where: { patientId_contentId: { patientId, contentId } }
        });
        if (existing) return { alreadyUnlocked: true, content };

        // Check requirements
        const level = ZenPointsService.getLevel(patient.zenPoints);
        if (level.tier < content.requiredLevel) {
            throw new Error(`Requires level ${content.requiredLevel}. You are level ${level.tier} (${level.name}).`);
        }
        if (patient.zenPoints < content.requiredPoints) {
            throw new Error(`Requires ${content.requiredPoints} zen points. You have ${patient.zenPoints}.`);
        }

        // Create unlock
        const unlock = await prisma.contentUnlock.create({
            data: { patientId, contentId },
            include: { content: true }
        });

        logger.info(`[HealthContent] Patient ${patientId} unlocked content "${content.title}"`);
        return { unlocked: true, content: unlock.content };
    }

    /**
     * Get only unlocked content for a patient.
     */
    static async getUnlockedContent(patientId) {
        const unlocks = await prisma.contentUnlock.findMany({
            where: { patientId },
            include: { content: true },
            orderBy: { unlockedAt: 'desc' }
        });

        return unlocks.map(u => ({
            id: u.content.id,
            title: u.content.title,
            description: u.content.description,
            type: u.content.type,
            contentUrl: u.content.contentUrl,
            thumbnail: u.content.thumbnail,
            category: u.content.category,
            unlockedAt: u.unlockedAt
        }));
    }

    /**
     * Seed initial content if none exists.
     */
    static async seedDefaultContent() {
        const existing = await prisma.healthContent.count();
        if (existing > 0) return;

        const defaults = [
            // Level 1 (free)
            {
                title: 'Basic Stretching Guide',
                description: 'A beginner-friendly stretching routine for daily wellness.',
                type: 'VIDEO',
                contentUrl: '/content/videos/basic-stretching.mp4',
                category: 'Exercise',
                requiredLevel: 1,
                requiredPoints: 0
            },
            {
                title: 'Healthy Eating 101',
                description: 'An introduction to balanced nutrition and healthy eating habits.',
                type: 'ARTICLE',
                contentUrl: '/content/articles/healthy-eating-101.html',
                category: 'Nutrition',
                requiredLevel: 1,
                requiredPoints: 0
            },
            // Level 2
            {
                title: 'Advanced Exercise Routines',
                description: 'Progressive exercise plans for building strength and endurance.',
                type: 'EXERCISE_PLAN',
                contentUrl: '/content/plans/advanced-exercise.pdf',
                category: 'Exercise',
                requiredLevel: 2,
                requiredPoints: 50
            },
            {
                title: 'Stress Management',
                description: 'Techniques and strategies for managing daily stress effectively.',
                type: 'ARTICLE',
                contentUrl: '/content/articles/stress-management.html',
                category: 'Mental Health',
                requiredLevel: 2,
                requiredPoints: 50
            },
            // Level 3
            {
                title: 'Custom Diet Plans',
                description: 'Personalized diet plans based on recovery goals and nutrition needs.',
                type: 'DIET_PLAN',
                contentUrl: '/content/plans/custom-diet.pdf',
                category: 'Nutrition',
                requiredLevel: 3,
                requiredPoints: 150
            },
            {
                title: 'Yoga for Recovery',
                description: 'Gentle yoga sequences designed to aid physical recovery.',
                type: 'VIDEO',
                contentUrl: '/content/videos/yoga-recovery.mp4',
                category: 'Exercise',
                requiredLevel: 3,
                requiredPoints: 150
            },
            // Level 4+
            {
                title: 'Expert Wellness Program',
                description: 'A comprehensive wellness program with expert-curated routines.',
                type: 'EXERCISE_PLAN',
                contentUrl: '/content/plans/expert-wellness.pdf',
                category: 'Wellness',
                requiredLevel: 4,
                requiredPoints: 300
            },
            {
                title: 'Mindfulness Masterclass',
                description: 'Advanced mindfulness and meditation techniques for long-term wellness.',
                type: 'VIDEO',
                contentUrl: '/content/videos/mindfulness-masterclass.mp4',
                category: 'Mental Health',
                requiredLevel: 4,
                requiredPoints: 300
            }
        ];

        await prisma.healthContent.createMany({ data: defaults });
        logger.info(`[HealthContent] Seeded ${defaults.length} default content items`);
    }
}
