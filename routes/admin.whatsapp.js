/**
 * Admin routes for per-hospital WhatsApp config (Phase 2a-T4).
 *
 * Mounted at /api/admin/whatsapp. Restricted to SUPER_ADMIN / ADMIN_DOCTOR and
 * scoped to the caller's hospital (req.user.hospitalId). The apiKey is never
 * returned in GET responses — only whether one is set.
 */
import express from 'express';
import { z } from 'zod';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import prisma from '../lib/prisma.js';
import { WhatsAppService } from '../services/whatsapp.service.js';
import logger from '../lib/logger.js';

const router = express.Router();

router.use(authMiddleware, roleMiddleware(['SUPER_ADMIN', 'ADMIN_DOCTOR']));

// Every route needs a hospital context. SUPER_ADMIN has no hospitalId of their
// own, so they must act within a hospital (out of scope here) → 400.
function requireHospital(req, res) {
  const hospitalId = req.user.hospitalId;
  if (!hospitalId) {
    res.status(400).json({ error: { code: 'NO_HOSPITAL', message: 'No hospital context on this account.' } });
    return null;
  }
  return hospitalId;
}

const mask = (cfg) => cfg && ({
  hospitalId: cfg.hospitalId,
  instanceName: cfg.instanceName,
  apiUrl: cfg.apiUrl,
  apiKeySet: Boolean(cfg.apiKey),
  status: cfg.status,
  connectedAt: cfg.connectedAt,
  updatedAt: cfg.updatedAt,
});

// GET /api/admin/whatsapp/config — current hospital's config (apiKey masked).
router.get('/config', async (req, res, next) => {
  try {
    const hospitalId = requireHospital(req, res); if (!hospitalId) return;
    const cfg = await prisma.hospitalWhatsappConfig.findUnique({ where: { hospitalId } });
    res.json({ config: mask(cfg) });
  } catch (err) { next(err); }
});

// GET /api/admin/whatsapp/status — connection status (NOT_CONFIGURED if none).
router.get('/status', async (req, res, next) => {
  try {
    const hospitalId = requireHospital(req, res); if (!hospitalId) return;
    const cfg = await prisma.hospitalWhatsappConfig.findUnique({ where: { hospitalId }, select: { status: true, connectedAt: true } });
    res.json({ status: cfg?.status ?? 'NOT_CONFIGURED', connectedAt: cfg?.connectedAt ?? null });
  } catch (err) { next(err); }
});

const configSchema = z.object({
  instanceName: z.string().min(1),
  apiUrl: z.string().url(),
  apiKey: z.string().min(1),
  status: z.enum(['CONNECTED', 'DISCONNECTED', 'ERROR']).optional(),
});

// PUT /api/admin/whatsapp/config — create or update this hospital's config.
router.put('/config', async (req, res, next) => {
  try {
    const hospitalId = requireHospital(req, res); if (!hospitalId) return;
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid config', details: parsed.error.issues } });
    }
    const { instanceName, apiUrl, apiKey, status } = parsed.data;
    const cfg = await prisma.hospitalWhatsappConfig.upsert({
      where: { hospitalId },
      create: { hospitalId, instanceName, apiUrl, apiKey, status: status ?? 'DISCONNECTED' },
      update: { instanceName, apiUrl, apiKey, ...(status && { status }) },
    });
    logger.info('[admin.whatsapp] config upserted', { hospitalId });
    res.json({ config: mask(cfg) });
  } catch (err) { next(err); }
});

const testSchema = z.object({
  number: z.string().min(8),
  text: z.string().min(1).optional(),
});

// POST /api/admin/whatsapp/test — send a test message using this hospital's config.
router.post('/test', async (req, res, next) => {
  try {
    const hospitalId = requireHospital(req, res); if (!hospitalId) return;
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: { code: 'VALIDATION', message: 'number is required' } });
    }
    const text = parsed.data.text || 'IWIS WhatsApp test message ✅';
    const result = await WhatsAppService.sendText(parsed.data.number, text, hospitalId);
    res.json({ result });
  } catch (err) { next(err); }
});

export default router;
