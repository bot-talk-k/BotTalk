// 推送 API — SendKey → 分发到用户的企业微信通道(经 WS 连接池)。
// 对齐微信/飞书契约:/notify + /:key.send,title/desp/card,各自 key 前缀(ww_)+ 各自错误。
//
// 企业微信差异:发送走 WS 长连接(pool.send),消息统一 markdown;
// 失败态多一个 pending_userid(通道已绑定但还没捕获接收 userid)。
const express = require('express');
const router = express.Router();
const db = require('../db');
const pool = require('../services/wecom-pool');
const { logActivity } = require('../services/logger');
const adminNotify = require('../services/admin-notify');

// 简单内存限流:每 SendKey 每小时最多 200 条
const rateLimits = {};
function checkRateLimit(sendKey, limit = 200) {
  const hour = Math.floor(Date.now() / 3600000);
  const key = `${sendKey}:${hour}`;
  rateLimits[key] = (rateLimits[key] || 0) + 1;
  for (const k in rateLimits) { if (!k.endsWith(`:${hour}`)) delete rateLimits[k]; }
  return rateLimits[key] <= limit;
}

// 解析目标通道:default / all / 逗号 id 列表 —— 只返回 active(可推)
function resolveChannels(userId, channelParam) {
  if (!channelParam || channelParam === 'default') {
    const ch = db.prepare(
      "SELECT * FROM channels WHERE user_id = ? AND is_default = 1 AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(userId);
    if (ch) return [ch];
    const fallback = db.prepare(
      "SELECT * FROM channels WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(userId);
    return fallback ? [fallback] : [];
  }
  if (channelParam === 'all') {
    return db.prepare("SELECT * FROM channels WHERE user_id = ? AND status = 'active'").all(userId);
  }
  const ids = channelParam.split(',').map(s => s.trim()).filter(Boolean);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM channels WHERE id IN (${placeholders}) AND user_id = ? AND status = 'active'`
  ).all(...ids, userId);
}

function buildMarkdown(title, content) {
  if (title && content) return `**${title}**\n\n${content}`;
  if (title) return `**${title}**`;
  return content || '';
}

async function handlePush(sendKey, title, content, clientIp, channelParam, req) {
  const user = db.prepare('SELECT * FROM users WHERE send_key = ?').get(sendKey);
  if (!user) return { code: 40001, message: 'SendKey 无效', data: null };
  if (user.is_disabled) return { code: 40301, message: '账号已禁用', data: null };
  if (!checkRateLimit(sendKey)) return { code: 42901, message: '发送频率超限(每小时最多200条)', data: null };
  if (!title && !content) return { code: 40003, message: 'title 和消息内容不能同时为空', data: null };

  const channels = resolveChannels(user.id, channelParam);
  if (channels.length === 0) {
    // 没有 active 通道 → 区分"完全没绑" vs "绑了但未激活"
    const pending = db.prepare("SELECT COUNT(*) AS c FROM channels WHERE user_id = ? AND status = 'pending_userid'").get(user.id).c;
    if (pending > 0) {
      return { code: 40002, message: '通道尚未激活', data: { reason: 'pending_userid', hint: '通道已绑定但还没捕获到接收目标——请在企业微信里打开机器人会话发送任意一句话激活,之后即可推送。' } };
    }
    return { code: 40002, message: '没有可用的企业微信通道,请先扫码绑定', data: null };
  }

  const md = buildMarkdown(title, content);
  const results = [];

  for (const channel of channels) {
    try {
      const r = await pool.send(channel.id, md); // { headers, errcode, errmsg }
      if (r && r.errcode === 0) {
        db.prepare("INSERT INTO push_logs (user_id, channel_id, title, content, status, ip, response) VALUES (?, ?, ?, ?, 'success', ?, ?)")
          .run(user.id, channel.id, title, content, clientIp, JSON.stringify({ errcode: 0 }));
        results.push({ channel_id: channel.id, status: 'success' });
      } else {
        db.prepare("INSERT INTO push_logs (user_id, channel_id, title, content, status, ip, response) VALUES (?, ?, ?, ?, 'failed', ?, ?)")
          .run(user.id, channel.id, title, content, clientIp, JSON.stringify({ errcode: r && r.errcode, errmsg: r && r.errmsg }));
        results.push({ channel_id: channel.id, status: 'failed', reason: 'wecom_other', wecom_errcode: r && r.errcode, wecom_errmsg: r && r.errmsg });
        adminNotify.send(`⚠️ 企业微信推送失败\n用户: ${user.nickname || user.send_key.slice(0, 12)}\n通道: ${channel.id}\nerrcode=${r && r.errcode} ${r && r.errmsg}`, `push-fail:${channel.id}:${r && r.errcode}`);
      }
    } catch (e) {
      const reason = e.code === 'pending_userid' ? 'pending_userid' : (e.code === 'ws_not_ready' ? 'ws_not_ready' : 'error');
      db.prepare("INSERT INTO push_logs (user_id, channel_id, title, content, status, ip, response) VALUES (?, ?, ?, ?, 'failed', ?, ?)")
        .run(user.id, channel.id, title, content, clientIp, JSON.stringify({ error: e.message, reason }));
      results.push({ channel_id: channel.id, status: 'failed', reason, error: e.message });
    }
  }

  logActivity(user.id, 'push', { title, channels: results.length }, req);

  const anySuccess = results.some(r => r.status === 'success');
  if (anySuccess) return { code: 0, message: 'success', data: { results } };

  const anyPending = results.some(r => r.reason === 'pending_userid');
  const anyWsDown = results.some(r => r.reason === 'ws_not_ready');
  let hint = '企业微信推送失败,请稍后重试或检查通道。';
  if (anyPending) hint = '通道尚未激活——请在企业微信里给机器人发一句话激活后再推送。';
  else if (anyWsDown) hint = 'WS 长连接暂未就绪(正在重连),请稍后重试。';
  return { code: 50001, message: '全部推送失败', data: { results, hint } };
}

function getClientIp(req) {
  return req.headers['x-real-ip'] || req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
}

// 风格1:/notify?key=KEY&msg=&title=  (POST 支持 Authorization: Bearer KEY)
router.all('/notify', async (req, res) => {
  let sendKey = req.query.key;
  if (!sendKey) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) sendKey = auth.slice(7);
  }
  if (!sendKey) return res.json({ code: 40001, message: '缺少 key 参数', data: null });
  const title = req.body?.title || req.query?.title || '';
  const content = req.body?.message || req.body?.desp || req.query?.msg || req.query?.desp || '';
  const channel = req.body?.channel || req.query?.channel || '';
  res.json(await handlePush(sendKey, title, content, getClientIp(req), channel, req));
});

// 风格2:Server酱风格  /:key.send?title=&desp=
router.all('/:key.send', async (req, res) => {
  const sendKey = req.params.key;
  const title = req.body?.title || req.query?.title || '';
  const content = req.body?.desp || req.body?.message || req.query?.desp || req.query?.msg || '';
  const channel = req.body?.channel || req.query?.channel || '';
  res.json(await handlePush(sendKey, title, content, getClientIp(req), channel, req));
});

module.exports = router;
module.exports.handlePush = handlePush;
