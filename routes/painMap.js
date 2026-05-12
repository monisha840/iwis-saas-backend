/**
 * Pain Map endpoints.
 *
 * Two surfaces, sharing a single normalisation pass:
 *
 *   1. Clinician view  — GET /api/patients/:patientId/pain-map
 *      Authorised iff: caller is ADMIN_DOCTOR, or the caller is the DOCTOR
 *      assigned to a CONFIRMED/COMPLETED appointment for this patient.
 *      All other roles → 403.
 *
 *   2. Patient self view — GET /api/patient/pain/my-map
 *      Returns the calling patient's own pain map. PATIENT-only.
 *
 * Source of truth: latest TriageSession.painRegions (taken on intake) folded
 * with the latest DailyCheckIn.painRegions (so manual updates from the daily
 * check-in flow surface here). Deduped on regionId, keeping the most recent
 * intensity reading; addedAt is the timestamp of the source row.
 */

import express from 'express';
import prisma from '../lib/prisma.js';
import { authMiddleware, resolvePatientId } from '../middleware/auth.js';

const router = express.Router();

// Build the response shape the frontend expects from a list of source rows
// (TriageSession + DailyCheckIn). Most recent timestamp wins for each regionId.
function _normalisePainMap({ triage, checkIns }) {
    const byRegion = new Map();

    function fold(sourceRows, getTime) {
        for (const row of sourceRows) {
            const ts = getTime(row);
            const regions = Array.isArray(row.painRegions) ? row.painRegions : [];
            for (const r of regions) {
                if (!r || typeof r !== 'object') continue;
                const id = r.regionId || r.region;
                if (!id) continue;
                const existing = byRegion.get(id);
                if (!existing || existing._ts < ts) {
                    byRegion.set(id, {
                        region: r.regionLabel || r.region || id,
                        intensity: typeof r.intensity === 'number' ? r.intensity : (r.severity ?? 0),
                        character: Array.isArray(r.characters) ? r.characters.join(', ') : (r.character || ''),
                        duration: r.duration || '',
                        addedAt: new Date(ts).toISOString(),
                        _ts: ts,
                    });
                }
            }
        }
    }

    if (triage) fold([triage], (t) => t.createdAt.getTime());
    fold(checkIns, (c) => c.createdAt.getTime());

    return Array.from(byRegion.values())
        .map(({ _ts, ...rest }) => rest)
        .sort((a, b) => new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime());
}

async function _loadPainMap(patientId) {
    const [triage, checkIns] = await Promise.all([
        prisma.triageSession.findFirst({
            where: { patientId, painRegions: { not: null } },
            orderBy: { createdAt: 'desc' },
            select: { painRegions: true, createdAt: true },
        }),
        prisma.dailyCheckIn.findMany({
            where: { patientId, painRegions: { not: null } },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: { painRegions: true, createdAt: true },
        }),
    ]);
    return _normalisePainMap({ triage, checkIns });
}

// ── Clinician view ─────────────────────────────────────────────────────────

/** GET /api/patients/:patientId/pain-map — consultation doctor or admin doctor only. */
router.get('/patients/:patientId/pain-map', authMiddleware, async (req, res, next) => {
    try {
        const { patientId } = req.params;

        if (req.user.role === 'ADMIN_DOCTOR') {
            const regions = await _loadPainMap(patientId);
            return res.json({ regions });
        }

        if (req.user.role !== 'DOCTOR') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // DOCTOR: must be the consultation doctor for this patient (CONFIRMED
        // or COMPLETED appointment). Resolve the caller's Doctor.id first since
        // Appointment.doctorId references Doctor, not User.
        const doctor = await prisma.doctor.findUnique({
            where: { userId: req.user.id },
            select: { id: true },
        });
        if (!doctor) return res.status(403).json({ error: 'Forbidden' });

        const appt = await prisma.appointment.findFirst({
            where: {
                patientId,
                doctorId: doctor.id,
                status: { in: ['CONFIRMED', 'COMPLETED'] },
            },
            select: { id: true },
        });
        if (!appt) {
            return res.status(403).json({ error: 'Not your patient' });
        }

        const regions = await _loadPainMap(patientId);
        res.json({ regions });
    } catch (err) { next(err); }
});

// ── Patient self view ──────────────────────────────────────────────────────

/** GET /api/patient/pain/my-map — patient's own pain map. */
router.get('/patient/pain/my-map', authMiddleware, resolvePatientId, async (req, res, next) => {
    try {
        if (req.user.role !== 'PATIENT') {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const regions = await _loadPainMap(req.user.patientId);
        res.json({ regions });
    } catch (err) { next(err); }
});

export default router;
