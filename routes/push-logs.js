const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../middleware/auth');

// All routes require login
router.use(requireLogin);

// GET / — return last 50 push logs for the current user, with channel name
router.get('/', (req, res) => {
  try {
    const logs = db.prepare(`
      SELECT pl.*, c.name AS channel_name
      FROM push_logs pl
      LEFT JOIN channels c ON pl.channel_id = c.id
      WHERE pl.user_id = ?
      ORDER BY pl.created_at DESC
      LIMIT 50
    `).all(req.session.userId);

    res.json({ success: true, data: logs });
  } catch (err) {
    console.error('Push logs error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

// GET /unread-count — 返回用户未读失败推送数
router.get('/unread-count', (req, res) => {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS cnt FROM push_logs
      WHERE user_id = ? AND status = 'failed' AND (read_state & 1) = 0
    `).get(req.session.userId);
    res.json({ success: true, data: { unread_failed: row.cnt } });
  } catch (err) {
    console.error('Unread count error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

// PATCH /:id/read — 标记单条为用户已读
router.patch('/:id/read', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid id' });
    }
    const info = db.prepare(`
      UPDATE push_logs SET read_state = read_state | 1
      WHERE id = ? AND user_id = ?
    `).run(id, req.session.userId);
    res.json({ success: true, data: { updated: info.changes } });
  } catch (err) {
    console.error('Mark read error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

// POST /mark-all-read — 批量标记所有失败推送为用户已读
router.post('/mark-all-read', (req, res) => {
  try {
    const info = db.prepare(`
      UPDATE push_logs SET read_state = read_state | 1
      WHERE user_id = ? AND status = 'failed' AND (read_state & 1) = 0
    `).run(req.session.userId);
    res.json({ success: true, data: { updated: info.changes } });
  } catch (err) {
    console.error('Mark all read error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

module.exports = router;
