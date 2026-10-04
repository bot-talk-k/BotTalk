const db = require('../db');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const insertActivityStmt = db.prepare(`
  INSERT INTO activity_logs (user_id, action, detail, ip, user_agent)
  VALUES (?, ?, ?, ?, ?)
`);

function configuredLevel() {
  const level = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[level] ? level : 'info';
}

function enabled(level) {
  return LEVELS[level] >= LEVELS[configuredLevel()];
}

function write(level, ...args) {
  if (!enabled(level)) return;
  const method = level === 'debug' ? 'log' : level;
  console[method](...args);
}

/**
 * Persist an application activity without interrupting its primary request.
 * Objects are stored as JSON; request metadata is optional for non-HTTP calls.
 */
function logActivity(userId, action, detail, req) {
  try {
    const ip = req
      ? req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
      : null;
    const userAgent = req ? req.headers['user-agent'] || null : null;
    const detailStr = detail && typeof detail === 'object' ? JSON.stringify(detail) : (detail || null);
    insertActivityStmt.run(userId || null, action, detailStr, ip || null, userAgent);
    write('debug', `🧾 activity ${action}`);
  } catch (error) {
    write('error', 'Failed to write activity log:', error.message);
  }
}

module.exports = {
  debug: (...args) => write('debug', ...args),
  info: (...args) => write('info', ...args),
  warn: (...args) => write('warn', ...args),
  error: (...args) => write('error', ...args),
  enabled,
  logActivity,
};
