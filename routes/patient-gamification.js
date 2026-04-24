import express from 'express';
import { authMiddleware, roleMiddleware, resolvePatientId } from '../middleware/auth.js';
import { requireFeature } from '../utils/featureGate.js';
import { PatientGamificationController } from '../controllers/patientGamification.controller.js';

const router = express.Router();

// All routes require PATIENT role
const patientAuth = [authMiddleware, roleMiddleware(['PATIENT']), resolvePatientId];

// Path-prefix feature gates (one per sub-area). Auth must run first because the gate
// reads req.user.hospitalId.
router.use('/quests',         authMiddleware, requireFeature('HEALTH_QUESTS'));
router.use('/avatar',         authMiddleware, requireFeature('HEALTH_AVATAR'));
router.use('/family',         authMiddleware, requireFeature('FAMILY_LEADERBOARD'));
router.use('/referral-stats', authMiddleware, requireFeature('REFERRAL_TIERS'));
router.use('/social-proof',   authMiddleware, requireFeature('SOCIAL_PROOF'));
router.use('/streaks',        authMiddleware, requireFeature('SOCIAL_PROOF'));
router.use('/content',        authMiddleware, requireFeature('UNLOCKABLE_CONTENT'));

// ── Health Quests ───────────────────────────────────────────────────────────

/** GET /api/patient-gamification/quests — available quests */
router.get('/quests', ...patientAuth, PatientGamificationController.getAvailableQuests);

/** GET /api/patient-gamification/quests/mine — my quests (optional ?status=ACTIVE|COMPLETED|EXPIRED) */
router.get('/quests/mine', ...patientAuth, PatientGamificationController.getMyQuests);

/** POST /api/patient-gamification/quests/:questId/start — start a quest */
router.post('/quests/:questId/start', ...patientAuth, PatientGamificationController.startQuest);

/** POST /api/patient-gamification/quests/:questId/tasks/:taskIndex — record task progress */
router.post('/quests/:questId/tasks/:taskIndex', ...patientAuth, PatientGamificationController.recordTaskProgress);

// ── Health Avatar ───────────────────────────────────────────────────────────

/** GET /api/patient-gamification/avatar — get or create avatar */
router.get('/avatar', ...patientAuth, PatientGamificationController.getAvatar);

/** POST /api/patient-gamification/avatar/feed — feed avatar { activityType } */
router.post('/avatar/feed', ...patientAuth, PatientGamificationController.feedAvatar);

// ── Family Leaderboard ──────────────────────────────────────────────────────

/** POST /api/patient-gamification/family — create family { name } */
router.post('/family', ...patientAuth, PatientGamificationController.createFamily);

/** POST /api/patient-gamification/family/join — join family { inviteCode } */
router.post('/family/join', ...patientAuth, PatientGamificationController.joinFamily);

/** GET /api/patient-gamification/family — my families */
router.get('/family', ...patientAuth, PatientGamificationController.getMyFamilies);

/** GET /api/patient-gamification/family/rankings — global family rankings */
router.get('/family/rankings', ...patientAuth, PatientGamificationController.getGlobalFamilyRankings);

/** GET /api/patient-gamification/family/:familyId/leaderboard — family leaderboard */
router.get('/family/:familyId/leaderboard', ...patientAuth, PatientGamificationController.getFamilyLeaderboard);

/** DELETE /api/patient-gamification/family/:familyId/leave — leave family */
router.delete('/family/:familyId/leave', ...patientAuth, PatientGamificationController.leaveFamily);

// ── Referral Gamification ───────────────────────────────────────────────────

/** GET /api/patient-gamification/referral-stats — referral tier stats */
router.get('/referral-stats', ...patientAuth, PatientGamificationController.getReferralStats);

// ── Social Proof & Streaks ──────────────────────────────────────────────────

/** GET /api/patient-gamification/social-proof/enhanced — enhanced social proof with percentile */
router.get('/social-proof/enhanced', ...patientAuth, PatientGamificationController.getEnhancedSocialProof);

/** GET /api/patient-gamification/streaks/milestones — upcoming streak milestones */
router.get('/streaks/milestones', ...patientAuth, PatientGamificationController.getStreakMilestones);

// ── Health Content ──────────────────────────────────────────────────────────

/** GET /api/patient-gamification/content — content library with lock status */
router.get('/content', ...patientAuth, PatientGamificationController.getContentLibrary);

/** GET /api/patient-gamification/content/unlocked — my unlocked content */
router.get('/content/unlocked', ...patientAuth, PatientGamificationController.getUnlockedContent);

/** POST /api/patient-gamification/content/:contentId/unlock — unlock content */
router.post('/content/:contentId/unlock', ...patientAuth, PatientGamificationController.unlockContent);

export default router;
