// 轻量错误上报：未捕获异常 / unhandledRejection 通过 BotTalk 自己的推送 API
// 发到管理员微信。无外部依赖（不引 Sentry）。
//
// 启用：环境变量 ADMIN_SENDKEY 必须设置（管理员账号的 send_key）
// 限流：同一 message hash 30 分钟内只发 1 次（避免循环错误轰炸）
// fail-safe：上报本身失败 → 仅 console.error，不再抛
//
// 使用：
//   const { reportError } = require('./services/error-reporter');
//   reportError(err, { phase: 'process', extra: '...' });

const crypto = require('node:crypto');

const ADMIN_SENDKEY = process.env.ADMIN_SENDKEY;
const BASE_URL = process.env.BASE_URL || 'https://bot-talk.com';
const DEDUP_WINDOW_MS = 30 * 60 * 1000;

const recentSent = new Map();

function hashMessage(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function pruneRecent() {
  const now = Date.now();
  for (const [key, ts] of recentSent) {
    if (now - ts > DEDUP_WINDOW_MS) recentSent.delete(key);
  }
}

async function reportError(err, context = {}) {
  if (!ADMIN_SENDKEY) {
    // 没配 admin sendkey（dev 环境）：仅 console
    console.error('[error-reporter] (no ADMIN_SENDKEY set)', err?.message || err);
    return;
  }

  try {
    const message = err?.stack || err?.message || String(err);
    const key = hashMessage(message);

    pruneRecent();
    if (recentSent.has(key)) {
      return; // 30 分钟内同样的错误不再发
    }
    recentSent.set(key, Date.now());

    const title = `🚨 ${context.phase || 'error'}: ${(err?.message || 'Unknown').slice(0, 60)}`;
    const body =
      `Phase: ${context.phase || 'unknown'}\n` +
      `Time: ${new Date().toISOString()}\n` +
      (context.extra ? `Extra: ${JSON.stringify(context.extra)}\n` : '') +
      `\n${message.slice(0, 1500)}`;

    const url = `${BASE_URL}/b${ADMIN_SENDKEY}.send`;
    const params = new URLSearchParams({ title, desp: body });

    // 轻量 fetch（Node 22 内置）；不重试，失败仅 log
    const r = await fetch(`${url}?${params.toString()}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      console.error('[error-reporter] push failed:', r.status);
    }
  } catch (e) {
    console.error('[error-reporter] internal failure:', e.message);
  }
}

module.exports = { reportError };
