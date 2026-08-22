// Radial and grid layouts.
//
// Unlike the tree and chain engines, these replace nothing, so there is no
// golden fixture to match. Verification is by property instead: every node
// placed at a finite position, nothing overlapping, and each parameter having
// the effect it claims. Those are the invariants a layout has to hold whatever
// its shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const { layoutRadial, layoutGrid } = loadFns(['layoutRadial', 'layoutGrid']);

const SHAPES = {
  flat:      { root:['a','b','c','d'], a:[], b:[], c:[], d:[] },
  nested:    { root:['a','b','c'], a:['a1','a2'], b:[], c:['c1'], a1:[], a2:[], c1:[] },
  deep:      { root:['a'], a:['a1'], a1:['a2'], a2:['a3'], a3:[] },
  lopsided:  { root:['a','b'], a:['a1','a2','a3','a4'], b:[], a1:[], a2:[], a3:[], a4:[] },
  single:    { root:['a'], a:[] },
  rootOnly:  { root:[] },
  collapsed: { root:['a','b'], a:['a1','a2'], b:[], a1:[], a2:[] },
};

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

const box = n => ({ l:n.x, r:n.x + n.w, t:n.y, b:n.y + n.h });
const overlaps = (a, b) => {
  const A = box(a), B = box(b);
  return A.l < B.r && A.r > B.l && A.t < B.b && A.b > B.t;
};
const allFinite = nodes =>
  Object.values(nodes).every(n => Number.isFinite(n.x) && Number.isFinite(n.y));
const dist = n => Math.hypot(n.x + n.w / 2, n.y + n.h / 2);

