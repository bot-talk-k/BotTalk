#!/usr/bin/env node
// PreToolUse hook for Bash — 物理拦截危险命令
//
// 拦截以下模式（命中即 deny + 解释原因）：
//   1. scp <file> rn:/opt/bottalk/...   → 强制走 ./deploy.sh
//   2. ssh rn 内 vi/vim/nano/重定向写入 /opt/bottalk → 禁止服务器手动改代码
//   3. git commit ... --no-verify       → 禁止跳过 pre-commit
//   4. git push ... --force ... main    → 禁止 force push 到 main
//
// fail-safe：脚本异常 → 默认放行（exit code != 0）。
// 想"挡不住就拒绝"则用 exit 2，这里选择放行优先（hook 出错不应阻塞工作）。

const fs = require('fs');

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf-8'));
} catch {
  process.exit(0);
}

const cmd = input?.tool_input?.command || '';

const RULES = [
  {
    name: 'no-scp-deploy',
    test: (c) => /\bscp\s+\S+[^\n]*\s+rn:\/opt\/bottalk/.test(c),
    reason:
      '禁止 scp 到 rn:/opt/bottalk —— 必须用 ./deploy.sh "commit message"。\n' +
      '原因：scp 单文件常漏文件，造成服务器跑旧代码（见 commit 9607943 事故）。\n' +
      'git 是唯一真理来源：本地 commit + push → ssh git pull + rebuild。',
  },
  {
    name: 'no-server-edit-vi',
    test: (c) =>
      /\bssh\s+rn\b[^\n]*\b(vi|vim|nano|emacs)\b/.test(c),
    reason:
      '禁止在服务器跑编辑器改代码 —— 必须本地改后用 ./deploy.sh。\n' +
      '只读调试（docker exec node -e、docker logs、cat 读取文件）允许。',
  },
  {
    name: 'no-server-write-redirect',
    test: (c) =>
      /\bssh\s+rn\b[^\n]*['"][^'"]*(>\s*['"]?\/opt\/bottalk|tee\s+\/opt\/bottalk|cat\s*>\s*['"]?\/opt\/bottalk|sed\s+-i\s+[^\n]*\/opt\/bottalk)/.test(c),
    reason:
      '禁止在服务器写 /opt/bottalk 下的文件（重定向/tee/sed -i）—— 必须本地改后用 ./deploy.sh。',
  },
  {
    name: 'no-skip-precommit',
    test: (c) => /git\s+commit\s+[^\n]*--no-verify/.test(c),
    reason:
      '禁止 --no-verify 跳过 pre-commit hook —— 修复 lint/test 错误而不是绕过。',
  },
  {
    name: 'no-force-push-main',
    test: (c) =>
      /git\s+push\s+[^\n]*--force[^\n]*\bmain\b/.test(c) ||
      /git\s+push\s+[^\n]*-f\s[^\n]*\bmain\b/.test(c),
    reason:
      '禁止 force push 到 main 分支 —— 会丢失历史，先和团队/记忆对齐再决定。',
  },
];

for (const rule of RULES) {
  try {
    if (rule.test(cmd)) {
      return deny(rule.reason);
    }
  } catch {
    // 单条规则正则崩 → 跳过该条
  }
}

process.exit(0);
