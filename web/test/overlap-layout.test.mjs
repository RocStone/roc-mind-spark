// Overlap avoidance: layout must not stack siblings on top of each other,
// and resolveNodeOverlaps must separate cards that already collide.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const {
  layoutTree,
  treeLayoutOpts,
  boxesOverlap,
  layoutSizesGrew,
  resolveNodeOverlaps,
  resolveSiblingOverlaps,
  nodeLayoutBox,
} = loadFns(
  [
    'layoutTree', 'treeLayoutOpts',
    'boxesOverlap', 'layoutSizesGrew', 'resolveNodeOverlaps', 'resolveSiblingOverlaps',
    'nodeLayoutBox', 'collectSubtreeIds', 'shiftSubtreeNodes',
  ],
  {
    TREE_LAYOUTS: {
      balanced: { axis:'x', dir: 1, split:'balanced', rootAnchor:'origin' },
      right:    { axis:'x', dir: 1, split:'one-side', rootAnchor:'origin' },
      left:     { axis:'x', dir:-1, split:'one-side', rootAnchor:'origin' },
      down:     { axis:'y', dir: 1, split:'one-side', rootAnchor:'centered', sideName:'down' },
    },
  }
);

const kidsOf = nodes => id =>
  Object.keys(nodes).filter(k => nodes[k].parent === id);

function twoSiblings(h) {
  const nodes = {
    root: { id:'root', parent:null, w:140, h:50, x:0, y:0 },
    a:    { id:'a', parent:'root', w:220, h, x:0, y:0, side:'right' },
    b:    { id:'b', parent:'root', w:220, h, x:0, y:0, side:'right' },
  };
  return nodes;
}

describe('layoutTree — wrapping siblings do not overlap', () => {
  test('two tall children of one parent keep a vertical gap', () => {
    const nodes = twoSiblings(80);
    layoutTree(nodes, 'root', kidsOf(nodes), treeLayoutOpts('right', 70, 22));
    const gap = 22;
    assert.ok(!boxesOverlap(nodeLayoutBox(nodes.a), nodeLayoutBox(nodes.b), 0),
      'cards must not share pixels');
    const top = nodes.a.y <= nodes.b.y ? nodes.a : nodes.b;
    const bot = top === nodes.a ? nodes.b : nodes.a;
    assert.ok(bot.y >= top.y + top.h + gap - 0.01,
      `expected ${gap}px gap, got ${bot.y - (top.y + top.h)}`);
  });
});

describe('layoutSizesGrew', () => {
  test('true when a visible node grew taller than the snapshot', () => {
    const before = { a:{w:120,h:40}, b:{w:120,h:40} };
    const nodes  = { a:{w:120,h:40}, b:{w:120,h:80} };
    assert.equal(layoutSizesGrew(before, nodes, new Set()), true);
  });
  test('false when sizes are unchanged', () => {
    const before = { a:{w:120,h:40} };
    const nodes  = { a:{w:120,h:40} };
    assert.equal(layoutSizesGrew(before, nodes, new Set()), false);
  });
  test('ignores hidden nodes', () => {
    const before = { a:{w:120,h:40} };
    const nodes  = { a:{w:120,h:90} };
    assert.equal(layoutSizesGrew(before, nodes, new Set(['a'])), false);
  });
});

describe('resolveNodeOverlaps', () => {
  test('pushes a later sibling down until the default gap is restored', () => {
    const nodes = {
      root: { id:'root', parent:null, w:140, h:50, x:0, y:0 },
      a:    { id:'a', parent:'root', w:220, h:80, x:200, y:0, side:'right' },
      b:    { id:'b', parent:'root', w:220, h:70, x:200, y:20, side:'right' },
    };
    assert.ok(boxesOverlap(nodeLayoutBox(nodes.a), nodeLayoutBox(nodes.b), 0));
    const moved = resolveNodeOverlaps(nodes, { gap:16, vertical:true, kidsOf:kidsOf(nodes) });
    assert.equal(moved, true);
    assert.ok(!boxesOverlap(nodeLayoutBox(nodes.a), nodeLayoutBox(nodes.b), 16),
      'siblings must clear each other by the gap');
    assert.equal(nodes.a.y, 0, 'the upper card stays put when it is first');
    assert.ok(nodes.b.y >= nodes.a.y + nodes.a.h + 16);
  });

  test('does not separate a parent from its child', () => {
    const nodes = {
      root: { id:'root', parent:null, w:140, h:50, x:0, y:0 },
      a:    { id:'a', parent:'root', w:120, h:40, x:10, y:5 },
    };
    resolveNodeOverlaps(nodes, { gap:16, vertical:true, kidsOf:kidsOf(nodes) });
    assert.equal(nodes.a.x, 10);
    assert.equal(nodes.a.y, 5);
  });
});

describe('resolveSiblingOverlaps', () => {
  test('separates the two wrapping children from the screenshot', () => {
    const nodes = {
      parent: { id:'parent', parent:'root', w:240, h:61, x:1578, y:1264, side:'right' },
      a: { id:'a', parent:'parent', w:259, h:80, x:1888, y:1233.1, side:'right' },
      b: { id:'b', parent:'parent', w:240, h:61, x:1888, y:1294.9, side:'right' },
      other: { id:'other', parent:'root', w:200, h:40, x:1880, y:1240, side:'right' },
    };
    const moved = resolveSiblingOverlaps(nodes, { gap:16, vertical:true, kidsOf:kidsOf(nodes) });
    assert.equal(moved, true);
    assert.ok(!boxesOverlap(nodeLayoutBox(nodes.a), nodeLayoutBox(nodes.b), 16));
    assert.ok(nodes.b.y >= nodes.a.y + nodes.a.h + 16);
    assert.equal(nodes.other.y, 1240, 'a node from another parent is left alone');
  });
});