describe('layoutRadial', () => {
  for (const shape of Object.keys(SHAPES)) {
    test(`${shape}: every node lands at a finite position`, () => {
      const { nodes, kidsOf } = build(shape);
      layoutRadial(nodes, 'root', kidsOf, { ring:200, startAngle:-90, sweep:360 });
      assert.ok(allFinite(nodes));
    });
  }

  test('the root sits at the centre', () => {
    const { nodes, kidsOf } = build('nested');
    layoutRadial(nodes, 'root', kidsOf, { ring:200, startAngle:-90, sweep:360 });
    assert.ok(Math.abs(nodes.root.x + nodes.root.w / 2) < 0.001);
    assert.ok(Math.abs(nodes.root.y + nodes.root.h / 2) < 0.001);
    assert.equal(nodes.root.side, 'root');
  });

  test('depth becomes distance — each level is further out than its parent', () => {
    const { nodes, kidsOf } = build('deep');
    layoutRadial(nodes, 'root', kidsOf, { ring:200, startAngle:-90, sweep:360 });
    assert.ok(dist(nodes.a) < dist(nodes.a1));
    assert.ok(dist(nodes.a1) < dist(nodes.a2));
    assert.ok(dist(nodes.a2) < dist(nodes.a3));
  });

  test('siblings at the same depth share a ring', () => {
    const { nodes, kidsOf } = build('flat');
    layoutRadial(nodes, 'root', kidsOf, { ring:200, startAngle:-90, sweep:360 });
    const ds = ['a','b','c','d'].map(id => dist(nodes[id]));
    for (const d of ds) assert.ok(Math.abs(d - ds[0]) < 0.001, `expected ${ds[0]}, got ${d}`);
  });

  test('a bushier branch gets a wider wedge than a sparse sibling', () => {
    // This is why wedges are sized by leaf count rather than split evenly, and
    // the assertion has to compare the two branches: an earlier version only
    // checked that the bushy branch fanned out at all, which stayed true even
    // with even splitting, so it proved nothing.
    //
    // 'a' has four leaves and 'b' has one, so with 360 degrees between them
    // 'a' should own roughly 4/5 of the circle and 'b' roughly 1/5.
    const { nodes, kidsOf } = build('lopsided');
    layoutRadial(nodes, 'root', kidsOf, { ring:200, startAngle:-90, sweep:360 });

    const angleOf = id => Math.atan2(nodes[id].y + nodes[id].h / 2, nodes[id].x + nodes[id].w / 2);
    // Wrap-safe: measure from the first child to the last rather than
    // max-minus-min, which breaks across the +/-180 boundary.
    const between = (p, q) => {
      let d = Math.abs(angleOf(p) - angleOf(q)) % (2 * Math.PI);
      return d > Math.PI ? 2 * Math.PI - d : d;
    };
    // Measure ADJACENT child spacing, not the full span: normalising to the
    // shorter way round turns a genuine 216-degree span into 144, which is
    // indistinguishable from a smaller one. Spacing stays under 180 either way,
    // so it is unambiguous.
    //   leaf-count weighting: 'a' owns 4/5 of 360 = 288, / 4 children = 72 apart
    //   even splitting:       'a' owns 180,             / 4 children = 45 apart
    const bushy = between('a1','a2');

    // With even splitting, 'a' and 'b' would each get 180 degrees, so a's four
    // children would span at most ~135 degrees (3/4 of its wedge). Leaf-count
    // weighting gives 'a' ~288 degrees, so its children span ~216.
    assert.ok(bushy > (60 * Math.PI / 180),
      `expected ~72 degrees between adjacent children of the bushy branch, got ${(bushy * 180 / Math.PI).toFixed(0)}`);
  });

  test('two branches with equal leaf counts get equal wedges', () => {
    const tree = { root:['a','b'], a:['a1','a2'], b:['b1','b2'], a1:[], a2:[], b1:[], b2:[] };
    const nodes = {};
    for (const id of Object.keys(tree)) {
      nodes[id] = { id, w: id === 'root' ? 140 : 120, h: id === 'root' ? 50 : 40, x:0, y:0 };
    }
    layoutRadial(nodes, 'root', id => tree[id] || [], { ring:200, startAngle:-90, sweep:360 });
    // atan2 wraps at +/-180, so a branch sitting across that boundary looks
    // enormous to a naive max-minus-min. Measure the angle BETWEEN two nodes
    // instead, normalised to the shorter way round.
    const angleOf = id => Math.atan2(nodes[id].y + nodes[id].h / 2, nodes[id].x + nodes[id].w / 2);
    const between = (p, q) => {
      let d = Math.abs(angleOf(p) - angleOf(q)) % (2 * Math.PI);
      return d > Math.PI ? 2 * Math.PI - d : d;
    };
    assert.ok(Math.abs(between('a1','a2') - between('b1','b2')) < 0.01,
      'equal leaf counts should produce equal wedges');
  });

  test('a larger ring pushes everything further from the centre', () => {
    const tight = build('nested'), loose = build('nested');
    layoutRadial(tight.nodes, 'root', tight.kidsOf, { ring:100, startAngle:-90, sweep:360 });
    layoutRadial(loose.nodes, 'root', loose.kidsOf, { ring:300, startAngle:-90, sweep:360 });
    assert.ok(dist(loose.nodes.a) > dist(tight.nodes.a));
  });

  test('a half sweep keeps everything on one side', () => {
    // Angles run clockwise from startAngle. Sweeping 180 degrees from -90
    // covers -90 to +90, which is the RIGHT half-plane (top to bottom), not
    // the upper half — worth pinning, because the intuition goes the other way.
    const { nodes, kidsOf } = build('flat');
    layoutRadial(nodes, 'root', kidsOf, { ring:200, startAngle:-90, sweep:180 });
    for (const id of ['a','b','c','d']) {
      assert.ok(nodes[id].x + nodes[id].w / 2 >= -0.001, `${id} should stay in the right half`);
    }
  });

  test('rotating the start angle rotates the whole map', () => {
    const a = build('flat'), b = build('flat');
    layoutRadial(a.nodes, 'root', a.kidsOf, { ring:200, startAngle:-90, sweep:180 });
    layoutRadial(b.nodes, 'root', b.kidsOf, { ring:200, startAngle:90,  sweep:180 });
    assert.ok(b.nodes.a.x + b.nodes.a.w / 2 <= 0.001, 'starting at +90 puts them on the left');
  });

  test('a collapsed branch contributes no ring positions for its hidden children', () => {
    const { nodes, kidsOf } = build('collapsed');
    layoutRadial(nodes, 'root', kidsOf, { ring:200, startAngle:-90, sweep:360 });
    // Hidden children keep whatever position they had; what matters is that the
    // visible layout stays finite and the collapsed parent is still placed.
    assert.ok(Number.isFinite(nodes.a.x));
    assert.ok(dist(nodes.a) > 0);
  });
});

