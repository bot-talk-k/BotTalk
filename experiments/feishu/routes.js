// 飞书 MVP 原型路由 — 仅 admin 可用,默认通过 ENABLE_FEISHU_PROTO=1 开关
//
// 数据存储: data/feishu-proto.json (MVP 用单文件,生产版会迁到 channels 表)
//   {
//     boundAt: ISO,
//     appId, appSecret, domain ('feishu'|'lark'), openId,
//     pollerLog: [{ at, code, msg }],
//     sendLog:   [{ at, text, code, msg, httpStatus }]
//   }

const path = require('path');
const fs = require('fs');
const express = require('express');
const { requireAdmin } = require('../../middleware/requireAdmin');
const { startQrcode, pollBind, validateCredentials } = require('./auth');
const { sendText, listChats } = require('./client');

const router = express.Router();
router.use(requireAdmin);

const STORE_PATH = path.join(__dirname, '..', '..', 'data', 'feishu-proto.json');

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    console.error('feishu-proto loadStore error:', e.message);
    return null;
  }
}

function saveStore(obj) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.error('feishu-proto saveStore error:', e.message);
  }
}

// 工具: 把 appId 脱敏到前 8 位
function maskAppId(appId) {
  if (!appId) return '';
  return appId.length > 8 ? appId.slice(0, 8) + '…' : appId;
}

// 工具: store 公开化(隐藏 secret)
function publicStore(s) {
  if (!s) return { bound: false };
  return {
    bound: true,
    boundAt: s.boundAt,
    appIdMasked: maskAppId(s.appId),
    domain: s.domain,
    openIdMasked: s.openId ? s.openId.slice(0, 12) + '…' : null,
    sendCount: (s.sendLog || []).length,
    lastSend: s.sendLog && s.sendLog.length ? s.sendLog[s.sendLog.length - 1] : null,
  };
}

// ============ Endpoints ============

// GET /api/feishu-proto/status — 当前绑定状态(脱敏)
router.get('/status', (req, res) => {
  res.json({ success: true, data: publicStore(loadStore()) });
});

// POST /api/feishu-proto/qrcode/start — 启动 Device Flow,返回 QR
// body: { isLark?: boolean }   默认 feishu 国内
router.post('/qrcode/start', async (req, res) => {
  try {
    const isLark = !!req.body.isLark;
    const r = await startQrcode(isLark);
    res.json({ success: true, data: { ...r, isLark } });
  } catch (e) {
    console.error('feishu-proto qrcode/start error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/feishu-proto/qrcode/poll — 轮询绑定,成功时落地
// body: { deviceCode, isLark? }
router.post('/qrcode/poll', async (req, res) => {
  try {
    const { deviceCode, isLark } = req.body;
    if (!deviceCode) return res.status(400).json({ success: false, error: 'deviceCode required' });
    const r = await pollBind(deviceCode, !!isLark);
    if (r.done) {
      const store = {
        boundAt: new Date().toISOString(),
        appId: r.appId,
        appSecret: r.appSecret,
        domain: r.domain,
        openId: r.openId,
        sendLog: [],
      };
      saveStore(store);
      console.log(`✅ feishu-proto 绑定成功 appId=${maskAppId(r.appId)} domain=${r.domain}`);
    }
    res.json({ success: true, data: { done: r.done, error: r.error, public: r.done ? publicStore(loadStore()) : null } });
  } catch (e) {
    console.error('feishu-proto qrcode/poll error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/feishu-proto/send — 发消息(单条或多条压测)
// body: { text, count?: number, receiveId?: string, receiveIdType?: string }
//   - 不传 receiveId 默认用绑定时拿到的 openId
//   - count 默认 1, 限制 50 (防误操作)
router.post('/send', async (req, res) => {
  const store = loadStore();
  if (!store) return res.status(400).json({ success: false, error: 'not bound yet — 先扫码绑定' });

  const { text, receiveIdType } = req.body;
  const count = Math.min(parseInt(req.body.count, 10) || 1, 50);
  const receiveId = req.body.receiveId || store.openId;
  if (!text) return res.status(400).json({ success: false, error: 'text required' });
  if (!receiveId) return res.status(400).json({ success: false, error: 'receiveId 缺失(绑定未返回 openId 时需手动传)' });

  const results = [];
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? `${text} [${i + 1}/${count}]` : text;
    let result;
    try {
      const r = await sendText({
        appId: store.appId,
        appSecret: store.appSecret,
        domain: store.domain,
        receiveId,
        receiveIdType: receiveIdType || 'open_id',
        text: t,
      });
      result = {
        idx: i + 1,
        at: new Date().toISOString(),
        text: t,
        success: r.code === 0,
        httpStatus: r.httpStatus,
        code: r.code,
        msg: r.msg,
      };
    } catch (e) {
      result = {
        idx: i + 1,
        at: new Date().toISOString(),
        text: t,
        success: false,
        error: e.message,
      };
    }
    results.push(result);
    // 限流压测时每条间隔 500ms (跟前端 setInterval 一致,但前端是并行调度,后端串行更稳)
    if (count > 1 && i < count - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // 把结果追加到 sendLog (限制最多保留最近 200 条)
  const log = (store.sendLog || []).concat(results.map(r => ({
    at: r.at, text: r.text, success: r.success, httpStatus: r.httpStatus, code: r.code, msg: r.msg, error: r.error,
  })));
  store.sendLog = log.slice(-200);
  saveStore(store);

  const successCount = results.filter(r => r.success).length;
  res.json({
    success: true,
    data: {
      sent: results.length,
      succeeded: successCount,
      failed: results.length - successCount,
      results,
    },
  });
});

// POST /api/feishu-proto/list-chats — 列出 bot 所在的 chat(没 openId 时用 chat_id 兜底)
router.post('/list-chats', async (req, res) => {
  const store = loadStore();
  if (!store) return res.status(400).json({ success: false, error: 'not bound yet' });
  try {
    const r = await listChats({ appId: store.appId, appSecret: store.appSecret, domain: store.domain });
    res.json({ success: true, data: r });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/feishu-proto/verify — 验证当前存储的凭证有效性(诊断用)
router.post('/verify', async (req, res) => {
  const store = loadStore();
  if (!store) return res.status(400).json({ success: false, error: 'not bound yet' });
  try {
    const valid = await validateCredentials(store.appId, store.appSecret);
    res.json({ success: true, data: { valid } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/feishu-proto/reset — 清除当前绑定(便于重测)
router.post('/reset', (req, res) => {
  try {
    if (fs.existsSync(STORE_PATH)) fs.unlinkSync(STORE_PATH);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
