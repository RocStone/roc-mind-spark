import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

// Every one of these mutates the map. Called in a read-only view (shared link,
// history preview) they must do nothing — each would otherwise touch `map`
// before anything else and throw or write.
const MUTATORS = [
  ['deleteNode', ['a']],
  ['bulkDelete', []],
  ['bulkFormat', ['bold']],
  ['bulkSetProp', ['color', '#fff']],
  ['bulkCycleAlign', []],
  ['bulkReparent', ['a']],
  ['toggleMultiSelect', ['a']],
  ['startLinkMode', ['a']],
  ['replaceNext', []],
  ['replaceAll', []],
];

for (const [name, args] of MUTATORS) {
  test(`${name} is a no-op when READONLY`, () => {
    const explode = new Proxy({}, { get() { throw new Error(`${name} touched map`); } });
    const fns = loadFns([name], {
      READONLY: true, _historyPreview: null, map: explode, multiSel: explode,
      sel: null, linkSource: null, $: () => { throw new Error(`${name} read the DOM`); },
    });
    assert.doesNotThrow(() => fns[name](...args));
  });
}

test('completeLink cancels link mode but writes nothing when READONLY', () => {
  let cancelled = 0;
  const explode = new Proxy({}, { get() { throw new Error('touched map'); } });
  const { completeLink } = loadFns(['completeLink'], {
    READONLY: true, map: explode, linkSource: 'a', cancelLinkMode: () => { cancelled++; },
  });
  completeLink('b');
  assert.equal(cancelled, 1);
});

test('bulkSetProp color on the root writes map.color', () => {
  const map = { rootId: 'r', color: '#111', nodes: { r: { id: 'r' }, a: { id: 'a' } } };
  const { bulkSetProp } = loadFns(['bulkSetProp'], {
    READONLY: false, map, multiSel: new Set(['r', 'a']),
    pushHistory() {}, render() {}, updateMultiSelUI() {},
  });
  bulkSetProp('color', '#abc');
  assert.equal(map.color, '#abc');
  assert.equal(map.nodes.a.color, '#abc');
  assert.equal(map.nodes.r.color, undefined);
});
