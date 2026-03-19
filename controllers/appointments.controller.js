/**
 * AppointmentsController — HTTP layer for appointment operations.
 *
 * Responsibilities:
 *   • Extract data from req (params, query, body, user)
 *   • Call AppointmentService
 *   • Return typed HTTP responses
 *   • Forward errors to next()
 *
 * NOT responsible for: business logic, DB access, role decisions.
 *
 * Migration path:
 *   Replace the inline async handlers in routes/appointments.js with imports
 *   from this file.  The route file then becomes a pure routing declaration.
 */

import { AppointmentService } from '../services/appointment.service.js';

export class AppointmentsController {
  static async list(req, res, next) {
    try {
      const result = await AppointmentService.getAppointments(req.user, req.query);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  static async create(req, res, next) {
    try {
      // PAT: strip administrative fields when booked by the patient themselves
      const body = req.user.role === 'PATIENT'
        ? (({ status, ...rest }) => rest)(req.body)
        : req.body;

      const appointment = await AppointmentService.createAppointment(req.user, body);
      res.status(201).json(appointment);
    } catch (err) {
      next(err);
    }
  }

  static async getAvailableSlots(req, res, next) {
    try {
      const { clinicianId, date } = req.query;
      if (!clinicianId || !date) {
        return res.status(400).json({ error: 'clinicianId and date are required' });
      }
      const slots = await AppointmentService.getAvailableSlots(clinicianId, date);
      res.json(slots);
    } catch (err) {
      next(err);
    }
  }

  static async getAvailableStaff(req, res, next) {
    try {
      const staff = await AppointmentService.getAvailableStaff(req.user, req.query);
      res.json(staff);
    } catch (err) {
      next(err);
    }
  }

  static async update(req, res, next) {
    try {
      const appointment = await AppointmentService.updateAppointment(
        req.user,
        req.params.id,
        req.body
      );
      res.json(appointment);
    } catch (err) {
      next(err);
    }
  }

  static async cancel(req, res, next) {
    try {
      await AppointmentService.cancelAppointment(req.user, req.params.id);
      res.json({ message: 'Appointment cancelled successfully' });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const appointment = await AppointmentService.getAppointmentById(req.user, req.params.id);
      if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
      res.json(appointment);
    } catch (err) {
      next(err);
    }
  }
}
