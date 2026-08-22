import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const {
  rectsIntersect,
  mapRectFromCorners,
  clientBoxFromGbr,
  nodesInMarqueeEls,
  nodesInMarquee,
  selectionMoveRoots,
  selectionCommonParent,
  orderIdsByNodeKeys,
  canDropSelection,
  spliceNodeOrder,
  siblingIdsOf,
  computeSelectionMove,
  isBoxSelectModifier,
} = loadFns([
  'rectsIntersect',
  'mapRectFromCorners',
  'clientBoxFromGbr',
  'nodesInMarqueeEls',
  'nodesInMarquee',
  'selectionMoveRoots',
  'selectionCommonParent',
  'orderIdsByNodeKeys',
  'canDropSelection',
  'spliceNodeOrder',
  'siblingIdsOf',
  'computeSelectionMove',
  'isBoxSelectModifier',
]);

function sample(){
  return {
    rootId: 'root',
    layout: 'right',
    nodes: {
      root: { id:'root', parent:null, text:'R', side:'right', x:0, y:80, w:80, h:40 },
      a:    { id:'a', parent:'root', text:'A', side:'right', x:120, y:0, w:80, h:40 },
      a1:   { id:'a1', parent:'a', text:'A1', side:'right', x:240, y:-20, w:80, h:40 },
      a2:   { id:'a2', parent:'a', text:'A2', side:'right', x:240, y:20, w:80, h:40 },
      b:    { id:'b', parent:'root', text:'B', side:'right', x:120, y:80, w:80, h:40 },
      b1:   { id:'b1', parent:'b', text:'B1', side:'right', x:240, y:80, w:80, h:40 },
      c:    { id:'c', parent:'root', text:'C', side:'right', x:120, y:160, w:80, h:40 },
    },
  };
}
const kids = (map, id) => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);

describe('rectsIntersect / nodesInMarquee', () => {
  test('overlapping boxes hit, touching an edge counts, disjoint miss', () => {
    assert.equal(rectsIntersect({x:0,y:0,w:10,h:10}, {x:5,y:5,w:10,h:10}), true);
    assert.equal(rectsIntersect({x:0,y:0,w:10,h:10}, {x:10,y:0,w:10,h:10}), false);
    assert.equal(rectsIntersect({x:0,y:0,w:10,h:10}, {x:11,y:0,w:10,h:10}), false);
  });

  test('marquee hits every node the rectangle covers, skips hidden ones', () => {
    const map = sample();
    const hits = nodesInMarquee(map.nodes, {x:230, y:-30, w:30, h:80});
    assert.deepEqual(hits.sort(), ['a1', 'a2']);
    const hidden = new Set(['a2']);
    assert.deepEqual(nodesInMarquee(map.nodes, {x:230, y:-30, w:30, h:80}, hidden), ['a1']);
  });

  test('empty or zero-size marquee hits nothing', () => {
    const map = sample();
    assert.deepEqual(nodesInMarquee(map.nodes, {x:0,y:0,w:0,h:10}), []);
    assert.deepEqual(nodesInMarquee(map.nodes, null), []);
  });
});

function fakeNode(id, left, top, width, height){
  return {
    dataset: { id },
    getBoundingClientRect: () => ({
      left, top, width, height,
      right: left+width, bottom: top+height,
    }),
  };
}

