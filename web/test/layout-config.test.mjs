// Layout config validation (issue #13 follow-up).
//
// This is a trust boundary, not a convenience: a layoutConfig travels inside
// #view= share links, so it arrives from whoever made the link. The rules it
// must hold to are that anything it returns is complete and in range, and that
// nothing it is given can make a map fail to open.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const DEFAULTS = extractConst('LAYOUT_CONFIG_DEFAULTS');
const BOUNDS = extractConst('LAYOUT_CONFIG_BOUNDS');
const { validateLayoutConfig } = loadFns(
  ['validateLayoutConfig'],
  { LAYOUT_CONFIG_DEFAULTS: DEFAULTS, LAYOUT_CONFIG_BOUNDS: BOUNDS }
);

const tl = raw => validateLayoutConfig(raw).timeline;

describe('validateLayoutConfig — always returns something usable', () => {
  const junk = [
    ['null', null], ['undefined', undefined], ['a string', 'timeline'],
    ['a number', 42], ['an array', [1, 2]], ['an empty object', {}],
    ['timeline as a string', { timeline: 'wide' }],
    ['timeline as an array', { timeline: [] }],
    ['timeline null', { timeline: null }],
  ];
  for (const [label, input] of junk) {
    test(`${label} yields the full defaults rather than throwing`, () => {
      assert.deepEqual(validateLayoutConfig(input), DEFAULTS);
    });
  }

  test('the result is always complete, so callers need no fallbacks', () => {
    const got = tl({ timeline: { gap: 100 } });
    for (const key of Object.keys(DEFAULTS.timeline)) {
      assert.notEqual(got[key], undefined, `${key} missing from the result`);
    }
  });

  test('does not mutate the defaults object between calls', () => {
    validateLayoutConfig({ timeline: { gap: 400 } });
    assert.equal(validateLayoutConfig(null).timeline.gap, DEFAULTS.timeline.gap);
  });

  test('does not mutate the input it was given', () => {
    const input = { timeline: { gap: 99999 } };
    validateLayoutConfig(input);
    assert.equal(input.timeline.gap, 99999, 'caller data must be left alone');
  });
});

describe('validateLayoutConfig — numeric knobs', () => {
  test('accepts an in-range value unchanged', () => {
    assert.equal(tl({ timeline: { gap: 120 } }).gap, 120);
  });

  test('clamps above and below the allowed range instead of rejecting the config', () => {
    const [lo, hi] = BOUNDS.timeline.gap;
    assert.equal(tl({ timeline: { gap: hi + 5000 } }).gap, hi);
    assert.equal(tl({ timeline: { gap: -900 } }).gap, lo);
  });

  test('rounds fractional values', () => {
    assert.equal(tl({ timeline: { gap: 90.6 } }).gap, 91);
  });

  test('ignores non-numbers rather than coercing them', () => {
    // '120' coerced would look right and hide a malformed config.
    assert.equal(tl({ timeline: { gap: '120' } }).gap, DEFAULTS.timeline.gap);
    assert.equal(tl({ timeline: { gap: NaN } }).gap, DEFAULTS.timeline.gap);
    assert.equal(tl({ timeline: { gap: Infinity } }).gap, DEFAULTS.timeline.gap);
    assert.equal(tl({ timeline: { gap: null } }).gap, DEFAULTS.timeline.gap);
  });

  test('each knob is bounded independently', () => {
    const got = tl({ timeline: { gap: 999, stem: -50, indent: 40 } });
    assert.equal(got.gap, BOUNDS.timeline.gap[1]);
    assert.equal(got.stem, BOUNDS.timeline.stem[0]);
    assert.equal(got.indent, 40);
  });

  test('a zero gap is lifted to the minimum, since 0 would overlap cards', () => {
    assert.equal(tl({ timeline: { gap: 0 } }).gap, BOUNDS.timeline.gap[0]);
  });
});

