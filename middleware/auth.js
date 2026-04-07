/**
 * Session-based authentication middleware.
 * Checks req.session.userId; returns 401 if not set.
 */
function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  next();
}

module.exports = { requireLogin };
