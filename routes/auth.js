const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateSendKey } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../services/logger');

// ═══════════════════════════════════════════════════════════════════
//  注册（Email）
// ═══════════════════════════════════════════════════════════════════

// POST /register — 用 Email 注册，生成 SendKey
router.post('/register', (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.trim()) {
      return res.json({ success: false, error: '请输入邮箱地址' });
    }

    const trimmedEmail = email.trim().toLowerCase();

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmedEmail)) {
      return res.json({ success: false, error: '邮箱格式无效' });
    }

    // Check if email already registered
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(trimmedEmail);
    if (existing) {
      return res.json({ success: false, error: '该邮箱已注册' });
    }

    const sendKey = generateSendKey();
    const info = db.prepare('INSERT INTO users (email, send_key) VALUES (?, ?)').run(trimmedEmail, sendKey);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

    req.session.userId = user.id;

    logActivity(user.id, 'register', { method: 'email' }, req);

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        send_key: user.send_key,
      },
    });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  登录（SendKey）
// ═══════════════════════════════════════════════════════════════════

// POST /login — 用 SendKey 登录
router.post('/login', (req, res) => {
  try {
    const { send_key } = req.body;
    if (!send_key) {
      return res.json({ success: false, error: '请输入 SendKey' });
    }

    const user = db.prepare('SELECT * FROM users WHERE send_key = ?').get(send_key);
    if (!user) {
      return res.json({ success: false, error: 'SendKey 无效' });
    }

    req.session.userId = user.id;

    const channelCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ? AND status != 'inactive'"
    ).get(user.id).cnt;

    logActivity(user.id, 'login', { method: 'sendkey' }, req);

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        send_key: user.send_key,
        channel_count: channelCount,
      },
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  通用
// ═══════════════════════════════════════════════════════════════════

// GET /me — 当前登录用户信息
router.get('/me', requireLogin, (req, res) => {
  try {
    const user = db.prepare('SELECT id, email, send_key, role FROM users WHERE id = ?').get(req.session.userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const channelCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ? AND status != 'inactive'"
    ).get(user.id).cnt;

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        send_key: user.send_key,
        role: user.role || 'user',
        channel_count: channelCount,
      },
    });
  } catch (err) {
    console.error('/me error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// POST /logout — 退出登录
router.post('/logout', requireLogin, (req, res) => {
  const userId = req.session.userId;
  logActivity(userId, 'logout', null, req);

  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to logout' });
    }
    res.json({ success: true });
  });
});

module.exports = router;
