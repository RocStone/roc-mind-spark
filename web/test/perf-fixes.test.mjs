// Regression tests for performance / correctness fixes in app.js helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

describe('autoLinkPlainTextNodes — global URL_RE state', () => {
  test('links a URL in every text node, not just the first', () => {
    const URL_RE = extractConst('URL_RE');
    const texts = [
      { nodeValue: 'first link at https://example.com/a-fairly-long/path', parentElement: null },
      { nodeValue: 'https://b.io', parentElement: null },
    ];
    const replaced = [];
    const document = {
      createTreeWalker: () => { let i = 0; return { nextNode: () => texts[i++] || null }; },
      createDocumentFragment: () => ({}),
    };
    for (const t of texts) t.parentNode = { replaceChild: () => replaced.push(t.nodeValue) };
    const { autoLinkPlainTextNodes } = loadFns(['autoLinkPlainTextNodes'], {
      URL_RE, document, NodeFilter: { SHOW_TEXT: 4 }, appendTextWithLinks: () => {},
    });
    autoLinkPlainTextNodes({});
    assert.deepEqual(replaced, texts.map(t => t.nodeValue));
  });
});

describe('searchAllMaps — cache, concurrency, stale abort', () => {
  function setup(count) {
    const maps = {};
    const idx = [];
    for (let i = 0; i < count; i++) {
      const id = 'm' + i;
      maps[id] = { id, title: 'Map ' + i, nodes: { n: { id: 'n', text: 'hello ' + i } } };
      idx.push({ id, updated: 1 });
    }
    const stats = { gets: 0, inFlight: 0, peak: 0 };
    const Store = {
      list: async () => idx.map(x => ({ ...x })),
      get: async id => {
        stats.gets++; stats.inFlight++;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        await new Promise(r => setTimeout(r, 1));
        stats.inFlight--;
        return maps[id];
      },
    };
    const fns = loadFns(['searchAllMaps'], {
      Store, map: null, nodeTextPlain: t => t,
      _searchMapCache: new Map(), SEARCH_FETCH_CONCURRENCY: 4,
    });
    return { fns, stats, idx };
  }

  test('fetches at most 4 maps at once and returns every match', async () => {
    const { fns, stats } = setup(10);
    const res = await fns.searchAllMaps('hello');
    assert.equal(res.length, 10);
    assert.equal(stats.gets, 10);
    assert.ok(stats.peak <= 4, `peak ${stats.peak}`);
  });

  test('retyping reuses unchanged maps; a changed `updated` refetches', async () => {
    const { fns, stats, idx } = setup(5);
    await fns.searchAllMaps('hello');
    await fns.searchAllMaps('hell');
    assert.equal(stats.gets, 5);
    idx[2].updated = 2;
    await fns.searchAllMaps('hel');
    assert.equal(stats.gets, 6);
  });

  test('a superseded run stops early and returns null', async () => {
    const { fns, stats } = setup(12);
    let calls = 0;
    const res = await fns.searchAllMaps('hello', () => ++calls > 1);
    assert.equal(res, null);
    assert.equal(stats.gets, 4);
  });
});

describe('splitPipeRow — escaped pipes', () => {
  const fns = loadFns([
    'splitPipeRow', 'isGfmSepLine', 'normalizeTableGrid', 'parseGfmAligns',
    'parseGfmMarkdownTable', 'htmlTableToMarkdown',
  ], {
    htmlTableToGrid: () => ({ headers: ['Name', 'Rule'], rows: [['A|B', 'x']] }),
  });

  test('splits only on unescaped pipes and unescapes cells', () => {
    assert.deepEqual(fns.splitPipeRow('| A\\|B | c |'), ['A|B', 'c']);
    assert.deepEqual(fns.splitPipeRow('a | b\\|'), ['a', 'b|']);
    assert.deepEqual(fns.splitPipeRow('| a | b |'), ['a', 'b']);
  });

  test('htmlTableToMarkdown output round-trips a cell containing a pipe', () => {
    const md = fns.htmlTableToMarkdown('<table></table>');
    assert.match(md, /A\\\|B/);
    const g = fns.parseGfmMarkdownTable(md);
    assert.deepEqual(g.headers, ['Name', 'Rule']);
    assert.deepEqual(g.rows, [['A|B', 'x']]);
  });
});
