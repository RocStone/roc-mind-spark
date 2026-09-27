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

  test('includes a rejected cross mark next to Approved', () => {
    const rejected = MARKERS.find(m => m.label === 'Rejected');
    assert.ok(rejected, 'missing Rejected marker');
    assert.equal(rejected.c, '\u274C');
  });

  test('keeps Finding as the conclusion marker', () => {
    const finding = MARKERS.find(m => m.label === 'Finding');
    assert.equal(finding && finding.c, '\u{1F48E}');
    assert.equal(MARKERS.some(m => m.label === 'Key takeaway'), false);
    assert.equal(MARKERS.some(m => m.label === 'Conclusion'), false);
  });
});
