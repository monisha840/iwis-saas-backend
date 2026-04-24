import { MessageTemplateService } from '../services/messageTemplate.service.js';
import logger from '../lib/logger.js';

function send(res, err) {
    const status = err?.status || 500;
    if (status === 500) logger.error('[MessageTemplateController]', err);
    res.status(status).json({ error: err?.message || 'Internal error' });
}

export class MessageTemplateController {
    static async list(req, res) {
        try {
            const { category, isActive, search, hospitalId } = req.query;
            const rows = await MessageTemplateService.list(req.user, {
                category,
                isActive: isActive === undefined ? undefined : isActive === 'true',
                search,
                hospitalId,
            });
            res.json({ data: rows });
        } catch (err) { send(res, err); }
    }

    static async getById(req, res) {
        try {
            const row = await MessageTemplateService.getById(req.user, req.params.id);
            res.json({ data: row });
        } catch (err) { send(res, err); }
    }

    static async create(req, res) {
        try {
            const created = await MessageTemplateService.create(req.user, req.body);
            res.status(201).json({ data: created });
        } catch (err) { send(res, err); }
    }

    static async update(req, res) {
        try {
            const updated = await MessageTemplateService.update(req.user, req.params.id, req.body);
            res.json({ data: updated });
        } catch (err) { send(res, err); }
    }

    static async remove(req, res) {
        try {
            await MessageTemplateService.remove(req.user, req.params.id);
            res.status(204).send();
        } catch (err) { send(res, err); }
    }

    static async preview(req, res) {
        try {
            const rendered = await MessageTemplateService.preview(req.user, req.body);
            res.json({ data: rendered });
        } catch (err) { send(res, err); }
    }

    static async placeholders(_req, res) {
        res.json({ data: MessageTemplateService.listStandardPlaceholders() });
    }
}
