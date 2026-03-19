/**
 * PharmacyController — HTTP layer for inventory and dispense operations.
 */

import { PharmacyService } from '../services/pharmacy.service.js';

export class PharmacyController {
  static async getMedicines(req, res, next) {
    try {
      const result = await PharmacyService.getMedicines(req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async getMedicineById(req, res, next) {
    try {
      const med = await PharmacyService.getMedicineById(req.params.id);
      if (!med) return res.status(404).json({ error: 'Medicine not found' });
      res.json(med);
    } catch (err) {
      next(err);
    }
  }

  static async createMedicine(req, res, next) {
    try {
      const med = await PharmacyService.createMedicine(req.body);
      res.status(201).json(med);
    } catch (err) {
      next(err);
    }
  }

  static async updateMedicine(req, res, next) {
    try {
      const med = await PharmacyService.updateMedicine(req.params.id, req.body);
      res.json(med);
    } catch (err) {
      next(err);
    }
  }

  static async getStock(req, res, next) {
    try {
      const stock = await PharmacyService.getStock(req.user, req.query);
      res.json(stock);
    } catch (err) {
      next(err);
    }
  }

  static async getLowStockAlerts(req, res, next) {
    try {
      const alerts = await PharmacyService.getLowStockAlerts(req.user);
      res.json(alerts);
    } catch (err) {
      next(err);
    }
  }

  static async adjustStock(req, res, next) {
    try {
      const result = await PharmacyService.adjustStock(req.params.stockId, req.body, req.user);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async createOrder(req, res, next) {
    try {
      const order = await PharmacyService.createOrder(req.body, req.user);
      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  }

  static async getOrders(req, res, next) {
    try {
      const result = await PharmacyService.getOrders(req.user, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async dispense(req, res, next) {
    try {
      const dispense = await PharmacyService.dispense(req.body, req.user);
      res.status(201).json(dispense);
    } catch (err) {
      next(err);
    }
  }

  static async getDispenseHistory(req, res, next) {
    try {
      const result = await PharmacyService.getDispenseHistory(req.user, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
}
