// Portal 超管登录 — 单一密码(env PORTAL_ADMIN_PASSWORD),够用。
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// POST /login { password }
router.post('/login', (req, res) => {
  const expected = process.env.PORTAL_ADMIN_PASSWORD;
  if (!expected) return res.json({ success: false, error: '门户未配置管理密码(PORTAL_ADMIN_PASSWORD)' });
  const { password } = req.body || {};
  if (!password || !safeEqual(password, expected)) {
    return res.json({ success: false, error: '密码错误' });
  }
  req.session.isAdmin = true;
  res.json({ success: true });
});

// GET /me
router.get('/me', (req, res) => {
  res.json({ success: true, data: { isAdmin: !!(req.session && req.session.isAdmin) } });
});

// POST /logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

module.exports = router;
