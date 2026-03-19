import express from 'express';
import { BranchService } from '../services/branch.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { z } from 'zod';
import logger from '../lib/logger.js';

const router = express.Router();

// Coerce empty strings to undefined so optional validators don't fail on blank fields.
const emptyToUndefined = (val) => (val === '' || val === null ? undefined : val);

const branchSchema = z.object({
    name:     z.string().min(2, 'Branch name must be at least 2 characters'),
    address:  z.preprocess(emptyToUndefined, z.string().optional()),
    phone:    z.preprocess(emptyToUndefined, z.string().optional()),
    email:    z.preprocess(emptyToUndefined, z.string().email('Invalid email address').optional()),
    isActive: z.boolean().optional()
});

router.use(authenticateToken);

// Admin Doctor only for management
router.post('/', authorizeRoles('ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = branchSchema.parse(req.body);
        const branch = await BranchService.createBranch(req.user.id, data);
        res.status(201).json(branch);
    } catch (err) {
        // Log validation failures with the submitted payload so admins can diagnose field issues
        if (err.name === 'ZodError') {
            logger.warn('[branch.POST] Validation failed', {
                issues: err.errors,
                body: req.body,
                userId: req.user?.id,
            });
        }
        next(err);
    }
});

router.get('/', async (req, res, next) => {
    try {
        // All staff can list branches for selection/view
        const branches = await BranchService.getBranches();
        res.json(branches);
    } catch (err) {
        next(err);
    }
});

router.put('/:id', authorizeRoles('ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = branchSchema.partial().parse(req.body);
        const branch = await BranchService.updateBranch(req.user.id, req.params.id, data);
        res.json(branch);
    } catch (err) {
        next(err);
    }
});

router.delete('/:id', authorizeRoles('ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        await BranchService.deleteBranch(req.user.id, req.params.id);
        res.json({ message: 'Branch deleted successfully' });
    } catch (err) {
        next(err);
    }
});

export default router;
