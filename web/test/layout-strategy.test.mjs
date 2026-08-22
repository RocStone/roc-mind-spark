// Layout strategies and parameters (step 4).
//
// This is what makes a layout expressible as JSON: every structural knob the
// engines read is declared in LAYOUT_PARAMS, and nothing outside it can be set.
// The validator repairs rather than rejects, because params arrive alongside a
// preset that is otherwise fine — one bad number should not discard a layout.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const LAYOUT_PARAMS = extractConst('LAYOUT_PARAMS');
const ENGINE_PARAMS = extractConst('ENGINE_PARAMS');

const { validateLayoutParams, resolveLayout } = loadFns(
  ['validateLayoutParams', 'resolveLayout'],
  { LAYOUT_PARAMS, ENGINE_PARAMS }
);

describe('validateLayoutParams — only declared knobs, only allowed values', () => {
  test('keeps a valid enum value', () => {
    assert.equal(validateLayoutParams('tree', { axis: 'y' }).axis, 'y');
  });

  test('drops an enum value that is not allowed', () => {
    assert.equal(validateLayoutParams('tree', { axis: 'diagonal' }).axis, undefined);
  });

  test('keeps and clamps numbers', () => {
    assert.equal(validateLayoutParams('radial', { ring: 200 }).ring, 200);
    assert.equal(validateLayoutParams('radial', { ring: 99999 }).ring, LAYOUT_PARAMS.radial.ring[1]);
    assert.equal(validateLayoutParams('radial', { ring: -5 }).ring, LAYOUT_PARAMS.radial.ring[0]);
  });

  test('never coerces a numeric-looking string', () => {
    assert.equal(validateLayoutParams('radial', { ring: '200' }).ring, undefined);
  });

  test('requires a real boolean', () => {
    assert.equal(validateLayoutParams('chain', { alternate: false }).alternate, false);
    assert.equal(validateLayoutParams('chain', { alternate: 'no' }).alternate, undefined);
  });

  test('drops knobs the strategy does not declare', () => {
    // 'columns' belongs to grid; asking for it on a tree must not smuggle it through.
    const p = validateLayoutParams('tree', { axis: 'x', columns: 5, evil: 1 });
    assert.equal(p.columns, undefined);
    assert.equal(p.evil, undefined);
    assert.equal(p.axis, 'x');
  });

  test('an unknown strategy yields nothing rather than throwing', () => {
    assert.deepEqual(validateLayoutParams('spiral', { ring: 200 }), {});
  });

  test('junk input yields an empty set', () => {
    for (const junk of [null, undefined, 'x', 42, []]) {
      assert.deepEqual(validateLayoutParams('tree', junk), {});
    }
  });

  test('a __proto__ key does not pollute Object.prototype', () => {
    validateLayoutParams('tree', JSON.parse('{"axis":"x","__proto__":{"polluted":"yes"}}'));
    assert.equal({}.polluted, undefined);
  });
});

describe('resolveLayout — always returns something runnable', () => {
  test('every built-in engine resolves to a known strategy', () => {
    for (const [engine, def] of Object.entries(ENGINE_PARAMS)) {
      const r = resolveLayout(engine, null);
      assert.equal(r.strategy, def.strategy, engine);
      assert.ok(LAYOUT_PARAMS[r.strategy], `${engine} -> unknown strategy`);
    }
  });

  test('a built-in resolves to its full default parameter set', () => {
    const r = resolveLayout('down', null);
    assert.equal(r.params.axis, 'y');
    assert.equal(r.params.rootAnchor, 'centered');
    assert.equal(r.params.sideName, 'down', 'down must still name the side its edges use');
  });

  test('explicit params override the defaults they name, and only those', () => {
    const r = resolveLayout('balanced', { gapMain: 200 });
    assert.equal(r.params.gapMain, 200);
    assert.equal(r.params.axis, 'x', 'unnamed defaults survive');
    assert.equal(r.params.split, 'balanced');
  });

  test('an invalid param is ignored rather than discarding the layout', () => {
    const r = resolveLayout('balanced', { axis: 'sideways', gapMain: 150 });
    assert.equal(r.params.axis, 'x', 'the bad value falls back');
    assert.equal(r.params.gapMain, 150, 'the good value still applies');
  });

  test('a bare strategy name resolves too', () => {
    assert.equal(resolveLayout('grid', { columns: 4 }).strategy, 'grid');
  });

  test('an unknown name falls back to a working layout, not a blank map', () => {
    const r = resolveLayout('does-not-exist', null);
    assert.equal(r.strategy, 'tree');
    assert.ok(Number.isFinite(r.params.gapMain));
  });
});