describe('validateLayoutConfig — enum and boolean knobs', () => {
  test('accepts both valid sides', () => {
    assert.equal(tl({ timeline: { start: 'above' } }).start, 'above');
    assert.equal(tl({ timeline: { start: 'below' } }).start, 'below');
  });

  test('falls back to the default for an unrecognised side', () => {
    assert.equal(tl({ timeline: { start: 'sideways' } }).start, DEFAULTS.timeline.start);
    assert.equal(tl({ timeline: { start: 1 } }).start, DEFAULTS.timeline.start);
  });

  test('accepts a real boolean for alternate', () => {
    assert.equal(tl({ timeline: { alternate: false } }).alternate, false);
    assert.equal(tl({ timeline: { alternate: true } }).alternate, true);
  });

  test('ignores truthy non-booleans, which would otherwise silently mean true', () => {
    assert.equal(tl({ timeline: { alternate: 'false' } }).alternate, DEFAULTS.timeline.alternate);
    assert.equal(tl({ timeline: { alternate: 0 } }).alternate, DEFAULTS.timeline.alternate);
  });
});

describe('validateLayoutConfig — every engine has its own section', () => {
  // Before this, only 'timeline' had knobs, so the settings dialog showed
  // timeline's values whatever layout was actually selected.
  test('each engine gets a complete section of its own defaults', () => {
    const got = validateLayoutConfig(null);
    for (const engine of Object.keys(DEFAULTS)) {
      assert.deepEqual(got[engine], DEFAULTS[engine], `${engine} section wrong`);
    }
  });

  test('the tree layouts expose spacing knobs', () => {
    for (const engine of ['balanced', 'right', 'left', 'down']) {
      const got = validateLayoutConfig({ [engine]: { hGap: 90, vGap: 30 } })[engine];
      assert.equal(got.hGap, 90, `${engine} hGap`);
      assert.equal(got.vGap, 30, `${engine} vGap`);
    }
  });

  test('down keeps its own larger vertical default, not the shared one', () => {
    assert.notEqual(DEFAULTS.down.vGap, DEFAULTS.balanced.vGap);
  });

  test('configuring one engine leaves the others at their defaults', () => {
    const got = validateLayoutConfig({ right: { hGap: 200 } });
    assert.equal(got.right.hGap, 200);
    assert.deepEqual(got.balanced, DEFAULTS.balanced);
    assert.deepEqual(got.timeline, DEFAULTS.timeline);
  });

  test('tree-layout knobs are clamped like the timeline ones', () => {
    assert.equal(validateLayoutConfig({ down: { hGap: 99999 } }).down.hGap, BOUNDS.down.hGap[1]);
    assert.equal(validateLayoutConfig({ down: { vGap: -10 } }).down.vGap, BOUNDS.down.vGap[0]);
  });
});

describe('validateLayoutConfig — hostile input', () => {
  test('unknown keys are dropped, not carried through', () => {
    const got = validateLayoutConfig({ timeline: { gap: 90, evil: 'x' }, other: 1 });
    assert.equal(got.timeline.evil, undefined, 'an unknown knob must not survive');
    assert.equal(got.other, undefined, 'an unknown section must not survive');
    // The result carries one section per engine the app implements, and only those.
    assert.deepEqual(Object.keys(got).sort(), Object.keys(DEFAULTS).sort());
  });

  test('a __proto__ key does not pollute Object.prototype', () => {
    const raw = JSON.parse('{"timeline":{"gap":90},"__proto__":{"polluted":"yes"}}');
    validateLayoutConfig(raw);
    assert.equal({}.polluted, undefined);
  });

  test('a function value is ignored — config is data, never code', () => {
    assert.equal(tl({ timeline: { gap: () => 999 } }).gap, DEFAULTS.timeline.gap);
  });

  test('deeply nested junk is ignored without recursing into it', () => {
    let deep = { v: 1 };
    for (let i = 0; i < 500; i++) deep = { nested: deep };
    assert.deepEqual(validateLayoutConfig({ timeline: { gap: 80, deep } }).timeline.gap, 80);
  });
});
