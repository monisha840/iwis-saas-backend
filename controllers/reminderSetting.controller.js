import { ReminderSettingService } from '../services/reminderSetting.service.js';
import logger from '../lib/logger.js';

function send(res, err) {
    const status = err?.status || 500;
    if (status === 500) logger.error('[ReminderSettingController]', err);
    res.status(status).json({ error: err?.message || 'Internal error' });
}

export class ReminderSettingController {
    static async get(req, res) {
        try {
            const row = await ReminderSettingService.getOrInit(req.user, req.query.hospitalId);
            res.json({ data: row });
        } catch (err) { send(res, err); }
    }

    static async update(req, res) {
        try {
            const row = await ReminderSettingService.update(req.user, req.body, req.query.hospitalId);
            res.json({ data: row });
        } catch (err) { send(res, err); }
    }

    static async triggerNow(req, res) {
        try {
            const summary = await ReminderSettingService.triggerNow(req.user, req.query.hospitalId);
            res.json({ data: summary });
        } catch (err) { send(res, err); }
    }

    static async deliveries(req, res) {
        try {
            const { kind, limit, offset, hospitalId } = req.query;
            const result = await ReminderSettingService.listDeliveries(req.user, { kind, limit, offset, hospitalId });
            res.json(result);
        } catch (err) { send(res, err); }
    }
}
