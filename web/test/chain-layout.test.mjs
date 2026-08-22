// Chain layout engine — golden-master equivalence.
//
// The timeline used to be its own hand-written placement function. It is now
// one set of parameters for a general chain engine, and the claim that matters
// is that output is IDENTICAL to what it replaced.
//
// test/fixtures/chain-layout-golden.json was captured from the previous
// layoutTimeline across five tree shapes and four configurations. Nothing
// regenerates it: if the engine moves a node, this fails.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns } from './helpers/load-app-fns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(readFileSync(join(here, 'fixtures', 'chain-layout-golden.json'), 'utf8'));

const { layoutChain } = loadFns(['layoutChain']);

const SHAPES = {
  simple:    { root:['m1','m2','m3'], m1:[], m2:[], m3:[] },
  subs:      { root:['m1','m2'], m1:['a1','a2'], m2:['b1'], a1:[], a2:[], b1:[] },
  deep:      { root:['m1','m2'], m1:['a1'], a1:['a2'], a2:[], m2:[] },
  lopsided:  { root:['m1','m2','m3'], m1:[], m2:['b1','b2','b3'], m3:[], b1:[], b2:[], b3:[] },
  collapsed: { root:['m1','m2'], m1:['a1','a2'], m2:[], a1:[], a2:[] },
};
// The four timeline configurations the fixture covers.
const CONFIGS = {
  default: { gap:70,  stem:30, indent:26, alternate:true,  start:'above' },
  wide:    { gap:150, stem:50, indent:40, alternate:true,  start:'above' },
  noalt:   { gap:70,  stem:30, indent:26, alternate:false, start:'above' },
  below:   { gap:70,  stem:30, indent:26, alternate:true,  start:'below' },
};
const HORIZONTAL = { axis:'x', dir:1, gapMain:70, gapCross:22 };

function build(shape) {
  const tree = SHAPES[shape];
  const nodes = {};
  for (const id of Object.keys(tree)) {
    const size = id === 'root' ? { w:140, h:50 } : { w:120, h:40 };
    nodes[id] = { id, ...size, x:0, y:0 };
  }
  if (shape === 'collapsed') nodes.m1.collapsed = true;
  return { nodes, kidsOf: id => tree[id] || [] };
}
const round = v => Math.round(v * 100) / 100;

describe('layoutChain reproduces the previous timeline exactly', () => {
  for (const shape of Object.keys(SHAPES)) {
    for (const cfg of Object.keys(CONFIGS)) {
      test(`${shape} / ${cfg}`, () => {
        const { nodes, kidsOf } = build(shape);
        layoutChain(nodes, 'root', kidsOf, { ...HORIZONTAL, ...CONFIGS[cfg] });
        const want = GOLDEN[`${shape}/${cfg}`];
        assert.ok(want, `no fixture for ${shape}/${cfg}`);
        for (const id of Object.keys(want)) {
          const g = want[id], n = nodes[id];
          assert.equal(round(n.x), g.x, `${id}.x`);
          assert.equal(round(n.y), g.y, `${id}.y`);
          assert.equal(n.side, g.side, `${id}.side`);
        }
      });
    }
  }

  test('the fixture covers every shape and configuration', () => {
    assert.equal(Object.keys(GOLDEN).length, Object.keys(SHAPES).length * Object.keys(CONFIGS).length);
  });
});

describe('layoutChain — parameters compose beyond the timeline', () => {
  // What generalising bought: variants that would previously have needed new
  // placement code are now parameter changes.
  const V = { axis:'y', dir:1, gapMain:70, gapCross:22, ...CONFIGS.default };

  test('a vertical chain runs downward with branches to the sides', () => {
    const { nodes, kidsOf } = build('subs');
    layoutChain(nodes, 'root', kidsOf, V);
    assert.ok(nodes.m2.y > nodes.m1.y, 'chain items advance downward');
    assert.ok(Math.abs(nodes.m1.x - nodes.m2.x) < 1, 'chain items share the centre line');
    assert.ok(nodes.a1.x !== nodes.m1.x, 'sub-topics hang to one side');
  });

  test('a reversed horizontal chain runs leftward', () => {
    const { nodes, kidsOf } = build('simple');
    layoutChain(nodes, 'root', kidsOf, { ...HORIZONTAL, dir:-1, ...CONFIGS.default });
    assert.ok(nodes.m1.x < nodes.root.x, 'the first item is left of the root');
    assert.ok(nodes.m2.x < nodes.m1.x, 'the chain continues leftward');
  });

  test('a reversed chain still leaves room for a wide sub-tree', () => {
    const { nodes, kidsOf } = build('deep');
    layoutChain(nodes, 'root', kidsOf, { ...HORIZONTAL, dir:-1, ...CONFIGS.default });
    // m2 must clear the deepest descendant of m1, which extends further left.
    assert.ok(nodes.m2.x + nodes.m2.w <= nodes.a2.x,
      'the next chain item must not overlap the previous sub-tree');
  });

  test('every node lands somewhere finite, whatever the axis and direction', () => {
    for (const axis of ['x','y']) for (const dir of [1,-1]) {
      const { nodes, kidsOf } = build('lopsided');
      layoutChain(nodes, 'root', kidsOf, { axis, dir, gapMain:70, gapCross:22, ...CONFIGS.default });
      for (const [id, n] of Object.entries(nodes)) {
        assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y), `${id} at ${axis}/${dir}`);
      }
    }
  });
});
