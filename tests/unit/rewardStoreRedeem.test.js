import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Pure-logic test for the redemption guards added to
 * RewardStoreService.redeemReward. The full service is heavily
 * Prisma-coupled, so this file mocks `../../lib/prisma.js` rather than
 * standing up a database. Each test exercises one invariant of the new
 * transactional flow:
 *
 *   1. Duplicate PENDING redemptions are refused with status 409 (so a
 *      retried POST doesn't double-charge).
 *   2. The stock CAS rejects redemption when stock has hit zero.
 *   3. The balance CAS rejects redemption when XP is below cost.
 *   4. A successful redemption returns the new RewardRedemption row.
 */

const tx = {
    rewardRedemption: {
        findFirst: vi.fn(),
        create:    vi.fn(),
    },
    rewardItem: {
        updateMany: vi.fn(),
    },
    clinicianXP: {
        updateMany: vi.fn(),
        findUnique: vi.fn(),
    },
    patient: {
        findUnique: vi.fn(),
        updateMany: vi.fn(),
    },
};

const prismaMock = {
    rewardItem: { findUnique: vi.fn() },
    user:       { findUnique: vi.fn() },
    $transaction: vi.fn(async (cb) => cb(tx)),
};

vi.mock('../../lib/prisma.js', () => ({ default: prismaMock }));
vi.mock('../../websocket/index.js', () => ({ emitToUser: vi.fn() }));

let RewardStoreService;
beforeEach(async () => {
    vi.clearAllMocks();
    // The service is loaded *after* the mocks are wired so the module-level
    // `import prisma` resolves to the mock above.
    ({ RewardStoreService } = await import('../../services/rewardStore.service.js'));
});

describe('RewardStoreService.redeemReward — guards', () => {
    const RID = 'reward-1';
    const UID = 'user-doc-1';

    function happyReward(over = {}) {
        prismaMock.rewardItem.findUnique.mockResolvedValueOnce({
            pointsCost: 100, isActive: true, stock: 5, name: 'Spa Day',
            ...over,
        });
        prismaMock.user.findUnique.mockResolvedValueOnce({ role: 'DOCTOR' });
    }

    it('refuses a duplicate PENDING redemption with status 409', async () => {
        happyReward();
        tx.rewardRedemption.findFirst.mockResolvedValueOnce({ id: 'existing-pending' });

        await expect(RewardStoreService.redeemReward(UID, RID))
            .rejects.toMatchObject({ status: 409 });

        // No debit / stock / create should fire if we short-circuit on the dupe.
        expect(tx.rewardItem.updateMany).not.toHaveBeenCalled();
        expect(tx.clinicianXP.updateMany).not.toHaveBeenCalled();
        expect(tx.rewardRedemption.create).not.toHaveBeenCalled();
    });

    it('rejects when stock CAS returns count=0 (out of stock)', async () => {
        happyReward({ stock: 1 });
        tx.rewardRedemption.findFirst.mockResolvedValueOnce(null);
        tx.rewardItem.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(RewardStoreService.redeemReward(UID, RID))
            .rejects.toMatchObject({ status: 400, message: /out of stock/i });

        expect(tx.clinicianXP.updateMany).not.toHaveBeenCalled();
        expect(tx.rewardRedemption.create).not.toHaveBeenCalled();
    });

    it('rejects when balance CAS returns count=0 (insufficient XP)', async () => {
        happyReward();
        tx.rewardRedemption.findFirst.mockResolvedValueOnce(null);
        tx.rewardItem.updateMany.mockResolvedValueOnce({ count: 1 });
        tx.clinicianXP.updateMany.mockResolvedValueOnce({ count: 0 });
        tx.clinicianXP.findUnique.mockResolvedValueOnce({ totalXP: 50 });

        await expect(RewardStoreService.redeemReward(UID, RID))
            .rejects.toMatchObject({ status: 400, message: /Insufficient XP/i });

        expect(tx.rewardRedemption.create).not.toHaveBeenCalled();
    });

    it('creates a PENDING redemption on the happy path', async () => {
        happyReward();
        tx.rewardRedemption.findFirst.mockResolvedValueOnce(null);
        tx.rewardItem.updateMany.mockResolvedValueOnce({ count: 1 });
        tx.clinicianXP.updateMany.mockResolvedValueOnce({ count: 1 });
        tx.rewardRedemption.create.mockResolvedValueOnce({
            id: 'new-redemption',
            userId: UID,
            rewardId: RID,
            pointsSpent: 100,
            status: 'PENDING',
            reward: { name: 'Spa Day' },
        });

        const result = await RewardStoreService.redeemReward(UID, RID);
        expect(result).toMatchObject({ id: 'new-redemption', status: 'PENDING' });
        expect(tx.rewardRedemption.create).toHaveBeenCalledOnce();
    });

    it('rejects when the role cannot redeem (e.g. ADMIN viewer)', async () => {
        prismaMock.rewardItem.findUnique.mockResolvedValueOnce({
            pointsCost: 100, isActive: true, stock: null, name: 'Spa Day',
        });
        prismaMock.user.findUnique.mockResolvedValueOnce({ role: 'ADMIN' });

        await expect(RewardStoreService.redeemReward(UID, RID))
            .rejects.toMatchObject({ status: 403 });

        // Transaction never opens.
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('404s for a missing or inactive reward', async () => {
        prismaMock.rewardItem.findUnique.mockResolvedValueOnce(null);
        await expect(RewardStoreService.redeemReward(UID, RID))
            .rejects.toMatchObject({ status: 404 });

        // Inactive reward
        prismaMock.rewardItem.findUnique.mockResolvedValueOnce({
            pointsCost: 100, isActive: false, stock: 5, name: 'Spa Day',
        });
        await expect(RewardStoreService.redeemReward(UID, RID))
            .rejects.toMatchObject({ status: 404 });
    });
});
