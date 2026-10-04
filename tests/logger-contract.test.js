const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../db' && parent?.filename?.endsWith(`${path.sep}services${path.sep}logger.js`)) {
    return { prepare: () => ({ run: () => ({ changes: 0 }) }) };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const ROOT = path.join(__dirname, '..');
const TOP_LEVEL_SERVICE_DIRS = new Set(['feishu', 'wecom', 'portal', 'sdk', 'node_modules', '.git', '.claude']);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory() && (TOP_LEVEL_SERVICE_DIRS.has(entry.name) || entry.name === 'node_modules')) return [];
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  });
}

function requiredLoggerNames(source) {
  const names = new Set();
  const pattern = /const\s*\{([^}]+)\}\s*=\s*require\(['"](?:\.\.\/)*services\/logger['"]\)/g;
  for (const match of source.matchAll(pattern)) {
    for (const item of match[1].split(',')) names.add(item.trim().split(':')[0].trim());
  }
  return names;
}

test('all logger destructured imports exist in their target service logger', () => {
  for (const service of ['', 'feishu', 'wecom']) {
    const root = path.join(ROOT, service);
    const logger = require(path.join(root, 'services', 'logger'));
    const imports = new Set();
    for (const file of walk(root)) {
      if (file.endsWith(`${path.sep}services${path.sep}logger.js`)) continue;
      for (const name of requiredLoggerNames(fs.readFileSync(file, 'utf8'))) imports.add(name);
    }
    for (const name of imports) {
      assert.strictEqual(typeof logger[name], 'function', `${service || 'main'} logger must export ${name}`);
    }
  }
});