describe('validateLayoutPreset — the strategy form', () => {
  const { validateLayoutPreset } = loadFns(
    ['validateLayoutConfig', 'validateLayoutParams', 'validateLayoutPreset'],
    {
      LAYOUT_PARAMS, ENGINE_PARAMS,
      LAYOUT_ENGINES: extractConst('LAYOUT_ENGINES'),
      LAYOUT_CONFIG_DEFAULTS: extractConst('LAYOUT_CONFIG_DEFAULTS'),
      LAYOUT_CONFIG_BOUNDS: extractConst('LAYOUT_CONFIG_BOUNDS'),
    }
  );

  test('accepts a strategy with params — no engine name needed', () => {
    const p = validateLayoutPreset({
      v: 1, id: 'org-up', name: 'Org chart (up)',
      strategy: 'tree',
      params: { axis: 'y', dir: -1, split: 'one-side', rootAnchor: 'centered' },
    });
    assert.ok(p);
    assert.equal(p.strategy, 'tree');
    assert.equal(p.params.dir, -1);
  });

  test('still accepts the engine shorthand', () => {
    const p = validateLayoutPreset({ v:1, id:'x', name:'X', engine:'timeline' });
    assert.ok(p);
    assert.equal(p.engine, 'timeline');
  });

  test('params given against an engine name are validated under its strategy', () => {
    const p = validateLayoutPreset({ v:1, id:'x', name:'X', engine:'grid', params:{ columns:4, axis:'y' } });
    assert.equal(p.params.columns, 4);
    assert.equal(p.params.axis, undefined, 'grid has no axis knob');
  });

  test('rejects a preset naming neither an engine nor a strategy', () => {
    assert.equal(validateLayoutPreset({ v:1, id:'x', name:'X' }), null);
    assert.equal(validateLayoutPreset({ v:1, id:'x', name:'X', strategy:'spiral' }), null);
  });

  test('a strategy preset still needs a usable id and name', () => {
    assert.equal(validateLayoutPreset({ v:1, id:'', name:'X', strategy:'tree' }), null);
    assert.equal(validateLayoutPreset({ v:1, id:'a b', name:'X', strategy:'tree' }), null);
  });
});

describe('every built-in is expressible in the schema', () => {
  // If a built-in used a knob the schema cannot express, layouts could not be
  // fully described as JSON — which is the whole premise of this step.
  for (const [engine, def] of Object.entries(ENGINE_PARAMS)) {
    test(`${engine}: every parameter it uses is declared`, () => {
      const declared = LAYOUT_PARAMS[def.strategy];
      for (const key of Object.keys(def.params)) {
        if (key === 'sideName') continue;   // internal: names the CSS side class
        assert.ok(declared[key], `${engine} uses "${key}", which ${def.strategy} does not declare`);
      }
    });

    test(`${engine}: its parameters survive validation unchanged`, () => {
      const kept = validateLayoutParams(def.strategy, def.params);
      for (const [key, want] of Object.entries(def.params)) {
        if (key === 'sideName') continue;
        assert.equal(kept[key], want, `${engine}.${key} was altered by validation`);
      }
    });
  }
});
