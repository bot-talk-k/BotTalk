/**
 * 检查所有公开 HTML 页面是否使用统一域名 (bot-talk.com)
 * 而非子域名 (feishu.bot-talk.com, wecom.bot-talk.com 等)
 */
const fs = require('fs');
const path = require('path');

const UNIFIED_DOMAIN = 'bot-talk.com';
const SUBDOMAINS = ['feishu.bot-talk.com', 'wecom.bot-talk.com', 'portal.bot-talk.com'];

// 需要检查的 HTML 文件
const HTML_FILES = [
  'public/intro.html',
  'public/index.html',
  'public/app.html',
  'feishu/public/intro.html',
  'feishu/public/app.html',
  'wecom/public/intro.html',
  'wecom/public/app.html',
  'portal/public/board.html',
];

let hasError = false;

console.log('=== 检查 HTML 文件域名使用规范 ===\n');

HTML_FILES.forEach(file => {
  const fullPath = path.join(__dirname, '..', file);
  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️  ${file} (不存在，跳过)`);
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const errors = [];

  // 检查是否使用了子域名链接（排除 JS 重写逻辑中的引用）
  SUBDOMAINS.forEach(subdomain => {
    // 匹配 href="https://subdomain.bot-talk.com/..." 但排除 JS 中的重写逻辑
    const regex = new RegExp(`href="https://${subdomain.replace(/\./g, '\\.')}/[^"]*"`, 'g');
    const matches = content.match(regex);
    if (matches) {
      errors.push(...matches.map(m => `  子域名链接：${m}`));
    }
  });

  if (errors.length > 0) {
    hasError = true;
    console.log(`❌ ${file}`);
    errors.forEach(e => console.log(e));
  } else {
    console.log(`✅ ${file}`);
  }
});

console.log('');
if (hasError) {
  console.log('❌ 发现子域名链接，请统一使用 bot-talk.com 主域名');
  console.log('   飞书通道：https://bot-talk.com/feishu-app');
  console.log('   企业微信通道：https://bot-talk.com/wecom-app');
  process.exit(1);
} else {
  console.log('✅ 所有 HTML 文件域名使用规范');
}
