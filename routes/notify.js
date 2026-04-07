const express = require('express');
const router = express.Router();
const db = require('../db');
const ilink = require('../ilink');
const { logActivity } = require('../services/logger');

// 简单内存限流：每 Key 每小时最多 100 条
const rateLimits = {};
function checkRateLimit(sendKey) {
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const key = `${sendKey}:${hour}`;
  rateLimits[key] = (rateLimits[key] || 0) + 1;
  for (const k in rateLimits) {
    if (!k.endsWith(`:${hour}`)) delete rateLimits[k];
  }
  return rateLimits[key] <= 100;
}

// 解析目标 channels
function resolveChannels(userId, channelParam) {
  if (!channelParam || channelParam === 'default') {
    // 默认频道
    const ch = db.prepare(
      `SELECT * FROM channels WHERE user_id = ? AND is_default = 1 AND status = 'active'`
    ).get(userId);
    return ch ? [ch] : [];
  }

  if (channelParam === 'all') {
    return db.prepare(
      `SELECT * FROM channels WHERE user_id = ? AND status = 'active'`
    ).all(userId);
  }

  // 逗号分隔的 ID 列表
  const ids = channelParam.split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM channels WHERE id IN (${placeholders}) AND user_id = ? AND status = 'active'`
  ).all(...ids, userId);
}

// 核心推送逻辑
async function handlePush(sendKey, title, content, clientIp, channelParam, req) {
  const user = db.prepare('SELECT * FROM users WHERE send_key = ?').get(sendKey);
  if (!user) {
    return { code: 40001, message: 'SendKey 无效', data: null };
  }

  if (!checkRateLimit(sendKey)) {
    return { code: 42901, message: '发送频率超限（每小时最多100条）', data: null };
  }

  if (!title && !content) {
    return { code: 40003, message: 'title 和消息内容不能同时为空', data: null };
  }

  const channels = resolveChannels(user.id, channelParam);
  if (channels.length === 0) {
    return { code: 40002, message: '没有可用的推送通道，请先绑定并激活通道', data: null };
  }

  const message = title + (content ? '\n\n' + content : '');
  const results = [];

  for (const channel of channels) {
    if (!channel.context_token) {
      results.push({ channel_id: channel.id, status: 'skipped', reason: 'no context_token' });
      continue;
    }

    try {
      let ilinkRes;
      try {
        ilinkRes = await ilink.sendMessage(channel.bot_token, channel.wechat_openid, message, channel.context_token);
      } catch (retryErr) {
        // ret: -2 时等 1 秒自动重试一次
        if (retryErr.response?.data?.ret === -2) {
          console.log(`⏳ 通道 ${channel.id} ret:-2，1秒后重试...`);
          await new Promise(r => setTimeout(r, 1000));
          ilinkRes = await ilink.sendMessage(channel.bot_token, channel.wechat_openid, message, channel.context_token);
        } else {
          throw retryErr;
        }
      }
      const resJson = JSON.stringify(ilinkRes);

      db.prepare(`
        INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
        VALUES (?, ?, ?, 'success', ?, ?, ?)
      `).run(user.id, title, content, clientIp, channel.id, resJson);

      logActivity(user.id, 'push_api', { channel_id: channel.id, title }, req);
      results.push({ channel_id: channel.id, status: 'success' });
    } catch (error) {
      const errStatus = error.response?.status;
      const errData = error.response?.data;
      const resJson = JSON.stringify(errData || { errcode: -1, errmsg: error.message });

      // session 过期（ret: -14）、HTTP 401/403、或重试后仍 ret: -2 均标记通道失效
      const tokenInvalid = errStatus === 401 || errStatus === 403
        || (errData && (errData.ret === -14 || errData.ret === -2));
      if (tokenInvalid) {
        db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
        console.error(`⚠️ 通道 ${channel.id} 已标记为 inactive（token 失效）`);
      }

      db.prepare(`
        INSERT INTO push_logs (user_id, title, content, status, ip, channel_id, response)
        VALUES (?, ?, ?, 'failed', ?, ?, ?)
      `).run(user.id, title, content, clientIp, channel.id, resJson);

      logActivity(user.id, 'push_fail', { channel_id: channel.id, error: error.message, token_invalid: tokenInvalid }, req);
      console.error('❌ 推送失败:', errData || error.message);
      results.push({ channel_id: channel.id, status: 'failed', token_invalid: tokenInvalid });
    }
  }

  const anySuccess = results.some(r => r.status === 'success');
  return {
    code: anySuccess ? 0 : 50001,
    message: anySuccess ? 'success' : '全部推送失败',
    data: { results }
  };
}

function getClientIp(req) {
  return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
}

// ===== 风格1：兼容现有 relay-api 格式 =====
// GET /notify?key=KEY&msg=消息&title=标题
// POST /notify (Authorization: Bearer KEY, body: {message, title})
router.all('/notify', async (req, res) => {
  let sendKey = req.query.key;
  if (!sendKey) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      sendKey = auth.slice(7);
    }
  }
  if (!sendKey) {
    return res.json({ code: 40001, message: '缺少 key 参数', data: null });
  }

  const title = req.body?.title || req.query?.title || '';
  const content = req.body?.message || req.body?.desp || req.query?.msg || req.query?.desp || '';
  const channel = req.body?.channel || req.query?.channel || '';

  const result = await handlePush(sendKey, title, content, getClientIp(req), channel, req);
  res.json(result);
});

// ===== 风格2：Server酱风格 =====
// GET/POST /:key.send?title=标题&desp=内容
router.all('/:key.send', async (req, res) => {
  const sendKey = req.params.key;
  const title = req.body?.title || req.query?.title || '';
  const content = req.body?.desp || req.body?.message || req.query?.desp || req.query?.msg || '';
  const channel = req.body?.channel || req.query?.channel || '';

  const result = await handlePush(sendKey, title, content, getClientIp(req), channel, req);
  res.json(result);
});

module.exports = router;
