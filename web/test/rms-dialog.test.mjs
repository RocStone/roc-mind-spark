import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns } from './helpers/load-app-fns.mjs';

const appSrc = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// Just enough DOM for rmsDialog: the modal root hands out one stub per class
// name that its innerHTML actually contains.
function fakeDom() {
  const state = { active: null, appended: [] };
  const stub = (cls) => {
    const el = {
      cls, value: '', textContent: '', isConnected: true, listeners: {},
      focus() { state.active = el; }, select() {}, setAttribute() {},
      addEventListener(t, f) { (el.listeners[t] ||= []).push(f); },
      remove() { el.isConnected = false; state.appended = state.appended.filter(x => x !== el); },
    };
    return el;
  };
  const document = {
    get activeElement() { return state.active; },
    createElement() {
      const root = stub('root'); const kids = {};
      root.querySelector = (sel) => {
        const cls = sel.replace(/^\./, '');
        if (!root.innerHTML.includes(cls)) return null;
        return (kids[cls] ||= stub(cls));
      };
      return root;
    },
    body: { appendChild(el) { state.appended.push(el); } },
  };
  return { document, state };
}
function key(k, target, extra = {}) {
  return { key: k, target, shiftKey: false, altKey: false, ...extra,
    preventDefault() {}, stopPropagation() { this.stopped = true; } };
}
function load() {
  const { document, state } = fakeDom();
  const fns = loadFns(['rmsDialog', 'rmsConfirm', 'rmsPrompt', 'rmsAlert', 'isImeEvent'], {
    document, rmsTr: (k, d) => d,
  });
  const modal = () => state.appended.at(-1);
  const press = (k, target, extra) => {
    const e = key(k, target, extra);
    modal().listeners.keydown.forEach(f => f(e));
    return e;
  };
  return { ...fns, state, modal, press };
}

test('rmsConfirm: Enter resolves true, keydown never reaches the canvas', async () => {
  const d = load();
  const p = d.rmsConfirm('Delete?');
  assert.equal(d.state.active.cls, 'vf-go', 'OK button has focus');
  const e = d.press('Backspace', d.state.active);
  assert.equal(e.stopped, true);
  d.press('Enter', d.state.active);
  assert.equal(await p, true);
  assert.equal(d.state.appended.length, 0);
});

test('rmsConfirm: Escape resolves false', async () => {
  const d = load();
  const p = d.rmsConfirm('Delete?', { danger: true });
  assert.match(d.modal().innerHTML, /vf-go primary danger/);
  d.press('Escape', d.state.active);
  assert.equal(await p, false);
});

test('rmsPrompt: Enter returns the typed value, Escape returns null, IME Enter is ignored', async () => {
  const d = load();
  const p = d.rmsPrompt('URL?', 'https://');
  const input = d.state.active;
  assert.equal(input.cls, 'rms-dialog-input');
  assert.equal(input.value, 'https://');
  input.value = 'https://example.com';
  d.press('Enter', input, { isComposing: true });
  assert.equal(d.state.appended.length, 1, 'IME Enter must not submit');
  d.press('Enter', input);
  assert.equal(await p, 'https://example.com');

  const d2 = load();
  const p2 = d2.rmsPrompt('URL?');
  d2.press('Escape', d2.state.active);
  assert.equal(await p2, null);
});

test('rmsAlert has no Cancel button and resolves on Enter', async () => {
  const d = load();
  const p = d.rmsAlert('Oops');
  assert.doesNotMatch(d.modal().innerHTML, /vf-cancel/);
  d.press('Enter', d.state.active);
  assert.equal(await p, undefined);
});

test('no native confirm/prompt/alert left in app.js', () => {
  const hits = appSrc.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /(^|[^\w.])(confirm|prompt|alert)\(/.test(l) && !/^\s*\/\//.test(l));
  const texts = hits.map(([, l]) => l.trim());
  assert.equal(hits.length, 0, texts.join('\n'));
});
