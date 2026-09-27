import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

// Minimal stand-in for the browser's inert <template> parse + serialize, for
// tag-free HTML: decode entities into one text node, re-escape on output.
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const encode = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function fakeDom() {
  const document = {
    createElement(tag) {
      if (tag === 'template') {
        const t = { content: { texts: [] } };
        Object.defineProperty(t, 'innerHTML', {
          set(v) { assert.doesNotMatch(v, /</, 'fake template only handles text'); t.content.texts = [{ nodeValue: decode(v) }]; },
        });
        return t;
      }
      const d = { frag: null, appendChild(f) { d.frag = f; } };
      Object.defineProperty(d, 'innerHTML', { get() { return d.frag.texts.map(x => encode(x.nodeValue)).join(''); } });
      return d;
    },
    createTreeWalker(content) { let i = 0; return { nextNode: () => content.texts[i++] || null }; },
  };
  return { document, NodeFilter: { SHOW_TEXT: 4 } };
}

const INLINE_HTML_RE = extractConst('INLINE_HTML_RE');
const ENTITY_RE = extractConst('ENTITY_RE');
const hasInlineMarkup = t => INLINE_HTML_RE.test(t || '') || ENTITY_RE.test(t || '');

test('replacing "&" in an entity-escaped node edits the text, not the entity', () => {
  const map = { nodes: { a: { id: 'a', text: 'Tom &amp; Jerry' } } };
  const { replaceInNode } = loadFns(['replaceInNode'], { map, hasInlineMarkup, ...fakeDom() });
  assert.equal(replaceInNode('a', '&', 'and'), 1);
  assert.equal(map.nodes.a.text, 'Tom and Jerry');
});

test('plain-text node is replaced directly', () => {
  const map = { nodes: { a: { id: 'a', text: 'foo bar foo' } } };
  const { replaceInNode } = loadFns(['replaceInNode'], { map, hasInlineMarkup, ...fakeDom() });
  assert.equal(replaceInNode('a', 'FOO', 'x'), 2);
  assert.equal(map.nodes.a.text, 'x bar x');
});

test('focusNextMatch(-1) walks backwards and wraps; from no match it lands on the last', () => {
  const cnt = { textContent: '' };
  const { focusNextMatch } = loadFns(['focusNextMatch'], {
    searchMatches: ['a', 'b', 'c'], searchPos: -1, searchReveal: null, _searchNavigating: false, _searchInputT: 0, doSearch() {},
    keepSearchFocus() {}, searchLeaveCurrent: () => false, searchEnterExpand: () => false,
    autoLayout() {}, searchNodeFingerprint: () => '', paintSearchHits() {},
    select() {}, centreOn() {}, $: () => cnt,
  });
  focusNextMatch(-1); assert.equal(cnt.textContent, '3 / 3');
  focusNextMatch(-1); assert.equal(cnt.textContent, '2 / 3');
  focusNextMatch(1);  assert.equal(cnt.textContent, '3 / 3');
  focusNextMatch();   assert.equal(cnt.textContent, '1 / 3');
  focusNextMatch(-1); assert.equal(cnt.textContent, '3 / 3');
});

test('search and replace inputs ignore IME Enter/Esc', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(src, /\$\('#search'\)\.addEventListener\('keydown',e=>\{\s*if\(isImeEvent\(e\)\) return;/);
  assert.match(src, /\$\('#replace'\)\.addEventListener\('keydown',e=>\{\s*if\(isImeEvent\(e\)\) return;/);
});

test('replaceAll only touches current search matches and toasts when nothing changed', () => {
  const map = { nodes: { a: { id: 'a', text: 'cat' }, b: { id: 'b', text: 'cat' } } };
  const toasts = [];
  const fields = { '#search': { value: 'cat' }, '#replace': { value: 'dog' } };
  const { replaceAll } = loadFns(['replaceAll', 'replaceInNode'], {
    map, hasInlineMarkup, ...fakeDom(), READONLY: false, _historyPreview: null,
    searchMatches: ['a'], $: s => fields[s], pushHistory() {}, render() {}, doSearch() {},
    toast: m => toasts.push(m), rmsTr: (k, d) => `${k}:${d}`,
  });
  replaceAll();
  assert.equal(map.nodes.a.text, 'dog');
  assert.equal(map.nodes.b.text, 'cat');
  fields['#search'].value = 'zzz';
  replaceAll();
  assert.equal(toasts.at(-1), 'replaceNone:Nothing to replace');
});
