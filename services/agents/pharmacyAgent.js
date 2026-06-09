/**
 * F07 · pharmacyAgent — first wave on triage.critical.submitted.
 *
 * Walks the patient's active prescriptions, aggregates current stock across
 * batches at the patient's branch (MedicineStock rows are split by
 * batchNumber per (medicineId, branchId) — minStock is the reorder threshold
 * on each batch but the *effective* on-hand quantity for the patient is the
 * sum across batches). Any medicine whose total drops below the highest
 * minStock seen across its batches gets flagged.
 *
 * For each flagged medicine we enqueue a single in-app notification to
 * pharmacists at that branch — they're the role that can actually act on it.
 * One notification per low-stock medicine, not one per pharmacist + medicine.
 *
 * Schema gotcha:
 *   • Prescription.patientId references Patient.id (NOT User.id).
 *     The spec's `patientUserId` field is not what we want here — use
 *     payload.patientId throughout.
 *   • Prescription has no `status` enum — "active" means `discontinuedAt IS NULL`.
 *   • MedicineStock has no `reorderLevel` — the field is `minStock`.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../lib/logger.js';
import { notificationService } from '../notification.service.js';

/**
 * @param {{ triageSessionId: string, patientId: string, branchId?: string|null }} payload
 */
export async function pharmacyAgent(payload) {
    const { triageSessionId, patientId, branchId } = payload;
    if (!patientId) {
        logger.warn('[agent:pharmacy] missing patientId — skipping');
        return { skipped: true, reason: 'no_patient' };
    }
    if (!branchId) {
        logger.info('[agent:pharmacy] no branchId in payload — stock is branch-scoped, skipping', {
            patientId,
        });
        return { skipped: true, reason: 'no_branch', medicinesChecked: 0, lowStockFlagged: 0 };
    }

    // 1) Active prescriptions for this patient with a real Medicine link.
    //    Free-text prescriptions (no medicineId) can't be stock-checked so
    //    they're filtered out here.
    let prescriptions = [];
    try {
        prescriptions = await prisma.prescription.findMany({
            where: {
                patientId,
                discontinuedAt: null,
                medicineId: { not: null },
            },
            select: {
                id: true,
                medicineId: true,
                medicationName: true,
            },
        });
    } catch (err) {
        logger.warn('[agent:pharmacy] prescription lookup failed', {
            patientId, err: err.message,
        });
        return { skipped: true, reason: 'rx_lookup_failed' };
    }

    if (prescriptions.length === 0) {
        logger.info('[agent:pharmacy] no active prescriptions — nothing to check', {
            patientId, triageSessionId,
        });
        return { medicinesChecked: 0, lowStockFlagged: 0, flagged: [] };
    }

    const medicineIds = [...new Set(prescriptions.map((p) => p.medicineId).filter(Boolean))];

    // 2) Aggregate live stock per medicine at this branch.
    //    SUM across batches because the effective on-hand quantity is what
    //    counts, not any single batch.
    let stockRows = [];
    try {
        stockRows = await prisma.medicineStock.groupBy({
            by: ['medicineId'],
            where: {
                branchId,
                medicineId: { in: medicineIds },
                // Don't count expired batches toward on-hand.
                expiryDate: { gt: new Date() },
            },
            _sum: { quantity: true },
            _max: { minStock: true },
        });
    } catch (err) {
        logger.warn('[agent:pharmacy] stock aggregate failed', {
            branchId, err: err.message,
        });
        return { skipped: true, reason: 'stock_lookup_failed' };
    }

    const stockByMed = new Map();
    for (const r of stockRows) {
        stockByMed.set(r.medicineId, {
            quantity: r._sum.quantity ?? 0,
            minStock: r._max.minStock ?? 0,
        });
    }

    // 3) For each prescription, decide if it's flagged. Medicines with zero
    //    matching MedicineStock rows are also flagged (we have no on-hand).
    const flagged = [];
    for (const rx of prescriptions) {
        const s = stockByMed.get(rx.medicineId) ?? { quantity: 0, minStock: 0 };
        if (s.quantity <= s.minStock) {
            flagged.push({
                medicineId: rx.medicineId,
                medicationName: rx.medicationName,
                quantity: s.quantity,
                minStock: s.minStock,
                prescriptionId: rx.id,
            });
        }
    }

    // 4) Notify pharmacists + admin doctors via the existing platform helper.
    //    NotificationService.sendLowStockAlert already resolves the right
    //    audience for the branch, uses the canonical type 'LOW_STOCK_ALERT',
    //    and lives in one place — so this agent doesn't drift its own
    //    notification vocabulary from the rest of the platform.
    let notifiedCount = 0;
    for (const f of flagged) {
        try {
            await notificationService.sendLowStockAlert(
                f.medicationName,
                f.quantity,
                branchId,
            );
            notifiedCount += 1;
        } catch (err) {
            logger.warn('[agent:pharmacy] sendLowStockAlert failed', {
                medicineId: f.medicineId, err: err.message,
            });
        }
    }

    logger.info('[agent:pharmacy] complete', {
        triageSessionId, patientId, branchId,
        medicinesChecked: medicineIds.length,
        lowStockFlagged:  flagged.length,
        notifiedCount,
    });

    return {
        medicinesChecked: medicineIds.length,
        lowStockFlagged:  flagged.length,
        flagged,
    };
}
