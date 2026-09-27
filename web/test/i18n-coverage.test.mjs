// Guards against hard-coded English UI text creeping back into app.js.
// Every toast() must go through rmsTr / rmsTf, and every literal key passed to
// the translation helpers must exist in both the en and zh dictionaries.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');
const app = readFileSync(join(pub, 'app.js'), 'utf8');

// Intentionally untranslated: developer-facing setup hint, never seen by users
// of a configured build.
const TOAST_ALLOWLIST = new Set([
  'Set GITHUB_URL in app.js to your repo URL',
]);

// Return the argument text of the call whose "(" is at `open`, honouring
// nested parens, quotes and template literals.
function callArgs(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return '';
}

// Blank out every rmsTr(...) / rmsTf(...) / rmsTh(...) call, so what is left
// is only text that bypasses translation.
function stripTranslated(s) {
  let out = s;
  for (;;) {
    const m = /\brmsT[rfh]\s*\(/.exec(out);
    if (!m) return out;
    const open = m.index + m[0].length - 1;
    const inner = callArgs(out, open);
    out = out.slice(0, m.index) + '0' + out.slice(open + inner.length + 2);
  }
}

function rawToastLiterals() {
  const hits = [];
  const re = /\btoast\s*\(/g;
  let m;
  while ((m = re.exec(app))) {
    const before = app.slice(Math.max(0, m.index - 9), m.index);
    if (/function\s+$/.test(before)) continue;          // the definition itself
    const args = callArgs(app, m.index + m[0].length - 1);
    const rest = stripTranslated(args);
    for (const lit of rest.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
      const text = lit[2];
      if (!/[A-Za-z]{2,}/.test(text)) continue;         // punctuation, numbers, '%'
      if (TOAST_ALLOWLIST.has(text)) continue;
      const line = app.slice(0, m.index).split('\n').length;
      hits.push(`app.js:${line}: ${text}`);
    }
  }
  return hits;
}

function loadDict() {
  const src = readFileSync(join(pub, 'i18n.js'), 'utf8');
  const ctx = {
    window: { dispatchEvent() {} },
    document: {
      documentElement: { lang: 'en', classList: { remove() {}, add() {} } },
      readyState: 'complete', querySelectorAll: () => [], addEventListener() {},
    },
    localStorage: { getItem: () => null, setItem() {} },
    CustomEvent: class {},
  };
  vm.runInNewContext(src, ctx);
  return ctx.window.rmsI18nKeys();
}

describe('i18n coverage', () => {
  test('no toast() in app.js shows a raw English literal', () => {
    const hits = rawToastLiterals();
    assert.deepEqual(hits, [], 'wrap these in rmsTr/rmsTf:\n' + hits.join('\n'));
  });

  test('the scanner catches a raw literal and ignores translated ones', () => {
    assert.equal(stripTranslated(`rmsTr('a','Hello there')`), '0');
    assert.equal(stripTranslated(`x ? rmsTf('k','%s done', n) : 'Nothing moved'`), `x ? 0 : 'Nothing moved'`);
  });

  test('every literal key passed to rmsTr / rmsTf / rmsTh exists in en and zh', () => {
    const { en, zh } = loadDict();
    const enSet = new Set(en), zhSet = new Set(zh);
    const missing = [];
    for (const m of app.matchAll(/\brmsT[rfh]\(\s*'([\w-]+)'\s*,/g)) {
      if (!enSet.has(m[1]) || !zhSet.has(m[1])) missing.push(m[1]);
    }
    assert.deepEqual([...new Set(missing)], []);
  });
});
