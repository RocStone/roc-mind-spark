// HTTP-level tests against the real server.js process (throw-away DB).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApiServer, rawRequest, JSON_HEADERS, sampleMap } from './helpers/api-server.mjs';

let srv;
before(async () => { srv = await startApiServer(); });
after(async () => { await srv.stop(); });

function splitBuffer(buf, size) {
  const out = [];
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size));
  return out;
}

describe('request body decoding', () => {
  test('a >64KB Chinese body split mid-character round-trips intact', async () => {
    const text = '思维导图节点内容，包含中文与标点。'.repeat(3000);
    const map = sampleMap('utf8big', { nodes: { r: { id: 'r', text, parent: null, x: 0, y: 0 } } });
    const body = Buffer.from(JSON.stringify(map), 'utf8');
    assert.ok(body.length > 64 * 1024);
    // 1001 is not a multiple of 3, so most chunk edges fall inside a character.
    const chunks = splitBuffer(body, 1001);
    const put = await rawRequest(srv.port, { method: 'PUT', path: '/api/maps/utf8big', headers: JSON_HEADERS, chunks });
    assert.equal(put.status, 200);
    const got = await rawRequest(srv.port, { path: '/api/maps/utf8big' });
    assert.equal(got.status, 200);
    assert.equal(got.json.nodes.r.text, text);
    assert.ok(!got.text.includes('�'));
  });

  test('an oversized body gets a 413 response instead of a dropped socket', async () => {
    const big = Buffer.alloc(8e6 + 1024, 0x20);
    const res = await rawRequest(srv.port, { method: 'PUT', path: '/api/maps/huge', headers: { ...JSON_HEADERS, 'Content-Length': String(big.length) }, chunks: splitBuffer(big, 256 * 1024) })
      .catch(e => ({ error: e }));
    assert.equal(res.error, undefined, 'client should receive a response: ' + (res.error && res.error.message));
    assert.equal(res.status, 413);
    assert.equal(res.json.error, 'payload too large');
    const after = await rawRequest(srv.port, { path: '/api/maps/huge' });
    assert.equal(after.status, 404);
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const res = await rawRequest(srv.port, { method: 'PUT', path: '/api/maps/bad', headers: JSON_HEADERS, chunks: ['{nope'] });
    assert.equal(res.status, 400);
  });
});
