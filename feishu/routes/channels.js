// 飞书通道:扫码绑定(Device Flow)+ 列出/改名/删。
//
// 扫码 = 创建一个全新飞书 app(= 一个通道)。同一个用户(session)可重复扫码挂任意多个通道。
// 首次扫码(未登录)→ 顺手建用户 + 发 SendKey + 自动登录;已登录扫码 → 只新增通道。
const express = require('express');
const router = express.Router();
const db = require('../db');
const { generateSendKey } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../services/logger');
const feishuAuth = require('../services/feishu-auth');
const feishuClient = require('../services/feishu-client');
const adminNotify = require('../services/admin-notify');

const MAX_CHANNELS = 20;

// deviceCode -> { sessionId, isLark }  (绑定防劫持 + 记住 domain)
const pendingBindings = new Map();

// ── 公开:扫码绑定(未登录也能扫,扫成功即注册+登录)──────────────────

// POST /feishu/start — 启动 Device Flow,返回 QR
router.post('/feishu/start', async (req, res) => {
  try {
    // 已登录用户校验通道上限
    if (req.session.userId) {
      const cnt = db.prepare(
        "SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ? AND status != 'inactive'"
      ).get(req.session.userId).cnt;
      if (cnt >= MAX_CHANNELS) {
        return res.status(400).json({ success: false, error: `最多 ${MAX_CHANNELS} 个通道` });
      }
    }
    // 未登录用户:强制保存 session(saveUninitialized:false)以便 poll 校验防劫持
    if (!req.session.userId) {
      req.session._feishuBind = true;
      await new Promise((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
    }

    const isLark = !!req.body.isLark;
    const r = await feishuAuth.startQrcode(isLark);
    pendingBindings.set(r.deviceCode, { sessionId: req.sessionID, isLark });
    res.json({ success: true, data: { url: r.url, deviceCode: r.deviceCode, interval: r.interval, expireIn: r.expireIn, isLark } });
  } catch (e) {
    console.error('feishu/start error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /feishu/poll — 轮询绑定;成功时落地通道(并在未登录时建用户+登录)
router.post('/feishu/poll', async (req, res) => {
  try {
    const { deviceCode } = req.body;
    if (!deviceCode) return res.status(400).json({ success: false, error: 'deviceCode required' });
    const pending = pendingBindings.get(deviceCode);
    if (!pending) return res.json({ success: true, data: { done: false, error: 'expired' } });
    if (pending.sessionId !== req.sessionID) {
      return res.status(403).json({ success: false, error: 'session mismatch' });
    }

    const r = await feishuAuth.pollBind(deviceCode, pending.isLark);
    if (!r.done) {
      return res.json({ success: true, data: { done: false, error: r.error || null } });
    }

    pendingBindings.delete(deviceCode);

    // ── 落地:已登录 → 仅加通道;未登录 → 建用户 + 登录 + 加首通道 ──
    let userId = req.session.userId;
    let isNewUser = false;
    let sendKey = null;
    if (!userId) {
      sendKey = generateSendKey();
      const now = new Date();
      const nickname = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') +
        String(now.getDate()).padStart(2, '0') + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      const info = db.prepare(
        'INSERT INTO users (feishu_open_id, send_key, nickname) VALUES (?, ?, ?)'
      ).run(r.openId || null, sendKey, nickname);
      userId = info.lastInsertRowid;
      req.session.userId = userId;
      isNewUser = true;
      logActivity(userId, 'register', { method: 'feishu_scan' }, req);
    }

    const cnt = db.prepare("SELECT COUNT(*) AS cnt FROM channels WHERE user_id = ?").get(userId).cnt;
    const isDefault = cnt === 0 ? 1 : 0;
    const name = `飞书通道 ${cnt + 1}`;
    const chInfo = db.prepare(
      `INSERT INTO channels (user_id, name, feishu_app_id, feishu_app_secret, feishu_domain, feishu_open_id, status, is_default)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`
    ).run(userId, name, r.appId, r.appSecret, r.domain, r.openId || null, isDefault);
    logActivity(userId, 'channel_add', { channel_id: chInfo.lastInsertRowid, domain: r.domain }, req);

    // 超管通知:新绑定
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const label = isNewUser ? '🎉 新用户注册' : '🔗 已有用户新增通道';
    adminNotify.send(`${label}\n\n昵称: ${isNewUser ? (db.prepare('SELECT nickname FROM users WHERE id=?').get(userId)||{}).nickname||'—' : '(已有用户)'}\n通道: ${name} (${r.domain})\n时间: ${now}`);

    const user = db.prepare('SELECT send_key FROM users WHERE id = ?').get(userId);

    // 把 SendKey 推进飞书 — fire-and-forget,不阻塞响应
    if (r.openId) {
      const baseUrl = process.env.BASE_URL || 'https://feishu.bot-talk.com';
      const welcomeMsg = isNewUser
        ? `🎉 绑定成功，欢迎使用 BotTalk！\n\n你的 SendKey：\n${user.send_key}\n\n请保存此消息，下次登录需要用到。\n\n推送示例：\ncurl "${baseUrl}/${user.send_key}.send?title=测试&desp=hello"`
        : `✅ 新通道「${name}」绑定成功\n\nSendKey（如已保存可忽略）：\n${user.send_key}`;
      feishuClient.sendText({
        appId: r.appId, appSecret: r.appSecret, domain: r.domain,
        receiveId: r.openId, receiveIdType: 'open_id', text: welcomeMsg,
      }).catch(e => console.error('welcome push failed:', e.message));
    }

    res.json({
      success: true,
      data: {
        done: true,
        is_new_user: isNewUser,
        send_key: user.send_key,
        channel: { id: chInfo.lastInsertRowid, name, domain: r.domain, is_default: isDefault, status: 'active' },
      },
    });
  } catch (e) {
    console.error('feishu/poll error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── 以下需登录 ───────────────────────────────────────────────────────
router.use(requireLogin);

function getOwned(channelId, userId) {
  return db.prepare('SELECT * FROM channels WHERE id = ? AND user_id = ?').get(channelId, userId);
}

// POST /feishu/test — 向用户默认通道发一条演示卡片消息,验证通道可用
router.post('/feishu/test', async (req, res) => {
  try {
    const ch = db.prepare(
      "SELECT * FROM channels WHERE user_id = ? AND status = 'active' AND is_default = 1 ORDER BY id DESC LIMIT 1"
    ).get(req.session.userId)
    || db.prepare("SELECT * FROM channels WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1").get(req.session.userId);
    if (!ch) return res.json({ success: false, error: '没有可用通道，请先扫码绑定' });

    const baseUrl = process.env.BASE_URL || 'https://feishu.bot-talk.com';
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '🎉 BotTalk 通道测试' },
        template: 'green',
      },
      elements: [
        {
          tag: 'div',
          text: { tag: 'lark_md', content: '**恭喜！你的飞书推送通道配置正确，消息已成功送达。**' },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content:
              '**📊 通道能力**\n\n' +
              '✅ **无限发送** — 无条数限制，不限流\n' +
              '✅ **无需回复** — 不用假装聊天保活\n' +
              '✅ **一账户多通道** — 按需添加，独立管理\n' +
              '✅ **HTTP 任意语言** — curl / Python / Node.js / Go',
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content:
              '**💡 发送一条消息只需：**\n\n' +
              '```\ncurl "' + baseUrl + '/YOUR_SENDKEY.send?title=Hello&desp=World"\n```',
          },
        },
        { tag: 'hr' },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '🌐 访问 BotTalk 官网' },
              type: 'primary',
              url: 'https://bot-talk.com',
            },
          ],
        },
      ],
    };
    const r = await feishuClient.sendCard({
      appId: ch.feishu_app_id, appSecret: ch.feishu_app_secret,
      domain: ch.feishu_domain, receiveId: ch.feishu_open_id,
      receiveIdType: 'open_id', card,
    });
    if (r.code === 0) {
      res.json({ success: true });
    } else {
      res.json({ success: false, error: `飞书返回 code=${r.code}: ${r.msg}` });
    }
  } catch (e) {
    console.error('test message error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET / — 列出当前用户的通道(脱敏 secret)
router.get('/', (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT id, name, feishu_app_id, feishu_domain, feishu_open_id, status, is_default, created_at FROM channels WHERE user_id = ? AND status != 'inactive' ORDER BY created_at DESC"
    ).all(req.session.userId);
    const channels = rows.map(c => ({
      id: c.id, name: c.name, domain: c.feishu_domain,
      app_id_masked: c.feishu_app_id ? c.feishu_app_id.slice(0, 10) + '…' : null,
      open_id_masked: c.feishu_open_id ? c.feishu_open_id.slice(0, 12) + '…' : null,
      status: c.status, is_default: c.is_default, created_at: c.created_at,
    }));
    res.json({ success: true, data: channels });
  } catch (err) {
    console.error('List channels error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

// PATCH /:id — 改名 / 设默认
router.patch('/:id', (req, res) => {
  try {
    const channel = getOwned(req.params.id, req.session.userId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
    const { name, is_default } = req.body;
    if (is_default === 1) {
      db.prepare('UPDATE channels SET is_default = 0 WHERE user_id = ?').run(req.session.userId);
    }
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

// DELETE /:id — 软删
router.delete('/:id', (req, res) => {
  try {
    const channel = getOwned(req.params.id, req.session.userId);
    if (!channel) return res.status(404).json({ success: false, error: 'Channel not found' });
    db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
    logActivity(req.session.userId, 'channel_delete', { channel_id: channel.id }, req);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete channel error:', err.message);
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

module.exports = router;
