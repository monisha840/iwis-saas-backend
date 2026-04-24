import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';
import { userNameSelect, flattenUserName } from '../lib/userName.js';

const BRANCH_SELECT = { select: { id: true, name: true } };

export class AnnouncementService {
  /**
   * Create a new announcement and notify relevant users via socket.
   * `branchIds` empty/undefined = broadcast to all branches.
   */
  static async createAnnouncement(authorId, { branchIds, title, message, priority, targetRoles, isPinned, expiresAt }) {
    const ids = Array.isArray(branchIds) ? branchIds.filter(Boolean) : [];
    logger.info(`Creating announcement`, { authorId, branchIds: ids, title, priority });

    const announcement = await prisma.announcement.create({
      data: {
        authorId,
        title,
        message,
        priority: priority || 'NORMAL',
        targetRoles: targetRoles || [],
        isPinned: isPinned || false,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        ...(ids.length > 0
          ? { branches: { connect: ids.map((id) => ({ id })) } }
          : {}),
      },
      include: {
        author: { select: userNameSelect },
        branches: BRANCH_SELECT,
      },
    });

    // Pick who to notify
    const userWhere = {};
    if (ids.length > 0) {
      userWhere.branchId = { in: ids };
    }
    if (targetRoles && targetRoles.length > 0) {
      userWhere.role = { in: targetRoles };
    }

    const users = await prisma.user.findMany({
      where: userWhere,
      select: { id: true },
    });

    for (const user of users) {
      emitToUser(user.id, 'new_announcement', announcement);
    }

    const flat = { ...announcement, author: flattenUserName(announcement.author) };
    logger.info(`Announcement created and emitted to ${users.length} users`, { announcementId: announcement.id });
    return flat;
  }

  /**
   * Get announcements visible to a user (matching branch + role), with read status.
   * Pinned first, then by createdAt desc. Excludes expired.
   *
   * Visibility rules:
   *   - Author always sees their own.
   *   - Announcement with no branches = broadcast → everyone in the hospital sees it.
   *   - Announcement with branches set = only users whose branch is in the set (admins see all in their hospital).
   */
  static async getAnnouncements(userId, userRole, userBranchId, userHospitalId, { page = 1, limit = 20 } = {}) {
    const currentPage = Math.max(1, parseInt(page) || 1);
    const take = Math.min(parseInt(limit) || 20, 100);
    const skip = (currentPage - 1) * take;

    const now = new Date();

    const isAdmin = userRole === 'ADMIN' || userRole === 'ADMIN_DOCTOR';
    const branchMatchers = [
      { branches: { none: {} } },       // broadcast
      { authorId: userId },              // self
    ];
    if (isAdmin && userHospitalId) {
      branchMatchers.push({ branches: { some: { hospitalId: userHospitalId } } });
    } else if (userBranchId) {
      branchMatchers.push({ branches: { some: { id: userBranchId } } });
    }

    const where = {
      OR: branchMatchers,
      AND: [
        {
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: now } },
          ],
        },
      ],
    };

    const [announcements, total] = await Promise.all([
      prisma.announcement.findMany({
        where,
        include: {
          author: { select: userNameSelect },
          branches: BRANCH_SELECT,
          reads: {
            where: { userId },
            select: { readAt: true },
          },
        },
        orderBy: [
          { isPinned: 'desc' },
          { createdAt: 'desc' },
        ],
        skip,
        take,
      }),
      prisma.announcement.count({ where }),
    ]);

    // Filter by targetRoles in application layer (array contains check)
    const filtered = announcements.filter(a =>
      a.targetRoles.length === 0 || a.targetRoles.includes(userRole)
    );

    const data = filtered.map(({ reads, author, ...rest }) => ({
      ...rest,
      author: flattenUserName(author),
      isRead: reads.length > 0,
      readAt: reads.length > 0 ? reads[0].readAt : null,
    }));

    return {
      data,
      pagination: {
        page: currentPage,
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }

  /**
   * Mark an announcement as read by a user.
   */
  static async markAsRead(announcementId, userId) {
    return prisma.announcementRead.upsert({
      where: {
        announcementId_userId: { announcementId, userId },
      },
      update: {},
      create: {
        announcementId,
        userId,
      },
    });
  }

  /**
   * Delete an announcement (only author or admin).
   */
  static async deleteAnnouncement(announcementId, userId) {
    const announcement = await prisma.announcement.findUnique({
      where: { id: announcementId },
    });

    if (!announcement) {
      throw new Error('Announcement not found');
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (announcement.authorId !== userId && user?.role !== 'ADMIN') {
      throw new Error('Not authorized to delete this announcement');
    }

    await prisma.announcement.delete({
      where: { id: announcementId },
    });

    return { success: true };
  }

  /**
   * Update an announcement's title, message, priority, pinned status, roles,
   * expiry, or branch targeting.
   */
  static async updateAnnouncement(announcementId, data) {
    const updateData = {};
    if (data.title !== undefined) updateData.title = data.title;
    if (data.message !== undefined) updateData.message = data.message;
    if (data.priority !== undefined) updateData.priority = data.priority;
    if (data.isPinned !== undefined) updateData.isPinned = data.isPinned;
    if (data.targetRoles !== undefined) updateData.targetRoles = data.targetRoles;
    if (data.expiresAt !== undefined) updateData.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    if (Array.isArray(data.branchIds)) {
      const ids = data.branchIds.filter(Boolean);
      updateData.branches = { set: ids.map((id) => ({ id })) };
    }

    const updated = await prisma.announcement.update({
      where: { id: announcementId },
      data: updateData,
      include: {
        author: { select: userNameSelect },
        branches: BRANCH_SELECT,
      },
    });
    return { ...updated, author: flattenUserName(updated.author) };
  }
}
