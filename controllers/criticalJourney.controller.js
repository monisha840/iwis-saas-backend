import { CriticalJourneyService } from '../services/criticalJourney.service.js';
import logger from '../lib/logger.js';

function send(res, err) {
    const status = err?.status || 500;
    if (status === 500) logger.error('[CriticalJourneyController]', err);
    res.status(status).json({ error: err?.message || 'Internal error' });
}

export class CriticalJourneyController {
    static async list(req, res) {
        try {
            const rows = await CriticalJourneyService.list({
                branchId: req.query.branchId,
                severity: req.query.severity,
                limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
            });
            res.json({ data: rows });
        } catch (err) { send(res, err); }
    }

    static async stats(req, res) {
        try {
            const s = await CriticalJourneyService.stats({ branchId: req.query.branchId });
            res.json({ data: s });
        } catch (err) { send(res, err); }
    }

    static async scan(req, res) {
        try {
            const result = await CriticalJourneyService.detect({ branchId: req.query.branchId });
            res.json({ data: result });
        } catch (err) { send(res, err); }
    }

    static async resolve(req, res) {
        try {
            const updated = await CriticalJourneyService.resolve(
                req.params.patientId,
                req.user,
                req.body?.note,
            );
            res.json({ data: updated });
        } catch (err) { send(res, err); }
    }
}
