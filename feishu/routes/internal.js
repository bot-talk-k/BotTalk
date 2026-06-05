// 内部只读统计 — 供 portal 综合看板聚合。X-Internal-Token 鉴权(bottalk-shared 网络内调用)。
const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/stats', (req, res) => {
  const token = process.env.INTERNAL_STATS_TOKEN;
  if (!token || req.headers['x-internal-token'] !== token) {
    return res.status(403).json({ success: false, error: 'forbidden' });
  }
  try {
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const channelsActive = db.prepare("SELECT COUNT(*) AS c FROM channels WHERE status = 'active'").get().c;
    const pushes24h = db.prepare("SELECT COUNT(*) AS c FROM push_logs WHERE created_at > datetime('now','-1 day')").get().c;
    const pushTotal = db.prepare('SELECT COUNT(*) AS c FROM push_logs').get().c;
    const pushSuccess = db.prepare("SELECT COUNT(*) AS c FROM push_logs WHERE status = 'success'").get().c;
    res.json({
      success: true,
      data: {
        channel: 'feishu',
        users,
        channels_active: channelsActive,
        channels_pending: 0,
        pushes_24h: pushes24h,
        push_total: pushTotal,
        push_success: pushSuccess,
        success_rate: pushTotal ? Math.round((pushSuccess * 100) / pushTotal) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
