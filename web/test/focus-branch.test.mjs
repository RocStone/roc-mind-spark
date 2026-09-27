import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

// root
// ├─ a
// │  ├─ a1
// │  │  └─ a1x
// │  └─ a2
// ├─ b (collapsed)
// │  └─ b1
// └─ c
function makeMap(extra = {}) {
  return {
    rootId: 'root',
    nodes: {
      root: { id: 'root', parent: null },
      a: { id: 'a', parent: 'root' },
      a1: { id: 'a1', parent: 'a' },
      a1x: { id: 'a1x', parent: 'a1' },
      a2: { id: 'a2', parent: 'a' },
      b: { id: 'b', parent: 'root', collapsed: true },
      b1: { id: 'b1', parent: 'b' },
      c: { id: 'c', parent: 'root' },
      ...extra,
    },
  };
}

function load(map, focusId) {
  return loadFns(
    ['buildChildIndex', 'focusBranchSets', 'hiddenSet', 'isFocusAncestor', 'isInFocusBranch', 'focusAllowsAdd'],
    { map, _ci: null, _focusRootId: focusId }
  );
}
const sorted = s => [...s].sort();

describe('hiddenSet without a focus root', () => {
  test('only collapsed descendants are hidden', () => {
    const { hiddenSet } = load(makeMap(), null);
    assert.deepEqual(sorted(hiddenSet()), ['b1']);
  });
  test('focusing the root is the same as no focus', () => {
    const { hiddenSet } = load(makeMap(), 'root');
    assert.deepEqual(sorted(hiddenSet()), ['b1']);
  });
  test('a focus id that no longer exists (deleted) hides nothing extra', () => {
    const { hiddenSet } = load(makeMap(), 'gone');
    assert.deepEqual(sorted(hiddenSet()), ['b1']);
  });
});

describe('hiddenSet with a focus root', () => {
  test('shows the subtree and the ancestor chain, hides every other branch', () => {
    const { hiddenSet } = load(makeMap(), 'a1');
    // visible: root, a (ancestors), a1, a1x (branch)
    assert.deepEqual(sorted(hiddenSet()), ['a2', 'b', 'b1', 'c']);
  });
  test('focusing a first-level topic keeps its whole subtree', () => {
    const { hiddenSet } = load(makeMap(), 'a');
    assert.deepEqual(sorted(hiddenSet()), ['b', 'b1', 'c']);
  });
  test('collapse inside the focused branch still hides descendants', () => {
    const m = makeMap();
    m.nodes.a1.collapsed = true;
    const { hiddenSet } = load(m, 'a');
    assert.deepEqual(sorted(hiddenSet()), ['a1x', 'b', 'b1', 'c']);
  });
  test('a folded ancestor does not hide the focused branch', () => {
    const m = makeMap();
    m.nodes.a.collapsed = true;
    const { hiddenSet } = load(m, 'a1');
    assert.deepEqual(sorted(hiddenSet()), ['a2', 'b', 'b1', 'c']);
  });
  test('focusing inside a collapsed branch works and b stays visible', () => {
    const { hiddenSet } = load(makeMap(), 'b1');
    assert.deepEqual(sorted(hiddenSet()), ['a', 'a1', 'a1x', 'a2', 'c']);
  });
  test('does not mutate collapsed flags or add any other field', () => {
    const m = makeMap();
    const before = JSON.stringify(m);
    load(m, 'a1').hiddenSet();
    assert.equal(JSON.stringify(m), before);
  });
});

describe('focusBranchSets', () => {
  test('returns the ancestor chain and the branch', () => {
    const m = makeMap();
    const { focusBranchSets, buildChildIndex } = load(m, null);
    const fb = focusBranchSets('a1', 'root', m.nodes, buildChildIndex());
    assert.deepEqual(sorted(fb.ancestors), ['a', 'root']);
    assert.deepEqual(sorted(fb.branch), ['a1', 'a1x']);
  });
  test('null for no id, the root, a missing node, or a detached node', () => {
    const m = makeMap({ orphan: { id: 'orphan', parent: 'nowhere' } });
    const { focusBranchSets, buildChildIndex } = load(m, null);
    const idx = buildChildIndex();
    assert.equal(focusBranchSets(null, 'root', m.nodes, idx), null);
    assert.equal(focusBranchSets('root', 'root', m.nodes, idx), null);
    assert.equal(focusBranchSets('gone', 'root', m.nodes, idx), null);
    assert.equal(focusBranchSets('orphan', 'root', m.nodes, idx), null);
  });
});

describe('ancestor dimming and add guards', () => {
  test('isFocusAncestor marks only the chain above the focus root', () => {
    const { isFocusAncestor } = load(makeMap(), 'a1');
    assert.equal(isFocusAncestor('root'), true);
    assert.equal(isFocusAncestor('a'), true);
    assert.equal(isFocusAncestor('a1'), false);
    assert.equal(isFocusAncestor('a1x'), false);
    assert.equal(isFocusAncestor('c'), false);
  });
  test('no focus root: nothing is an ancestor, every add is allowed', () => {
    const { isFocusAncestor, focusAllowsAdd } = load(makeMap(), null);
    assert.equal(isFocusAncestor('root'), false);
    assert.equal(focusAllowsAdd('root', false), true);
    assert.equal(focusAllowsAdd('c', true), true);
  });
  test('adding inside the branch is allowed', () => {
    const { focusAllowsAdd } = load(makeMap(), 'a1');
    assert.equal(focusAllowsAdd('a1', false), true);   // child of the focus root
    assert.equal(focusAllowsAdd('a1x', false), true);  // grandchild
    assert.equal(focusAllowsAdd('a1x', true), true);   // sibling under a1
  });
  test('adding outside the branch is refused', () => {
    const { focusAllowsAdd } = load(makeMap(), 'a1');
    assert.equal(focusAllowsAdd('a1', true), false);   // sibling of focus root -> under a
    assert.equal(focusAllowsAdd('a', false), false);   // child of an ancestor
    assert.equal(focusAllowsAdd('root', false), false);
    assert.equal(focusAllowsAdd('root', true), false);
  });
});
