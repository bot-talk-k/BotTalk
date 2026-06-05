// 认证:SendKey 登录 + 当前用户 + 登出。
// (企业微信扫码注册-登录在 routes/channels.js 的 /wecom/bind —— 扫码同时建用户/建通道/登录)
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../services/logger');

// POST /login — 用 SendKey 登录
router.post('/login', (req, res) => {
  try {
    const { send_key } = req.body;
    if (!send_key) return res.json({ success: false, error: '请输入 SendKey' });

    const user = db.prepare('SELECT * FROM users WHERE send_key = ?').get(send_key.trim());
    if (!user) return res.json({ success: false, error: 'SendKey 无效' });
    if (user.is_disabled) return res.json({ success: false, error: '账号已禁用' });

    req.session.userId = user.id;
    const channelCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ? AND status != 'inactive'"
    ).get(user.id).cnt;
    logActivity(user.id, 'login', { method: 'sendkey' }, req);

    res.json({
      success: true,
      data: { id: user.id, send_key: user.send_key, nickname: user.nickname || null, channel_count: channelCount },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// GET /me — 当前登录用户
router.get('/me', requireLogin, (req, res) => {
  try {
    const user = db.prepare('SELECT id, send_key, role, nickname FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    const channelCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ? AND status != 'inactive'"
    ).get(user.id).cnt;
    res.json({
      success: true,
      data: { id: user.id, send_key: user.send_key, role: user.role || 'user', nickname: user.nickname || null, channel_count: channelCount },
    });
  } catch (err) {
    console.error('/me error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// PATCH /me — 更新昵称
router.patch('/me', requireLogin, (req, res) => {
  try {
    let { nickname } = req.body;
    if (nickname !== undefined) {
      nickname = String(nickname).trim().substring(0, 20) || null;
      db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, req.session.userId);
      logActivity(req.session.userId, 'update_nickname', { nickname }, req);
    }
    const user = db.prepare('SELECT id, nickname FROM users WHERE id = ?').get(req.session.userId);
    res.json({ success: true, data: { id: user.id, nickname: user.nickname } });
  } catch (err) {
    console.error('/me patch error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// POST /logout
router.post('/logout', requireLogin, (req, res) => {
  const userId = req.session.userId;
  logActivity(userId, 'logout', null, req);
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ success: false, error: 'Failed to logout' });
    res.json({ success: true });
  });
});

module.exports = router;
