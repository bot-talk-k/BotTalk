const test = require('node:test');
const assert = require('node:assert');

test('wecom GET /healthz returns while a fake-clock poller throws', () => {
  const { healthz } = require('../healthz');
  const fakeClockPoller = () => { throw new Error('fake clock blocked poller'); };
  const response = {
    statusCode: null,
    contentType: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; },
  };

  assert.throws(fakeClockPoller, /blocked poller/);
  healthz({}, response);
  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.contentType, 'text/plain');
  assert.strictEqual(response.body, 'ok');
});
