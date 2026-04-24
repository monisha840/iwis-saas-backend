/**
 * /api/super-admin — platform-level routes (spec §4).
 * All routes require authMiddleware + requireSuperAdmin.
 * No route in this file returns patient-level PII.
 */
import express from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { requireSuperAdmin } from '../middleware/requireSuperAdmin.js';
import { SuperAdminHospitalService } from '../services/superAdmin.hospital.service.js';
import { SuperAdminFeatureService } from '../services/superAdmin.feature.service.js';
import { SuperAdminAnalyticsService } from '../services/superAdmin.analytics.service.js';
import { SuperAdminAuditService } from '../services/superAdmin.audit.service.js';
import { SuperAdminTriageService } from '../services/superAdmin.triage.service.js';
import { runFeatureRegistrySync } from '../services/featureRegistrySync.service.js';
import logger from '../lib/logger.js';

const router = express.Router();
router.use(authMiddleware, requireSuperAdmin);

// ── Hospital management (§4.1) ──────────────────────────────────────────────

router.get('/hospitals', async (req, res, next) => {
  try {
    const hospitals = await SuperAdminHospitalService.list();
    res.json({ data: hospitals });
  } catch (err) { next(err); }
});

router.post('/hospitals', async (req, res, next) => {
  try {
    const result = await SuperAdminHospitalService.create({
      actorId: req.user.id,
      ip: req.ip,
      ...req.body,
    });
    res.status(201).json(result);
  } catch (err) { next(err); }
});

router.get('/hospitals/:id', async (req, res, next) => {
  try {
    const hospital = await SuperAdminHospitalService.getById(req.params.id);
    res.json({ data: hospital });
  } catch (err) { next(err); }
});

router.patch('/hospitals/:id', async (req, res, next) => {
  try {
    const updated = await SuperAdminHospitalService.update({
      actorId: req.user.id,
      ip: req.ip,
      id: req.params.id,
      patch: req.body,
    });
    res.json({ data: updated });
  } catch (err) { next(err); }
});

router.post('/hospitals/:id/suspend', async (req, res, next) => {
  try {
    const updated = await SuperAdminHospitalService.suspend({
      actorId: req.user.id,
      ip: req.ip,
      id: req.params.id,
      reason: req.body?.reason,
    });
    res.json({ data: updated });
  } catch (err) { next(err); }
});

router.post('/hospitals/:id/reactivate', async (req, res, next) => {
  try {
    const updated = await SuperAdminHospitalService.reactivate({
      actorId: req.user.id,
      ip: req.ip,
      id: req.params.id,
    });
    res.json({ data: updated });
  } catch (err) { next(err); }
});

router.delete('/hospitals/:id', async (req, res, next) => {
  try {
    const updated = await SuperAdminHospitalService.decommission({
      actorId: req.user.id,
      ip: req.ip,
      id: req.params.id,
    });
    res.json({ data: updated });
  } catch (err) { next(err); }
});

// ── Feature flag management (§4.2) ──────────────────────────────────────────

router.get('/hospitals/:id/features', async (req, res, next) => {
  try {
    const features = await SuperAdminFeatureService.getHospitalFeatures(req.params.id);
    res.json({ data: features });
  } catch (err) { next(err); }
});

router.put('/hospitals/:id/features/:key', async (req, res, next) => {
  try {
    const flag = await SuperAdminFeatureService.setHospitalFeature({
      actorId: req.user.id,
      ip: req.ip,
      hospitalId: req.params.id,
      featureKey: req.params.key,
      enabled: Boolean(req.body?.enabled),
      notes: req.body?.notes,
    });
    res.json({ data: flag });
  } catch (err) { next(err); }
});

router.post('/hospitals/:id/features/bulk', async (req, res, next) => {
  try {
    const results = await SuperAdminFeatureService.bulkSet({
      actorId: req.user.id,
      ip: req.ip,
      hospitalId: req.params.id,
      changes: Array.isArray(req.body?.changes) ? req.body.changes : [],
    });
    res.json({ data: results });
  } catch (err) { next(err); }
});

// ── Feature registry management (§4.3) ──────────────────────────────────────

router.get('/feature-registry', async (req, res, next) => {
  try {
    const items = await SuperAdminFeatureService.listRegistry();
    res.json({ data: items });
  } catch (err) { next(err); }
});

router.patch('/feature-registry/:key', async (req, res, next) => {
  try {
    const updated = await SuperAdminFeatureService.updateRegistryMeta({
      actorId: req.user.id,
      ip: req.ip,
      key: req.params.key,
      patch: req.body || {},
    });
    res.json({ data: updated });
  } catch (err) { next(err); }
});

// Global toggle — enable/disable this feature across every non-decommissioned hospital.
router.post('/feature-registry/:key/toggle-all', async (req, res, next) => {
  try {
    const result = await SuperAdminFeatureService.toggleForAllHospitals({
      actorId: req.user.id,
      ip: req.ip,
      featureKey: req.params.key,
      enabled: Boolean(req.body?.enabled),
    });
    res.json({ data: result });
  } catch (err) { next(err); }
});

router.post('/feature-registry/sync', async (req, res, next) => {
  try {
    const result = await runFeatureRegistrySync();
    await SuperAdminAuditService.log({
      superAdminId: req.user.id,
      action: 'FEATURE_REGISTRY_SYNC_TRIGGERED',
      details: result,
      ipAddress: req.ip,
    });
    res.json({ data: result });
  } catch (err) {
    logger.error('Feature registry sync failed', { err: err.message });
    next(err);
  }
});

// ── Platform analytics (§4.4) ───────────────────────────────────────────────

router.get('/analytics', async (req, res, next) => {
  try {
    const overview = await SuperAdminAnalyticsService.platformOverview();
    res.json({ data: overview });
  } catch (err) { next(err); }
});

router.get('/analytics/hospitals/:id', async (req, res, next) => {
  try {
    const usage = await SuperAdminAnalyticsService.hospitalUsage(req.params.id);
    res.json({ data: usage });
  } catch (err) { next(err); }
});

// ── Triage oversight (platform-wide) ────────────────────────────────────────

router.get('/triage/overview', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
    const overview = await SuperAdminTriageService.platformOverview({ days });
    res.json({ data: overview });
  } catch (err) { next(err); }
});

router.get('/triage/specialty-routes', async (req, res, next) => {
  try {
    const routes = await SuperAdminTriageService.listSpecialtyRoutes();
    res.json({ data: routes });
  } catch (err) { next(err); }
});

router.put('/triage/specialty-routes', async (req, res, next) => {
  try {
    const row = await SuperAdminTriageService.upsertSpecialtyRoute({
      actorId: req.user.id,
      ip: req.ip,
      specialty: req.body?.specialty,
      tags: req.body?.tags ?? [],
      priority: req.body?.priority,
      isActive: req.body?.isActive,
    });
    res.json({ data: row });
  } catch (err) { next(err); }
});

router.delete('/triage/specialty-routes/:id', async (req, res, next) => {
  try {
    const result = await SuperAdminTriageService.deleteSpecialtyRoute({
      actorId: req.user.id,
      ip: req.ip,
      id: req.params.id,
    });
    res.json({ data: result });
  } catch (err) { next(err); }
});

// ── Audit log ───────────────────────────────────────────────────────────────

router.get('/audit', async (req, res, next) => {
  try {
    const page = await SuperAdminAuditService.list({
      action: req.query.action,
      hospitalId: req.query.hospitalId,
      from: req.query.from,
      to: req.query.to,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.json(page);
  } catch (err) { next(err); }
});

export default router;
