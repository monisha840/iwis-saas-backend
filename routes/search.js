import express from 'express';
import { SearchService } from '../services/search.service.js';
import { authMiddleware } from '../middleware/auth.js';

const router = express.Router();

/**
 * @swagger
 * /search:
 *   get:
 *     tags: [Search]
 *     summary: Global search across patients, appointments, and prescriptions
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Search query string
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Search results grouped by entity type }
 */
router.get('/', authMiddleware, async (req, res, next) => {
    try {
        const { q, limit } = req.query;
        const results = await SearchService.globalSearch(q, {
            userId: req.user.id,
            userRole: req.user.role,
            limit: limit ? parseInt(limit, 10) : 20,
        });
        res.json(results);
    } catch (err) {
        next(err);
    }
});

/**
 * @swagger
 * /search/patients:
 *   get:
 *     tags: [Search]
 *     summary: Search patients by name, email, or phone
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Patient search query
 *       - in: query
 *         name: branchId
 *         schema: { type: string }
 *         description: Filter by branch
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: List of matching patients }
 */
router.get('/patients', authMiddleware, async (req, res, next) => {
    try {
        const { q, branchId, limit } = req.query;
        const patients = await SearchService.searchPatients(q, {
            branchId: branchId || null,
            limit: limit ? parseInt(limit, 10) : 20,
        });
        res.json(patients);
    } catch (err) {
        next(err);
    }
});

export default router;
