import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

function fns(){
  let counter = 0;
  return loadFns([
    'serializeNodeClip', 'isNodeClip', 'cloneNodeClipInto', 'isOutlineClipboardText',
    'outlineTextToNodeClip', 'parseMarkdownOutline', 'mdInlineToHtml', 'escapeHtml', 'safeColor',
  ], {
    uid: () => `p${++counter}`,
    INLINE_HTML_RE: extractConst('INLINE_HTML_RE'),
    SAFE_COLOR_NAMES: extractConst('SAFE_COLOR_NAMES'),
  });
}
const kidsOf = (nodes, id) => Object.keys(nodes).filter(k => nodes[k].parent === id);

describe('isOutlineClipboardText', () => {
  const { isOutlineClipboardText } = fns();
  test('bullets and headings are outlines', () => {
    assert.equal(isOutlineClipboardText('- a\n- b'), true);
    assert.equal(isOutlineClipboardText('- a\n  - b\n  - c'), true);
    assert.equal(isOutlineClipboardText('# Title\nsome text'), true);
    assert.equal(isOutlineClipboardText('1. one\n2. two'), true);
    assert.equal(isOutlineClipboardText('Parent\n\tChild\n\tChild 2'), true);
  });
  test('a single line or plain prose is not', () => {
    assert.equal(isOutlineClipboardText('just a line'), false);
    assert.equal(isOutlineClipboardText('- one bullet'), false);
    assert.equal(isOutlineClipboardText('first sentence.\nsecond sentence.'), false);
    assert.equal(isOutlineClipboardText(''), false);
  });
});

describe('outlineTextToNodeClip', () => {
  test('several top-level bullets become several roots with nesting kept', () => {
    const { outlineTextToNodeClip } = fns();
    const clip = outlineTextToNodeClip('- A\n  - A1\n  - A2\n- B');
    assert.equal(clip.roots.length, 2);
    const [a, b] = clip.roots.map(r => clip.nodes[r]);
    assert.equal(a.text, 'A');
    assert.equal(b.text, 'B');
    assert.equal(a.parent, null);
    assert.deepEqual(kidsOf(clip.nodes, a.id).map(k => clip.nodes[k].text), ['A1', 'A2']);
  });
  test('one top-level item is a single root', () => {
    const { outlineTextToNodeClip } = fns();
    const clip = outlineTextToNodeClip('- Only\n  - child');
    assert.equal(clip.roots.length, 1);
    assert.equal(clip.nodes[clip.roots[0]].text, 'Only');
  });
  test('tab-indented plain outline is nested', () => {
    const { outlineTextToNodeClip } = fns();
    const clip = outlineTextToNodeClip('Parent\n\tKid 1\n\tKid 2');
    assert.equal(clip.roots.length, 1);
    const root = clip.nodes[clip.roots[0]];
    assert.equal(root.text, 'Parent');
    assert.equal(kidsOf(clip.nodes, root.id).length, 2);
  });
});

describe('serializeNodeClip / cloneNodeClipInto', () => {
  const nodes = () => ({
    root: { id: 'root', text: 'Root', parent: null, side: 'root', x: 0, y: 0 },
    a: { id: 'a', text: 'A', parent: 'root', side: 'right', notes: '<p>n</p>', marker: '⭐', color: '#fee', x: 5, y: 5 },
    a1: { id: 'a1', text: 'A1', parent: 'a', side: 'right' },
    a2: { id: 'a2', text: 'A2', parent: 'a', side: 'right', collapsed: true },
    b: { id: 'b', text: 'B', parent: 'root', side: 'left', x: -10, y: 3 },
  });
  test('serializes the whole subtree and inner links only', () => {
    const { serializeNodeClip } = fns();
    const clip = serializeNodeClip(['a'], nodes(), null, [{ from: 'a1', to: 'a2' }, { from: 'a', to: 'b' }]);
    assert.deepEqual(clip.roots, ['a']);
    assert.deepEqual(Object.keys(clip.nodes), ['a', 'a1', 'a2']);
    assert.equal(clip.nodes.a.parent, null);
    assert.equal(clip.nodes.a.x, undefined);
    assert.deepEqual(clip.links, [{ from: 'a1', to: 'a2' }]);
  });
  test('onlyIds keeps just the selected nodes', () => {
    const { serializeNodeClip } = fns();
    const clip = serializeNodeClip(['a'], nodes(), ['a', 'a2']);
    assert.deepEqual(Object.keys(clip.nodes), ['a', 'a2']);
  });
  test('clones under a new parent with fresh ids, keeping text/notes/marker/color/links', () => {
    const { serializeNodeClip, cloneNodeClipInto } = fns();
    const src = nodes();
    const clip = serializeNodeClip(['a'], src, null, [{ from: 'a1', to: 'a2' }]);
    const links = [];
    let n = 0;
    const created = cloneNodeClipInto(clip, 'b', src, () => 'new' + (++n), links);
    assert.deepEqual(created, ['new1', 'new2', 'new3']);
    const top = src.new1;
    assert.equal(top.parent, 'b');
    assert.equal(top.text, 'A');
    assert.equal(top.notes, '<p>n</p>');
    assert.equal(top.marker, '⭐');
    assert.equal(top.color, '#fee');
    assert.equal(top.side, 'left');
    assert.equal(src.new2.parent, 'new1');
    assert.equal(src.new3.collapsed, true);
    assert.deepEqual(links, [{ from: 'new2', to: 'new3' }]);
    // the original is untouched
    assert.equal(src.a.parent, 'root');
    assert.equal(src.a1.parent, 'a');
  });
  test('cloning an outline clip under the root alternates sides', () => {
    const { outlineTextToNodeClip, cloneNodeClipInto } = fns();
    const src = nodes();
    const clip = outlineTextToNodeClip('- X\n- Y');
    let n = 0;
    const created = cloneNodeClipInto(clip, 'root', src, () => 'c' + (++n));
    assert.equal(created.length, 2);
    assert.equal(src.c1.parent, 'root');
    assert.equal(src.c1.text, 'X');
    assert.notEqual(src.c1.side, src.c2.side);
  });
  test('rejects a malformed clip', () => {
    const { cloneNodeClipInto } = fns();
    assert.deepEqual(cloneNodeClipInto({ roots: ['zz'], nodes: {} }, 'root', nodes(), () => 'x'), []);
    assert.deepEqual(cloneNodeClipInto(null, 'root', nodes(), () => 'x'), []);
  });
});
