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

describe('paste image as a child of the selected node', () => {
  const nodes = () => ({
    root: { id: 'root', text: 'root', x: 0, y: 0 },
    n1: { id: 'n1', parent: 'root', text: 'topic', x: 180, y: 40, side: 'right' },
  });

  test('resolveImagePasteParentId prefers the node being edited', () => {
    const { resolveImagePasteParentId } = loadFns(['resolveImagePasteParentId']);
    const ns = nodes();
    assert.equal(resolveImagePasteParentId({ editingId: 'n1', selectedId: 'root', nodes: ns }), 'n1');
    assert.equal(resolveImagePasteParentId({ editingId: null, selectedId: 'n1', nodes: ns }), 'n1');
    assert.equal(resolveImagePasteParentId({ editingId: null, selectedId: null, nodes: ns }), null);
    assert.equal(resolveImagePasteParentId({ editingId: null, selectedId: 'gone', nodes: ns }), null);
  });

  test('insertChildNode adds a child under the parent and does not touch the parent image', () => {
    const map = { rootId: 'root', nodes: nodes() };
    const { insertChildNode } = loadFns(['insertChildNode'], {
      map,
      NODE_COLORS: ['#ffffff', '#ffe2d6'],
      uid: () => 'img1',
      childrenOf: id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id),
    });
    const id = insertChildNode('n1', { text: '' });
    assert.equal(id, 'img1');
    assert.equal(map.nodes.img1.parent, 'n1');
    assert.equal(map.nodes.img1.text, '');
    assert.equal(map.nodes.n1.image, undefined);
  });

  test('beginImagePasteAsChild creates an empty child, not an attach on the parent', () => {
    const map = { rootId: 'root', nodes: nodes() };
    let sel = 'n1';
    const { beginImagePasteAsChild } = loadFns(
      ['insertChildNode', 'beginImagePasteAsChild'],
      {
        READONLY: false,
        map,
        sel,
        NODE_COLORS: ['#ffffff', '#ffe2d6'],
        uid: () => 'img1',
        childrenOf: id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id),
        opLog() {},
        commitOpenEdit() { return false; },
      }
    );
    const id = beginImagePasteAsChild('n1');
    assert.equal(id, 'img1');
    assert.equal(map.nodes.n1.image, undefined);
    assert.equal(map.nodes.img1.parent, 'n1');
    assert.equal(map.nodes.img1.text, '');
    assert.equal(map.nodes.img1.image, undefined);
  });

  test('pasteImageAsChild writes the image onto the new child', () => {
    const map = { rootId: 'root', nodes: nodes() };
    const file = { type: 'image/png' };
    const { pasteImageAsChild } = loadFns(
      ['insertChildNode', 'resolveImagePasteParentId', 'beginImagePasteAsChild', 'pasteImageAsChild'],
      {
        READONLY: false,
        map,
        sel: 'n1',
        NODE_COLORS: ['#ffffff', '#ffe2d6'],
        uid: () => 'img1',
        childrenOf: id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id),
        opLog() {},
        commitOpenEdit() { return false; },
        isAppTextField: () => false,
        openClipboardTarget: () => null,
        toast() {},
        readImageFile(f, id) { map.nodes[id].image = 'from-file'; },
        readImageDataUrl(url, id) { map.nodes[id].image = url; },
      }
    );
    global.document = { activeElement: { tagName: 'BODY' }, querySelector: () => null };
    assert.equal(pasteImageAsChild(file, null), true);
    assert.equal(map.nodes.n1.image, undefined);
    assert.equal(map.nodes.img1.parent, 'n1');
    assert.equal(map.nodes.img1.image, 'from-file');
  });

  test('pasteImageAsChild refuses to run when no topic is selected', () => {
    const map = { rootId: 'root', nodes: nodes() };
    let message = '';
    const { pasteImageAsChild } = loadFns(
      ['insertChildNode', 'resolveImagePasteParentId', 'beginImagePasteAsChild', 'pasteImageAsChild'],
      {
        READONLY: false,
        map,
        sel: null,
        NODE_COLORS: ['#ffffff', '#ffe2d6'],
        uid: () => 'img1',
        childrenOf: () => [],
        opLog() {},
        commitOpenEdit() { return false; },
        isAppTextField: () => false,
        openClipboardTarget: () => null,
        toast(m) { message = m; },
        readImageFile() { throw new Error('should not attach'); },
        readImageDataUrl() { throw new Error('should not attach'); },
      }
    );
    global.document = { activeElement: { tagName: 'BODY' }, querySelector: () => null };
    assert.equal(pasteImageAsChild({ type: 'image/png' }, null), false);
    assert.equal(message, 'Select a topic first, then paste the image');
    assert.equal(map.nodes.img1, undefined);
  });

  test('handleImagePasteEvent prevents default only when the paste is handled', () => {
    let handled = false;
    const { handleImagePasteEvent } = loadFns(['handleImagePasteEvent'], {
      READONLY: false,
      firstImageFile: dt => dt && dt.file,
      pasteImageAsChild: file => {
        handled = !!file;
        return handled;
      },
    });
    let prevented = false;
    assert.equal(handleImagePasteEvent({
      clipboardData: { file: { type: 'image/png' } },
      preventDefault() { prevented = true; },
    }), true);
    assert.equal(handled, true);
    assert.equal(prevented, true);

    handled = false;
    prevented = false;
    assert.equal(handleImagePasteEvent({
      clipboardData: { file: null },
      preventDefault() { prevented = true; },
    }), false);
    assert.equal(prevented, false);
  });

  test('rmsClipboardPasteImage uses a data URL from the native pasteboard', () => {
    const map = { rootId: 'root', nodes: nodes() };
    const dataUrl = 'data:image/jpeg;base64,aaa';
    const { rmsClipboardPasteImage } = loadFns(
      ['insertChildNode', 'resolveImagePasteParentId', 'beginImagePasteAsChild', 'pasteImageAsChild', 'rmsClipboardPasteImage'],
      {
        READONLY: false,
        map,
        sel: 'n1',
        NODE_COLORS: ['#ffffff', '#ffe2d6'],
        uid: () => 'img1',
        childrenOf: id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id),
        opLog() {},
        commitOpenEdit() { return false; },
        isAppTextField: () => false,
        openClipboardTarget: () => null,
        toast() {},
        readImageFile() { throw new Error('file path should not run'); },
        readImageDataUrl(url, id) { map.nodes[id].image = url; },
      }
    );
    global.document = { activeElement: { tagName: 'BODY' }, querySelector: () => null };
    assert.equal(rmsClipboardPasteImage(dataUrl), true);
    assert.equal(map.nodes.n1.image, undefined);
    assert.equal(map.nodes.img1.image, dataUrl);
  });

  test('failImageAttach removes an empty child that never got an image', () => {
    const map = { rootId: 'root', nodes: nodes() };
    map.nodes.img1 = { id: 'img1', parent: 'n1', text: '' };
    let sel = 'img1';
    let message = '';
    const { failImageAttach } = loadFns(['failImageAttach'], {
      map,
      sel,
      toast(m) { message = m; },
    });
    failImageAttach('img1');
    assert.equal(map.nodes.img1, undefined);
    assert.equal(message, 'Could not read image');
  });

  test('commitImageData stores the data-URL on the given node', () => {
    const map = { rootId: 'root', nodes: nodes() };
    let laidOut = false;
    const { commitImageData } = loadFns(['commitImageData'], {
      map,
      MODE: 'server',
      pushHistory() {},
      render() {},
      autoLayout() { laidOut = true; },
      toast() {},
    });
    commitImageData('n1', 'data:image/jpeg;base64,xx');
    assert.equal(map.nodes.n1.image, 'data:image/jpeg;base64,xx');
    assert.equal(laidOut, true);
  });
});
