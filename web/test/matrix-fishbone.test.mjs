// Matrix strategy and the fishbone angle.
//
// These two were chosen to test the boundary between "new parameter" and "new
// strategy". Fishbone turned out to be a parameter: a chain whose ribs leave
// the spine at an angle. Matrix could not be, because its defining property —
// row N meaning the same thing in every column, so rows share a height and
// line up — is something the grid's independent column sizing cannot express.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const { layoutMatrix, layoutChain } = loadFns(['layoutMatrix', 'layoutChain']);

const MOPTS = { colGap:40, rowGap:24, cellGap:10, headGap:60 };
const build = tree => {
  const nodes = {};
  for (const id of Object.keys(tree)) {
    nodes[id] = { id, w: id === 'root' ? 140 : 120, h: 40, x:0, y:0 };
  }
  return { nodes, kidsOf: id => tree[id] || [] };
};
const round = v => Math.round(v);

describe('layoutMatrix — rows align across columns', () => {
  // Uneven columns on purpose: alignment is trivial when every column matches.
  const TREE = {
    root:['c1','c2','c3'],
    c1:['r1','r2'], c2:['s1','s2','s3'], c3:['t1'],
    r1:[], r2:[], s1:[], s2:[], s3:[], t1:[],
  };

  test('the first row shares a y across every column', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutMatrix(nodes, 'root', kidsOf, MOPTS);
    assert.equal(round(nodes.r1.y), round(nodes.s1.y));
    assert.equal(round(nodes.s1.y), round(nodes.t1.y));
  });

  test('later rows align too, even where a column has run out', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutMatrix(nodes, 'root', kidsOf, MOPTS);
    assert.equal(round(nodes.r2.y), round(nodes.s2.y));
    // c3 has no second row; that must not shift the others.
    assert.ok(nodes.s3.y > nodes.s2.y);
  });

  test('a column shares one x with all of its cells', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutMatrix(nodes, 'root', kidsOf, MOPTS);
    assert.equal(round(nodes.c1.x), round(nodes.r1.x));
    assert.equal(round(nodes.r1.x), round(nodes.r2.x));
    assert.equal(round(nodes.c2.x), round(nodes.s1.x));
  });

  test('columns are ordered left to right and do not share an x', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutMatrix(nodes, 'root', kidsOf, MOPTS);
    assert.ok(nodes.c1.x < nodes.c2.x);
    assert.ok(nodes.c2.x < nodes.c3.x);
  });

  test('column headers sit below the root and share a y', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutMatrix(nodes, 'root', kidsOf, MOPTS);
    for (const id of ['c1','c2','c3']) assert.ok(nodes[id].y > nodes.root.y);
    assert.equal(round(nodes.c1.y), round(nodes.c2.y));
  });

  test('a taller cell pushes its whole row down, keeping alignment', () => {
    // This is what separates a matrix from a grid: one deep cell must move the
    // entire row, not just its own column.
    const deep = {
      root:['c1','c2'], c1:['r1'], c2:['s1','s2'],
      r1:['r1a','r1b'], r1a:[], r1b:[], s1:[], s2:[],
    };
    const { nodes, kidsOf } = build(deep);
    layoutMatrix(nodes, 'root', kidsOf, MOPTS);
    assert.equal(round(nodes.r1.y), round(nodes.s1.y), 'row 1 still aligns');
    // r1's stack (r1, r1a, r1b) is taller than s1 alone, so row 2 must clear it.
    assert.ok(nodes.s2.y > nodes.r1b.y, 'row 2 clears the tallest cell in row 1');
  });

  test('every node is placed, whatever the shape', () => {
    for (const tree of [TREE, { root:[] }, { root:['c1'], c1:[] }]) {
      const { nodes, kidsOf } = build(tree);
      layoutMatrix(nodes, 'root', kidsOf, MOPTS);
      for (const [id, n] of Object.entries(nodes)) {
        assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), id);
      }
    }
  });

  test('a collapsed column reserves no rows', () => {
    const { nodes, kidsOf } = build(TREE);
    const shut = build(TREE);
    layoutMatrix(nodes, 'root', kidsOf, MOPTS);
    shut.nodes.c2.collapsed = true;
    layoutMatrix(shut.nodes, 'root', shut.kidsOf, MOPTS);
    assert.ok(Number.isFinite(shut.nodes.c2.x));
    assert.equal(round(shut.nodes.r1.y), round(nodes.r1.y), 'other columns are unaffected');
  });
});

describe('fishbone — chain with an angle', () => {
  const TREE = { root:['m1','m2'], m1:['a1','a2','a3'], m2:[], a1:[], a2:[], a3:[] };
  const BASE = { axis:'x', dir:1, gap:70, stem:30, indent:26,
                 alternate:true, start:'above', gapMain:70, gapCross:22 };

  test('90 degrees is exactly the plain timeline', () => {
    // Existing timelines must not shift because a parameter was added.
    const a = build(TREE), b = build(TREE);
    layoutChain(a.nodes, 'root', a.kidsOf, BASE);
    layoutChain(b.nodes, 'root', b.kidsOf, { ...BASE, angle:90 });
    for (const id of Object.keys(a.nodes)) {
      assert.equal(a.nodes[id].x, b.nodes[id].x, `${id}.x`);
      assert.equal(a.nodes[id].y, b.nodes[id].y, `${id}.y`);
    }
  });

  test('square ribs all share one x', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutChain(nodes, 'root', kidsOf, { ...BASE, angle:90 });
    assert.equal(nodes.a1.x, nodes.a2.x);
    assert.equal(nodes.a2.x, nodes.a3.x);
  });

  test('an angle steps each rib along the spine', () => {
    const { nodes, kidsOf } = build(TREE);
    layoutChain(nodes, 'root', kidsOf, { ...BASE, angle:35 });
    assert.notEqual(nodes.a1.x, nodes.a2.x);
    assert.notEqual(nodes.a2.x, nodes.a3.x);
  });

  test('ribs further from the spine slide further along it', () => {
    // The rib nearest the spine should be the least displaced.
    const sq = build(TREE), fb = build(TREE);
    layoutChain(sq.nodes, 'root', sq.kidsOf, { ...BASE, angle:90 });
    layoutChain(fb.nodes, 'root', fb.kidsOf, { ...BASE, angle:35 });
    const shift = id => Math.abs(fb.nodes[id].x - sq.nodes[id].x);
    // a3 sits closest to the spine in an upward block, a1 furthest.
    assert.ok(shift('a1') > shift('a3'), 'the outermost rib slides most');
  });

  test('a shallower angle slants further than a steep one', () => {
    const steep = build(TREE), shallow = build(TREE);
    layoutChain(steep.nodes, 'root', steep.kidsOf, { ...BASE, angle:60 });
    layoutChain(shallow.nodes, 'root', shallow.kidsOf, { ...BASE, angle:20 });
    const spread = n => Math.abs(n.a1.x - n.a3.x);
    assert.ok(spread(shallow.nodes) > spread(steep.nodes));
  });

  test('every node stays placed at any angle', () => {
    for (const angle of [10, 35, 90, 145, 170]) {
      const { nodes, kidsOf } = build(TREE);
      layoutChain(nodes, 'root', kidsOf, { ...BASE, angle });
      for (const [id, n] of Object.entries(nodes)) {
        assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${id} at ${angle}`);
      }
    }
  });
});
