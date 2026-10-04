const POLL_START_STAGGER_MS = 100;

function schedulePollerRestores(channels, start, schedule = setTimeout, staggerMs = POLL_START_STAGGER_MS) {
  return channels.map((channel, index) => schedule(() => {
    Promise.resolve(start(channel)).catch(error => {
      console.error(`恢复频道轮询失败: channel=${channel.id}`, error.message);
    });
  }, index * staggerMs));
}

module.exports = { POLL_START_STAGGER_MS, schedulePollerRestores };
