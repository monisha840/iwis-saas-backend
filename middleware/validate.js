import { z } from 'zod';

/**
 * Middleware to validate request data against a Zod schema.
 * @param {Object} schemas - Object containing Zod schemas for body, query, and/or params.
 */
export const validate = (schemas) => (req, res, next) => {
    try {
        if (schemas.body) {
            req.body = schemas.body.parse(req.body);
        }
        if (schemas.query) {
            req.query = schemas.query.parse(req.query);
        }
        if (schemas.params) {
            req.params = schemas.params.parse(req.params);
        }
        next();
    } catch (err) {
        if (err instanceof z.ZodError) {
            const errors = err.errors.map((e) => ({
                path: e.path.join('.'),
                message: e.message,
            }));
            return res.status(400).json({
                error: 'Validation failed',
                details: errors,
            });
        }
        next(err);
    }
};
