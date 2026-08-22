// Helpers behind drag-drop / paste image attachment. These are the parts that
// decide *whether* an attach happens and *to which node* — the actual gesture
// needs a browser, but this logic does not, and it's where the edge cases live
// (clipboard images arrive differently from dropped files; a drop can land on
// empty canvas or on a node that no longer exists).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

// No jsdom: this project has zero runtime dependencies and CI deliberately
// runs no `npm ci`, so the tests must not need an install either. These two
// helpers only touch elementFromPoint(), createElement() and closest(), so a
// few lines of stub cover exactly what they use.
function makeEl(cls = '', id = null) {
  const el = { className: cls, dataset: {}, parentNode: null, children: [] };
  if (id !== null) el.dataset.id = id;
  el.closest = sel => {
    if (sel !== '.node') throw new Error('stub only supports .node');
    let cur = el;
    while (cur) { if ((cur.className || '').split(/\s+/).includes('node')) return cur; cur = cur.parentNode; }
    return null;
  };
  el.appendChild = child => { child.parentNode = el; el.children.push(child); return child; };
  return el;
}
global.document = {
  elementFromPoint: () => null,
  createElement: tag => makeEl(tag === 'span' ? '' : ''),
};

const MAP = { nodes: { n1: { text: 'one' }, n2: { text: 'two' } } };
const { firstImageFile, nodeIdAtPoint } = loadFns(
  ['firstImageFile', 'nodeIdAtPoint'],
  { map: MAP }
);

const imgFile = (type = 'image/png') => ({ type, name: 'x' });

describe('firstImageFile — dropped files', () => {
  test('returns the image when one file is dropped', () => {
    const f = imgFile();
    assert.equal(firstImageFile({ files: [f] }), f);
  });

  test('skips non-images and returns the first actual image', () => {
    const img = imgFile('image/jpeg');
    const dt = { files: [{ type: 'application/pdf' }, img, imgFile('image/gif')] };
    assert.equal(firstImageFile(dt), img);
  });

  test('returns null when nothing dropped is an image', () => {
    assert.equal(firstImageFile({ files: [{ type: 'application/pdf' }] }), null);
  });

  test('returns null for an empty drop', () => {
    assert.equal(firstImageFile({ files: [] }), null);
  });

  test('returns null for a null DataTransfer rather than throwing', () => {
    assert.equal(firstImageFile(null), null);
    assert.equal(firstImageFile(undefined), null);
  });
});

describe('firstImageFile — pasted clipboard items', () => {
  // Clipboard images have no entry in .files, only in .items — handling only
  // .files would make paste appear to do nothing at all.
  const item = (kind, file) => ({ kind, getAsFile: () => file });

  test('finds an image among clipboard items when .files is empty', () => {
    const f = imgFile();
    assert.equal(firstImageFile({ files: [], items: [item('file', f)] }), f);
  });

  test('ignores text items, which is what a normal text paste looks like', () => {
    const dt = { files: [], items: [item('string', null)] };
    assert.equal(firstImageFile(dt), null);
  });

  test('ignores a non-image file item', () => {
    const dt = { files: [], items: [item('file', { type: 'text/csv' })] };
    assert.equal(firstImageFile(dt), null);
  });

  test('survives an item whose getAsFile() returns null', () => {
    const dt = { files: [], items: [item('file', null)] };
    assert.equal(firstImageFile(dt), null);
  });

  test('prefers .files when both are present (a real drop, not a paste)', () => {
    const dropped = imgFile('image/png');
    const clip = imgFile('image/gif');
    const dt = { files: [dropped], items: [item('file', clip)] };
    assert.equal(firstImageFile(dt), dropped);
  });
});

describe('nodeIdAtPoint — where the drop landed', () => {
  const withElementAt = (el, fn) => {
    const prev = document.elementFromPoint;
    document.elementFromPoint = () => el;
    try { return fn(); } finally { document.elementFromPoint = prev; }
  };
  const nodeEl = id => makeEl('node', id);

  test('returns the id of the node under the pointer', () => {
    assert.equal(withElementAt(nodeEl('n1'), () => nodeIdAtPoint(10, 10)), 'n1');
  });

  test('finds the node when the pointer is over a child element inside it', () => {
    const outer = nodeEl('n2');
    const inner = makeEl('node-text');
    outer.appendChild(inner);
    assert.equal(withElementAt(inner, () => nodeIdAtPoint(10, 10)), 'n2');
  });

  test('returns null over empty canvas', () => {
    assert.equal(withElementAt(makeEl('stage'), () => nodeIdAtPoint(10, 10)), null);
  });

  test('returns null when there is no element at all', () => {
    assert.equal(withElementAt(null, () => nodeIdAtPoint(10, 10)), null);
  });

  test('returns null for a stale node id no longer in the map', () => {
    // Guards readImageFile(), which would throw on map.nodes[undefined].image
    assert.equal(withElementAt(nodeEl('deleted'), () => nodeIdAtPoint(10, 10)), null);
  });
});
