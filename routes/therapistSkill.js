import express from 'express';
import { z } from 'zod';
import { TherapistSkillService } from '../services/therapistSkill.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';

const router = express.Router();
router.use(authenticateToken);
router.use(requireFeature('THERAPIST_SKILL_MATCHING'));

const AYUR_SKILLS = ['ABHYANGA','SHIRODHARA','PANCHAKARMA_GENERAL','BASTI','VIRECHANA','NASYA','KIZHI','NJAVARA','PIZHICHIL','MARMA_THERAPY','YOGA_THERAPY','NATUROPATHY'];

const skillSchema = z.object({
    skill:       z.enum(AYUR_SKILLS),
    proficiency: z.enum(['CERTIFIED','EXPERIENCED','LEARNING']),
    certifiedAt: z.coerce.date().optional(),
    notes:       z.string().optional(),
});

router.get('/match', async (req, res, next) => {
    try {
        const skills = Array.isArray(req.query.skills)
            ? req.query.skills
            : (req.query.skills ? String(req.query.skills).split(',').filter(Boolean) : []);
        const branchId = req.query.branchId || undefined;
        const top = Math.min(Number(req.query.top || 5), 20);
        res.json(await TherapistSkillService.matchTherapists({ skills, branchId, top }));
    } catch (err) { next(err); }
});

router.get('/coverage', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        res.json(await TherapistSkillService.getBranchCoverage());
    } catch (err) { next(err); }
});

router.get('/:therapistId/skills', async (req, res, next) => {
    try {
        res.json(await TherapistSkillService.listSkills(req.params.therapistId));
    } catch (err) { next(err); }
});

router.post('/:therapistId/skills', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = skillSchema.parse(req.body);
        const out = await TherapistSkillService.upsertSkill(req.params.therapistId, data);
        res.status(201).json(out);
    } catch (err) { next(err); }
});

router.delete('/:therapistId/skills/:skill', authorizeRoles('ADMIN', 'ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        await TherapistSkillService.deleteSkill(req.params.therapistId, req.params.skill);
        res.json({ success: true });
    } catch (err) { next(err); }
});

export default router;
