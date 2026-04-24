import prisma from '../lib/prisma.js';

export class SuperAdminAuditService {
  static async log({ superAdminId, action, hospitalId = null, featureKey = null, details = null, ipAddress = null }) {
    return prisma.superAdminAuditLog.create({
      data: { superAdminId, action, hospitalId, featureKey, details, ipAddress },
    });
  }

  static async list({ action, hospitalId, from, to, page = 1, pageSize = 50 } = {}) {
    const where = {};
    if (action) where.action = action;
    if (hospitalId) where.hospitalId = hospitalId;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    const take = Math.min(Number(pageSize) || 50, 200);
    const skip = Math.max((Number(page) || 1) - 1, 0) * take;
    const [items, total] = await Promise.all([
      prisma.superAdminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          superAdmin: { select: { id: true, email: true } },
          hospital: { select: { id: true, name: true, slug: true } },
        },
      }),
      prisma.superAdminAuditLog.count({ where }),
    ]);
    return { items, total, page: Number(page) || 1, pageSize: take, totalPages: Math.ceil(total / take) };
  }
}
