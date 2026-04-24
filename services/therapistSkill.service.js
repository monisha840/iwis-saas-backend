import prisma from '../lib/prisma.js';

/**
 * Therapist-to-Patient Skill Matching (IWIS competitor feature 4)
 * Ranked suggestion is `proficiency` first, then therapist load; availability check
 * is a light-weight "has a recent appointment on the day" heuristic left to caller.
 */
const PROFICIENCY_WEIGHT = { CERTIFIED: 3, EXPERIENCED: 2, LEARNING: 1 };

export class TherapistSkillService {
    static async listSkills(therapistId) {
        return prisma.therapistSkill.findMany({
            where: { therapistId },
            orderBy: [{ proficiency: 'asc' }, { skill: 'asc' }],
        });
    }

    static async upsertSkill(therapistId, { skill, proficiency, certifiedAt, notes }) {
        return prisma.therapistSkill.upsert({
            where: { therapistId_skill: { therapistId, skill } },
            update: { proficiency, certifiedAt: certifiedAt ? new Date(certifiedAt) : null, notes },
            create: { therapistId, skill, proficiency, certifiedAt: certifiedAt ? new Date(certifiedAt) : null, notes },
        });
    }

    static async deleteSkill(therapistId, skill) {
        return prisma.therapistSkill.delete({
            where: { therapistId_skill: { therapistId, skill } },
        });
    }

    /**
     * Match & rank therapists by required skill set and branch.
     * Returns top N with a per-skill match breakdown so admin UI can highlight coverage.
     */
    static async matchTherapists({ skills = [], branchId, top = 5 }) {
        if (!skills.length) return [];
        const therapists = await prisma.therapist.findMany({
            where: branchId ? { user: { branchId } } : {},
            include: {
                therapistSkills: { where: { skill: { in: skills } } },
                _count: { select: { appointments: true } },
                user: { select: { branchId: true } },
            },
        });

        const ranked = therapists
            .map((t) => {
                const matched = t.therapistSkills;
                const score = matched.reduce((s, ts) => s + (PROFICIENCY_WEIGHT[ts.proficiency] || 0), 0);
                const coverage = matched.length / skills.length;
                return {
                    therapist: { id: t.id, fullName: t.fullName, specialization: t.specialization, qualification: t.qualification },
                    matchedSkills: matched.map((s) => ({ skill: s.skill, proficiency: s.proficiency })),
                    missingSkills: skills.filter((s) => !matched.some((m) => m.skill === s)),
                    coverage,
                    score,
                    activePatientLoad: t._count.appointments,
                };
            })
            .filter((r) => r.matchedSkills.length > 0)
            .sort((a, b) => (b.score - a.score) || (a.activePatientLoad - b.activePatientLoad))
            .slice(0, top);

        return ranked;
    }

    /**
     * Skill-coverage heatmap per branch. Returns a matrix of
     * [{ skill, byBranch: { [branchId]: { certified, experienced, learning, total } } }].
     */
    static async getBranchCoverage() {
        const skills = await prisma.therapistSkill.findMany({
            include: { therapist: { include: { user: { select: { branchId: true } } } } },
        });
        const map = new Map();
        for (const s of skills) {
            const branchId = s.therapist.user?.branchId || 'unassigned';
            if (!map.has(s.skill)) map.set(s.skill, {});
            const row = map.get(s.skill);
            if (!row[branchId]) row[branchId] = { CERTIFIED: 0, EXPERIENCED: 0, LEARNING: 0, total: 0 };
            row[branchId][s.proficiency] += 1;
            row[branchId].total += 1;
        }
        return [...map.entries()].map(([skill, byBranch]) => ({ skill, byBranch }));
    }
}
