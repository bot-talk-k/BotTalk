// 超管通知 — 企业微信站的超管事件(新用户注册 / 推送失败等)统一推到
// 「超管飞书」(全站超管消息中枢),并标注【企业微信】来源,便于在飞书里区分。
//
// 为什么推飞书而非 wecom 自己通道:用户拍板"真正的超管消息通道是飞书"。
// 走 bottalk-shared 网络内的 feishu 容器,凭超管飞书 SendKey 推送。
// fire-and-forget,不阻塞;同类事件 1 小时去重。

const axios = require('axios');

const FEISHU_URL = process.env.FEISHU_INTERNAL_URL || 'http://bottalk-feishu:3000';
const ADMIN_KEY = process.env.SUPERADMIN_FEISHU_SENDKEY; // 超管飞书 SendKey(fs_…)

const _dedup = new Map();
function dedup(key) {
  const hour = Math.floor(Date.now() / 3600000);
  const k = `${key}:${hour}`;
  if (_dedup.has(k)) return true;
  _dedup.set(k, 1);
  for (const [ek] of _dedup) { if (!ek.endsWith(`:${hour}`)) _dedup.delete(ek); }
  return false;
}

function send(msg, dedupKey) {
  if (dedupKey && dedup(dedupKey)) return;
  if (!ADMIN_KEY) {
    console.warn('[admin-notify] SUPERADMIN_FEISHU_SENDKEY 未配置,跳过超管通知');
    return;
  }
  // 推到超管飞书,title 带【企业微信】来源标识,正文为事件详情(card 渲染)
  axios.post(`${FEISHU_URL}/${ADMIN_KEY}.send`, null, {
    params: { title: '【企业微信】超管通知', desp: msg, card: 1 },
    timeout: 5000,
    validateStatus: () => true,
  }).catch((e) => console.error('[admin-notify] 推飞书失败:', e.message));
}

module.exports = { send };