describe('nodesInMarqueeEls — clientX marquee vs node GBR', () => {
  test('hits every node the rectangle covers', () => {
    const els = [
      fakeNode('a', 100, 100, 80, 40),
      fakeNode('b', 300, 100, 80, 40),
      fakeNode('c', 100, 300, 80, 40),
    ];
    assert.deepEqual(nodesInMarqueeEls(els, {x:90, y:90, w:100, h:60}).sort(), ['a']);
    assert.deepEqual(nodesInMarqueeEls(els, {x:90, y:90, w:300, h:60}).sort(), ['a','b']);
  });

  test('partial overlap counts; disjoint misses; zero-size marquee hits nothing', () => {
    const els = [fakeNode('a', 100, 100, 80, 40)];
    assert.deepEqual(nodesInMarqueeEls(els, {x:170, y:120, w:20, h:20}), ['a']);
    assert.deepEqual(nodesInMarqueeEls(els, {x:181, y:100, w:20, h:20}), []);
    assert.deepEqual(nodesInMarqueeEls(els, {x:0, y:0, w:0, h:10}), []);
    assert.deepEqual(nodesInMarqueeEls(els, null), []);
  });

  test('skips elements without an id', () => {
    const els = [{ dataset:{}, getBoundingClientRect: () => ({left:0,top:0,width:10,height:10,right:10,bottom:10}) }];
    assert.deepEqual(nodesInMarqueeEls(els, {x:0, y:0, w:10, h:10}), []);
  });

  test('mapRectFromCorners normalizes inverted drag', () => {
    assert.deepEqual(mapRectFromCorners(80, 40, 20, 10), {x:20, y:10, w:60, h:30});
  });

  test('clientBoxFromGbr reads width/height or right-left', () => {
    assert.deepEqual(clientBoxFromGbr({left:10, top:20, width:30, height:40}), {x:10, y:20, w:30, h:40});
    assert.deepEqual(clientBoxFromGbr({left:10, top:20, right:40, bottom:60}), {x:10, y:20, w:30, h:40});
  });
});

describe('selectionMoveRoots / common parent', () => {
  test('parent + its children collapses to the parent', () => {
    const map = sample();
    assert.deepEqual(selectionMoveRoots(['a','a1','a2'], map.nodes, 'root'), ['a']);
  });

  test('siblings stay independent move-roots', () => {
    const map = sample();
    assert.deepEqual(selectionMoveRoots(['a1','a2'], map.nodes, 'root'), ['a1','a2']);
    assert.equal(selectionCommonParent(['a1','a2'], map.nodes), 'a');
  });

  test('nodes from different branches have no common parent', () => {
    const map = sample();
    assert.deepEqual(selectionMoveRoots(['a1','b1'], map.nodes, 'root'), ['a1','b1']);
    assert.equal(selectionCommonParent(['a1','b1'], map.nodes), null);
  });

  test('root is never a move-root, and selecting it does not swallow its children', () => {
    const map = sample();
    assert.deepEqual(selectionMoveRoots(['root','a','b'], map.nodes, 'root'), ['a','b']);
    assert.deepEqual(selectionMoveRoots(['root'], map.nodes, 'root'), []);
  });

  test('orderIdsByNodeKeys follows map.nodes key order', () => {
    const map = sample();
    assert.deepEqual(orderIdsByNodeKeys(['c','a1','b'], map.nodes), ['a1','b','c']);
  });
});

describe('canDropSelection', () => {
  test('rejects root, self, and own descendants', () => {
    const map = sample();
    assert.equal(canDropSelection(['root'], 'c', 'on', map.nodes, 'root'), false);
    assert.equal(canDropSelection(['a'], 'a', 'on', map.nodes, 'root'), false);
    assert.equal(canDropSelection(['a'], 'a1', 'on', map.nodes, 'root'), false);
    assert.equal(canDropSelection(['a'], 'c', 'before', map.nodes, 'root'), true);
    assert.equal(canDropSelection(['a'], 'root', 'before', map.nodes, 'root'), false);
    assert.equal(canDropSelection(['a'], 'root', 'on', map.nodes, 'root'), true);
  });
});

