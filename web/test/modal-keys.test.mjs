import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns } from './helpers/load-app-fns.mjs';

const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Tiny DOM: elements have class lists; the document matches a comma list of
// simple `.a` / `.a.b` selectors against what is currently "open".
function el(classes, kids = {}) {
  const e = {
    classes: new Set(classes.split(' ')), removed: false, clicked: 0,
    classList: { contains: c => e.classes.has(c) },
    querySelector: sel => sel.split(',').map(s => kids[s.trim()]).find(Boolean) || null,
    remove() { e.removed = true; },
    click() { e.clicked++; },
  };
  return e;
}
function fakeDocument(open) {
  const matches = (e, sel) => sel.trim().split('.').filter(Boolean).every(c => e.classes.has(c));
  const live = () => open.filter(e => !e.removed);
  return {
    querySelectorAll: sel => live().filter(e => sel.split(',').some(s => matches(e, s))),
    querySelector: sel => live().find(e => sel.split(',').some(s => matches(e, s))) || null,
  };
}
function load(open, extra = {}) {
  return loadFns(['topModalEl', 'closeModalOnEscape', 'closeTransientOnEscape'], {
    document: fakeDocument(open), themePanel: null, closeAllMenus() {}, ...extra,
  });
}

test('topModalEl sees var-form, kb-help and hist-panel; the in-page dialog wins', () => {
  assert.equal(load([]).topModalEl(), null);
  const kb = el('kb-help'), dlg = el('var-form rms-dialog'), hist = el('hist-panel');
  assert.equal(load([kb]).topModalEl(), kb);
  assert.equal(load([hist]).topModalEl(), hist);
  assert.equal(load([dlg, kb]).topModalEl(), dlg);
});

test('closeModalOnEscape presses Cancel/close, closes history via its × and leaves settings alone', () => {
  const cancel = el('vf-cancel');
  const form = el('var-form', { '.vf-cancel': cancel });
  assert.equal(load([form]).closeModalOnEscape(form), true);
  assert.equal(cancel.clicked, 1);

  const kbClose = el('kb-close');
  const kb = el('kb-help', { '.kb-close': kbClose });
  load([kb]).closeModalOnEscape(kb);
  assert.equal(kbClose.clicked, 1);

  const x = el('hist-x');
  const hist = el('hist-panel', { '.hist-x': x });
  load([hist]).closeModalOnEscape(hist);
  assert.equal(x.clicked, 1);

  const settings = el('rms-settings var-form');
  assert.equal(load([settings]).closeModalOnEscape(settings), false);
  assert.equal(settings.removed, false);
});

test('closeTransientOnEscape closes menus before the diff panel, one layer per press', () => {
  const menu = el('rms-ctx'), diff = el('diff-panel');
  let menusClosed = 0;
  const f = load([menu, diff], { closeAllMenus() { menusClosed++; } });
  assert.equal(f.closeTransientOnEscape(), true);
  assert.equal(menu.removed, true);
  assert.equal(diff.removed, false);
  assert.equal(menusClosed, 1);
  assert.equal(f.closeTransientOnEscape(), true);
  assert.equal(diff.removed, true);
  assert.equal(f.closeTransientOnEscape(), false);
});

test('main canvas keydown returns early while a modal is open', () => {
  assert.match(appSrc,
    /if\(clipboardEditAction\(e\)\) return;\s*const modal=topModalEl\(\);\s*if\(modal\)\{[\s\S]{0,400}?return;\s*\}\s*if\(\['INPUT','TEXTAREA'\]/);
  assert.match(appSrc, /if\(isImeEvent\(e\)\) return;\s*if\(topModalEl\(\)\) return;/, 'sibling reorder capture handler');
});

test('shortcut help focuses its close button', () => {
  assert.match(appSrc, /m\.querySelector\('\.kb-close'\)\.focus\(\);/);
});
