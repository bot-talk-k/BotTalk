// 企业微信通道:扫码绑定(浏览器 SDK 在前端拿 botid/secret,后端只接收)+ 列出/改名/删。
//
// 与飞书差异:飞书是 Node 端 Device Flow 轮询;企业微信是浏览器弹窗 SDK
// (@wecom/wecom-aibot-sdk 的 openBotInfoAuthWindow)在前端完成,返回 {botid, secret}。
// 后端 /wecom/bind 落库 + 起 WS 连接池。userid 不在扫码里,靠 WS 捕获(见 wecom-pool)。
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateSendKey } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../services/logger');
const pool = require('../services/wecom-pool');
const adminNotify = require('../services/admin-notify');

const MAX_CHANNELS = 20;

// ── 公开:绑定(未登录也能绑,绑成功即注册+登录)──────────────────────
// POST /wecom/bind  { botId, secret }
router.post('/wecom/bind', (req, res) => {
  try {
    const botId = (req.body && req.body.botId || '').trim();
    const secret = (req.body && req.body.secret || '').trim();
    if (!botId || !secret) return res.status(400).json({ success: false, error: 'botId / secret 缺失' });

    if (req.session.userId) {
      const cnt = db.prepare(
        "SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ? AND status != 'inactive'"
      ).get(req.session.userId).cnt;
      if (cnt >= MAX_CHANNELS) return res.status(400).json({ success: false, error: `最多 ${MAX_CHANNELS} 个通道` });
    }

    // 落地:未登录 → 建用户 + 登录;已登录 → 仅加通道
    let userId = req.session.userId;
    let isNewUser = false;
    if (!userId) {
      const sendKey = generateSendKey();
      const now = new Date();
      const nickname = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      const info = db.prepare('INSERT INTO users (send_key, nickname) VALUES (?, ?)').run(sendKey, nickname);
      userId = info.lastInsertRowid;
      req.session.userId = userId;
      isNewUser = true;
      logActivity(userId, 'register', { method: 'wecom_scan' }, req);
    }

    const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ?').get(userId).cnt;
    const isDefault = cnt === 0 ? 1 : 0;
    const name = `企业微信通道 ${cnt + 1}`;
    const chInfo = db.prepare(
      `INSERT INTO channels (user_id, name, wecom_bot_id, wecom_secret, status, is_default)
       VALUES (?, ?, ?, ?, 'pending_userid', ?)`
    ).run(userId, name, botId, secret, isDefault);
    const channelId = chInfo.lastInsertRowid;
    logActivity(userId, 'channel_add', { channel_id: channelId }, req);

    // 起 WS 长连接(异步,前端轮询 status 等捕获 userid)
    try { pool.ensure(db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId)); }
    catch (e) { console.error('pool.ensure on bind failed:', e.message); }

    const nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const label = isNewUser ? '🎉 新用户注册(企业微信)' : '🔗 已有用户新增企业微信通道';
    adminNotify.send(`${label}\n\n通道: ${name}\n时间: ${nowStr}`);

    const user = db.prepare('SELECT send_key FROM users WHERE id = ?').get(userId);
    res.json({
      success: true,
      data: {
        done: true,
        is_new_user: isNewUser,
        send_key: user.send_key,
        channel: { id: channelId, name, status: 'pending_userid', is_default: isDefault },
      },
    });
  } catch (e) {
    console.error('wecom/bind error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 以下需登录 ───────────────────────────────────────────────────────
router.use(requireLogin);

function getOwned(channelId, userId) {
  return db.prepare('SELECT * FROM channels WHERE id = ? AND user_id = ?').get(channelId, userId);
}

// GET / — 列出当前用户通道(脱敏 + 运行态)
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT id, name, wecom_bot_id, captured_userid, status, is_default, created_at FROM channels WHERE user_id = ? AND status != 'inactive' ORDER BY created_at DESC"
    ).all(req.session.userId);
    const channels = rows.map(c => {
      const st = pool.getState(c.id);
      return {
        id: c.id, name: c.name,
        bot_id_masked: c.wecom_bot_id ? c.wecom_bot_id.slice(0, 10) + '…' : null,
        userid_captured: !!c.captured_userid,
        status: c.status, // pending_userid / active
        ws_authenticated: st.authenticated,
        is_default: c.is_default, created_at: c.created_at,
      };
    });
    res.json({ success: true, data: channels });
  } catch (err) {
    console.error('List channels error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// POST /wecom/test — 给默认通道发一条测试消息(需已激活)
router.post('/wecom/test', async (req, res) => {
  try {
    const ch = db.prepare(
      "SELECT * FROM channels WHERE user_id = ? AND status = 'active' AND is_default = 1 ORDER BY id DESC LIMIT 1"
    ).get(req.session.userId)
    || db.prepare("SELECT * FROM channels WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(req.session.userId);
    if (!ch) return res.json({ success: false, error: '没有已激活通道。请先扫码绑定,并在企业微信给机器人发一句话激活。' });
    const md = '**🎉 BotTalk 企业微信通道测试**\n\n你的推送通道配置正确,消息已送达。\n\n✅ 无条数限制 · ✅ 激活后无需回复 · ✅ HTTP 任意语言';
    const r = await pool.send(ch.id, md);
    if (r && r.errcode === 0) res.json({ success: true });
    else res.json({ success: false, error: `企业微信返回 errcode=${r && r.errcode}: ${r && r.errmsg}` });
  } catch (e) {
    const map = { pending_userid: '通道未激活——请在企业微信给机器人发一句话', ws_not_ready: 'WS 连接未就绪,请稍候重试' };
    res.json({ success: false, error: map[e.code] || e.message });
  }
});

// PATCH /:id — 改名 / 设默认
router.patch('/:id', (req, res) => {
  try {
    const channel = getOwned(req.params.id, req.session.userId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
    const { name, is_default } = req.body;
    if (is_default === 1) db.prepare('UPDATE channels SET is_default = 0 WHERE user_id = ?').run(req.session.userId);
    const updates = [], params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(String(name).trim().substring(0, 40)); }
    if (is_default !== undefined) { updates.push('is_default = ?'); params.push(is_default ? 1 : 0); }
    if (updates.length) { params.push(channel.id); db.prepare(`UPDATE channels SET ${updates.join(', ')} WHERE id = ?`).run(...params); }
    res.json({ success: true, data: db.prepare('SELECT id, name, is_default FROM channels WHERE id = ?').get(channel.id) });
  } catch (err) {
    console.error('Update channel error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// DELETE /:id — 软删 + 断开 WS
router.delete('/:id', (req, res) => {
  try {
    const channel = getOwned(req.params.id, req.session.userId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
    db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
    pool.remove(channel.id);
    logActivity(req.session.userId, 'channel_delete', { channel_id: channel.id }, req);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete channel error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

module.exports = router;
