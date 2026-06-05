// 企业微信智能机器人 MVP 原型路由 — 仅 admin 可用,ENABLE_WECOM_PROTO=1 开关
//
// 数据存储: data/wecom-proto.json
//   { boundAt, botId, secret, capturedUserId }
//
// 注意: 企业微信智能机器人是 WS 长连接(见 ./client.js),进程重启需重新 connect。
// 本路由层只负责: 存凭证、触发 connect、转发主动发送、暴露收到的消息/事件给前端轮询。

const path = require('path');
const fs = require('fs');
const express = require('express');
const { requireAdmin } = require('../../middleware/requireAdmin');
const wsClient = require('./client');

const router = express.Router();
router.use(requireAdmin);

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'wecom-proto.json');

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    console.error('wecom-proto loadStore error:', e.message);
    return null;
  }
}

function saveStore(obj) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('wecom-proto saveStore error:', e.message);
  }
}

function mask(s) {
  if (!s) return '';
  return s.length > 8 ? s.slice(0, 8) + '…' : s;
}

function publicStatus() {
  const store = loadStore();
  const st = wsClient.getState();
  return {
    bound: !!store,
    botIdMasked: store ? mask(store.botId) : null,
    boundAt: store ? store.boundAt : null,
    connected: st.connected,
    authenticated: st.authenticated,
    isConnected: st.isConnected,
    lastError: st.lastError,
    capturedUserId: st.capturedUserId || (store && store.capturedUserId) || null,
    inboundCount: st.inbound.length,
  };
}

// ============ Endpoints ============

// GET /status — 绑定 + WS 连接状态(脱敏)
router.get('/status', (req, res) => {
  res.json({ success: true, data: publicStatus() });
});

// POST /bind — 浏览器扫码 SDK 拿到 {botId, secret} 后回传,落地并自动连接
// body: { botId, secret }
router.post('/bind', (req, res) => {
  const { botId, secret } = req.body || {};
  if (!botId || !secret) {
    return res.status(400).json({ success: false, error: 'botId / secret required' });
  }
  try {
    saveStore({ boundAt: new Date().toISOString(), botId, secret, capturedUserId: null });
    wsClient.connect({ botId, secret });
    console.log(`🧪 wecom-proto 绑定 + 连接中 botId=${mask(botId)}`);
    res.json({ success: true, data: publicStatus() });
  } catch (e) {
    console.error('wecom-proto bind error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /connect — 用已存凭证(重新)建立 WS 长连接(进程重启后用)
router.post('/connect', (req, res) => {
  const store = loadStore();
  if (!store) return res.status(400).json({ success: false, error: 'not bound yet — 先扫码绑定' });
  try {
    wsClient.connect({ botId: store.botId, secret: store.secret });
    res.json({ success: true, data: publicStatus() });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /disconnect — 断开 WS(诊断用)
router.post('/disconnect', (req, res) => {
  wsClient.disconnect();
  res.json({ success: true, data: publicStatus() });
});

// GET /inbound — 收到的消息 + 事件(前端轮询,证明双向 / 抓 userid)
router.get('/inbound', (req, res) => {
  const st = wsClient.getState();
  res.json({
    success: true,
    data: { inbound: st.inbound, events: st.events, capturedUserId: st.capturedUserId },
  });
});

// POST /send — 主动推送(单条或连发压测)
// body: { text, count?: number, chatid?: string }
//   - chatid 不传则用捕获到的 capturedUserId
//   - count 默认 1,上限 50
router.post('/send', async (req, res) => {
  const store = loadStore();
  if (!store) return res.status(400).json({ success: false, error: 'not bound yet — 先扫码绑定' });

  const st = wsClient.getState();
  const text = req.body && req.body.text;
  const count = Math.min(parseInt(req.body && req.body.count, 10) || 1, 50);
  const chatid = (req.body && req.body.chatid) || st.capturedUserId;
  if (!text) return res.status(400).json({ success: false, error: 'text required' });
  if (!chatid) {
    return res.status(400).json({
      success: false,
      error: '无发送目标 — 请先在企业微信里打开机器人会话并发一句话,以捕获你的 userid',
    });
  }

  const results = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? `${text} [${i + 1}/${count}]` : text;
    try {
      const r = await wsClient.sendMarkdown(chatid, t);
      results.push({
        idx: i + 1,
        at: new Date().toISOString(),
        text: t,
        success: r && r.errcode === 0,
        errcode: r && r.errcode,
        errmsg: r && r.errmsg,
      });
    } catch (e) {
      results.push({ idx: i + 1, at: new Date().toISOString(), text: t, success: false, error: e.message });
    }
    // 串行间隔 500ms(限频 30/min,留余量)
    if (count > 1 && i < count - 1) await new Promise((r) => setTimeout(r, 500));
  }

  const succeeded = results.filter((r) => r.success).length;
  res.json({
    success: true,
    data: { sent: results.length, succeeded, failed: results.length - succeeded, chatid, results },
  });
});

// POST /reset — 断开 + 清除绑定(重测用)
router.post('/reset', (req, res) => {
  try {
    wsClient.disconnect();
    if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
