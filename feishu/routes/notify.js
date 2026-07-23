// 推送 API — SendKey → 分发到用户的飞书通道。
// 对齐微信站契约(便于 SDK 复用):/notify + /:key.send,风格1/风格2 兼容。
//
// 极简:飞书无限流/无衰减/无需互动 → 无 appendTip、无重试队列、无失联状态机。
// 失败只两类:凭证死(标 inactive,需重扫)/ 瞬时(不杀通道)。
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../db');
const feishu = require('../services/feishu-client');
const { logActivity } = require('../services/logger');
const adminNotify = require('../services/admin-notify');

// ── 频率门限(2026-07-17 加分钟窗)──
//
// 分钟窗防**突发洪水**,小时窗防**持续刷量**。
// 血账: 旧版只有 200/小时,粒度太粗 —— 它允许第 1 分钟打完 200 条再静默 59 分钟。
// user 16/24 的抖音舆情监控丢了「已通知」状态,每轮扫描把整个评论区历史全量重推。
//
// 阈值按近 7 天真实分布校准(2026-07-17):合法用户每分钟峰值最高是 user 9(整点跑行情)
// 的 19 条;洪水 user 24 峰值 24、常态 14。**每分钟条数这个维度分不开「失控」和「合法高频」**
// (两者 14~24 重叠) → 门限只当**平台安全上限**,定在不误伤任何合法用户处(30,离 19 有余量);
// 真正区分洪水靠「同一正文重复度」(见 trackDuplicate),那条走告警+人工,不拦。
const LIMIT_PER_MIN = 30;
const LIMIT_PER_HOUR = 200;

const _minuteCounts = new Map();
const _hourCounts = new Map();

function bumpWindow(map, sendKey, bucket) {
  const key = `${sendKey}:${bucket}`;
  const n = (map.get(key) || 0) + 1;
  map.set(key, n);
  for (const k of map.keys()) { if (!k.endsWith(`:${bucket}`)) map.delete(k); }
  return n;
}

// 通过返回 null;超限返回 { scope, limit, count }
function checkRateLimit(sendKey) {
  const perMin = bumpWindow(_minuteCounts, sendKey, Math.floor(Date.now() / 60000));
  const perHour = bumpWindow(_hourCounts, sendKey, Math.floor(Date.now() / 3600000));
  if (perMin > LIMIT_PER_MIN) return { scope: 'minute', limit: LIMIT_PER_MIN, count: perMin };
  if (perHour > LIMIT_PER_HOUR) return { scope: 'hour', limit: LIMIT_PER_HOUR, count: perHour };
  return null;
}

// ── 相同消息重复限速(2026-07-18 加,推翻 07-17「只告警不拦」)──
//
// 同一条消息(**标题+正文完全相同**)短时间快速重复超过 10 次 = 用户程序多半异常在重推
// (丢了「已通知」状态、循环没退出…),他自己收到几十条一模一样的也看不过来。
// 达阈值后把**这一条**限速到「每分钟最多 1 条」,超出返回 42901 明确提示 —— 不静默丢,
// 让他的程序能看到自己在被限速(避免 [[feishu-zombie-channel]] 那种「以为发了实则被扔」)。
//
// 判定键=标题+正文完全相同,是刻意的:user 23(行情)标题固定但正文条条在变(实时报价),
// 按标题会误伤他 32 条真实更新;按整条相同只打 user 16/24 那种「同一条老评论重推 6-8 次」。
const DUP_BURST_THRESHOLD = 10; // 快速重复超过此值 → 进入限速
const DUP_WINDOW_MS = 10 * 60 * 1000; // 计数窗:该消息 10 分钟没再来则重置
const DUP_THROTTLE_INTERVAL_MS = 60 * 1000; // 限速后同一条最小间隔
const _dupState = new Map(); // `${userId}:${hash}` -> { count, windowStart, lastPassAt, alerted }

