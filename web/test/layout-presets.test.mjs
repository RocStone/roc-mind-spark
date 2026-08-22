// Layout preset validation.
//
// This is the gate on imported JSON. Unlike validateLayoutConfig(), which
// repairs whatever it is handed, this returns null for anything unusable: a
// user pasting a preset should be told it is wrong, not silently given
// something they did not ask for.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const ENGINES = extractConst('LAYOUT_ENGINES');
const BUILTINS = extractConst('BUILTIN_LAYOUTS');
const DEFAULTS = extractConst('LAYOUT_CONFIG_DEFAULTS');
const BOUNDS = extractConst('LAYOUT_CONFIG_BOUNDS');

const { validateLayoutPreset } = loadFns(
  ['validateLayoutConfig', 'validateLayoutPreset'],
  {
    LAYOUT_ENGINES: ENGINES,
    LAYOUT_CONFIG_DEFAULTS: DEFAULTS,
    LAYOUT_CONFIG_BOUNDS: BOUNDS,
  }
);

const ok = over => ({ v: 1, id: 'my-layout', name: 'My layout', engine: 'timeline', ...over });

describe('validateLayoutPreset — accepts a well-formed preset', () => {
  test('returns a clean preset', () => {
    const p = validateLayoutPreset(ok());
    assert.equal(p.id, 'my-layout');
    assert.equal(p.name, 'My layout');
    assert.equal(p.engine, 'timeline');
  });

  test('every engine this app implements is accepted', () => {
    for (const engine of ENGINES) {
      assert.ok(validateLayoutPreset(ok({ engine })), `${engine} should be valid`);
    }
  });

  test('an optional description is kept', () => {
    assert.equal(validateLayoutPreset(ok({ desc: 'Wider spacing' })).desc, 'Wider spacing');
  });

  test('options are run through the config validator, so bounds apply here too', () => {
    const p = validateLayoutPreset(ok({ options: { timeline: { gap: 99999 } } }));
    assert.equal(p.options.timeline.gap, BOUNDS.timeline.gap[1], 'out-of-range gap must be clamped');
  });

  test('a preset without options is still valid', () => {
    assert.equal(validateLayoutPreset(ok()).options, undefined);
  });
});

describe('validateLayoutPreset — rejects rather than repairs', () => {
  const bad = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'timeline'],
    ['an array', [{ engine: 'timeline' }]],
    ['an empty object', {}],
    ['an unknown engine', ok({ engine: 'spiral' })],
    ['a missing engine', { v: 1, id: 'x', name: 'X' }],
    ['an engine that is not a string', ok({ engine: 3 })],
    ['a missing id', ok({ id: undefined })],
    ['an empty id', ok({ id: '   ' })],
    ['a missing name', ok({ name: '' })],
    ['a name that is not a string', ok({ name: 42 })],
  ];
  for (const [label, input] of bad) {
    test(`${label} returns null`, () => {
      assert.equal(validateLayoutPreset(input), null);
    });
  }

  test('an id with characters that would not survive a DOM attribute is rejected', () => {
    // The id is interpolated into data-id, so quotes and angle brackets must
    // never reach it.
    for (const id of ['a"b', "a'b", '<script>', 'a b', 'a/b', '-lead']) {
      assert.equal(validateLayoutPreset(ok({ id })), null, `${id} should be rejected`);
    }
  });
});

describe('validateLayoutPreset — bounds what it keeps', () => {
  test('an over-long id is truncated rather than rejected', () => {
    const p = validateLayoutPreset(ok({ id: 'a'.repeat(200) }));
    assert.ok(p && p.id.length <= 40);
  });

  test('an over-long name is truncated so it cannot break the picker row', () => {
    const p = validateLayoutPreset(ok({ name: 'N'.repeat(200) }));
    assert.ok(p && p.name.length <= 24);
  });

  test('an over-long description is truncated', () => {
    const p = validateLayoutPreset(ok({ desc: 'D'.repeat(500) }));
    assert.ok(p && p.desc.length <= 80);
  });

  test('unknown keys are dropped, not carried into storage', () => {
    const p = validateLayoutPreset(ok({ evil: 'x', onclick: 'alert(1)' }));
    assert.equal(p.evil, undefined);
    assert.equal(p.onclick, undefined);
  });

  test('a function value cannot smuggle behaviour in as an engine', () => {
    assert.equal(validateLayoutPreset(ok({ engine: () => {} })), null);
  });

  test('a __proto__ key does not pollute Object.prototype', () => {
    const raw = JSON.parse('{"v":1,"id":"x","name":"X","engine":"right","__proto__":{"polluted":"yes"}}');
    validateLayoutPreset(raw);
    assert.equal({}.polluted, undefined);
  });
});

describe('BUILTIN_LAYOUTS use the same schema as an import', () => {
  // If a built-in could not survive validateLayoutPreset(), the schema would
  // be describing something other than what the app actually does.
  for (const b of BUILTINS) {
    test(`"${b.id}" is a valid preset in its own right`, () => {
      const p = validateLayoutPreset(b);
      assert.ok(p, `${b.id} failed validation`);
      assert.equal(p.engine, b.engine);
    });
  }

  test('every built-in names an engine that exists', () => {
    for (const b of BUILTINS) assert.ok(ENGINES.includes(b.engine), `${b.id} -> ${b.engine}`);
  });

  test('built-in ids are unique', () => {
    const ids = BUILTINS.map(b => b.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});
