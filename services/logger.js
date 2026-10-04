const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel() {
  const level = String(process.env.LOG_LEVEL || 'info').toLowerCase();
  return LEVELS[level] ? level : 'info';
}

function enabled(level) {
  return LEVELS[level] >= LEVELS[configuredLevel()];
}

function write(level, ...args) {
  if (!enabled(level)) return;
  const method = level === 'debug' ? 'log' : level;
  console[method](...args);
}

module.exports = {
  debug: (...args) => write('debug', ...args),
  info: (...args) => write('info', ...args),
  warn: (...args) => write('warn', ...args),
  error: (...args) => write('error', ...args),
  enabled,
};
