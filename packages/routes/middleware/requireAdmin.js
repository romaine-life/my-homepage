const ADMIN_EMAIL = 'fullnelsongrip@gmail.com';

/**
 * Express middleware that restricts access to the admin user.
 * Must be placed after requireAuth so req.user is populated.
 */
export function requireAdmin(req, res, next) {
  if (req.user?.email !== ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
