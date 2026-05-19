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
        const photos = await prisma.clinicalPhoto.findMany({
            where: {
                ...(patientId ? { patientId } : {}),
                ...(journeyId ? { journeyId } : {}),
                ...(category ? { category } : {}),
                ...(stage ? { stage } : {}),
            },
            orderBy: { takenAt: 'desc' },
        });

        // Patient-uploaded images currently land in the Document table (via
        // the triage media upload route at /api/triage/:sessionId/media).
        // The Clinical Photos page expects ClinicalPhoto rows, so triage
        // photos were invisible there. Merge them in — normalised to the
        // ClinicalPhoto shape — so the patient sees their own uploads.
        //
        // Scope: requires a patientId (we never want to leak triage media
        // across patients), and we narrow further by category + stage when
        // the caller asked for a strict subset (e.g. BEFORE/AFTER) since
        // triage media is always DURING / GENERAL_PROGRESS.
        if (patientId) {
            const wantsDuring = !stage || stage === 'DURING';
            const wantsGeneral = !category || category === 'GENERAL_PROGRESS';
            if (wantsDuring && wantsGeneral) {
                const triageDocs = await prisma.document.findMany({
                    where: {
                        patientId,
                        category: 'TRIAGE_MEDIA',
                        fileType: { startsWith: 'image/' },
                        ...(journeyId ? { /* no journey link on Document — skip */ } : {}),
                    },
                    orderBy: { createdAt: 'desc' },
                });
                // Drop journey-scoped queries (Document has no journeyId) so
                // the doctor's journey-filtered view stays clean.
                if (!journeyId) {
                    for (const d of triageDocs) {
                        photos.push({
                            id:             d.id,
                            patientId:      d.patientId,
                            uploadedById:   d.uploadedBy,
                            journeyId:      null,
                            phaseId:        null,
                            therapySessionId: null,
                            category:       'GENERAL_PROGRESS',
                            stage:          'DURING',
                            bodyRegion:     null,
                            notes:          d.description || null,
                            filePath:       d.fileUrl,
                            takenAt:        d.createdAt,
                            createdAt:      d.createdAt,
                        });
                    }
                }
            }
        }

        // Re-sort the merged list newest-first.
        photos.sort((a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime());
        return photos;
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
