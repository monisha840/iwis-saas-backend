/**
 * /api/message-templates — hospital-scoped CRUD + preview for reusable templates.
 *
 * Feature-gated on MESSAGING_TEMPLATES (seeded isCore=true so every non-decommissioned
 * hospital has it on by default).
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { MessageTemplateController } from '../controllers/messageTemplate.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.use(requireFeature('MESSAGING_TEMPLATES'));

// ── Metadata (any authenticated staff) ─────────────────────────────────────
router.get('/placeholders', MessageTemplateController.placeholders);

// ── Preview (any authenticated staff) ──────────────────────────────────────
router.post('/preview', MessageTemplateController.preview);

// ── List / fetch (any authenticated staff who might send messages) ─────────
router.get('/',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']),
    MessageTemplateController.list);

router.get('/:id',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR', 'THERAPIST']),
    MessageTemplateController.getById);

// ── Create / update (RBAC enforced in service: doctors only edit their own) ─
router.post('/',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    MessageTemplateController.create);

router.put('/:id',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    MessageTemplateController.update);

// ── Delete (admins only) ────────────────────────────────────────────────────
router.delete('/:id',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    MessageTemplateController.remove);

export default router;
