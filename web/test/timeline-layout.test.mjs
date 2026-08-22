// Timeline layout geometry (issue #13).
//
// layoutTimeline() is pure arithmetic over a node map, so the properties that
// actually matter — nothing overlaps, main topics sit on one axis, sub-topics
// alternate sides — are checkable without a browser. That is deliberate: every
// layout bug in this project so far has been an overlap caused by positions
// computed against the wrong sizes.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

// The timeline is now one set of parameters for the general chain engine, so
// these behavioural checks target layoutChain directly. They are kept because
// they assert what a timeline should LOOK like — one axis, alternating
// branches, nothing overlapping — which the golden fixture alone does not say.
const { layoutChain } = loadFns(['layoutChain']);

const TIMELINE = {
  axis: 'x', dir: 1,
  gap: 70, stem: 30, indent: 26, alternate: true, start: 'above',
  gapMain: 60, gapCross: 16,
};
const layoutTimeline = (nodes, rootId, kidsOf, opts) =>
  layoutChain(nodes, rootId, kidsOf, { ...TIMELINE, ...(opts || {}) });

const OPTS = {};

/** Build a map from a {id: [childIds]} shape, all nodes the same size. */
function buildMap(tree, { w = 120, h = 40 } = {}) {
  const nodes = {};
  for (const id of Object.keys(tree)) nodes[id] = { id, w, h, x: 0, y: 0 };
  for (const [pid, kids] of Object.entries(tree)) {
    for (const k of kids) { if (!nodes[k]) nodes[k] = { id: k, w, h, x: 0, y: 0 }; nodes[k].parent = pid; }
  }
  const kidsOf = id => tree[id] || [];
  return { nodes, kidsOf };
}

const box = n => ({ l: n.x, r: n.x + n.w, t: n.y, b: n.y + n.h });
const overlaps = (a, b) => {
  const A = box(a), B = box(b);
  return A.l < B.r && A.r > B.l && A.t < B.b && A.b > B.t;
};
const centreY = n => n.y + n.h / 2;

describe('timeline (chain engine) — the axis', () => {
  const tree = { root: ['m1', 'm2', 'm3'], m1: [], m2: [], m3: [] };

  test('root sits at the far left', () => {
    const { nodes, kidsOf } = buildMap(tree);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    for (const id of ['m1', 'm2', 'm3']) {
      assert.ok(nodes[id].x > nodes.root.x, `${id} should be right of root`);
    }
  });

  test('every main topic is centred on the same horizontal axis', () => {
    const { nodes, kidsOf } = buildMap(tree);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    const axis = centreY(nodes.root);
    for (const id of ['m1', 'm2', 'm3']) {
      assert.ok(Math.abs(centreY(nodes[id]) - axis) < 0.001,
        `${id} centre ${centreY(nodes[id])} is off the axis ${axis}`);
    }
  });

  test('main topics run left to right in child order', () => {
    const { nodes, kidsOf } = buildMap(tree);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    assert.ok(nodes.m1.x < nodes.m2.x);
    assert.ok(nodes.m2.x < nodes.m3.x);
  });

  test('consecutive main topics never overlap', () => {
    const { nodes, kidsOf } = buildMap(tree);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    assert.ok(!overlaps(nodes.m1, nodes.m2));
    assert.ok(!overlaps(nodes.m2, nodes.m3));
    assert.ok(!overlaps(nodes.root, nodes.m1));
  });

  test('a map with only a root does not throw', () => {
    const { nodes, kidsOf } = buildMap({ root: [] });
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    assert.equal(nodes.root.x, 0);
  });
});

describe('timeline (chain engine) — sub-topics alternate above and below', () => {
  const tree = {
    root: ['m1', 'm2', 'm3'],
    m1: ['a1'], m2: ['b1'], m3: ['c1'],
    a1: [], b1: [], c1: [],
  };

  test('first main topic hangs its sub-topics above the axis', () => {
    const { nodes, kidsOf } = buildMap(tree);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    assert.ok(centreY(nodes.a1) < centreY(nodes.m1), 'a1 should sit above the axis');
  });

  test('second main topic hangs its sub-topics below', () => {
    const { nodes, kidsOf } = buildMap(tree);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    assert.ok(centreY(nodes.b1) > centreY(nodes.m2), 'b1 should sit below the axis');
  });

  test('the alternation continues rather than sticking on one side', () => {
    const { nodes, kidsOf } = buildMap(tree);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    assert.ok(centreY(nodes.c1) < centreY(nodes.m3), 'c1 should be back above');
  });

  test('sub-topics are indented right of their main topic, not centred on it', () => {
    const { nodes, kidsOf } = buildMap(tree);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    assert.ok(nodes.a1.x > nodes.m1.x, 'sub-topic should be inset from the main topic');
  });
});

describe('timeline (chain engine) — no overlaps anywhere', () => {
  // The property that matters most: whatever the shape, no two visible nodes
  // may share space. Positions here are derived from measured sizes, which is
  // exactly where previous layout bugs came from.
  const shapes = {
    'wide sub-trees': {
      root: ['m1', 'm2'],
      m1: ['a1', 'a2', 'a3'], m2: ['b1', 'b2'],
      a1: [], a2: [], a3: [], b1: [], b2: [],
    },
    'deep sub-trees': {
      root: ['m1', 'm2'],
      m1: ['a1'], a1: ['a2'], a2: ['a3'], a3: [],
      m2: ['b1'], b1: [], 
    },
    'lopsided': {
      root: ['m1', 'm2', 'm3'],
      m1: [], m2: ['b1', 'b2', 'b3', 'b4'], m3: [],
      b1: [], b2: [], b3: [], b4: [],
    },
  };

  for (const [label, tree] of Object.entries(shapes)) {
    test(`${label}: no two nodes overlap`, () => {
      const { nodes, kidsOf } = buildMap(tree);
      layoutTimeline(nodes, 'root', kidsOf, OPTS);
      const ids = Object.keys(nodes);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          assert.ok(!overlaps(nodes[ids[i]], nodes[ids[j]]),
            `${ids[i]} overlaps ${ids[j]}`);
        }
      }
    });
  }

  test('a tall sub-tree pushes the next main topic further right', () => {
    // A deep branch under m1 must not be run over by m2.
    const deep = { root: ['m1', 'm2'], m1: ['a1'], a1: ['a2'], a2: [], m2: [] };
    const { nodes, kidsOf } = buildMap(deep);
    layoutTimeline(nodes, 'root', kidsOf, OPTS);
    assert.ok(nodes.m2.x > nodes.a2.x + nodes.a2.w,
      'm2 should start past the rightmost descendant of m1');
  });
});

describe('timeline (chain engine) — collapsed nodes', () => {
  test('a collapsed main topic reserves no room for its hidden children', () => {
    const tree = { root: ['m1', 'm2'], m1: ['a1', 'a2'], m2: [], a1: [], a2: [] };
    const open = buildMap(tree);
    layoutTimeline(open.nodes, 'root', open.kidsOf, OPTS);
    const openGap = open.nodes.m2.x;

    const shut = buildMap(tree);
    shut.nodes.m1.collapsed = true;
    layoutTimeline(shut.nodes, 'root', shut.kidsOf, OPTS);

    assert.ok(shut.nodes.m2.x <= openGap,
      'collapsing should not push the next main topic further out');
  });
});
