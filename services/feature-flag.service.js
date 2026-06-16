// DEPRECATED (Phase 2c): manages the legacy global FeatureFlag table. Feature
// decisions are per-hospital via FeatureRegistry + HospitalFeatureFlag
// (utils/featureGate.js Layer 1, services/superAdmin.feature.service.js). This
// service now only backs the legacy Layer-2 branch/role gate + its admin CRUD.
import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { cacheService } from './cache.service.js';

const FLAG_CACHE_TTL = 300; // 5-minute TTL — flags should propagate quickly

/**
 * FeatureFlagService — DB-backed feature flags with Redis caching.
 * Supports role-scoped and branch-scoped rollouts.
 */
export class FeatureFlagService {
    /**
     * Check whether a feature flag is enabled for a given user context.
     *
     * @param {string} key - Flag key, e.g. 'payment_gateway'
     * @param {{ role?: string, branchId?: string }} userCtx - User context for scope checks
     * @returns {Promise<boolean>}
     */
    static async isEnabled(key, userCtx = {}) {
        try {
            const cacheKey = `ff:${key}`;
            let flag = await cacheService.get(cacheKey);

            if (!flag) {
                flag = await prisma.featureFlag.findUnique({ where: { key } });
                if (flag) {
                    await cacheService.set(cacheKey, flag, FLAG_CACHE_TTL);
                }
            }

            if (!flag || !flag.enabled) return false;

            // Role gating — only if the flag defines allowed roles
            if (flag.allowedRoles?.length > 0 && userCtx.role) {
                if (!flag.allowedRoles.includes(userCtx.role)) return false;
            }

            // Branch gating — only if the flag defines allowed branches
            if (flag.allowedBranches?.length > 0 && userCtx.branchId) {
                if (!flag.allowedBranches.includes(userCtx.branchId)) return false;
            }

            return true;
        } catch {
            // Fail open — if Redis/DB is unavailable, don't block the user
            return false;
        }
    }

    /** Return all flags (admin view) */
    static async listAll() {
        return prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
    }

    /** Return a single flag by key */
    static async getByKey(key) {
        return prisma.featureFlag.findUnique({ where: { key } });
    }

    /** Create or update a flag */
    static async upsert({ key, enabled, description, allowedRoles = [], allowedBranches = [] }) {
        const flag = await prisma.featureFlag.upsert({
            where:  { key },
            create: { key, enabled, description, allowedRoles, allowedBranches },
            update: { enabled, description, allowedRoles, allowedBranches },
        });
        // Invalidate cache
        await cacheService.del(`ff:${key}`);
        return flag;
    }

    /** Toggle a flag on/off */
    static async toggle(key) {
        const existing = await prisma.featureFlag.findUnique({ where: { key } });
        if (!existing) throw new Error(`Feature flag "${key}" not found`);

        const updated = await prisma.featureFlag.update({
            where: { key },
            data:  { enabled: !existing.enabled },
        });

        await cacheService.del(`ff:${key}`);
        return updated;
    }

    /** Delete a flag (use sparingly — prefer disabling) */
    static async delete(key) {
        const deleted = await prisma.featureFlag.delete({ where: { key } });
        await cacheService.del(`ff:${key}`);
        return deleted;
    }

    /**
     * Seed default system flags (safe to call multiple times — upserts).
     * Call on server startup or via migration.
     */
    static async seedDefaults() {
        const defaults = [
            { key: 'payment_gateway',           enabled: false, description: 'Enable Razorpay payment checkout flow' },
            { key: 'ocr_document_extraction',   enabled: false, description: 'Enable Tesseract.js OCR for uploaded documents' },
            { key: 'video_consultation',        enabled: false, description: 'Enable Daily.co embedded video consultation' },
            { key: 'referral_programme',        enabled: true,  description: 'Enable patient referral & Zen Points reward' },
            { key: 'prescription_refill',       enabled: true,  description: 'Enable patient self-service prescription refill requests' },
            { key: 'branch_leaderboard',        enabled: true,  description: 'Show branch-level performance benchmarking to ADMIN_DOCTOR' },
            { key: 'patient_timeline',          enabled: true,  description: 'Show EHR-style longitudinal patient timeline' },
            { key: 'consultation_feedback_flow', enabled: true, description: '4-question post-consultation feedback prompt on the patient Today dashboard' },
        ];

        for (const flag of defaults) {
            await FeatureFlagService.upsert(flag);
        }

        logger.info(`[FeatureFlagService] ${defaults.length} default flags seeded`);
    }
}
