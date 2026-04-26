// 给业务推送消息追加保活小尾巴，帮助用户理解并习惯回复
//
// 模式（env KEEPALIVE_TIP_MODE）：
//   'off'    → 不追加
//   'short'  → 永远追加短尾巴
//   'long'   → 永远追加长尾巴（解释性）
//   'smart'  → 智能选择：最近有 ret:-2 或连续 neg2 > 0 时用长尾巴，否则短尾巴
//
// 仅业务消息调用（handlePush、scheduler 提醒、resend 补发等）
// 系统消息（欢迎、报警、预警、重绑通知等）不追加
//
// 默认：'long'。初期用户量小且多在试用，优先完整传达保活机制；
// 后续用户量上来、重复阅读产生疲劳时再切回 'smart'。

const MODE = process.env.KEEPALIVE_TIP_MODE || 'long';

const SHORT_TIP = '\n\n—— 💬 回"1"= 通道保持畅通 24h（微信官方限制）';

const LONG_TIP =
  '\n\n━━━━━━━━━━━━━━━━\n' +
  '💬 由于微信官方限制，通道如果没有互动（向通道发送任何消息），' +
  '只是单向接收或者根本不发送接收任何消息，则24小时左右自动关闭该通道，' +
  '需重新扫码才能继续。\n' +
  '因此，如果你24小时无论是否收发消息，也向微信发送任意字比如"1"，' +
  '即可假装聊天互动，可无需再次扫码重绑。\n' +
  '详情：bot-talk.com/intro#clawbot-limitation';

// 判断是否用长尾巴（smart 模式下）
// 触发条件：
//   A. 连续 ret:-2 >= 1
//   B. 最近 2 小时内有过 ret:-2
//   C. 用户超过 6 小时没给 bot 发消息（接近 context_token 老化窗口）
//   D. 从来没收到过用户回复（新通道 + 已过 2h）
function shouldUseLong(channel) {
  if (!channel) return false;
  if ((channel.consecutive_neg2_count || 0) >= 1) return true;
  const now = Date.now();
  if (channel.last_neg2_at) {
    const diffMs = now - new Date(channel.last_neg2_at + 'Z').getTime();
    if (diffMs < 2 * 60 * 60 * 1000) return true;
  }
  const lastInbound = channel.last_inbound_at ? new Date(channel.last_inbound_at + 'Z').getTime() : null;
  if (lastInbound && (now - lastInbound) > 6 * 60 * 60 * 1000) return true;
  if (!lastInbound && channel.created_at) {
    const channelAgeMs = now - new Date(channel.created_at + 'Z').getTime();
    if (channelAgeMs > 2 * 60 * 60 * 1000) return true;
  }
  return false;
}

/**
 * 给消息附加保活尾巴
 * @param {string} message 原消息
 * @param {object} channel channels 表的行（至少包含 consecutive_neg2_count、last_neg2_at）
 * @returns {string} 可能追加了尾巴的消息
 */
function appendTip(message, channel) {
  if (MODE === 'off') return message;
  if (MODE === 'short') return message + SHORT_TIP;
  if (MODE === 'long') return message + LONG_TIP;
  // smart
  return message + (shouldUseLong(channel) ? LONG_TIP : SHORT_TIP);
}

module.exports = { appendTip, MODE };