// 返回 { allow, throttled?, firstThrottle?, count? }
function checkDuplicate(userId, title, content) {
  const now = Date.now();
  const hash = crypto.createHash('sha1').update(`${title}\n${content}`).digest('hex').slice(0, 16);
  const key = `${userId}:${hash}`;
  let st = _dupState.get(key);
  if (!st || now - st.windowStart > DUP_WINDOW_MS) {
    // 新建状态时顺手清理过期项,避免 Map 无限增长
    if (_dupState.size > 500) {
      for (const [k, v] of _dupState) { if (now - v.windowStart > DUP_WINDOW_MS) _dupState.delete(k); }
    }
    st = { count: 0, windowStart: now, lastPassAt: 0, alerted: false };
    _dupState.set(key, st);
  }
  st.count++;
  if (st.count <= DUP_BURST_THRESHOLD) return { allow: true };
  // 已进入限速:每 60s 放一条
  if (now - st.lastPassAt >= DUP_THROTTLE_INTERVAL_MS) {
    st.lastPassAt = now;
    return { allow: true, throttled: true };
  }
  const firstThrottle = !st.alerted;
  st.alerted = true;
  return { allow: false, firstThrottle, count: st.count };
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
    elements: [{ tag: 'plain_text', content: '由 BotTalk 推送 · bot-talk.com' }],
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

  const who = user.nickname || user.send_key.slice(0, 12);
  const limited = checkRateLimit(sendKey);
  if (limited) {
    // 分钟窗被打爆 = 失控循环的特征信号 → 报超管(人工联系用户),小时窗多为正常刷量不报
    if (limited.scope === 'minute') {
      adminNotify.send(
        `🚧 飞书推送触发分钟门限\n用户: ${who}\n本分钟已达: ${limited.count} 条(上限 ${limited.limit})\n疑似推送源失控循环,建议人工核实`,
        `rate-limit-min:${user.id}`,
      );
    }
    const unit = limited.scope === 'minute' ? '分钟' : '小时';
    return { code: 42901, message: `发送频率超限(每${unit}最多${limited.limit}条)`, data: null };
  }
  if (!title && !content) return { code: 40003, message: 'title 和消息内容不能同时为空', data: null };

  // 相同消息(标题+正文完全相同)高频重复 → 限速 1 条/分钟(见 checkDuplicate 注释)
  const dup = checkDuplicate(user.id, title, content);
  if (dup.firstThrottle) {
    adminNotify.send(
      `🔁 飞书推送相同消息高频重复\n用户: ${who}\n同一条已重复: ${dup.count} 次\n标题: ${title || '(无)'}\n疑似程序异常在重推,该消息已限速为每分钟最多 1 条`,
      `dup-throttle:${user.id}`,
    );
  }
  if (!dup.allow) {
    return { code: 42901, message: '相同消息重复过于频繁(疑似程序异常),已限速为每分钟最多1条,请检查推送源', data: null };
  }

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
        // 非 0 业务码:凭证死 → 标 inactive(重扫);频控(已退避重试仍失败)→ throttled;否则瞬时
        const dead = r.deadCredential;
        if (dead) db.prepare("UPDATE channels SET status = 'inactive' WHERE id = ?").run(channel.id);
        db.prepare("INSERT INTO push_logs (user_id, channel_id, title, content, status, ip, response) VALUES (?, ?, ?, ?, 'failed', ?, ?)")
          .run(user.id, channel.id, title, content, clientIp, JSON.stringify({ code: r.code, msg: r.msg, attempts: r.attempts }));
        const reason = dead ? 'channel_dead' : (feishu.isThrottleCode(r.code) ? 'throttled' : 'feishu_other');
        results.push({ channel_id: channel.id, status: 'failed', reason, feishu_code: r.code, feishu_msg: r.msg });
        adminNotify.send(
          `⚠️ 飞书推送失败\n用户: ${who}\n通道: ${channel.id}\n标题: ${title||'(无)'}\n原因: ${reason} code=${r.code}`,
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
        `⚠️ 飞书推送失败\n用户: ${who}\n通道: ${channel.id}\n标题: ${title||'(无)'}\n原因: ${reason} ${e.message.slice(0,60)}`,
        `push-fail:${channel.id}:${reason}`
      );
    }
  }

  logActivity(user.id, 'push', { title, channels: results.length }, req);

  const anySuccess = results.some(r => r.status === 'success');
  if (anySuccess) return { code: 0, message: 'success', data: { results } };

  const anyDead = results.some(r => r.reason === 'channel_dead');
  const anyThrottled = results.some(r => r.reason === 'throttled');
  let reason = 'feishu_other';
  let hint = '飞书推送失败(临时或参数问题),请稍后重试或检查通道。';
  if (anyDead) {
    reason = 'channel_dead';
    hint = '飞书通道凭证已失效,请到控制台重新扫码绑定。';
  } else if (anyThrottled) {
    reason = 'throttled';
    hint = '触发飞书接口频控(同一接收者 5 QPS),退避重试后仍失败。通道本身健康,建议把整点齐发的定时任务错峰。';
  }
  return { code: 50001, message: '全部推送失败', data: { results, reason, hint } };
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
module.exports.LIMIT_PER_MIN = LIMIT_PER_MIN;
module.exports.LIMIT_PER_HOUR = LIMIT_PER_HOUR;
