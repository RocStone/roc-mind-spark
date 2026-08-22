import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

describe('moveSibling — keyboard Alt+Up/Down sibling reordering', () => {
  const map = {
    rootId: 'root',
    layout: 'balanced',
    nodes: {},
  };
  let historyPushed = 0;
  let autoLayoutCalled = 0;
  let highlightedNode = null;

  const childrenOf = id =>
    Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);

  const _subtreeSet = id => {
    const s = new Set([id]);
    const w = i => childrenOf(i).forEach(c => { s.add(c); w(c); });
    w(id);
    return s;
  };

  const pushHistory = () => { historyPushed++; };
  const autoLayout = () => { autoLayoutCalled++; };
  const mdHighlightNode = id => { highlightedNode = id; };
  const hasInlineMarkup = t => /<(b|i|u|s|strong|em|br|a|span|div)\b/i.test(t || '');

  // Load the real moveSibling and buildMarkdown functions from public/app.js
  const appFns = loadFns([
    'moveSibling',
    'buildMarkdown',
    'notesToMdBlocks',
    'htmlToInlineMd',
    'nodeTextPlain',
    '_nodeMeta',
    'frontmatterNodeToYaml',
    'escapeHtml',
  ], {
    map,
    READONLY: false,
    childrenOf,
    _subtreeSet,
    pushHistory,
    autoLayout,
    opLog(){},
    mdMode: true,
    mdHighlightNode,
    hasInlineMarkup,
  });

  const { moveSibling, buildMarkdown } = appFns;

  beforeEach(() => {
    historyPushed = 0;
    autoLayoutCalled = 0;
    highlightedNode = null;
  });

  test('cannot move root node', () => {
    map.rootId = 'root';
    map.layout = 'balanced';
    map.nodes = {
      root: { id: 'root', parent: null, text: 'Central' },
      a: { id: 'a', parent: 'root', text: 'A' },
    };
    const res = moveSibling('root', 'up');
    assert.equal(res, false);
    assert.equal(historyPushed, 0);
  });

  test('only child has no sibling to swap with', () => {
    map.rootId = 'root';
    map.layout = 'right';
    map.nodes = {
      root: { id: 'root', parent: null, text: 'Root' },
      only: { id: 'only', parent: 'root', text: 'Only' },
      leaf: { id: 'leaf', parent: 'only', text: 'Leaf' },
    };
    assert.equal(moveSibling('only', 'down'), false);
    assert.equal(moveSibling('only', 'up'), false);
    assert.equal(moveSibling('leaf', 'down'), false);
    assert.deepEqual(childrenOf('root'), ['only']);
    assert.equal(historyPushed, 0);
  });

  test('swaps sibling up and down within normal parent', () => {
    map.rootId = 'root';
    map.layout = 'right';
    map.nodes = {
      root: { id: 'root', parent: null, text: 'Root' },
      a: { id: 'a', parent: 'root', text: 'A' },
      b: { id: 'b', parent: 'root', text: 'B' },
      c: { id: 'c', parent: 'root', text: 'C' },
    };

    // 'b' is between 'a' and 'c'
    assert.deepEqual(childrenOf('root'), ['a', 'b', 'c']);

    // Move 'b' up -> should swap with 'a'
    const upRes = moveSibling('b', 'up');
    assert.equal(upRes, true);
    assert.deepEqual(childrenOf('root'), ['b', 'a', 'c']);
    assert.equal(historyPushed, 1);
    assert.equal(autoLayoutCalled, 1);
    assert.equal(highlightedNode, 'b');

    // 'b' is now first, moving up again should return false (no-op)
    const upTopRes = moveSibling('b', 'up');
    assert.equal(upTopRes, false);
    assert.deepEqual(childrenOf('root'), ['b', 'a', 'c']);
    assert.equal(historyPushed, 1);

    // Move 'b' down -> should swap back with 'a'
    const downRes1 = moveSibling('b', 'down');
    assert.equal(downRes1, true);
    assert.deepEqual(childrenOf('root'), ['a', 'b', 'c']);

    // Move 'b' down again -> should swap with 'c'
    const downRes2 = moveSibling('b', 'down');
    assert.equal(downRes2, true);
    assert.deepEqual(childrenOf('root'), ['a', 'c', 'b']);

    // 'b' is now last, moving down again should return false (no-op)
    const downBottomRes = moveSibling('b', 'down');
    assert.equal(downBottomRes, false);
    assert.deepEqual(childrenOf('root'), ['a', 'c', 'b']);
  });

  test('entire subtree stays attached and reorders with parent node', () => {
    map.rootId = 'root';
    map.layout = 'right';
    map.nodes = {
      root: { id: 'root', parent: null, text: 'Root' },
      a: { id: 'a', parent: 'root', text: 'A' },
      a1: { id: 'a1', parent: 'a', text: 'A1' },
      a2: { id: 'a2', parent: 'a', text: 'A2' },
      b: { id: 'b', parent: 'root', text: 'B' },
      b1: { id: 'b1', parent: 'b', text: 'B1' },
      c: { id: 'c', parent: 'root', text: 'C' },
    };

    assert.deepEqual(childrenOf('root'), ['a', 'b', 'c']);
    assert.deepEqual(childrenOf('a'), ['a1', 'a2']);
    assert.deepEqual(childrenOf('b'), ['b1']);

    // Move 'b' up above 'a'
    const res = moveSibling('b', 'up');
    assert.equal(res, true);

    // Root children order should be b, a, c
    assert.deepEqual(childrenOf('root'), ['b', 'a', 'c']);
    // Internal subtrees stay attached via parent pointers
    assert.deepEqual(childrenOf('a'), ['a1', 'a2']);
    assert.deepEqual(childrenOf('b'), ['b1']);
    assert.equal(map.nodes.a1.parent, 'a');
    assert.equal(map.nodes.a2.parent, 'a');
    assert.equal(map.nodes.b1.parent, 'b');

    // Move 'b' back down
    const downRes = moveSibling('b', 'down');
    assert.equal(downRes, true);
    assert.deepEqual(childrenOf('root'), ['a', 'b', 'c']);
    assert.deepEqual(childrenOf('a'), ['a1', 'a2']);
    assert.deepEqual(childrenOf('b'), ['b1']);
  });

  test('scattered descendants do not make a sibling jump past later siblings', () => {
    // Same shape as 进度如何 / 设计如何: 设计如何's grandchildren were added later
    // and sit AFTER 下一步的目标 in key order.
    map.rootId = 'root';
    map.layout = 'right';
    map.nodes = {
      root: { id: 'root', parent: null, text: 'trans emb' },
      progress: { id: 'progress', parent: 'root', text: '进度如何' },
      design: { id: 'design', parent: 'root', text: '设计如何' },
      d1: { id: 'd1', parent: 'design', text: '各个规定文档' },
      next: { id: 'next', parent: 'root', text: '下一步的目标' },
      n1: { id: 'n1', parent: 'next', text: '搞清楚当前进度' },
      d2: { id: 'd2', parent: 'd1', text: '读取 beads' },
    };

    assert.deepEqual(childrenOf('root'), ['progress', 'design', 'next']);
    assert.deepEqual(childrenOf('design'), ['d1']);
    assert.deepEqual(childrenOf('d1'), ['d2']);

    const res = moveSibling('progress', 'down');
    assert.equal(res, true);
    assert.deepEqual(childrenOf('root'), ['design', 'progress', 'next']);
    assert.deepEqual(childrenOf('design'), ['d1']);
    assert.deepEqual(childrenOf('d1'), ['d2']);
    assert.deepEqual(childrenOf('next'), ['n1']);

    const md = buildMarkdown();
    const iDesign = md.indexOf('- 设计如何');
    const iProgress = md.indexOf('- 进度如何');
    const iNext = md.indexOf('- 下一步的目标');
    const iGrand = md.indexOf('读取 beads');
    assert.ok(iDesign < iProgress);
    assert.ok(iProgress < iNext);
    assert.ok(iDesign < iGrand && iGrand < iProgress);
  });

  test('balanced layout: root left and right children reorder independently', () => {
    map.rootId = 'root';
    map.layout = 'balanced';
    map.nodes = {
      root: { id: 'root', parent: null, text: 'Root' },
      r1: { id: 'r1', parent: 'root', side: 'right', text: 'Right 1' },
      l1: { id: 'l1', parent: 'root', side: 'left', text: 'Left 1' },
      r2: { id: 'r2', parent: 'root', side: 'right', text: 'Right 2' },
      l2: { id: 'l2', parent: 'root', side: 'left', text: 'Left 2' },
      r3: { id: 'r3', parent: 'root', side: 'right', text: 'Right 3' },
    };

    // Right children in visual order: r1, r2, r3
    // Left children in visual order: l1, l2
    const rightKids = () => childrenOf('root').filter(id => map.nodes[id].side === 'right');
    const leftKids = () => childrenOf('root').filter(id => map.nodes[id].side === 'left');

    assert.deepEqual(rightKids(), ['r1', 'r2', 'r3']);
    assert.deepEqual(leftKids(), ['l1', 'l2']);

    // Move 'r2' up on right side -> swaps with 'r1'
    const resR2Up = moveSibling('r2', 'up');
    assert.equal(resR2Up, true);
    assert.deepEqual(rightKids(), ['r2', 'r1', 'r3']);
    // Left side is unaffected
    assert.deepEqual(leftKids(), ['l1', 'l2']);

    // Move 'l2' up on left side -> swaps with 'l1'
    const resL2Up = moveSibling('l2', 'up');
    assert.equal(resL2Up, true);
    assert.deepEqual(leftKids(), ['l2', 'l1']);
    // Right side is unaffected
    assert.deepEqual(rightKids(), ['r2', 'r1', 'r3']);
  });

  test('reordering deeply nested child nodes', () => {
    map.rootId = 'root';
    map.layout = 'balanced';
    map.nodes = {
      root: { id: 'root', parent: null, text: 'Root' },
      branch: { id: 'branch', parent: 'root', text: 'Branch' },
      leaf1: { id: 'leaf1', parent: 'branch', text: 'Leaf 1' },
      leaf2: { id: 'leaf2', parent: 'branch', text: 'Leaf 2' },
      leaf3: { id: 'leaf3', parent: 'branch', text: 'Leaf 3' },
    };

    assert.deepEqual(childrenOf('branch'), ['leaf1', 'leaf2', 'leaf3']);

    // Move leaf2 up
    const res1 = moveSibling('leaf2', 'up');
    assert.equal(res1, true);
    assert.deepEqual(childrenOf('branch'), ['leaf2', 'leaf1', 'leaf3']);

    // Move leaf3 up
    const res2 = moveSibling('leaf3', 'up');
    assert.equal(res2, true);
    assert.deepEqual(childrenOf('branch'), ['leaf2', 'leaf3', 'leaf1']);
  });

  test('buildMarkdown produces updated outline reflecting reordered nodes and subtrees', () => {
    map.rootId = 'root';
    map.layout = 'right';
    map.nodes = {
      root: { id: 'root', parent: null, text: 'My Mind Map' },
      topicA: { id: 'topicA', parent: 'root', text: 'Topic A' },
      subA1: { id: 'subA1', parent: 'topicA', text: 'Sub A1' },
      topicB: { id: 'topicB', parent: 'root', text: 'Topic B' },
      subB1: { id: 'subB1', parent: 'topicB', text: 'Sub B1' },
      topicC: { id: 'topicC', parent: 'root', text: 'Topic C' },
    };

    const initialMd = buildMarkdown();
    assert.ok(initialMd.indexOf('- Topic A') < initialMd.indexOf('- Topic B'));
    assert.ok(initialMd.indexOf('- Topic B') < initialMd.indexOf('- Topic C'));
    assert.ok(initialMd.indexOf('  - Sub A1') < initialMd.indexOf('- Topic B'));

    // Move Topic B up before Topic A
    moveSibling('topicB', 'up');

    const updatedMd = buildMarkdown();
    assert.ok(updatedMd.indexOf('- Topic B') < updatedMd.indexOf('- Topic A'));
    assert.ok(updatedMd.indexOf('  - Sub B1') < updatedMd.indexOf('- Topic A'));
    assert.ok(updatedMd.indexOf('- Topic A') < updatedMd.indexOf('- Topic C'));
    assert.ok(updatedMd.indexOf('  - Sub A1') < updatedMd.indexOf('- Topic C'));
  });
});
