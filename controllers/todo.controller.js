import { TodoService } from '../services/todo.service.js';

function actorOf(req) {
    return {
        id: req.user.id,
        role: req.user.role,
        branchId: req.user.branchId || null,
    };
}

export class TodoController {
    static async list(req, res, next) {
        try {
            const result = await TodoService.listForAssignee(req.user.id, {
                status: req.query.status,
                priority: req.query.priority,
                tab: req.query.tab,
                page: parseInt(req.query.page, 10) || 1,
                limit: Math.min(100, parseInt(req.query.limit, 10) || 50),
            });
            res.json(result);
        } catch (err) { next(err); }
    }

    static async listAssignedByMe(req, res, next) {
        try {
            const result = await TodoService.listAssignedByMe(actorOf(req), {
                status: req.query.status,
                page: parseInt(req.query.page, 10) || 1,
                limit: Math.min(100, parseInt(req.query.limit, 10) || 50),
            });
            res.json(result);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    static async createSelf(req, res, next) {
        try {
            const todo = await TodoService.createSelf(actorOf(req), req.body || {});
            res.status(201).json(todo);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    static async assign(req, res, next) {
        try {
            const todo = await TodoService.assign(actorOf(req), req.body || {});
            res.status(201).json(todo);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    static async setStatus(req, res, next) {
        try {
            const result = await TodoService.updateStatus(actorOf(req), req.params.id, req.body?.status);
            res.json(result);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    static async edit(req, res, next) {
        try {
            const result = await TodoService.edit(actorOf(req), req.params.id, req.body || {});
            res.json(result);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    static async revoke(req, res, next) {
        try {
            const result = await TodoService.revoke(actorOf(req), req.params.id);
            res.json(result);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    static async remind(req, res, next) {
        try {
            const result = await TodoService.remind(actorOf(req), req.params.id);
            res.json(result);
        } catch (err) {
            if (err.status) return res.status(err.status).json({ error: err.message });
            next(err);
        }
    }

    static async summary(req, res, next) {
        try {
            const summary = await TodoService._summarizeInbox(req.user.id);
            res.json(summary);
        } catch (err) { next(err); }
    }
}
