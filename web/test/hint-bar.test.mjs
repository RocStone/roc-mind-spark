import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns } from './helpers/load-app-fns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');

describe('bottom hint bar', () => {
  test('uses the current chords, and the show/hide hotkey when known', () => {
    global.window = {
      rmsChordLabel: id => ({ addChild: '⌘ T', help: '⇧ /' })[id] || '',
      __RMS_NATIVE__: { toggleDisplay: '⌥ ⇧ ⌘ Q' },
    };
    const { hintBarHtml } = loadFns(['hintBarHtml', 'rmsTr', 'escapeHtml']);
    const out = hintBarHtml();
    assert.match(out, /<b>⌘ T<\/b> child/);
    assert.match(out, /<b>Enter<\/b> sibling/);
    assert.match(out, /<b>\?<\/b> all shortcuts/);
    assert.match(out, /<b>⌥ ⇧ ⌘ Q<\/b> show \/ hide/);
    delete global.window;
  });
  test('shortcuts help takes keys from the current chords and lists the new rows', () => {
    global.window = { rmsChordLabel: id => ({ find: '⌃ F', addChild: '⌘ T' })[id] || '' };
    const { keyboardHelpRows } = loadFns(['keyboardHelpRows', 'helpChordLabel']);
    const rows = keyboardHelpRows((k, f) => f).flatMap(g => g[1]);
    const keyFor = desc => (rows.find(r => r[1] === desc) || [])[0];
    assert.equal(keyFor('Find in this map'), '⌃ F');
    assert.equal(keyFor('Add a child node'), '⌘ T');
    assert.equal(keyFor('Find and replace'), '⌘ H');
    assert.equal(keyFor('Show this list'), '?');
    assert.equal(keyFor('Discard the edit and restore the text'), '⇧ Esc');
    assert.equal(keyFor('Select every visible topic'), '⌘ A');
    assert.equal(keyFor('Paste a copied subtree or an outline as children'), '⌘ V');
    delete global.window;
  });
  test('close button is labelled and dismissal is remembered', () => {
    assert.match(html, /id="hintClose"[^>]*aria-label=/);
    assert.match(app, /localStorage\.setItem\(HINT_DISMISSED_KEY, '1'\)/);
    assert.match(app, /HINT_DISMISSED_KEY='rms:hintDismissed'/);
  });
});
