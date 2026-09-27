// The native shell quits without flushing when the page reports
// saveState dirty:false, even with the overlay visible. So the flag must
// include drafts that have not reached the model yet, not only the save queue.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const INLINE_HTML_RE = extractConst('INLINE_HTML_RE');

function classList(...names){
  const set = new Set(names);
  return { contains: c => set.has(c) };
}

function setup({ saveStates = [], md = {}, notes = null, editing = null, float = null, nodes } = {}){
  const map = { nodes: nodes || { n1: { text: 'hello' } } };
  const document = {
    querySelector(sel){
      if(sel === '.notes-popup .np-editor') return notes;
      if(sel === '.node.editing') return editing;
      return null;
    },
  };
  return loadFns(
    ['rmsPageIsDirty', 'notesPopupIsDirty', 'openNodeEditIsDirty', 'captureNodeEditText', 'editFloatLiveTextEl'],
    {
      document, map,
      _mapSaveStates: new Map(saveStates),
      mdMode: !!md.on, _mdTimer: md.timer || 0, _mdComposing: !!md.composing,
      _editFloat: float,
      INLINE_HTML_RE,
      sanitizeInlineHTML: h => h,
      sanitizeNotes: h => h,
      captureBlockEditHTML: (box, original) => box.innerHTML || original,
    }
  ).rmsPageIsDirty;
}

function textEditor(text, extra = {}){
  return { innerHTML: text, textContent: text, ...extra };
}

describe('rmsPageIsDirty', () => {
  test('idle page with no open editors is clean', () => {
    assert.equal(setup()(), false);
    assert.equal(setup({ saveStates: [['m1', 'saved']] })(), false);
  });

  test('any unsaved queue state is dirty', () => {
    assert.equal(setup({ saveStates: [['m1', 'saved'], ['m2', 'saving']] })(), true);
    assert.equal(setup({ saveStates: [['m1', 'failed']] })(), true);
  });

  test('Markdown pane with a pending sync timer or IME composition is dirty', () => {
    assert.equal(setup({ md: { on: true, timer: 7 } })(), true);
    assert.equal(setup({ md: { on: true, composing: true } })(), true);
    assert.equal(setup({ md: { on: true } })(), false);
  });

  test('notes popup is dirty only when its HTML differs from what it opened with', () => {
    assert.equal(setup({ notes: { innerHTML: 'a', _initialHTML: 'a' } })(), false);
    assert.equal(setup({ notes: { innerHTML: 'ab', _initialHTML: 'a' } })(), true);
  });

  test('open node editor: unchanged text is clean, typed text is dirty', () => {
    const el = (t, extra) => ({ dataset: { id: 'n1' }, classList: classList('node', 'editing'),
      querySelector: s => s === '.node-text' ? textEditor(t, extra) : null });
    assert.equal(setup({ editing: el('hello') })(), false);
    assert.equal(setup({ editing: el('hello world') })(), true);
    assert.equal(setup({ editing: el('hello', { _rmsComposing: true }) })(), true);
  });

  test('WK edit float is read instead of the hidden placeholder', () => {
    const live = textEditor('typed');
    const float = { dataset: { nodeId: 'n1' }, classList: classList('edit-float'),
      querySelector: s => s === '.edit-float-text' ? live : null };
    assert.equal(setup({ float })(), true);
    live.innerHTML = live.textContent = 'hello';
    assert.equal(setup({ float })(), false);
  });

  test('a float merely prepared for the first keystroke is clean', () => {
    const float = { dataset: { nodeId: 'n1' }, classList: classList('edit-float', 'input-ready'),
      querySelector: () => textEditor('') };
    assert.equal(setup({ float })(), false);
  });

  test('block (code/table) edit compares the captured HTML', () => {
    const nodes = { n1: { html: '<pre><code>x</code></pre>' } };
    const el = html => ({ dataset: { id: 'n1' }, classList: classList('node', 'editing', 'editing-block'),
      querySelector: s => s === '.node-block' ? { innerHTML: html } : null });
    assert.equal(setup({ nodes, editing: el('<pre><code>x</code></pre>') })(), false);
    assert.equal(setup({ nodes, editing: el('<pre><code>xy</code></pre>') })(), true);
  });
});
