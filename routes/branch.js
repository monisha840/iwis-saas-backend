import express from 'express';
import { BranchService } from '../services/branch.service.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { z } from 'zod';
import logger from '../lib/logger.js';

const router = express.Router();

// Coerce empty strings to undefined so optional validators don't fail on blank fields.
const emptyToUndefined = (val) => (val === '' || val === null ? undefined : val);

const branchBaseSchema = z.object({
    name:     z.string().min(2, 'Branch name must be at least 2 characters'),
    address:  z.preprocess(emptyToUndefined, z.string().optional()),
    phone:    z.preprocess(emptyToUndefined, z.string().optional()),
    email:    z.preprocess(emptyToUndefined, z.string().email('Invalid email address').optional()),
    isActive: z.boolean().optional(),
    // Capacity & Operations (IWIS competitor feature 0)
    totalBeds:          z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().optional()),
    availableBeds:      z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().optional()),
    totalRooms:         z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().optional()),
    totalTherapyRooms:  z.preprocess(emptyToUndefined, z.coerce.number().int().nonnegative().optional()),
    ipdEnabled:         z.boolean().optional(),
    opdEnabled:         z.boolean().optional(),
    operatingHoursFrom: z.preprocess(emptyToUndefined, z.string().optional()),
    operatingHoursTo:   z.preprocess(emptyToUndefined, z.string().optional()),
});

const capacityCheck = (d) => {
    if (d.availableBeds != null && d.totalBeds != null && d.availableBeds > d.totalBeds) {
        const e = new Error('availableBeds cannot exceed totalBeds'); e.status = 400; throw e;
    }
    if (d.totalTherapyRooms != null && d.totalRooms != null && d.totalTherapyRooms > d.totalRooms) {
        const e = new Error('totalTherapyRooms cannot exceed totalRooms'); e.status = 400; throw e;
    }
};

const branchSchema = branchBaseSchema;

router.use(authenticateToken);

// Admin Doctor only for management
router.post('/', authorizeRoles('ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = branchSchema.parse(req.body);
        capacityCheck(data);
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

router.get('/:id', async (req, res, next) => {
    try {
        const branch = await BranchService.getBranchById(req.params.id);
        if (!branch) return res.status(404).json({ error: 'Branch not found' });
        res.json(branch);
    } catch (err) { next(err); }
});

router.get('/:id/capacity', requireFeature('BRANCH_CAPACITY'), async (req, res, next) => {
    try {
        const summary = await BranchService.getCapacity(req.params.id);
        res.json(summary);
    } catch (err) { next(err); }
});

router.put('/:id', authorizeRoles('ADMIN_DOCTOR'), async (req, res, next) => {
    try {
        const data = branchSchema.partial().parse(req.body);
        capacityCheck(data);
        const branch = await BranchService.updateBranch(req.user.id, req.params.id, data);
        res.json(branch);
    } catch (err) {
        next(err);
    }
});

router.patch('/:id', authorizeRoles('ADMIN_DOCTOR', 'ADMIN'), async (req, res, next) => {
    try {
        const data = branchSchema.partial().parse(req.body);
        capacityCheck(data);
        const branch = await BranchService.updateBranch(req.user.id, req.params.id, data);
        res.json(branch);
    } catch (err) { next(err); }
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
