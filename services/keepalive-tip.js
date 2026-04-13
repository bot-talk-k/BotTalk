// 给业务推送消息追加保活小尾巴，帮助用户理解并习惯回复
//
// 模式（env KEEPALIVE_TIP_MODE）：
//   'off'    → 不追加
//   'short'  → 永远追加短尾巴
//   'long'   → 永远追加长尾巴（解释性）
//   'smart'  → 智能选择（默认）：最近有 ret:-2 或连续 neg2 > 0 时用长尾巴，否则短尾巴
//
// 仅业务消息调用（handlePush、scheduler 提醒、resend 补发等）
// 系统消息（欢迎、报警、预警、重绑通知等）不追加

const MODE = process.env.KEEPALIVE_TIP_MODE || 'smart';

const SHORT_TIP = '\n\n—— 💬 回复任意字保活';

const LONG_TIP =
  '\n\n━━━━━━━━━━━━━━━━\n' +
  '💬 微信 ClawBot 平台已知限制：通道长时间无互动会失联。' +
  '请收到本条后顺手回复"好""1"等任意一字，即可为通道续命。';

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
