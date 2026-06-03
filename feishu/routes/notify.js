// 推送 API — SendKey → 分发到用户的飞书通道。
// 对齐微信站契约(便于 SDK 复用):/notify + /:key.send,风格1/风格2 兼容。
//
// 极简:飞书无限流/无衰减/无需互动 → 无 appendTip、无重试队列、无失联状态机。
// 失败只两类:凭证死(标 inactive,需重扫)/ 瞬时(不杀通道)。
const express = require('express');
const router = express.Router();
const db = require('../db');
const feishu = require('../services/feishu-client');
const { logActivity } = require('../services/logger');

// 简单内存限流:每 SendKey 每小时最多 200 条
const rateLimits = {};
function checkRateLimit(sendKey, limit = 200) {
  const hour = Math.floor(Date.now() / 3600000);
  const key = `${sendKey}:${hour}`;
  rateLimits[key] = (rateLimits[key] || 0) + 1;
  for (const k in rateLimits) { if (!k.endsWith(`:${hour}`)) delete rateLimits[k]; }
  return rateLimits[key] <= limit;
}

// 解析目标通道:default(默认通道)/ all(全部)/ 逗号 id 列表
function resolveChannels(userId, channelParam) {
  if (!channelParam || channelParam === 'default') {
    const ch = db.prepare(
      "SELECT * FROM channels WHERE user_id = ? AND is_default = 1 AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(userId);
    if (ch) return [ch];
    // 没有显式默认 → 退回最新一个 active 通道
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

async function handlePush(sendKey, title, content, clientIp, channelParam, req) {
  const user = db.prepare('SELECT * FROM users WHERE send_key = ?').get(sendKey);
  if (!user) return { code: 40001, message: 'SendKey 无效', data: null };
  if (user.is_disabled) return { code: 40301, message: '账号已禁用', data: null };
  if (!checkRateLimit(sendKey)) return { code: 42901, message: '发送频率超限(每小时最多200条)', data: null };
  if (!title && !content) return { code: 40003, message: 'title 和消息内容不能同时为空', data: null };

  const channels = resolveChannels(user.id, channelParam);
  if (channels.length === 0) return { code: 40002, message: '没有可用的飞书通道,请先扫码绑定', data: null };

  const message = title + (content ? '\n\n' + content : '');
  const results = [];

  for (const channel of channels) {
    if (channel.status === 'inactive') {
      results.push({ channel_id: channel.id, status: 'skipped', reason: 'channel_dead' });
      continue;
    }
    try {
      const r = await feishu.sendText({
        appId: channel.feishu_app_id,
        appSecret: channel.feishu_app_secret,
        domain: channel.feishu_domain,
        receiveId: channel.feishu_open_id,
        receiveIdType: 'open_id',
        text: message,
      });
      if (r.code === 0) {
        db.prepare("INSERT INTO push_logs (user_id, channel_id, title, content, status, ip, response) VALUES (?, ?, ?, ?, 'success', ?, ?)")
          .run(user.id, channel.id, title, content, clientIp, JSON.stringify({ code: 0, msgid: r.data && r.data.message_id }));
        results.push({ channel_id: channel.id, status: 'success' });
      } else {
        // 非 0 业务码:凭证死 → 标 inactive(重扫);否则瞬时
        const dead = r.deadCredential;
        if (dead) db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
        db.prepare("INSERT INTO push_logs (user_id, channel_id, title, content, status, ip, response) VALUES (?, ?, ?, ?, 'failed', ?, ?)")
          .run(user.id, channel.id, title, content, clientIp, JSON.stringify({ code: r.code, msg: r.msg }));
        results.push({ channel_id: channel.id, status: 'failed', reason: dead ? 'channel_dead' : 'feishu_other', feishu_code: r.code, feishu_msg: r.msg });
      }
    } catch (e) {
      // getTenantToken 抛错:凭证死 → 标 inactive;否则网络瞬时
      const dead = !!e.deadCredential;
      if (dead) db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
      db.prepare("INSERT INTO push_logs (user_id, channel_id, title, content, status, ip, response) VALUES (?, ?, ?, ?, 'failed', ?, ?)")
        .run(user.id, channel.id, title, content, clientIp, JSON.stringify({ error: e.message, code: e.feishuCode }));
      results.push({ channel_id: channel.id, status: 'failed', reason: dead ? 'channel_dead' : 'network', error: e.message });
    }
  }

  logActivity(user.id, 'push', { title, channels: results.length }, req);

  const anySuccess = results.some(r => r.status === 'success');
  if (anySuccess) return { code: 0, message: 'success', data: { results } };

  const anyDead = results.some(r => r.reason === 'channel_dead');
  const hint = anyDead
    ? '飞书通道凭证已失效,请到控制台重新扫码绑定。'
    : '飞书推送失败(临时或参数问题),请稍后重试或检查通道。';
  return { code: 50001, message: '全部推送失败', data: { results, reason: anyDead ? 'channel_dead' : 'feishu_other', hint } };
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
