import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFns } from './helpers/load-app-fns.mjs';

const window = { __RMS_SHORTCUTS__: null };
const { rms, editSessionCreateAction } = loadFns(
  ['specMatches', 'rms', 'editSessionCreateAction'],
  { window }
);

const ev = (over = {}) => ({
  key: 'Tab',
  code: 'Tab',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('rms — optional shortcut overrides from the Mac shell', () => {
  test('no override: the fallback decides', () => {
    window.__RMS_SHORTCUTS__ = null;
    assert.equal(rms('addChild', ev(), true), true);
    assert.equal(rms('addChild', ev(), false), false);
  });

  test('override matches key + modifiers exactly', () => {
    window.__RMS_SHORTCUTS__ = {
      addChild: { key: 'tab', code: 'Tab', meta: false, ctrl: false, alt: false, shift: false },
    };
    assert.equal(rms('addChild', ev({ key: 'Tab', code: 'Tab' }), false), true);
    assert.equal(rms('addChild', ev({ key: 'Tab', code: 'Tab', metaKey: true }), false), false);
  });

  test('help matches Slash+Shift as ?', () => {
    window.__RMS_SHORTCUTS__ = {
      help: { key: '/', code: 'Slash', meta: false, ctrl: false, alt: false, shift: true },
    };
    assert.equal(rms('help', ev({ key: '?', code: 'Slash', shiftKey: true }), false), true);
    assert.equal(rms('help', ev({ key: '/', code: 'Slash', shiftKey: false }), false), false);
  });

  test('addSibling is bare Enter; addSiblingMod is ⌘/Ctrl+Enter', () => {
    window.__RMS_SHORTCUTS__ = {
      addSibling: { key: 'Enter', code: 'Enter', meta: false, ctrl: false, alt: false, shift: false },
      addSiblingMod: { key: 'Enter', code: 'Enter', meta: true, ctrl: false, alt: false, shift: false },
    };
    const enter = ev({ key: 'Enter', code: 'Enter' });
    const cmdEnter = ev({ key: 'Enter', code: 'Enter', metaKey: true });
    assert.equal(rms('addSibling', enter, false), true);
    assert.equal(rms('addSibling', cmdEnter, false), false);
    assert.equal(rms('addSiblingMod', cmdEnter, false), true);
    assert.equal(rms('addSiblingMod', enter, false), false);
  });

  test('editSessionCreateAction follows addSiblingMod override', () => {
    window.__RMS_SHORTCUTS__ = {
      addChild: { key: 'Tab', code: 'Tab', meta: false, ctrl: false, alt: false, shift: false },
      addSiblingMod: { key: 'Enter', code: 'Enter', meta: true, ctrl: false, alt: false, shift: false },
    };
    assert.equal(editSessionCreateAction(ev({ key: 'Enter', code: 'Enter', metaKey: true })), 'sibling');
    assert.equal(editSessionCreateAction(ev({ key: 'Enter', code: 'Enter' })), null);
  });
});

describe('settings canvas shortcut list', () => {
  test('Cmd+, lists both sibling chords and the other canvas actions', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'rms-settings.js'),
      'utf8'
    );
    const ids = [...src.matchAll(/id:'([a-zA-Z]+)'/g)].map(m => m[1]);
    for (const id of [
      'openSettings', 'addChild', 'addSibling', 'addSiblingMod', 'editNode',
      'deleteNode', 'deleteForward', 'collapse', 'link',
      'moveSiblingUp', 'moveSiblingDown', 'moveSiblingUpAlt', 'moveSiblingDownAlt',
      'undo', 'redo', 'find', 'findReplace', 'help',
    ]) {
      assert.ok(ids.includes(id), 'missing canvas shortcut ' + id);
    }
    assert.equal(ids.filter(id => id === 'addSibling' || id === 'addSiblingMod').length, 2);
  });
});
