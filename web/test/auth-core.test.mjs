// authorizeRequest() decides who may read, write, or administer a map.
// It's the highest-consequence pure function in the codebase — a wrong `ok:true`
// exposes or lets someone edit another user's map. It has also regressed before
// (linkAccess==='edit' briefly required an identity, breaking anonymous
// link-editing), which is exactly the kind of change these tests pin down.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRequest } from '../worker/auth-core.js';

const OWNER = { sub: 'user-owner' };
const OTHER = { sub: 'user-other' };

const aclWith = (over = {}) => ({
  ownerId: 'user-owner',
  linkAccess: 'none',
  members: {},
  ...over,
});

describe('authorizeRequest — read', () => {
  test('a map with no ACL at all is readable by anyone (pre-ACL legacy maps)', () => {
    const r = authorizeRequest({ acl: null, need: 'read' });
    assert.equal(r.ok, true);
    assert.equal(r.role, 'open-legacy');
  });

  test('owner can read', () => {
    const r = authorizeRequest({ acl: aclWith(), identity: OWNER, need: 'read' });
    assert.equal(r.ok, true);
    assert.equal(r.role, 'owner');
  });

  test('a viewer member can read', () => {
    const acl = aclWith({ members: { 'user-other': { role: 'viewer' } } });
    const r = authorizeRequest({ acl, identity: OTHER, need: 'read' });
    assert.equal(r.ok, true);
    assert.equal(r.role, 'viewer');
  });

  test('a stranger CANNOT read a private map', () => {
    const r = authorizeRequest({ acl: aclWith({ linkAccess: 'none' }), identity: OTHER, need: 'read' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403, 'authenticated but unauthorised is 403, not 401');
  });

  test('an anonymous visitor CANNOT read a private map, and gets 401 not 403', () => {
    const r = authorizeRequest({ acl: aclWith({ linkAccess: 'none' }), need: 'read' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401, 'no identity means 401 so the client knows to sign in');
  });

  test("linkAccess 'view' lets an anonymous visitor read", () => {
    const r = authorizeRequest({ acl: aclWith({ linkAccess: 'view' }), need: 'read' });
    assert.equal(r.ok, true);
    assert.equal(r.role, 'link-viewer');
  });

  test("linkAccess 'edit' also implies read for anonymous visitors", () => {
    const r = authorizeRequest({ acl: aclWith({ linkAccess: 'edit' }), need: 'read' });
    assert.equal(r.ok, true);
  });

  test("linkAccess 'view-auth' requires a signed-in user", () => {
    const acl = aclWith({ linkAccess: 'view-auth' });
    assert.equal(authorizeRequest({ acl, need: 'read' }).ok, false, 'anonymous is refused');
    assert.equal(authorizeRequest({ acl, identity: OTHER, need: 'read' }).ok, true, 'signed-in is allowed');
  });
});

describe('authorizeRequest — write', () => {
  test('owner can write', () => {
    const r = authorizeRequest({ acl: aclWith(), identity: OWNER, need: 'write' });
    assert.equal(r.ok, true);
    assert.equal(r.role, 'owner');
  });

  test('an editor member can write', () => {
    const acl = aclWith({ members: { 'user-other': { role: 'editor' } } });
    assert.equal(authorizeRequest({ acl, identity: OTHER, need: 'write' }).ok, true);
  });

  test('a VIEWER member cannot write (rank must be >= editor)', () => {
    const acl = aclWith({ members: { 'user-other': { role: 'viewer' } } });
    const r = authorizeRequest({ acl, identity: OTHER, need: 'write' });
    assert.equal(r.ok, false, 'read access must not imply write access');
  });

  test("linkAccess 'edit' allows an ANONYMOUS editor — no identity, no token", () => {
    // Regression guard: this branch was once tightened to require an identity,
    // which silently broke every "anyone with the link can edit" map.
    const r = authorizeRequest({ acl: aclWith({ linkAccess: 'edit' }), need: 'write' });
    assert.equal(r.ok, true);
    assert.equal(r.role, 'link-editor');
  });

  test("linkAccess 'edit-auth' requires sign-in to write", () => {
    const acl = aclWith({ linkAccess: 'edit-auth' });
    assert.equal(authorizeRequest({ acl, need: 'write' }).ok, false, 'anonymous refused');
    assert.equal(authorizeRequest({ acl, identity: OTHER, need: 'write' }).ok, true, 'signed-in allowed');
  });

  test("linkAccess 'view' does NOT grant write", () => {
    const r = authorizeRequest({ acl: aclWith({ linkAccess: 'view' }), need: 'write' });
    assert.equal(r.ok, false, 'view-only links must never permit edits');
  });

  test('with no ACL, a matching legacy edit token grants write', () => {
    const r = authorizeRequest({ acl: null, editToken: 'secret', tokenHeader: 'secret', need: 'write', allowClaim: false });
    assert.equal(r.ok, true);
    assert.equal(r.role, 'link-editor');
  });

  test('with no ACL, a NON-matching token is refused', () => {
    const r = authorizeRequest({ acl: null, editToken: 'secret', tokenHeader: 'wrong', need: 'write', allowClaim: false });
    assert.equal(r.ok, false);
  });

  test('with no ACL and no token, the first write claims the token', () => {
    const r = authorizeRequest({ acl: null, need: 'write' });
    assert.equal(r.ok, true);
    assert.equal(r.claimToken, true);
  });
});

describe('authorizeRequest — admin', () => {
  test('owner can administer', () => {
    assert.equal(authorizeRequest({ acl: aclWith(), identity: OWNER, need: 'admin' }).ok, true);
  });

  test('an EDITOR member cannot administer (only the owner may)', () => {
    const acl = aclWith({ members: { 'user-other': { role: 'editor' } } });
    const r = authorizeRequest({ acl, identity: OTHER, need: 'admin' });
    assert.equal(r.ok, false, 'editors must not be able to change sharing/ACL');
  });

  test('an anonymous visitor can never administer, even on a public-edit map', () => {
    const r = authorizeRequest({ acl: aclWith({ linkAccess: 'edit' }), need: 'admin' });
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  });

  test('the first authenticated user claims an unowned map', () => {
    const r = authorizeRequest({ acl: null, identity: OTHER, need: 'admin' });
    assert.equal(r.ok, true);
    assert.equal(r.claim, true);
  });

  test('claiming can be disabled with allowClaim:false', () => {
    const r = authorizeRequest({ acl: null, identity: OTHER, need: 'admin', allowClaim: false });
    assert.equal(r.ok, false);
  });
});
