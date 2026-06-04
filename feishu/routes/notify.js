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

// 把 title + content 包装成飞书卡片 JSON(绿色标题 + Markdown 正文)
function buildCard(title, content) {
  const elements = [];
  if (content) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content } });
    elements.push({ tag: 'hr' });
  }
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '由 BotTalk 推送 · feishu.bot-talk.com' }],
  });
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title || '(无标题)' }, template: 'green' },
    elements,
  };
}

async function handlePush(sendKey, title, content, clientIp, channelParam, req, useCard = false) {
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
      const sendParams = {
        appId: channel.feishu_app_id, appSecret: channel.feishu_app_secret,
        domain: channel.feishu_domain, receiveId: channel.feishu_open_id, receiveIdType: 'open_id',
      };
      const r = useCard
        ? await feishu.sendCard({ ...sendParams, card: buildCard(title, content) })
        : await feishu.sendText({ ...sendParams, text: message });
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
        const reason = dead ? 'channel_dead' : 'feishu_other';
        results.push({ channel_id: channel.id, status: 'failed', reason, feishu_code: r.code, feishu_msg: r.msg });
        adminNotify.send(
          `⚠️ 飞书推送失败\n用户: ${user.nickname||user.send_key.slice(0,12)}\n通道: ${channel.id}\n标题: ${title||'(无)'}\n原因: ${reason} code=${r.code}`,
          `push-fail:${channel.id}:${r.code}`
        );
      }
    } catch (e) {
      // getTenantToken 抛错:凭证死 → 标 inactive;否则网络瞬时
      const dead = !!e.deadCredential;
      if (dead) db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
      db.prepare("INSERT INTO push_logs (user_id, channel_id, title, content, status, ip, response) VALUES (?, ?, ?, ?, 'failed', ?, ?)")
        .run(user.id, channel.id, title, content, clientIp, JSON.stringify({ error: e.message, code: e.feishuCode }));
      const reason = dead ? 'channel_dead' : 'network';
      results.push({ channel_id: channel.id, status: 'failed', reason, error: e.message });
      adminNotify.send(
        `⚠️ 飞书推送失败\n用户: ${user.nickname||user.send_key.slice(0,12)}\n通道: ${channel.id}\n标题: ${title||'(无)'}\n原因: ${reason} ${e.message.slice(0,60)}`,
        `push-fail:${channel.id}:${reason}`
      );
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
  const useCard = !!(req.body?.card || req.query?.card);
  res.json(await handlePush(sendKey, title, content, getClientIp(req), channel, req, useCard));
});

// 风格2:Server酱风格  /:key.send?title=&desp=&card=1
router.all('/:key.send', async (req, res) => {
  const sendKey = req.params.key;
  const title = req.body?.title || req.query?.title || '';
  const content = req.body?.desp || req.body?.message || req.query?.desp || req.query?.msg || '';
  const channel = req.body?.channel || req.query?.channel || '';
  const useCard = !!(req.body?.card || req.query?.card);
  res.json(await handlePush(sendKey, title, content, getClientIp(req), channel, req, useCard));
});

module.exports = router;
module.exports.handlePush = handlePush;
