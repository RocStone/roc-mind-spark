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
