/**
 * requireSuperAdmin — gate for /api/super-admin/* routes.
 * Assumes authMiddleware has already populated req.user.
 */
export function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'SUPER_ADMIN') {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'Super Admin access required.' },
    });
  }
  next();
}
