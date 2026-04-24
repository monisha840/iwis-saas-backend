/**
 * /api/reminder-settings — per-hospital daily check-in broadcast config.
 *
 * Admin & admin-doctor write the setting. Read is available to those two plus
 * DOCTOR so they can see what time the broadcast fires.
 */

import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { ReminderSettingController } from '../controllers/reminderSetting.controller.js';

const router = express.Router();

router.use(authMiddleware);
router.use(requireFeature('MESSAGING_TEMPLATES'));

router.get('/',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR', 'DOCTOR']),
    ReminderSettingController.get);

router.put('/',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    ReminderSettingController.update);

router.post('/trigger-now',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    ReminderSettingController.triggerNow);

router.get('/deliveries',
    roleMiddleware(['ADMIN', 'ADMIN_DOCTOR']),
    ReminderSettingController.deliveries);

export default router;
