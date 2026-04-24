import prisma from '../lib/prisma.js';
import { cacheService } from './cache.service.js';
import { Prisma } from '@prisma/client';
import logger from '../lib/logger.js';

const BRANCHES_CACHE_KEY = 'branches:all';

export class BranchService {
    static async createBranch(adminId, data) {
        try {
            return await prisma.$transaction(async (tx) => {
                const branch = await tx.branch.create({ data });

                await tx.auditLog.create({
                    data: {
                        userId: adminId,
                        action: 'CREATE',
                        entityType: 'BRANCH',
                        entityId: branch.id,
                        newData: branch
                    }
                });

                await cacheService.del(BRANCHES_CACHE_KEY);
                return branch;
            });
        } catch (err) {
            // Log exact failure reason before re-throwing so it appears in structured logs
            if (err instanceof Prisma.PrismaClientKnownRequestError) {
                if (err.code === 'P2002') {
                    const field = err.meta?.target?.[0] ?? 'field';
                    logger.warn('[BranchService.createBranch] Duplicate key', { field, adminId, data });
                    const friendly = new Error(`A branch with that ${field} already exists.`);
                    friendly.status = 409;
                    throw friendly;
                }
                logger.error('[BranchService.createBranch] Prisma error', err, { code: err.code, meta: err.meta, adminId });
            } else {
                logger.error('[BranchService.createBranch] Unexpected error', err, { adminId });
            }
            throw err;
        }
    }

    static async getBranches() {
        const cached = await cacheService.get(BRANCHES_CACHE_KEY);
        if (cached) return cached;

        const branches = await prisma.branch.findMany({
            include: {
                _count: {
                    select: {
                        patients: true,
                        appointments: true,
                        users: true
                    }
                }
            }
        });

        await cacheService.set(BRANCHES_CACHE_KEY, branches, 86400); // 24h
        return branches;
    }

    static async getBranchById(id) {
        return prisma.branch.findUnique({
            where: { id },
            include: {
                _count: { select: { patients: true, appointments: true, users: true, therapyRooms: true } }
            }
        });
    }

    static async getCapacity(id) {
        const branch = await prisma.branch.findUnique({
            where: { id },
            select: {
                id: true, name: true,
                totalBeds: true, availableBeds: true,
                totalRooms: true, totalTherapyRooms: true,
                ipdEnabled: true, opdEnabled: true,
                operatingHoursFrom: true, operatingHoursTo: true,
            }
        });
        if (!branch) return null;

        const [registeredTherapyRooms, activeEnrolments] = await Promise.all([
            prisma.therapyRoom.count({ where: { branchId: id, isActive: true } }),
            prisma.packageEnrolment.count({ where: { status: 'ACTIVE', package: { branchId: id } } }).catch(() => 0),
        ]);

        const totalBeds = branch.totalBeds ?? 0;
        const availableBeds = branch.availableBeds ?? 0;
        const occupiedBeds = Math.max(0, totalBeds - availableBeds);

        return {
            ...branch,
            registeredTherapyRooms,
            occupiedBeds,
            activeInpatientEnrolments: activeEnrolments,
            therapyRoomRegistrationGap: Math.max(0, (branch.totalTherapyRooms ?? 0) - registeredTherapyRooms),
        };
    }

    static async updateBranch(adminId, id, data) {
        return prisma.$transaction(async (tx) => {
            const oldData = await tx.branch.findUnique({ where: { id } });
            const branch = await tx.branch.update({
                where: { id },
                data
            });

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'UPDATE',
                    entityType: 'BRANCH',
                    entityId: id,
                    oldData,
                    newData: branch
                }
            });

            await cacheService.del(BRANCHES_CACHE_KEY);
            return branch;
        });
    }

    static async deleteBranch(adminId, id) {
        return prisma.$transaction(async (tx) => {
            // Check for associated records
            const counts = await tx.branch.findUnique({
                where: { id },
                include: {
                    _count: {
                        select: {
                            patients: true,
                            appointments: true,
                            users: true,
                            pharmacyOrders: true
                        }
                    }
                }
            });

            if (counts._count.patients > 0 || counts._count.users > 0) {
                throw new Error('Cannot delete branch with active patients or staff. Reassign them first.');
            }

            const oldData = await tx.branch.findUnique({ where: { id } });
            await tx.branch.delete({ where: { id } });

            await tx.auditLog.create({
                data: {
                    userId: adminId,
                    action: 'DELETE',
                    entityType: 'BRANCH',
                    entityId: id,
                    oldData
                }
            });

            await cacheService.del(BRANCHES_CACHE_KEY);
            return { success: true };
        });
    }
}
