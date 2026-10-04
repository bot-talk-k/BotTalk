#!/usr/bin/env node
// PreToolUse hook for Bash: enforce source-of-truth and k8s2 production safety.
// The model must still obtain explicit user approval before every k8s mutation.

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
const isK8s2Route = /\bssh\s+(?:[^\n]*\s+)?(?:homevps|um880pro|k8s-n3)\b/.test(cmd);

const RULES = [
  {
    name: 'no-source-scp',
    test: (c) => /\bscp\s+.*(?:\.js|\.ts|\.json|\.ya?ml|\.sh|\.md)\b/i.test(c),
    reason: '禁止用 scp 单文件热改源码。Git 是唯一真相；发布只能使用 SHA 镜像 artifact。',
  },
  {
    name: 'no-server-editor',
    test: (c) => /\bssh\b[^\n]*\b(vi|vim|nano|emacs)\b/.test(c),
    reason: '禁止在服务器上用编辑器修改代码。请在本地修改、测试并走 SHA 镜像发布。',
  },
  {
    name: 'no-skip-precommit',
    test: (c) => /git\s+commit\s+[^\n]*--no-verify/.test(c),
    reason: '禁止 --no-verify 跳过 pre-commit hook；应修复 lint/test 问题。',
  },
  {
    name: 'no-force-push-main',
    test: (c) => /git\s+push\s+[^\n]*(?:--force|-f)\b[^\n]*\bmain\b/.test(c),
    reason: '禁止 force push 到 main 分支。',
  },
  {
    name: 'no-k8s2-sql-write',
    test: (c) => isK8s2Route && /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|TRIGGER)|DROP\s+(?:TABLE|INDEX|TRIGGER)|TRUNCATE|REPLACE\s+INTO)\b/i.test(c),
    reason: '禁止直接在 k8s2 生产环境执行 SQL 写操作。数据库变更必须随应用 migration 发布。',
  },
  {
    name: 'no-k8s2-db-write-call',
    test: (c) => isK8s2Route && (/\bdb\.exec\s*\(/.test(c) || /\.prepare\s*\([^)]*\)\s*\.run\s*\(/.test(c)),
    reason: '禁止直接在 k8s2 生产环境调用 db.exec/.run 写库；请使用应用 migration。',
  },
  {
    name: 'no-broad-pod-delete',
    test: (c) => /\bkubectl\b[^\n]*\bdelete\s+pods\s+--all\b/.test(c),
    reason: '禁止批量删除 Bottalk Pod。发布仅能通过逐个 Deployment 的 SHA rollout。',
  },
  {
    name: 'no-infrastructure-mutation',
    test: (c) => isK8s2Route && /\bkubectl\b[^\n]*\b(?:delete|apply|patch|replace|create)\b[^\n]*\b(?:pvc|service|ingress|namespace|configmap|secret|role|rolebinding|clusterrole|clusterrolebinding)\b/i.test(c),
    reason: '基础设施资源归 Home-Lab 侧管理。本项目发布只能改变四个 Deployment。',
  },
];

for (const rule of RULES) {
  try {
    if (rule.test(cmd)) return deny(rule.reason);
  } catch {
    // A failed individual safety check must not block unrelated work.
  }
}

process.exit(0);
