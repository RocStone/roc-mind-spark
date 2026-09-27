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

describe('CSRF guards on writes', () => {
  const body = () => [JSON.stringify(sampleMap('csrf'))];

  test('a write with a foreign Origin is refused', async () => {
    const res = await rawRequest(srv.port, { method: 'PUT', path: '/api/maps/csrf', headers: { ...JSON_HEADERS, Origin: 'https://evil.example' }, chunks: body() });
    assert.equal(res.status, 403);
    assert.equal((await rawRequest(srv.port, { path: '/api/maps/csrf' })).status, 404);
  });

  test('Origin "null" (file:// or sandboxed frame) is refused, DELETE included', async () => {
    const res = await rawRequest(srv.port, { method: 'DELETE', path: '/api/maps/csrf', headers: { Origin: 'null' } });
    assert.equal(res.status, 403);
  });

  test('the allowed origin and an Origin-less native request are accepted', async () => {
    const a = await rawRequest(srv.port, { method: 'PUT', path: '/api/maps/csrf', headers: { ...JSON_HEADERS, Origin: srv.origin }, chunks: body() });
    assert.equal(a.status, 200);
    const b = await rawRequest(srv.port, { method: 'PUT', path: '/api/maps/csrf', headers: { 'Content-Type': 'application/json; charset=utf-8' }, chunks: body() });
    assert.equal(b.status, 200);
  });

  test('GET with a foreign Origin still reads (no CORS headers are granted)', async () => {
    const res = await rawRequest(srv.port, { path: '/api/maps', headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  for (const [method, path] of [
    ['PUT', '/api/maps/ct'],
    ['POST', '/api/maps'],
    ['POST', '/api/import'],
    ['POST', '/api/ops-log'],
    ['POST', '/api/maps/ct/images/duplicate'],
  ]) {
    test(`${method} ${path} rejects a text/plain body with 415`, async () => {
      const res = await rawRequest(srv.port, { method, path, headers: { 'Content-Type': 'text/plain' }, chunks: [JSON.stringify(sampleMap('ct'))] });
      assert.equal(res.status, 415);
    });
  }

  test('image upload keeps accepting a binary Content-Type', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const res = await rawRequest(srv.port, { method: 'POST', path: '/api/maps/csrf/images', headers: { 'Content-Type': 'image/png' }, chunks: [png] });
    assert.equal(res.status, 201);
  });
});
