#!/usr/bin/env node

/**
 * 将指定 SendKey 的用户提权为 admin。
 * 用法: node scripts/make-admin.js <sendkey>
 */

const path = require('path');

// Load db from project root (triggers migrations)
const db = require(path.join(__dirname, '..', 'db'));

const sendKey = process.argv[2];

if (!sendKey) {
  console.error('用法: node scripts/make-admin.js <sendkey>');
  process.exit(1);
}

const user = db.prepare('SELECT id, email, role FROM users WHERE send_key = ?').get(sendKey);

if (!user) {
  console.error(`错误: 未找到 SendKey 为 "${sendKey}" 的用户`);
  process.exit(1);
}

if (user.role === 'admin') {
  console.log(`用户 #${user.id} (${user.email || 'no email'}) 已经是 admin`);
  process.exit(0);
}

db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
console.log(`成功: 用户 #${user.id} (${user.email || 'no email'}) 已提权为 admin`);
