/**
 * UserController — HTTP layer for user & profile management.
 */

import { UserService } from '../services/user.service.js';

export class UserController {
  static async getMe(req, res, next) {
    try {
      const profile = await UserService.getProfile(req.user.id);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      res.json(profile);
    } catch (err) {
      next(err);
    }
  }

  static async updateMe(req, res, next) {
    try {
      const updated = await UserService.updateProfile(req.user.id, req.user.role, req.body);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }

  static async listUsers(req, res, next) {
    try {
      const result = await UserService.listUsers(req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getUserById(req, res, next) {
    try {
      const user = await UserService.getUserById(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json(user);
    } catch (err) {
      next(err);
    }
  }

  static async updateUser(req, res, next) {
    try {
      const updated = await UserService.adminUpdateUser(req.params.id, req.body, req.user);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  }

  static async deleteUser(req, res, next) {
    try {
      await UserService.softDeleteUser(req.params.id, req.user);
      res.json({ message: 'User deactivated successfully' });
    } catch (err) {
      next(err);
    }
  }

  static async getDoctors(req, res, next) {
    try {
      const doctors = await UserService.getDoctors(req.query);
      res.json(doctors);
    } catch (err) {
      next(err);
    }
  }

  static async getPatients(req, res, next) {
    try {
      const patients = await UserService.getPatients(req.user, req.query);
      res.json(patients);
    } catch (err) {
      next(err);
    }
  }
}
