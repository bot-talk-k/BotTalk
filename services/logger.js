const db = require('../db');

const insertStmt = db.prepare(`
  INSERT INTO activity_logs (user_id, action, detail, ip, user_agent)
  VALUES (?, ?, ?, ?, ?)
`);

/**
 * Log an activity to the activity_logs table.
 *
 * @param {number|null} userId
 * @param {string} action - e.g. 'login', 'push', 'channel.create'
 * @param {string|object|null} detail - extra info (objects are JSON-stringified)
 * @param {import('express').Request} [req] - Express request (for ip / user-agent)
 */
function logActivity(userId, action, detail, req) {
  try {
    const ip = req
      ? req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
      : null;
    const userAgent = req ? req.headers['user-agent'] || null : null;
    const detailStr = detail && typeof detail === 'object' ? JSON.stringify(detail) : (detail || null);

    insertStmt.run(userId || null, action, detailStr, ip || null, userAgent);
  } catch (err) {
    console.error('Failed to write activity log:', err.message);
  }
}

module.exports = { logActivity };
