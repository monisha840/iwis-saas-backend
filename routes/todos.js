/**
 * Todo routes (IWIS_Dashboard_Refactor_Spec.md §9.1).
 *
 * Mounted at /api/todos.
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { TodoController } from '../controllers/todo.controller.js';

const router = express.Router();

router.use(authMiddleware);
// PATIENT is out of scope — todos are a staff/clinician feature.
router.use(roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST', 'PHARMACIST']));

// Inbox (todos assigned to me)
router.get('/', TodoController.list);
router.get('/summary', TodoController.summary);

// Management: todos I've assigned to others
router.get('/assigned-by-me', TodoController.listAssignedByMe);

// Create self-assigned
router.post('/', TodoController.createSelf);

// Assign to another user (ADMIN / ADMIN_DOCTOR enforced inside service)
router.post('/assign', TodoController.assign);

// Mutate
router.patch('/:id', TodoController.edit);
router.patch('/:id/status', TodoController.setStatus);
router.delete('/:id', TodoController.revoke);
router.post('/:id/remind', TodoController.remind);

export default router;
