import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const window = { __RMS_SHORTCUTS__: null };
const { rms } = loadFns(['rms'], { window });

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
});
