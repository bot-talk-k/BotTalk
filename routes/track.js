const express = require('express');
const router = express.Router();
const db = require('../db');

// ── Rate-limit map: key = "ip|page" → last timestamp ────────────────
const recentHits = new Map();

// Clean up old entries every 60 seconds
setInterval(() => {
  const cutoff = Date.now() - 5000;
  for (const [key, ts] of recentHits) {
    if (ts < cutoff) recentHits.delete(key);
  }
}, 60000);

const insertStmt = db.prepare(`
  INSERT INTO page_views (page, tab, user_id, ip, user_agent, referer)
  VALUES (?, ?, ?, ?, ?, ?)
`);

// Allowed page identifiers
const VALID_PAGES = ['home', 'key_api', 'push_log', 'demo', 'admin', 'channels'];

// ═══════════════════════════════════════════════════════════════════
//  POST /api/track — record a page view (no auth required)
// ═══════════════════════════════════════════════════════════════════

router.post('/', (req, res) => {
  try {
    const { page, tab } = req.body || {};

    if (!page || typeof page !== 'string') {
      return res.json({ success: false, error: 'page is required' });
    }

    // Only allow known page identifiers
    if (!VALID_PAGES.includes(page)) {
      return res.json({ success: false, error: 'invalid page' });
    }

    const ip = req.headers['x-real-ip']
      || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.ip;

    // Rate-limit: same IP + same page within 1 second
    const rateKey = `${ip}|${page}`;
    const now = Date.now();
    const last = recentHits.get(rateKey);
    if (last && now - last < 1000) {
      return res.json({ success: true }); // silently skip
    }
    recentHits.set(rateKey, now);

    const userId = (req.session && req.session.userId) || null;
    const userAgent = req.headers['user-agent'] || null;
    const referer = req.headers['referer'] || req.headers['referrer'] || null;

    insertStmt.run(
      page,
      tab || null,
      userId,
      ip || null,
      userAgent,
      referer
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Track error:', err.message);
    res.json({ success: true }); // don't leak errors to client
  }
});

module.exports = router;