describe('computeSelectionMove — nest / reorder / group', () => {
  test('drop on a node nests as its last children and keeps relative order', () => {
    const map = sample();
    assert.equal(computeSelectionMove(map, ['a1','b1'], 'c', 'on'), true);
    assert.equal(map.nodes.a1.parent, 'c');
    assert.equal(map.nodes.b1.parent, 'c');
    assert.deepEqual(kids(map, 'c'), ['a1','b1']);
    assert.deepEqual(kids(map, 'a'), ['a2']);
    assert.deepEqual(kids(map, 'b'), []);
  });

  test('dropping a parent+child pair only moves the parent; the child stays attached', () => {
    const map = sample();
    // raw compute still honours whatever list it is given — the UI filters first.
    // This test documents the desired apply-time filter via selectionMoveRoots.
    const roots = selectionMoveRoots(['a','a1','a2'], map.nodes, 'root');
    assert.deepEqual(roots, ['a']);
    assert.equal(computeSelectionMove(map, roots, 'c', 'on'), true);
    assert.equal(map.nodes.a.parent, 'c');
    assert.equal(map.nodes.a1.parent, 'a');
    assert.equal(map.nodes.a2.parent, 'a');
    assert.deepEqual(kids(map, 'c'), ['a']);
  });

  test('drop before / after reorders siblings and can change parent', () => {
    const map = sample();
    assert.equal(computeSelectionMove(map, ['c'], 'a', 'before'), true);
    assert.deepEqual(kids(map, 'root'), ['c','a','b']);

    assert.equal(computeSelectionMove(map, ['a1','a2'], 'b', 'after'), true);
    assert.equal(map.nodes.a1.parent, 'root');
    assert.equal(map.nodes.a2.parent, 'root');
    assert.deepEqual(kids(map, 'root'), ['c','a','b','a1','a2']);
    assert.deepEqual(kids(map, 'a'), []);
  });

  test('drop on current parent is a no-op', () => {
    const map = sample();
    const before = kids(map, 'a');
    assert.equal(computeSelectionMove(map, ['a1','a2'], 'a', 'on'), false);
    assert.deepEqual(kids(map, 'a'), before);
  });

  test('drop after the previous sibling when already there is a no-op', () => {
    const map = sample();
    assert.equal(computeSelectionMove(map, ['b'], 'a', 'after'), false);
    assert.deepEqual(kids(map, 'root'), ['a','b','c']);
  });

  test('cannot drop a topic onto its own descendant', () => {
    const map = sample();
    assert.equal(computeSelectionMove(map, ['a'], 'a1', 'on'), false);
    assert.equal(map.nodes.a1.parent, 'a');
  });

  test('group insert before a sibling stays a contiguous block', () => {
    const map = sample();
    assert.equal(computeSelectionMove(map, ['b','c'], 'a', 'before'), true);
    assert.deepEqual(kids(map, 'root'), ['b','c','a']);
  });

  test('balanced-root insert copies the reference sibling side', () => {
    const map = sample();
    map.layout = 'balanced';
    map.nodes.a.side = 'right';
    map.nodes.b.side = 'left';
    map.nodes.c.side = 'right';
    assert.equal(computeSelectionMove(map, ['b'], 'c', 'after'), true);
    assert.equal(map.nodes.b.parent, 'root');
    assert.equal(map.nodes.b.side, 'right');
    assert.equal(map.nodes.b1.side, 'right');
  });
});

describe('spliceNodeOrder', () => {
  test('pulls keys out and reinserts them as a block', () => {
    const nodes = { a:{id:'a'}, b:{id:'b'}, c:{id:'c'}, d:{id:'d'} };
    const after = spliceNodeOrder(nodes, ['a','c'], {after:'d'});
    assert.deepEqual(Object.keys(after), ['b','d','a','c']);
    const before = spliceNodeOrder(nodes, ['d'], {before:'b'});
    assert.deepEqual(Object.keys(before), ['a','d','b','c']);
  });
});

describe('isBoxSelectModifier', () => {
  test('Command or Ctrl, but not Alt-chords', () => {
    assert.equal(isBoxSelectModifier({metaKey:true, ctrlKey:false, altKey:false}), true);
    assert.equal(isBoxSelectModifier({metaKey:false, ctrlKey:true, altKey:false}), true);
    assert.equal(isBoxSelectModifier({metaKey:true, ctrlKey:false, altKey:true}), false);
    assert.equal(isBoxSelectModifier({metaKey:false, ctrlKey:false, altKey:false}), false);
  });
});
