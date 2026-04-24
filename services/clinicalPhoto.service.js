import prisma from '../lib/prisma.js';

/**
 * Clinical Photo (IWIS competitor feature 3)
 * Stage-tagged patient photos (BEFORE/DURING/AFTER) with category + body region,
 * enabling before/after comparison UI and dataset accumulation for future multimodal AI.
 */
export class ClinicalPhotoService {
    static async create(data) {
        return prisma.clinicalPhoto.create({ data });
    }

    static async list({ patientId, journeyId, category, stage }) {
        return prisma.clinicalPhoto.findMany({
            where: {
                ...(patientId ? { patientId } : {}),
                ...(journeyId ? { journeyId } : {}),
                ...(category ? { category } : {}),
                ...(stage ? { stage } : {}),
            },
            orderBy: { takenAt: 'desc' },
        });
    }

    /**
     * Pair up BEFORE/AFTER photos for comparison UI. Groups by category + bodyRegion
     * so "left knee — wound healing" BEFORE is paired with its corresponding AFTER.
     */
    static async getComparison({ patientId, category }) {
        const photos = await prisma.clinicalPhoto.findMany({
            where: {
                patientId,
                ...(category ? { category } : {}),
                stage: { in: ['BEFORE', 'AFTER'] },
            },
            orderBy: { takenAt: 'asc' },
        });

        const groups = new Map();
        for (const p of photos) {
            const key = `${p.category}::${p.bodyRegion || 'unspecified'}`;
            if (!groups.has(key)) groups.set(key, { category: p.category, bodyRegion: p.bodyRegion, before: null, after: null });
            const g = groups.get(key);
            if (p.stage === 'BEFORE' && !g.before) g.before = p;
            if (p.stage === 'AFTER') g.after = p; // Latest AFTER wins
        }
        return [...groups.values()];
    }

    static async delete(id) {
        return prisma.clinicalPhoto.delete({ where: { id } });
    }
}
