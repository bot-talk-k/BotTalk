// Session 登录中间件 + 超管中间件
const db = require('../db');

function requireLogin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, error: '未登录' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, error: '未登录' });
  }
  const user = db.prepare('SELECT role, is_disabled FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ success: false, error: '用户不存在' });
  if (user.is_disabled) return res.status(403).json({ success: false, error: '账号已禁用' });
  if (user.role !== 'admin') return res.status(403).json({ success: false, error: '需要超管权限' });
  next();
}

module.exports = { requireLogin, requireAdmin };
