/**
 * Admin authorization middleware.
 * Must be used after session middleware — checks that the logged-in user has role === 'admin'.
 */
const db = require('../db');

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
  }

  const user = db.prepare('SELECT role, is_disabled FROM users WHERE id = ?').get(req.session.userId);
  if (!user) {
    return res.status(401).json({ success: false, error: 'User not found.' });
  }
  if (user.is_disabled) {
    return res.status(403).json({ success: false, error: 'Account is disabled.' });
  }
  if (user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required.' });
  }

  next();
}

module.exports = { requireAdmin };
