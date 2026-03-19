/**
 * NotificationsController — HTTP layer for notification delivery and preferences.
 */

import { NotificationService } from '../services/notification.service.js';

const notificationService = new NotificationService();

export class NotificationsController {
  static async getAll(req, res, next) {
    try {
      const result = await notificationService.getNotifications(req.user.id, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async markRead(req, res, next) {
    try {
      await notificationService.markAsRead(req.user.id, req.params.id);
      res.json({ message: 'Notification marked as read' });
    } catch (err) {
      next(err);
    }
  }

  static async markAllRead(req, res, next) {
    try {
      await notificationService.markAllAsRead(req.user.id);
      res.json({ message: 'All notifications marked as read' });
    } catch (err) {
      next(err);
    }
  }

  static async getPreferences(req, res, next) {
    try {
      const prefs = await notificationService.getPreferences(req.user.id);
      res.json(prefs);
    } catch (err) {
      next(err);
    }
  }

  static async updatePreferences(req, res, next) {
    try {
      const prefs = await notificationService.updatePreferences(req.user.id, req.body);
      res.json(prefs);
    } catch (err) {
      next(err);
    }
  }

  static async subscribePush(req, res, next) {
    try {
      await notificationService.subscribePushNotifications(req.user.id, req.body);
      res.json({ message: 'Push subscription registered' });
    } catch (err) {
      next(err);
    }
  }
}
