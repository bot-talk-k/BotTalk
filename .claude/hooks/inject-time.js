#!/usr/bin/env node
// UserPromptSubmit hook — 每次用户发消息时把"当前北京时间"注入 Claude context，
// 防止 Claude 因为看到 SQLite/log 里的 UTC 时间而误判用户当前所处时段。
//
// 输出 JSON 到 stdout：{ hookSpecificOutput: { additionalContext: "..." } }
// 该字段不会显示给用户，只是给 Claude 的隐式上下文。

function bjStringFromUTC(d) {
  const ms = d.getTime() + 8 * 3600 * 1000;
  const t = new Date(ms);
  // 手算避免 ICU 数据缺失
  const Y = t.getUTCFullYear();
  const M = String(t.getUTCMonth() + 1).padStart(2, '0');
  const D = String(t.getUTCDate()).padStart(2, '0');
  const h = String(t.getUTCHours()).padStart(2, '0');
  const m = String(t.getUTCMinutes()).padStart(2, '0');
  const dow = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][t.getUTCDay()];
  return { date: `${Y}-${M}-${D}`, time: `${h}:${m}`, dow, hour: t.getUTCHours() };
}

function periodLabel(hour) {
  if (hour >= 6 && hour < 11) return '上午';
  if (hour >= 11 && hour < 13) return '中午';
  if (hour >= 13 && hour < 18) return '下午';
  if (hour >= 18 && hour < 23) return '晚上';
  return '深夜';
}

const now = new Date();
const bj = bjStringFromUTC(now);
const period = periodLabel(bj.hour);
const utcStr = now.toISOString().slice(0, 16).replace('T', ' ');

const ctx =
  `[时区上下文] 用户当前位于北京时间（Asia/Shanghai, UTC+8）：\n` +
  `  现在是 ${bj.date} ${bj.dow} ${bj.time}（${period}）\n` +
  `  对应 UTC：${utcStr}\n` +
  `规则：\n` +
  `  1. 与用户讨论时间默认北京时间，不要用 UTC（除非用户明确要求）\n` +
  `  2. 引用 SQLite created_at / docker logs 时间戳时（这些都是 UTC），必须 +8h 显式转换为北京时间再陈述给用户\n` +
  `  3. 不要根据 UTC 小时判断"用户是早上/晚上"，永远以上面这行北京时间为准`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { additionalContext: ctx },
}));
process.exit(0);
