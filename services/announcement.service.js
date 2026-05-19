import prisma from '../lib/prisma.js';
import logger from '../lib/logger.js';
import { emitToUser } from '../websocket/index.js';
import { userNameSelect, flattenUserName } from '../lib/userName.js';
import { notificationService } from './notification.service.js';

const BRANCH_SELECT = { select: { id: true, name: true } };

// Announcement.priority ↔ Notification.priority are different enums
// (announcement has URGENT, notification doesn't). Map explicitly so the
// notification bell visually matches the announcement's intent.
const ANNOUNCEMENT_TO_NOTIFICATION_PRIORITY = {
  URGENT: 'HIGH',
  HIGH:   'HIGH',
  NORMAL: 'MEDIUM',
  LOW:    'LOW',
};

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

    // Pick who to notify — soft-deleted users never receive announcements.
    const userWhere = { deletedAt: null };
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

    // Persist a Notification row per targeted user — this is what the bell
    // / NotificationPanel reads from. Before this, the service only fired a
    // fire-and-forget WebSocket emit, so any user who wasn't online at the
    // exact moment of creation never saw the announcement. Doctors had no
    // dedicated announcements page either, so for them the announcement
    // was invisible everywhere — fix surfaces it in the bell.
    //
    // Author is excluded — no point pushing a notification about your own
    // post into your own bell.
    //
    // Promise.allSettled so one failure (e.g. a single user with a
    // misconfigured account) doesn't abort the rest of the fan-out. The
    // route handler still returns 201 to the admin even if some
    // downstream notification creates fail — failures are logged.
    const notifPriority = ANNOUNCEMENT_TO_NOTIFICATION_PRIORITY[announcement.priority] || 'MEDIUM';
    const recipients = users.filter((u) => u.id !== authorId);
    const fanout = await Promise.allSettled(
      recipients.map((user) =>
        notificationService.createNotification({
          userId:    user.id,
          type:      'ANNOUNCEMENT',
          title:     announcement.title,
          message:   announcement.message,
          priority:  notifPriority,
          relatedId: announcement.id,
          // The notification panel's resolveNotificationRoute reads
          // `data.link` as a fallback when no type-specific route is
          // registered, so the click lands on the announcements page.
          data: {
            link: '/announcements',
            announcementId: announcement.id,
            announcementPriority: announcement.priority,
          },
        }),
      ),
    );
    const notifFailed = fanout.filter((r) => r.status === 'rejected').length;
    if (notifFailed > 0) {
      logger.warn(`[Announcement] ${notifFailed}/${recipients.length} notification creates failed`, {
        announcementId: announcement.id,
      });
    }

    // WebSocket emit stays — frontends that already listen on
    // 'new_announcement' (e.g. an announcements-page live ticker) keep
    // working without changes. The new_notification emit inside
    // createNotification handles the bell.
    for (const user of users) {
      emitToUser(user.id, 'new_announcement', announcement);
    }

    const flat = { ...announcement, author: flattenUserName(announcement.author) };
    logger.info(`Announcement created — ${recipients.length} notifications fanned out (${notifFailed} failed), socket emit to ${users.length}`, {
      announcementId: announcement.id,
    });
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
   * Delete an announcement.
   *
   * Allowed when caller is:
   *   - the original author (any role), OR
   *   - ADMIN / ADMIN_DOCTOR.
   * Anyone else gets a 403 (`status: 403`).
   */
  static async deleteAnnouncement(announcementId, userId) {
    const announcement = await prisma.announcement.findUnique({
      where: { id: announcementId },
      select: { authorId: true },
    });

    if (!announcement) {
      const err = new Error('Announcement not found');
      err.status = 404;
      throw err;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    const isAuthor = announcement.authorId === userId;
    const isAdmin  = user?.role === 'ADMIN' || user?.role === 'ADMIN_DOCTOR';
    if (!isAuthor && !isAdmin) {
      const err = new Error('Not authorized to delete this announcement');
      err.status = 403;
      throw err;
    }

    await prisma.announcement.delete({
      where: { id: announcementId },
    });

    return { success: true };
  }

  /**
   * Update an announcement's title, message, priority, pinned status, roles,
   * expiry, or branch targeting.
   *
   * Editing is reserved for the announcement's author. ADMIN / ADMIN_DOCTOR
   * may also edit announcements they didn't author so they can correct an
   * announcement after the author has left or moved branches.
   */
  static async updateAnnouncement(announcementId, data, userId) {
    const existing = await prisma.announcement.findUnique({
      where: { id: announcementId },
      select: { authorId: true },
    });
    if (!existing) {
      const err = new Error('Announcement not found');
      err.status = 404;
      throw err;
    }

    if (userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      const isAuthor = existing.authorId === userId;
      const isAdmin  = user?.role === 'ADMIN' || user?.role === 'ADMIN_DOCTOR';
      if (!isAuthor && !isAdmin) {
        const err = new Error('Not authorized to edit this announcement');
        err.status = 403;
        throw err;
      }
    }

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
