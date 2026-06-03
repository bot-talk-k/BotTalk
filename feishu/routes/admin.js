// 超管台 — 用户/通道/推送统计(独立于微信站超管)
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

// GET /stats — 总览
router.get('/stats', (req, res) => {
  try {
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const channels = db.prepare("SELECT COUNT(*) AS c FROM channels WHERE status = 'active'").get().c;
    const pushes = db.prepare('SELECT COUNT(*) AS c FROM push_logs').get().c;
    const pushOk = db.prepare("SELECT COUNT(*) AS c FROM push_logs WHERE status = 'success'").get().c;
    const pushes24h = db.prepare("SELECT COUNT(*) AS c FROM push_logs WHERE created_at > datetime('now','-1 day')").get().c;
    res.json({ success: true, data: { users, channels, pushes, push_success: pushOk, pushes_24h: pushes24h } });
  } catch (err) {
    console.error('admin stats error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// GET /users — 用户列表(含通道数)
router.get('/users', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT u.id, u.nickname, u.feishu_open_id, u.role, u.is_disabled, u.created_at,
             (SELECT COUNT(*) FROM channels c WHERE c.user_id = u.id AND c.status='active') AS channel_count,
             (SELECT COUNT(*) FROM push_logs p WHERE p.user_id = u.id) AS push_count
      FROM users u ORDER BY u.id DESC
    `).all();
    res.json({ success: true, data: rows.map(u => ({
      ...u,
      feishu_open_id: u.feishu_open_id ? u.feishu_open_id.slice(0, 12) + '…' : null,
    })) });
  } catch (err) {
    console.error('admin users error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// PATCH /users/:id — 设角色/禁用
router.patch('/users/:id', (req, res) => {
  try {
    const { role, is_disabled } = req.body;
    const updates = [], params = [];
    if (role !== undefined) {
      if (!['user', 'admin'].includes(role)) return res.json({ success: false, error: 'role 只能是 user 或 admin' });
      updates.push('role = ?'); params.push(role);
    }
    if (is_disabled !== undefined) { updates.push('is_disabled = ?'); params.push(is_disabled ? 1 : 0); }
    if (!updates.length) return res.json({ success: false, error: '无更新字段' });
    params.push(req.params.id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true, data: db.prepare('SELECT id, role, is_disabled FROM users WHERE id = ?').get(req.params.id) });
  } catch (err) {
    console.error('admin patch user error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// GET /push-logs — 全部用户最近 200 条推送记录
router.get('/push-logs', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id, p.user_id, u.nickname, p.title, p.content, p.status,
             p.channel_id, c.name AS channel_name, p.created_at
      FROM push_logs p
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN channels c ON c.id = p.channel_id
      ORDER BY p.id DESC LIMIT 200
    `).all();
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('admin push-logs error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// GET /recent — 最近 50 条活动(注册/扫码/推送/页面访问)
router.get('/recent', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT a.id, a.user_id, u.nickname, a.action, a.detail, a.ip, a.created_at
      FROM activity_logs a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 50
    `).all();
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('admin recent error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// GET /pageviews — 近 7 天页面访问分 intro/app 汇总
router.get('/pageviews', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT detail AS page,
             SUM(CASE WHEN created_at > datetime('now','-1 day') THEN 1 ELSE 0 END) AS today,
             SUM(CASE WHEN created_at > datetime('now','-7 days') THEN 1 ELSE 0 END) AS week,
             COUNT(*) AS total
      FROM activity_logs WHERE action = 'page_view'
      GROUP BY detail
    `).all();
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('admin pageviews error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

module.exports = router;
