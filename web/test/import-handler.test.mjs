// handleImport() is the HTTP entry point of the PUBLIC, unauthenticated import
// endpoint — auth check, JSON parsing, and error mapping all live here rather
// than in buildMapFromSpec().
//
// These exist because mutation testing found a real gap: reverting the
// prototype-pollution hardening (PR #6) left the whole suite green, because
// that fix is in the JSON.parse reviver here and every existing test targeted
// buildMapFromSpec() downstream of it. A security fix with no test covering it
// is exactly what quietly regresses later.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { handleImport } from '../worker/import-core.js';

const ENV = { ALLOWED_ORIGIN: 'https://example.com/' };

const post = (body, env = ENV, headers = {}) =>
  handleImport(
    new Request('https://worker.test/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env
  );

const validSpec = {
  title: 'Imported',
  nodes: [
    { id: 'r', text: 'Root', parent: null },
    { id: 'a', text: 'Child', parent: 'r' },
  ],
};

describe('handleImport — happy path', () => {
  test('returns 201 with a share URL built from ALLOWED_ORIGIN', async () => {
    const res = await post(validSpec);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.id, 'a map id is returned');
    assert.match(body.url, /^https:\/\/example\.com\/#view=g/, 'gzip share token, no double slash');
  });

  test('a trailing slash on ALLOWED_ORIGIN is not doubled in the URL', async () => {
    const res = await post(validSpec, { ALLOWED_ORIGIN: 'https://example.com///' });
    const { url } = await res.json();
    assert.ok(!url.includes('com//#'), `unexpected double slash: ${url}`);
  });
});

describe('handleImport — auth', () => {
  test('with IMPORT_TOKEN set, a request with no Authorization header is refused', async () => {
    const res = await post(validSpec, { ...ENV, IMPORT_TOKEN: 'secret' });
    assert.equal(res.status, 401);
  });

  test('with IMPORT_TOKEN set, a wrong bearer token is refused', async () => {
    const res = await post(validSpec, { ...ENV, IMPORT_TOKEN: 'secret' }, { Authorization: 'Bearer wrong' });
    assert.equal(res.status, 401);
  });

  test('the correct bearer token is accepted', async () => {
    const res = await post(validSpec, { ...ENV, IMPORT_TOKEN: 'secret' }, { Authorization: 'Bearer secret' });
    assert.equal(res.status, 201);
  });

  test('with no IMPORT_TOKEN configured the endpoint is open (documented default)', async () => {
    assert.equal((await post(validSpec, ENV)).status, 201);
  });
});

describe('handleImport — bad input maps to 400, never 500', () => {
  test('malformed JSON', async () => {
    const res = await post('{not json');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /valid JSON/);
  });

  test('valid JSON that fails spec validation surfaces the reason', async () => {
    const res = await post({ title: 'no nodes' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /nodes/);
  });

  test('an empty body is rejected rather than throwing', async () => {
    assert.equal((await post('')).status, 400);
  });
});

describe('handleImport — prototype pollution (PR #6)', () => {
  // Honest note on what these can and cannot prove. Mutation testing showed
  // that reverting PR #6's reviver leaves this whole suite green — and that
  // is correct, not a gap in the tests. JSON.parse does NOT change an
  // object's real prototype when it sees a "__proto__" key; it creates an
  // ordinary own property with that name. Real pollution needs downstream
  // code that does target[key] = value in a recursive merge, and
  // buildMapFromSpec() reads every field by explicit name and builds its
  // output from object literals, so nothing here propagates it.
  //
  // The reviver is therefore defence-in-depth against a future change to
  // this file, not a fix for observable behaviour — which means there is no
  // black-box assertion that can distinguish it being present from absent.
  // These tests pin down the property that actually matters (hostile input
  // never reaches Object.prototype) and will fail if a future refactor
  // introduces a merge that makes the payload live.
  test('a top-level __proto__ key does not pollute Object.prototype', async () => {
    const res = await post(
      '{"title":"evil","nodes":[{"id":"r","text":"r","parent":null}],"__proto__":{"polluted":"yes"}}'
    );
    assert.equal(res.status, 201);
    assert.equal({}.polluted, undefined, 'Object.prototype must be untouched');
  });

  test('__proto__ nested inside a node does not pollute Object.prototype', async () => {
    await post('{"nodes":[{"id":"r","text":"r","parent":null,"__proto__":{"polluted2":"yes"}}]}');
    assert.equal({}.polluted2, undefined);
  });

  test('a "constructor" key in the payload is also harmless', async () => {
    const res = await post(
      '{"nodes":[{"id":"r","text":"r","parent":null}],"constructor":{"prototype":{"bad":1}}}'
    );
    assert.equal(res.status, 201);
    assert.equal({}.bad, undefined);
  });
});
