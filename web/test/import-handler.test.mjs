// POST /api/import on the real loopback server: auth check, JSON parsing, and
// error mapping live in server.js, in front of buildMapFromSpec()
// (web/import-spec.js). buildMapFromSpec's own rules are in import-spec.test.mjs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApiServer, rawRequest, JSON_HEADERS } from './helpers/api-server.mjs';

const validSpec = {
  title: 'Imported',
  nodes: [
    { id: 'r', text: 'Root', parent: null },
    { id: 'a', text: 'Child', parent: 'r' },
  ],
};

const post = (srv, body, headers = {}) => rawRequest(srv.port, {
  method: 'POST',
  path: '/api/import',
  headers: { ...JSON_HEADERS, ...headers },
  chunks: [typeof body === 'string' ? body : JSON.stringify(body)],
});

describe('POST /api/import without IMPORT_TOKEN', () => {
  let srv;
  before(async () => { srv = await startApiServer(); });
  after(async () => { await srv.stop(); });

  test('returns 201 with the map id and a loopback URL that opens it', async () => {
    const res = await post(srv, validSpec);
    assert.equal(res.status, 201);
    assert.ok(res.json.id, 'a map id is returned');
    assert.equal(res.json.url, `${srv.base}/?map=${res.json.id}`);
    const got = await rawRequest(srv.port, { path: '/api/maps/' + res.json.id });
    assert.equal(got.status, 200);
    assert.equal(got.json.title, 'Imported');
  });

  test('is open when no token is configured (documented default)', async () => {
    assert.equal((await post(srv, validSpec)).status, 201);
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const res = await post(srv, '{not json');
    assert.equal(res.status, 400);
    assert.match(res.json.error, /invalid JSON/);
  });

  test('valid JSON that fails spec validation surfaces the reason', async () => {
    const res = await post(srv, { title: 'no nodes' });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /nodes/);
  });

  test('an empty body is rejected rather than throwing', async () => {
    assert.equal((await post(srv, '')).status, 400);
  });

  test('__proto__ and constructor keys in the payload are not carried into the stored map', async () => {
    const res = await post(srv,
      '{"title":"evil","nodes":[{"id":"r","text":"r","parent":null,"__proto__":{"polluted":"yes"}}],' +
      '"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"bad":1}}}');
    assert.equal(res.status, 201);
    const got = await rawRequest(srv.port, { path: '/api/maps/' + res.json.id });
    assert.ok(!got.text.includes('polluted') && !got.text.includes('"bad"'), got.text);
    // The server process still answers normally afterwards.
    assert.equal((await post(srv, validSpec)).status, 201);
  });
});

describe('POST /api/import with IMPORT_TOKEN', () => {
  let srv;
  before(async () => { srv = await startApiServer({ env: { IMPORT_TOKEN: 'secret' } }); });
  after(async () => { await srv.stop(); });

  test('a request with no Authorization header is refused', async () => {
    assert.equal((await post(srv, validSpec)).status, 401);
  });

  test('a wrong bearer token is refused', async () => {
    assert.equal((await post(srv, validSpec, { Authorization: 'Bearer wrong' })).status, 401);
  });

  test('the correct bearer token is accepted', async () => {
    assert.equal((await post(srv, validSpec, { Authorization: 'Bearer secret' })).status, 201);
  });
});
