// HTTP-level tests against the real server.js process (throw-away DB).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
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

describe('map list', () => {
  test('includes a boolean pinned flag for every map, open or not', async () => {
    const put = (m) => rawRequest(srv.port, { method: 'PUT', path: '/api/maps/' + m.id, headers: JSON_HEADERS, chunks: [JSON.stringify(m)] });
    assert.equal((await put(sampleMap('pinYes', { pinned: true }))).status, 200);
    assert.equal((await put(sampleMap('pinNo'))).status, 200);
    const list = (await rawRequest(srv.port, { path: '/api/maps' })).json;
    const byId = Object.fromEntries(list.map(m => [m.id, m]));
    assert.equal(byId.pinYes.pinned, true);
    assert.equal(byId.pinNo.pinned, false);
    assert.equal('data' in byId.pinYes, false, 'list stays a lightweight index');
  });
});

describe('version history retention', () => {
  const MIN = 60 * 1000;
  const T0 = 1_700_000_000_000;
  const put = (id, updated, text) => rawRequest(srv.port, {
    method: 'PUT', path: '/api/maps/' + id, headers: JSON_HEADERS,
    chunks: [JSON.stringify(sampleMap(id, { updated, nodes: { r: { id: 'r', text, parent: null } } }))],
  });
  const versions = async (id) => (await rawRequest(srv.port, { path: `/api/maps/${id}/versions` })).json.map(v => v.ts);

  test('saves inside one 5-minute window coalesce into that window\'s newest version', async () => {
    assert.equal((await put('hist', T0, 'a')).status, 200);
    assert.deepEqual(await versions('hist'), [T0]);
    await put('hist', T0 + 1 * MIN, 'b');
    await put('hist', T0 + 4 * MIN, 'c');
    assert.deepEqual(await versions('hist'), [T0 + 4 * MIN], 'the window keeps only its latest state');
    const tip = (await rawRequest(srv.port, { path: `/api/maps/hist/versions/${T0 + 4 * MIN}` })).json;
    assert.equal(tip.nodes.r.text, 'c');

    // Anchored at the window start: steady editing still opens a new version.
    await put('hist', T0 + 5 * MIN + 1, 'd');
    assert.deepEqual(await versions('hist'), [T0 + 5 * MIN + 1, T0 + 4 * MIN]);
    await put('hist', T0 + 7 * MIN, 'e');
    assert.deepEqual(await versions('hist'), [T0 + 7 * MIN, T0 + 4 * MIN]);
    await put('hist', T0 + 60 * MIN, 'f');
    assert.deepEqual(await versions('hist'), [T0 + 60 * MIN, T0 + 7 * MIN, T0 + 4 * MIN]);
  });

  test('sealing the window keeps the pre-restore state as its own version', async () => {
    await put('seal', T0, 'a');
    await put('seal', T0 + 1 * MIN, 'b');
    assert.deepEqual(await versions('seal'), [T0 + 1 * MIN]);
    const seal = await rawRequest(srv.port, { method: 'POST', path: '/api/maps/seal/versions/seal' });
    assert.equal(seal.status, 204);
    await put('seal', T0 + 2 * MIN, 'restored');
    assert.deepEqual(await versions('seal'), [T0 + 2 * MIN, T0 + 1 * MIN], 'the save after sealing is a new version');
    const kept = (await rawRequest(srv.port, { path: `/api/maps/seal/versions/${T0 + 1 * MIN}` })).json;
    assert.equal(kept.nodes.r.text, 'b');
  });

  test('an older database without the started column is migrated and still coalesces', async () => {
    const legacyTs = Date.now() - 60 * 1000;
    const legacy = await startApiServer({
      prepareDb(file) {
        const db = new DatabaseSync(file);
        db.exec('CREATE TABLE map_versions (id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, ts))');
        db.prepare('INSERT INTO map_versions (id, ts, data) VALUES (?,?,?)').run('old', legacyTs, '{}');
        db.close();
      },
    });
    try {
      const res = await rawRequest(legacy.port, {
        method: 'PUT', path: '/api/maps/old', headers: JSON_HEADERS,
        chunks: [JSON.stringify(sampleMap('old', { updated: legacyTs + 1000 }))],
      });
      assert.equal(res.status, 200);
      const ts = (await rawRequest(legacy.port, { path: '/api/maps/old/versions' })).json.map(v => v.ts);
      assert.deepEqual(ts, [legacyTs + 1000], 'a legacy row falls back to ts as its window start');
    } finally {
      await legacy.stop();
    }
  });

  test('keeps at most 50 versions per map', async () => {
    for (let i = 0; i < 55; i++) await put('cap', T0 + i * 6 * MIN, 'v' + i);
    const ts = await versions('cap');
    assert.equal(ts.length, 50);
    assert.equal(ts[0], T0 + 54 * 6 * MIN);
  });
});

describe('map body validation', () => {
  const write = (method, path, value) => rawRequest(srv.port, { method, path, headers: JSON_HEADERS, chunks: [JSON.stringify(value)] });
  const bad = [
    ['an array', [1, 2]],
    ['a string', 'hello'],
    ['null', null],
    ['an empty object', {}],
    ['nodes as an array', { rootId: 'r', nodes: [] }],
    ['a rootId missing from nodes', { rootId: 'x', nodes: { r: { id: 'r' } } }],
    ['no rootId', { nodes: { r: { id: 'r' } } }],
  ];
  for (const [label, value] of bad) {
    test(`PUT and POST refuse ${label} with 400`, async () => {
      const put = await write('PUT', '/api/maps/valid', value);
      assert.equal(put.status, 400);
      const post = await write('POST', '/api/maps', value && typeof value === 'object' && !Array.isArray(value) ? { ...value, id: 'valid' } : value);
      assert.equal(post.status, 400);
      assert.equal((await rawRequest(srv.port, { path: '/api/maps/valid' })).status, 404, 'nothing was stored');
    });
  }

  test('a well-formed map is accepted by PUT and POST', async () => {
    assert.equal((await write('PUT', '/api/maps/valid1', sampleMap('valid1'))).status, 200);
    assert.equal((await write('POST', '/api/maps', sampleMap('valid2'))).status, 201);
  });

  test('POST still requires a usable id', async () => {
    const { id, ...noId } = sampleMap('x');
    assert.equal((await write('POST', '/api/maps', noId)).status, 400);
    assert.equal((await write('POST', '/api/maps', { ...noId, id: '../evil' })).status, 400);
  });

  test('POST /api/import still builds a map from a node-list spec', async () => {
    const res = await write('POST', '/api/import', { title: 'Imp', nodes: [{ id: 'r', text: 'Root', parent: null }, { id: 'a', text: 'A', parent: 'r' }] });
    assert.equal(res.status, 201);
    const got = await rawRequest(srv.port, { path: '/api/maps/' + res.json.id });
    assert.equal(got.status, 200);
    assert.equal(got.json.nodes[got.json.rootId].text, 'Root');
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
