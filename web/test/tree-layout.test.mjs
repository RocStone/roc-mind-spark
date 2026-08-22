// Tree layout engine — golden-master equivalence.
//
// balanced / right / left / down used to be four hand-written placement blocks.
// They are now one parameterised engine, and the only claim that matters is
// that it produces IDENTICAL output to what it replaced.
//
// test/fixtures/tree-layout-golden.json was captured by running the previous
// implementation over these shapes. Nothing regenerates it: if a change to the
// engine moves a single node, this fails. That is the point — layout has no
// unit-testable "correct" answer beyond "the same as before", and every layout
// bug in this project so far has been nodes ending up somewhere unintended.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns } from './helpers/load-app-fns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(readFileSync(join(here, 'fixtures', 'tree-layout-golden.json'), 'utf8'));

const { layoutTree, treeLayoutOpts } = loadFns(['layoutTree', 'treeLayoutOpts'], {
  TREE_LAYOUTS: {
    balanced: { axis:'x', dir: 1, split:'balanced', rootAnchor:'origin' },
    right:    { axis:'x', dir: 1, split:'one-side', rootAnchor:'origin' },
    left:     { axis:'x', dir:-1, split:'one-side', rootAnchor:'origin' },
    down:     { axis:'y', dir: 1, split:'one-side', rootAnchor:'centered', sideName:'down' },
  },
});

// The same shapes the fixture was captured from.
const SHAPES = {
  simple:    { root:['a','b','c'], a:[], b:[], c:[] },
  nested:    { root:['a','b'], a:['a1','a2'], b:['b1'], a1:[], a2:[], b1:[] },
  deep:      { root:['a'], a:['a1'], a1:['a2'], a2:['a3'], a3:[] },
  lopsided:  { root:['a','b','c','d'], a:['a1','a2','a3'], b:[], c:['c1'], d:[], a1:[], a2:[], a3:[], c1:[] },
  collapsed: { root:['a','b'], a:['a1','a2'], b:[], a1:[], a2:[] },
};
const LAYOUTS = ['balanced', 'right', 'left', 'down'];

function build(shape) {
  const tree = SHAPES[shape];
  const nodes = {};
  for (const id of Object.keys(tree)) {
    const size = id === 'root' ? { w:140, h:50 } : { w:120, h:40 };
    nodes[id] = { id, ...size, x:0, y:0 };
  }
  if (shape === 'collapsed') nodes.a.collapsed = true;
  return { nodes, kidsOf: id => tree[id] || [] };
}

const round = v => Math.round(v * 100) / 100;

describe('layoutTree reproduces the previous implementations exactly', () => {
  for (const shape of Object.keys(SHAPES)) {
    for (const layout of LAYOUTS) {
      test(`${shape} / ${layout}`, () => {
        const { nodes, kidsOf } = build(shape);
        layoutTree(nodes, 'root', kidsOf, treeLayoutOpts(layout, 70, 22));
        const want = GOLDEN[`${shape}/${layout}`];
        assert.ok(want, `no fixture for ${shape}/${layout}`);
        for (const id of Object.keys(want)) {
          const g = want[id], n = nodes[id];
          assert.equal(round(n.x), g.x, `${id}.x`);
          assert.equal(round(n.y), g.y, `${id}.y`);
          assert.equal(n.side, g.side, `${id}.side`);
        }
      });
    }
  }

  test('the fixture covers every shape and layout, so none is silently skipped', () => {
    assert.equal(Object.keys(GOLDEN).length, Object.keys(SHAPES).length * LAYOUTS.length);
  });
});

describe('treeLayoutOpts — the parameter table', () => {
  test('names every built-in tree layout', () => {
    for (const l of LAYOUTS) assert.ok(treeLayoutOpts(l, 70, 22), `${l} missing`);
  });

  test('returns null for a layout it does not handle, so callers can fall through', () => {
    assert.equal(treeLayoutOpts('timeline', 70, 22), null);
    assert.equal(treeLayoutOpts('nonsense', 70, 22), null);
  });

  test('horizontal layouts map hGap to the main axis', () => {
    const o = treeLayoutOpts('right', 70, 22);
    assert.equal(o.gapMain, 70);
    assert.equal(o.gapCross, 22);
  });

  test('the vertical layout SWAPS them — hGap separates siblings, vGap generations', () => {
    // Getting this backwards produced the only failure when the engine was
    // first checked against the fixture, so it is pinned explicitly.
    const o = treeLayoutOpts('down', 70, 22);
    assert.equal(o.gapMain, 22, 'generations are separated by vGap');
    assert.equal(o.gapCross, 70, 'siblings are separated by hGap');
  });
});

describe('layoutTree — parameters compose beyond the four built-ins', () => {
  // The point of the refactor: variants that previously needed new code are now
  // reachable by changing numbers.
  test('an upward org chart is just dir:-1 on the vertical axis', () => {
    const { nodes, kidsOf } = build('simple');
    layoutTree(nodes, 'root', kidsOf,
      { axis:'y', dir:-1, split:'one-side', rootAnchor:'centered', sideName:'up', gapMain:22, gapCross:70 });
    assert.ok(nodes.a.y < nodes.root.y, 'children should sit above the root');
  });

  test('balanced splitting works on the vertical axis too (up-and-down)', () => {
    const { nodes, kidsOf } = build('simple');
    nodes.a.side = 'right'; nodes.b.side = 'left';
    layoutTree(nodes, 'root', kidsOf,
      { axis:'y', dir:1, split:'balanced', rootAnchor:'origin', gapMain:22, gapCross:70 });
    assert.ok(nodes.a.y > nodes.root.y, 'the forward side goes below');
    assert.ok(nodes.b.y < nodes.root.y, 'the back side goes above');
  });

  test('changing only the gaps moves nodes without changing their arrangement', () => {
    const tight = build('nested'), loose = build('nested');
    layoutTree(tight.nodes, 'root', tight.kidsOf, treeLayoutOpts('right', 70, 22));
    layoutTree(loose.nodes, 'root', loose.kidsOf, treeLayoutOpts('right', 200, 22));
    assert.ok(loose.nodes.a.x > tight.nodes.a.x, 'a wider main gap pushes children out');
    assert.equal(loose.nodes.a.side, tight.nodes.a.side, 'sides are unaffected by spacing');
  });
});
