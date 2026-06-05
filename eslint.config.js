// ESLint 9 flat config
// 最小集：eslint:recommended + Node CommonJS globals
// 关掉对本项目过于啰嗦的规则（catch ignore、未使用变量改 warn）

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'data/**',
      'feishu/node_modules/**',
      'feishu/data/**',
      'feishu/data-test/**',
      'public/i18n.js',
      'public/**/*.html',
      'public/**/*.min.js',
      '**/*.umd.js',
      'feishu/public/**/*.min.js',
      'wecom/public/**/*.min.js',
      'sdk/**',
      'tests/tmp.sqlite*',
      '.claude/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-redeclare': 'warn',
      'no-undef': 'error',
    },
  },
];
