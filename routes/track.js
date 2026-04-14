const express = require('express');
const axios = require('axios');
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

// ── IP 地理位置查询（内存缓存 + 异步更新 country 字段）─────────────
const ipCache = new Map(); // ip -> { country: string, ts: number }
const IP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时

function isPrivateIp(ip) {
  if (!ip) return true;
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|::1$|fe80:)/i.test(ip);
}

async function fetchCountry(ip) {
  if (isPrivateIp(ip)) return '本地';
  const cached = ipCache.get(ip);
  if (cached && Date.now() - cached.ts < IP_CACHE_TTL) return cached.country;
  try {
    // ip-api.com 免费版，中文返回，每分钟 45 次限制
    const res = await axios.get(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,country,regionName,city`, { timeout: 5000 });
    if (res.data && res.data.status === 'success') {
      const parts = [res.data.country, res.data.regionName, res.data.city].filter(Boolean);
      const country = parts.join(' ') || '未知';
      ipCache.set(ip, { country, ts: Date.now() });
      return country;
    }
  } catch (e) {
    // 静默失败
  }
  return null;
}

async function updateCountryAsync(ip) {
  if (!ip) return;
  const country = await fetchCountry(ip);
  if (country) {
    try {
      db.prepare('UPDATE page_views SET country = ? WHERE ip = ? AND (country IS NULL OR country = ?)').run(country, ip, '');
    } catch (e) {}
  }
}

// 后台回填任务：每 5 分钟扫一次 country 为空的记录，补查 ip-api
// 场景：容器重启清空 ipCache；首次 async 查询时 ip-api 限流/网络抖动；初始实装前的历史数据
async function backfillMissingCountries() {
  try {
    // 按最新访问倒序取独立 IP — 先查最近的访客，不浪费在历史数据上
    const rows = db.prepare(`
      SELECT ip FROM page_views
      WHERE (country IS NULL OR country = '') AND ip IS NOT NULL
      GROUP BY ip
      ORDER BY MAX(id) DESC
      LIMIT 20
    `).all();
    if (rows.length === 0) return;
    for (const { ip } of rows) {
      await updateCountryAsync(ip);
      // ip-api 免费档 45/min，保守每条 1.5s
      await new Promise(r => setTimeout(r, 1500));
    }
    console.log(`🌍 country 回填完成：扫描 ${rows.length} 个独立 IP`);
  } catch (e) {
    console.error('backfillMissingCountries 错误:', e.message);
  }
}

// 启动后 60s 跑一次，之后每 5 分钟
setTimeout(backfillMissingCountries, 60 * 1000);
setInterval(backfillMissingCountries, 5 * 60 * 1000);

// Allowed page identifiers
const VALID_PAGES = ['home', 'key_api', 'push_log', 'demo', 'admin', 'channels', 'intro'];

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

    // 异步更新地理位置（不阻塞响应）
    updateCountryAsync(ip).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('Track error:', err.message);
    res.json({ success: true }); // don't leak errors to client
  }
});

module.exports = router;