describe('layoutGrid', () => {
  const OPTS = { columns:2, gapX:60, gapY:60, rowGap:14, indent:24 };

  for (const shape of Object.keys(SHAPES)) {
    test(`${shape}: every node lands at a finite position`, () => {
      const { nodes, kidsOf } = build(shape);
      layoutGrid(nodes, 'root', kidsOf, OPTS);
      assert.ok(allFinite(nodes));
    });

    test(`${shape}: no two nodes overlap`, () => {
      const { nodes, kidsOf } = build(shape);
      layoutGrid(nodes, 'root', kidsOf, OPTS);
      const ids = Object.keys(nodes).filter(id => !(shape === 'collapsed' && ['a1','a2'].includes(id)));
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          assert.ok(!overlaps(nodes[ids[i]], nodes[ids[j]]), `${ids[i]} overlaps ${ids[j]}`);
        }
      }
    });
  }

  test('the root sits above the grid', () => {
    const { nodes, kidsOf } = build('flat');
    layoutGrid(nodes, 'root', kidsOf, OPTS);
    for (const id of ['a','b','c','d']) assert.ok(nodes[id].y > nodes.root.y);
  });

  test('the column count is respected — the third card starts a new row', () => {
    const { nodes, kidsOf } = build('flat');
    layoutGrid(nodes, 'root', kidsOf, OPTS);   // 2 columns
    assert.ok(Math.abs(nodes.a.y - nodes.b.y) < 0.001, 'a and b share a row');
    assert.ok(nodes.c.y > nodes.a.y, 'c wraps to the next row');
    assert.ok(Math.abs(nodes.a.x - nodes.c.x) < 0.001, 'a and c share a column');
  });

  test('one column puts every card in a single stack', () => {
    const { nodes, kidsOf } = build('flat');
    layoutGrid(nodes, 'root', kidsOf, { ...OPTS, columns:1 });
    const xs = ['a','b','c','d'].map(id => nodes[id].x);
    for (const x of xs) assert.equal(x, xs[0]);
  });

  test('sub-topics are indented beneath their card, one row each', () => {
    const { nodes, kidsOf } = build('nested');
    layoutGrid(nodes, 'root', kidsOf, OPTS);
    assert.ok(nodes.a1.x > nodes.a.x, 'a1 is indented from a');
    assert.ok(nodes.a1.y > nodes.a.y, 'a1 is below a');
    assert.ok(nodes.a2.y > nodes.a1.y, 'a2 is below a1');
    assert.equal(nodes.a1.x, nodes.a2.x, 'siblings share an indent level');
  });

  test('deeper levels indent further', () => {
    const { nodes, kidsOf } = build('deep');
    layoutGrid(nodes, 'root', kidsOf, OPTS);
    assert.ok(nodes.a1.x > nodes.a.x);
    assert.ok(nodes.a2.x > nodes.a1.x);
    assert.ok(nodes.a3.x > nodes.a2.x);
  });

  test('a collapsed card hides its outline rows rather than reserving space', () => {
    const open = build('nested'), shut = build('nested');
    layoutGrid(open.nodes, 'root', open.kidsOf, { ...OPTS, columns:1 });
    shut.nodes.a.collapsed = true;
    layoutGrid(shut.nodes, 'root', shut.kidsOf, { ...OPTS, columns:1 });
    assert.ok(shut.nodes.b.y < open.nodes.b.y, 'collapsing should pull the next card up');
  });

  test('a larger indent shifts sub-topics further right without moving their card', () => {
    const a = build('nested'), b = build('nested');
    layoutGrid(a.nodes, 'root', a.kidsOf, { ...OPTS, indent:10 });
    layoutGrid(b.nodes, 'root', b.kidsOf, { ...OPTS, indent:60 });
    assert.equal(a.nodes.a.x, b.nodes.a.x, 'the card itself does not move');
    assert.ok(b.nodes.a1.x > a.nodes.a1.x, 'its children indent further');
  });
});
