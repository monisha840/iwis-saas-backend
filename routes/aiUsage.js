/**
 * AI usage reporting routes (Phase 2c-T5).
 *
 *   GET /api/admin/ai-usage/current-month      (SUPER_ADMIN, ADMIN_DOCTOR) — this hospital
 *   GET /api/admin/ai-usage/history?months=6   (SUPER_ADMIN, ADMIN_DOCTOR) — this hospital
 *   GET /api/super-admin/ai-usage/all          (SUPER_ADMIN) — every hospital
 *
 * Admin routes are scoped to req.user.hospitalId. Reads use the base client with
 * an explicit hospitalId filter (deterministic; the super-admin view is unscoped
 * by design). Empty periods return zeros, never an error.
 */
import express from 'express';
import { authMiddleware, roleMiddleware } from '../middleware/auth.js';
import { prismaBase } from '../lib/prisma.js';

const round = (n) => Math.round((n || 0) * 1e6) / 1e6;
const currentMonth = () => new Date().toISOString().slice(0, 7);
function lastNMonths(n) {
  // Use UTC so the keys match monthKey() in aiMetering.service.js (also UTC).
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}
function summarise(rows) {
  return {
    totalCalls: rows.reduce((s, r) => s + r.totalCalls, 0),
    totalCost: round(rows.reduce((s, r) => s + r.totalCost, 0)),
    byFeature: rows.map((r) => ({ feature: r.feature, totalCalls: r.totalCalls, totalCost: round(r.totalCost) })),
  };
}

// ── Admin (current hospital) ─────────────────────────────────────────────────
export const adminAiUsageRouter = express.Router();
adminAiUsageRouter.use(authMiddleware, roleMiddleware(['SUPER_ADMIN', 'ADMIN_DOCTOR']));

function hospitalOf(req, res) {
  const hospitalId = req.user.hospitalId;
  if (!hospitalId) { res.status(400).json({ error: { code: 'NO_HOSPITAL', message: 'No hospital context on this account.' } }); return null; }
  return hospitalId;
}

adminAiUsageRouter.get('/current-month', async (req, res, next) => {
  try {
    const hospitalId = hospitalOf(req, res); if (!hospitalId) return;
    const month = currentMonth();
    const rows = await prismaBase.aiUsageMonthly.findMany({ where: { hospitalId, month }, orderBy: { feature: 'asc' } });
    res.json({ month, ...summarise(rows) });
  } catch (err) { next(err); }
});

adminAiUsageRouter.get('/history', async (req, res, next) => {
  try {
    const hospitalId = hospitalOf(req, res); if (!hospitalId) return;
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 36);
    const monthList = lastNMonths(months);
    const rows = await prismaBase.aiUsageMonthly.findMany({ where: { hospitalId, month: { in: monthList } }, orderBy: [{ month: 'desc' }, { feature: 'asc' }] });
    const byMonth = monthList.map((m) => ({ month: m, ...summarise(rows.filter((r) => r.month === m)) }));
    res.json({ months: monthList, usage: byMonth });
  } catch (err) { next(err); }
});

// ── Super-admin (all hospitals) ──────────────────────────────────────────────
export const superAdminAiUsageRouter = express.Router();
superAdminAiUsageRouter.use(authMiddleware, roleMiddleware(['SUPER_ADMIN']));

superAdminAiUsageRouter.get('/all', async (req, res, next) => {
  try {
    const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month)) ? req.query.month : currentMonth();
    const rows = await prismaBase.aiUsageMonthly.findMany({
      where: { month },
      include: { hospital: { select: { id: true, name: true } } },
      orderBy: { totalCost: 'desc' },
    });
    const byHospital = new Map();
    for (const r of rows) {
      const key = r.hospitalId;
      if (!byHospital.has(key)) byHospital.set(key, { hospitalId: key, hospitalName: r.hospital?.name ?? null, totalCalls: 0, totalCost: 0, byFeature: [] });
      const h = byHospital.get(key);
      h.totalCalls += r.totalCalls;
      h.totalCost = round(h.totalCost + r.totalCost);
      h.byFeature.push({ feature: r.feature, totalCalls: r.totalCalls, totalCost: round(r.totalCost) });
    }
    const hospitals = [...byHospital.values()];
    res.json({ month, grandTotalCost: round(hospitals.reduce((s, h) => s + h.totalCost, 0)), hospitals });
  } catch (err) { next(err); }
});
