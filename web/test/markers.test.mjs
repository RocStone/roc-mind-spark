// Per-node marker badges (issue #13).
//
// The palette test exists because of a real bug caught during development:
// '\u1F6A9' looks like a flag but plain \uXXXX takes exactly four hex digits,
// so it silently parses as '\u1F6A' followed by a literal '9' and renders as
// garbage. Seven of twelve markers were broken that way. A length check on
// every entry catches the whole class.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractConst } from './helpers/load-app-fns.mjs';
import { buildMapFromSpec } from '../worker/import-core.js';

const MARKERS = extractConst('MARKERS');

describe('MARKERS palette', () => {
  test('is a non-empty list', () => {
    assert.ok(Array.isArray(MARKERS) && MARKERS.length > 0);
  });

  test('every marker is exactly one character — catches truncated \\uXXXX escapes', () => {
    for (const m of MARKERS) {
      assert.equal([...m.c].length, 1,
        `${m.label} is ${[...m.c].length} chars (${JSON.stringify(m.c)}) — likely a \\uXXXX escape above U+FFFF`);
    }
  });

  test('no marker contains an ASCII digit or letter, which is what a broken escape leaves behind', () => {
    for (const m of MARKERS) {
      assert.ok(!/[0-9A-Za-z]/.test(m.c), `${m.label} contains a stray ASCII char: ${JSON.stringify(m.c)}`);
    }
  });

  test('every marker has a human-readable label for its tooltip', () => {
    for (const m of MARKERS) {
      assert.equal(typeof m.label, 'string');
      assert.ok(m.label.trim().length > 0);
    }
  });

  test('no duplicate glyphs — two entries rendering identically would be unpickable', () => {
    const seen = new Set(MARKERS.map(m => m.c));
    assert.equal(seen.size, MARKERS.length);
  });

  test('stays small enough to scan at a glance', () => {
    assert.ok(MARKERS.length <= 16, `${MARKERS.length} markers is past the point of being scannable`);
  });

  test('includes an in-progress hourglass', () => {
    const hourglass = MARKERS.find(m => m.label === 'In progress');
    assert.ok(hourglass, 'missing In progress marker');
    assert.equal(hourglass.c, '\u23F3');
  });

  test('keeps Finding as the conclusion marker', () => {
    const finding = MARKERS.find(m => m.label === 'Finding');
    assert.equal(finding && finding.c, '\u{1F48E}');
    assert.equal(MARKERS.some(m => m.label === 'Key takeaway'), false);
    assert.equal(MARKERS.some(m => m.label === 'Conclusion'), false);
  });
});

describe('import endpoint carries markers', () => {
  const spec = markerValue => ({
    nodes: [
      { id: 'r', text: 'Root', parent: null },
      { id: 'a', text: 'Child', parent: 'r', marker: markerValue },
    ],
  });

  test('a valid marker survives import', () => {
    const m = buildMapFromSpec(spec('\u2B50'));
    assert.equal(m.nodes.a.marker, '\u2B50');
  });

  test('an astral-plane emoji survives (two UTF-16 units, one character)', () => {
    const m = buildMapFromSpec(spec('\u{1F6A9}'));
    assert.equal(m.nodes.a.marker, '\u{1F6A9}');
  });

  test('surrounding whitespace is trimmed', () => {
    assert.equal(buildMapFromSpec(spec('  \u2B50  ')).nodes.a.marker, '\u2B50');
  });

  test('a long string is rejected rather than becoming a second text field', () => {
    assert.equal(buildMapFromSpec(spec('not a marker at all')).nodes.a.marker, undefined);
  });

  test('an empty or whitespace-only marker is dropped', () => {
    assert.equal(buildMapFromSpec(spec('')).nodes.a.marker, undefined);
    assert.equal(buildMapFromSpec(spec('   ')).nodes.a.marker, undefined);
  });

  test('a non-string marker is ignored rather than coerced', () => {
    assert.equal(buildMapFromSpec(spec(42)).nodes.a.marker, undefined);
    assert.equal(buildMapFromSpec(spec({ c: '\u2B50' })).nodes.a.marker, undefined);
  });

  test('nodes without a marker do not gain one', () => {
    const m = buildMapFromSpec({ nodes: [{ id: 'r', text: 'Root', parent: null }] });
    assert.equal(m.nodes.r.marker, undefined);
  });
});
