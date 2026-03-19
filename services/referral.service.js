import prisma from '../lib/prisma.js';
import { notificationService } from './notification.service.js';
import crypto from 'crypto';

/** Points awarded to the referrer when the referred patient completes their first appointment */
const REFERRAL_ZEN_POINTS = 50;

/**
 * Generates a URL-safe random referral code of the specified byte length.
 * Default produces an 8-character alphanumeric-ish string.
 */
function generateCode(bytes = 6) {
    return crypto.randomBytes(bytes).toString('base64url').toUpperCase().slice(0, 8);
}

export class ReferralService {
    /**
     * Fetch (or lazily create) a unique referral code for the authenticated patient.
     */
    static async getOrCreateCode(userId) {
        const patient = await prisma.patient.findUnique({
            where: { userId },
            include: { referralsMade: { where: { status: { not: 'COMPLETED' } }, take: 1 } },
        });
        if (!patient) throw new Error('Patient profile not found');

        // Return existing non-completed referral code if already issued
        if (patient.referralsMade.length > 0) {
            return {
                referralCode: patient.referralsMade[0].referralCode,
                referralLink: buildReferralLink(patient.referralsMade[0].referralCode),
            };
        }

        // Generate unique code (retry on collision)
        let code;
        let attempts = 0;
        while (attempts < 5) {
            code = generateCode();
            const existing = await prisma.referral.findUnique({ where: { referralCode: code } });
            if (!existing) break;
            attempts++;
        }
        if (!code) throw new Error('Could not generate a unique referral code — please try again');

        const referral = await prisma.referral.create({
            data: {
                referrerId:   patient.id,
                referralCode: code,
                status:       'PENDING',
            },
        });

        return {
            referralCode: referral.referralCode,
            referralLink: buildReferralLink(referral.referralCode),
        };
    }

    /**
     * Called during patient registration when a referralCode is supplied.
     * Links the new patient to the referral record (status → REGISTERED).
     */
    static async applyReferralCode(newPatientId, referralCode) {
        if (!referralCode) return null;

        const referral = await prisma.referral.findUnique({ where: { referralCode } });
        if (!referral || referral.status !== 'PENDING') return null;
        if (referral.referrerId === newPatientId) return null; // can't refer yourself

        return prisma.referral.update({
            where: { id: referral.id },
            data:  { referredId: newPatientId, status: 'REGISTERED' },
        });
    }

    /**
     * Called after a referred patient completes their first appointment.
     * Marks the referral COMPLETED and awards Zen Points to the referrer.
     */
    static async completeReferral(completedPatientId) {
        // Find any REGISTERED referral where this patient is the referred person
        const referral = await prisma.referral.findFirst({
            where: { referredId: completedPatientId, status: 'REGISTERED' },
            include: { referrer: { include: { user: true } } },
        });

        if (!referral || referral.rewardGranted) return null;

        // Grant Zen Points to referrer
        await prisma.$transaction([
            prisma.patient.update({
                where: { id: referral.referrerId },
                data:  { zenPoints: { increment: REFERRAL_ZEN_POINTS } },
            }),
            prisma.referral.update({
                where: { id: referral.id },
                data:  { status: 'COMPLETED', rewardGranted: true },
            }),
        ]);

        // Notify referrer
        if (referral.referrer?.user?.id) {
            await notificationService.createNotification({
                userId:   referral.referrer.user.id,
                type:     'REFERRAL_COMPLETED',
                title:    `🎉 Referral reward — +${REFERRAL_ZEN_POINTS} Zen Points!`,
                message:  `Someone you referred just completed their first session at Al-Shifa. You've earned ${REFERRAL_ZEN_POINTS} Zen Points as a thank-you!`,
                priority: 'MEDIUM',
                data: { referralId: referral.id, zenPointsAwarded: REFERRAL_ZEN_POINTS },
            });
        }

        return referral;
    }

    /** Fetch all referrals made by a patient (for their referral dashboard). */
    static async getMyReferrals(userId) {
        const patient = await prisma.patient.findUnique({ where: { userId } });
        if (!patient) throw new Error('Patient profile not found');

        const referrals = await prisma.referral.findMany({
            where: { referrerId: patient.id },
            include: {
                referred: { select: { fullName: true, createdAt: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        return referrals.map(r => ({
            id:           r.id,
            referralCode: r.referralCode,
            referralLink: buildReferralLink(r.referralCode),
            status:       r.status,
            rewardGranted:r.rewardGranted,
            referredName: r.referred?.fullName || null,
            createdAt:    r.createdAt,
        }));
    }

    /** Admin: aggregate referral statistics */
    static async getStats() {
        const [total, registered, completed, pending] = await Promise.all([
            prisma.referral.count(),
            prisma.referral.count({ where: { status: 'REGISTERED' } }),
            prisma.referral.count({ where: { status: 'COMPLETED' } }),
            prisma.referral.count({ where: { status: 'PENDING' } }),
        ]);

        const conversionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

        return { total, pending, registered, completed, conversionRate };
    }
}

function buildReferralLink(code) {
    const base = process.env.FRONTEND_URL || 'http://localhost:5173';
    return `${base}/register?ref=${code}`;
}
