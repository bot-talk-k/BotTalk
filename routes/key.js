const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateSendKey } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../services/logger');

// All routes require login
router.use(requireLogin);

// GET / — return the user's send_key
router.get('/', (req, res) => {
  try {
    const user = db.prepare('SELECT send_key FROM users WHERE id = ?').get(req.session.userId);
    if (!user) {
      return res.status(404).json({ success: false, data: { error: 'User not found' } });
    }
    res.json({ success: true, data: { send_key: user.send_key } });
  } catch (err) {
    console.error('Get key error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

// POST /reset — generate a new send_key
router.post('/reset', (req, res) => {
  try {
    const newKey = generateSendKey();
    db.prepare('UPDATE users SET send_key = ? WHERE id = ?').run(newKey, req.session.userId);

    logActivity(req.session.userId, 'key_reset', null, req);

    res.json({ success: true, data: { send_key: newKey } });
  } catch (err) {
    console.error('Reset key error:', err.message);
    res.status(500).json({ success: false, data: { error: 'Internal error' } });
  }
});

module.exports = router;
