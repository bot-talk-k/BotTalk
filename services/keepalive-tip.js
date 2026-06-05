// 给业务推送消息追加保活尾巴
//
// 模式（env KEEPALIVE_TIP_MODE）：
//   'off'    → 不追加
//   'short'  → 永远追加短尾巴（"收到请回复"）
//   'long'   → 永远追加长尾巴（解释性文案，运维兜底）
//   'smart'  → 智能（默认，新逻辑）：
//                北京时间 8:00–22:00 + 当天首条 → 长尾巴
//                其他情况（夜间 / 当天非首条）→ 短尾巴
//              判定"当天首条"：channel.last_long_tip_at 的北京日期 ≠ 今天北京日期
//
// 仅业务消息调用（handlePush、scheduler 提醒、resend 补发等）
// 系统消息（欢迎、报警、预警、重绑通知等）不调用本函数

// db 延迟 require —— pickTipMode 单元测试不需要 db（避免 better-sqlite3 加载）
let db = null;
function getDb() {
  if (db === null) db = require('../db');
  return db;
}

const MODE = process.env.KEEPALIVE_TIP_MODE || 'smart';

const SHORT_TIP = '\n\n—— 💬 收到请回复保活 ｜ 微信限流烦? 可改用飞书/企业微信无限通道 → bot-talk.com';

const LONG_TIP =
  '\n\n━━━━━━━━━━━━━━━━\n' +
  '⚠️ 微信通道受腾讯限制：连续接收约 10 条不回复就会被强制停发，需回复任意消息才恢复，长期困扰用户。\n' +
  '本站已新增「飞书」与「企业微信」两个新消息通道 —— 均可个人手机安装、扫码即绑定，真正无限且稳定，无需"假装聊天"保活。\n' +
  '建议在腾讯对个人微信的支持改善之前，改用飞书或企业微信（扫码或 SendKey 即可使用）。\n' +
  '详情访问：bot-talk.com';

// 北京时间纯算 helper（不依赖 Intl/ICU）
function beijingDateStr(d) {
  const ms = d.getTime() + 8 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10); // 'YYYY-MM-DD'
}
function beijingHour(d) {
  const ms = d.getTime() + 8 * 3600 * 1000;
  return new Date(ms).getUTCHours();
}

/**
 * 决策函数（pure）：根据当前时间、上次发长尾巴的时间、mode，决定本次发哪种尾巴。
 * 不读 db、不写 db，便于单元测试。
 *
 * @param {object} opts
 * @param {Date} opts.now 当前时间
 * @param {Date|string|null} opts.lastLongTipAt 上次发长尾巴的时间（Date 对象 or SQLite 时间字符串 or null）
 * @param {'off'|'short'|'long'|'smart'} opts.mode
 * @returns {'none'|'short'|'long'}
 */
function pickTipMode({ now, lastLongTipAt, mode }) {
  if (mode === 'off') return 'none';
  if (mode === 'short') return 'short';
  if (mode === 'long') return 'long';
  // smart 模式
  const hour = beijingHour(now);
  if (hour < 8 || hour >= 22) return 'short';
  if (!lastLongTipAt) return 'long';

  // SQLite CURRENT_TIMESTAMP 是 'YYYY-MM-DD HH:MM:SS'（UTC，无 Z 后缀），
  // 不同环境对此格式 new Date() 解析不一致。强制加 'Z' 当 UTC 解析。
  const lastDate = lastLongTipAt instanceof Date
    ? lastLongTipAt
    : new Date(String(lastLongTipAt).replace(' ', 'T') + (String(lastLongTipAt).endsWith('Z') ? '' : 'Z'));

  return beijingDateStr(now) === beijingDateStr(lastDate)
    ? 'short'   // 今天已发过 long → short
    : 'long';   // 跨日 → long
}

/**
 * 给消息附加保活尾巴
 * @param {string} message 原消息
 * @param {object} channel channels 表的行（至少包含 id；新逻辑会实时读 last_long_tip_at）
 * @returns {string} 可能追加了尾巴的消息
 */
function appendTip(message, channel) {
  if (MODE === 'off') return message;

  // 实时读最新 last_long_tip_at（避免上层 SELECT 快照过期导致同分钟内重复发 long）
  let lastLongTipAt = null;
  if (channel?.id) {
    try {
      const row = getDb().prepare('SELECT last_long_tip_at FROM channels WHERE id = ?').get(channel.id);
      lastLongTipAt = row?.last_long_tip_at || null;
    } catch {
      // 表 / 列不存在等异常 → fallback 用传入对象的字段
      lastLongTipAt = channel.last_long_tip_at || null;
    }
  }

  const decision = pickTipMode({ now: new Date(), lastLongTipAt, mode: MODE });

  if (decision === 'none') return message;
  if (decision === 'short') return message + SHORT_TIP;

  // 'long' → 附长尾巴 + 更新 last_long_tip_at
  if (channel?.id) {
    try {
      getDb().prepare('UPDATE channels SET last_long_tip_at = CURRENT_TIMESTAMP WHERE id = ?').run(channel.id);
    } catch (e) {
      console.error('keepalive-tip: 更新 last_long_tip_at 失败:', e.message);
    }
  }
  return message + LONG_TIP;
}

module.exports = { appendTip, pickTipMode, MODE, SHORT_TIP, LONG_TIP };
