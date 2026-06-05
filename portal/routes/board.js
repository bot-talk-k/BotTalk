// 综合看板 — 超管聚合各渠道 internal 只读统计。
// 各渠道独立:某渠道挂/超时 → 该卡标 offline,不影响其它(Promise 各自 catch)。
const express = require('express');
const router = express.Router();
const axios = require('axios');

// 渠道注册表。internal 为容器内网地址(bottalk-shared 网络);admin 为公网深链。
// 微信冻结站不接入 internal 统计,只放深链。
const CHANNELS = [
  {
    key: 'wechat', name: '微信', color: '#07c160',
    site: process.env.WECHAT_SITE_URL || 'https://bot-talk.com',
    // 微信站 admin 是静态页 admin.html(无 /admin 路由,区别于 feishu/wecom)
    admin: (process.env.WECHAT_SITE_URL || 'https://bot-talk.com') + '/admin.html',
    internal: null, note: '冻结站,未接入聚合统计',
  },
  {
    key: 'feishu', name: '飞书', color: '#00b386',
    site: 'https://feishu.bot-talk.com',
    admin: 'https://feishu.bot-talk.com/admin',
    internal: 'http://bottalk-feishu:3000/api/internal/stats',
  },
  {
    key: 'wecom', name: '企业微信', color: '#2f90ea',
    site: 'https://wecom.bot-talk.com',
    admin: 'https://wecom.bot-talk.com/admin',
    internal: 'http://bottalk-wecom:3000/api/internal/stats',
  },
];

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.isAdmin) return res.status(401).json({ success: false, error: '未登录' });
  next();
}

// GET /summary — 各渠道 meta + 实时基本统计(或 offline)
router.get('/summary', requireAdmin, async (req, res) => {
  const token = process.env.INTERNAL_STATS_TOKEN;
  const results = await Promise.all(CHANNELS.map(async (ch) => {
    const meta = { key: ch.key, name: ch.name, color: ch.color, site: ch.site, admin: ch.admin, note: ch.note || null };
    if (!ch.internal) return { ...meta, stats: null, status: 'no_stats' };
    if (!token) return { ...meta, stats: null, status: 'no_token' };
    try {
      const r = await axios.get(ch.internal, { headers: { 'x-internal-token': token }, timeout: 4000 });
      if (r.data && r.data.success) return { ...meta, stats: r.data.data, status: 'online' };
      return { ...meta, stats: null, status: 'error' };
    } catch (e) {
      return { ...meta, stats: null, status: 'offline' };
    }
  }));
  res.json({ success: true, data: { channels: results } });
});

module.exports = router;
