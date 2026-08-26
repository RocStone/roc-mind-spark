// Per-node hyperlink (n.url). Badge opens; nodebar edits.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const i18nSrc = readFileSync(join(here, '..', 'public', 'i18n.js'), 'utf8');
const appSrc = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(here, '..', 'public', 'styles.css'), 'utf8');

const { normalizeNodeUrl } = loadFns(['normalizeNodeUrl']);

describe('normalizeNodeUrl', () => {
  test('keeps a normal https URL', () => {
    assert.equal(
      normalizeNodeUrl('https://arxiv.org/html/2601.03511v2'),
      'https://arxiv.org/html/2601.03511v2'
    );
  });

  test('trims, unwraps <...>, and prefixes a bare host', () => {
    assert.equal(normalizeNodeUrl('  arxiv.org/html/2601.03511v2  '), 'https://arxiv.org/html/2601.03511v2');
    assert.equal(normalizeNodeUrl('<https://example.com/a>'), 'https://example.com/a');
  });

  test('rejects javascript, data, and empty values', () => {
    assert.equal(normalizeNodeUrl('javascript:alert(1)'), '');
    assert.equal(normalizeNodeUrl('data:text/html,hi'), '');
    assert.equal(normalizeNodeUrl(''), '');
    assert.equal(normalizeNodeUrl('   '), '');
    assert.equal(normalizeNodeUrl('not a url'), '');
  });
});

describe('setNodeUrl', () => {
  function harness(){
    const map = { nodes: { n1: { text: 'IntroLM 2026' } } };
    let rendered = 0, laid = 0, flushed = 0, toasts = [];
    const { setNodeUrl } = loadFns(
      ['normalizeNodeUrl', 'setNodeUrl'],
      {
        map,
        flushOpenEditToModel(){ flushed++; },
        pushHistory(){},
        render(){ rendered++; },
        autoLayout(){ laid++; },
        toast(msg){ toasts.push(msg); },
      }
    );
    return { map, setNodeUrl, stats: () => ({ rendered, laid, flushed, toasts }) };
  }

  test('stores a valid URL and rebuilds the card', () => {
    const h = harness();
    assert.equal(h.setNodeUrl('n1', 'https://arxiv.org/html/2601.03511v2'), true);
    assert.equal(h.map.nodes.n1.url, 'https://arxiv.org/html/2601.03511v2');
    const s = h.stats();
    assert.ok(s.flushed >= 1);
    assert.ok(s.rendered >= 1);
    assert.ok(s.laid >= 1);
  });

  test('empty input removes the URL', () => {
    const h = harness();
    h.map.nodes.n1.url = 'https://example.com';
    assert.equal(h.setNodeUrl('n1', '  '), true);
    assert.equal(h.map.nodes.n1.url, undefined);
  });

  test('rejects a bad URL and leaves the node unchanged', () => {
    const h = harness();
    h.map.nodes.n1.url = 'https://example.com';
    assert.equal(h.setNodeUrl('n1', 'javascript:alert(1)'), false);
    assert.equal(h.map.nodes.n1.url, 'https://example.com');
    assert.ok(h.stats().toasts.length >= 1);
  });
});

describe('chrome wiring', () => {
  test('nodebar has an Add hyperlink button next to cite', () => {
    assert.match(appSrc, /data-a="href"/);
    assert.match(appSrc, /Add hyperlink/);
    assert.match(appSrc, /showHrefPicker\(b, sel\)/);
  });

  test('Enter and the Save button both confirm', () => {
    assert.match(appSrc, /if\(ev\.key==='Enter'\)\{ ev\.preventDefault\(\); save\(\); \}/);
    assert.match(appSrc, /querySelector\('\.href-go'\)\.onclick=ev=>\{ ev\.stopPropagation\(\); save\(\); \}/);
  });

  test('linked nodes are not underlined as a whole', () => {
    assert.match(css, /\.node\.href-node/);
    assert.match(css, /\.node \.href-bar/);
    assert.match(css, /\.node \.href-mark/);
    assert.doesNotMatch(css, /\.node\.href-node[^{]*\{[^}]*text-decoration:\s*underline/);
    assert.doesNotMatch(css, /\.href-node \.node-text[^{]*\{[^}]*text-decoration:\s*underline/);
  });

  test('i18n labels exist in both locales', () => {
    assert.match(i18nSrc, /actHref: 'Hyperlink'/);
    assert.match(i18nSrc, /actHref: '超链接'/);
  });
});
