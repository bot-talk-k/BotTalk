const test = require('node:test');
const assert = require('node:assert');
const { healthz } = require('../healthz');

test('portal GET /healthz is an in-memory ok response', () => {
  const response = {
    statusCode: null,
    contentType: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    send(value) { this.body = value; },
  };

  healthz(new Proxy({}, {
    get() { throw new Error('healthz must not read the request'); },
  }), response);

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(response.contentType, 'text/plain');
  assert.strictEqual(response.body, 'ok');
});
