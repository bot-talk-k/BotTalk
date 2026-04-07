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

module.exports = router;
