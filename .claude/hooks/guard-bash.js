#!/usr/bin/env node
// PreToolUse hook for Bash — 物理拦截危险命令
//
// 拦截以下模式（命中即 deny + 解释原因）：
//   1. scp <file> rn:/opt/bottalk/...   → 强制走 ./deploy.sh
//   2. ssh rn 内 vi/vim/nano/重定向写入 /opt/bottalk → 禁止服务器手动改代码
//   3. git commit ... --no-verify       → 禁止跳过 pre-commit
//   4. git push ... --force ... main    → 禁止 force push 到 main
//   5. ssh rn 内 DDL/DML SQL（INSERT/UPDATE/DELETE/ALTER/CREATE/DROP/TRUNCATE/REPLACE）
//      → 禁止在服务器写库；migration 必须写 db.js 末尾走 deploy.sh
//   6. ssh rn 内 db.exec(...) 或 db.prepare(...).run() → 禁止服务器写库（同上）
//   7. ssh rn 内 docker compose down|stop|restart|kill → 禁止造成生产中断
//   8. ssh rn 内 rm -rf 任意 /opt/bottalk 路径 → 禁止删数据/代码
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
  {
    name: 'no-server-sql-write',
    // ssh rn 命令内出现 DDL/DML 关键字（不区分大小写）
    test: (c) =>
      /\bssh\s+rn\b/.test(c) &&
      /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+(TABLE|INDEX|TRIGGER)|DROP\s+(TABLE|INDEX|TRIGGER)|TRUNCATE|REPLACE\s+INTO)\b/i.test(c),
    reason:
      '禁止在服务器执行 DDL/DML SQL —— migration 必须写在 db.js 末尾（hasRun/markRun 模式），通过 ./deploy.sh 部署。\n' +
      '原因：服务器手动跑 SQL 会导致 migration 编号冲突，下次部署可能起不来。\n' +
      '只读 SELECT 仍允许：用 db.prepare(...).all() / .get() 或 sqlite3 ".dump"。',
  },
  {
    name: 'no-server-db-write-call',
    // ssh rn 命令内出现 db.exec( 或 db.prepare(...).run( —— 这些都是写库调用
    test: (c) =>
      /\bssh\s+rn\b/.test(c) &&
      (/\bdb\.exec\s*\(/.test(c) ||
        /\bdb\.prepare\s*\([^)]*\)\s*\.run\s*\(/.test(c) ||
        /\.prepare\s*\([^)]*\)\s*\.run\s*\(/.test(c)),
    reason:
      '禁止在服务器执行 db.exec(...) 或 db.prepare(...).run() —— 都是写库调用。\n' +
      '只读调试请用 .all() / .get() / .iterate()。\n' +
      '需要改数据 → 写在 db.js migration 里，通过 ./deploy.sh 部署。',
  },
  {
    name: 'no-server-docker-compose-stop',
    test: (c) =>
      /\bssh\s+rn\b[^\n]*\bdocker\s+compose\s+(down|stop|restart|kill)\b/.test(c),
    reason:
      '禁止在服务器跑 docker compose down/stop/restart/kill —— 会造成生产中断。\n' +
      '正常重建容器：./deploy.sh（内含 up -d --build，零停机滚动更新）。\n' +
      '只读操作 docker ps / docker logs / docker exec 不受限。',
  },
  {
    name: 'no-server-rm-rf-bottalk',
    test: (c) =>
      /\bssh\s+rn\b[^\n]*\brm\s+-(?:r[fr]?|f[r]?)\b[^\n]*\/opt\/bottalk/.test(c),
    reason:
      '禁止在服务器跑 rm -rf 删除 /opt/bottalk 下任何路径 —— ' +
      '包括 data/（生产数据库，不可逆）和代码（会破坏 deploy.sh 的 git reset 流程）。',
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
