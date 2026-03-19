/**
 * NotificationRepository — DB access for Notification and NotificationPreference models.
 */

import prisma from '../lib/prisma.js';
import { BaseRepository } from './base.repository.js';

export class NotificationRepository extends BaseRepository {
  get model() {
    return prisma.notification;
  }

  async findByUser(userId, { page = 1, limit = 30, unreadOnly = false } = {}) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 30));
    const skip = (safePage - 1) * safeLimit;
    const where = { userId, ...(unreadOnly && { isRead: false }) };

    const [notifications, total] = await prisma.$transaction([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      prisma.notification.count({ where }),
    ]);

    return { notifications, total, page: safePage, limit: safeLimit };
  }

  async markAllRead(userId) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  async getPreferences(userId) {
    return prisma.notificationPreference.findUnique({ where: { userId } });
  }

  async upsertPreferences(userId, data) {
    return prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }

  /** Idempotency check — has a notification for this appointment+type already been sent? */
  async hasNotificationBeenSent(relatedId, type) {
    const count = await prisma.notification.count({
      where: { relatedId, type },
    });
    return count > 0;
  }
}

export const notificationRepository = new NotificationRepository();
