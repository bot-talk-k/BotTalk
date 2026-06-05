// 推送历史 — 当前用户的 push_logs(分页)
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

router.use(requireLogin);

// GET /?limit=50&offset=0
router.get('/', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const rows = db.prepare(
      `SELECT p.id, p.channel_id, c.name AS channel_name, p.title, p.content, p.status, p.created_at
       FROM push_logs p LEFT JOIN channels c ON c.id = p.channel_id
       WHERE p.user_id = ? ORDER BY p.id DESC LIMIT ? OFFSET ?`
    ).all(req.session.userId, limit, offset);
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM push_logs WHERE user_id = ?').get(req.session.userId).cnt;
    res.json({ success: true, data: { logs: rows, total, limit, offset } });
  } catch (err) {
    console.error('push-logs error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

module.exports = router;
