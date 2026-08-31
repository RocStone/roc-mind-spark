// WKWebView lifts the in-progress editor onto #stage as .edit-float. The
// original card stays in the tree as a hidden placeholder. If a toolbar
// action (marker, color, task) rebuilds the card without reading that float,
// you get a disconnected "New topic" clone next to the real node.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const INLINE_HTML_RE = extractConst('INLINE_HTML_RE');

describe('editFloatViewportPos — leftover helper still reads on-screen GBR', () => {
  const { editFloatViewportPos } = loadFns(['editFloatViewportPos']);

  test('reads left/top from getBoundingClientRect', () => {
    assert.deepEqual(
      editFloatViewportPos({ getBoundingClientRect: () => ({ left: 40.5, top: 12 }) }),
      { left: 40.5, top: 12 }
    );
  });

  test('missing element is origin', () => {
    assert.deepEqual(editFloatViewportPos(null), { left: 0, top: 0 });
  });
});

describe('editFloatStagePos — float sits on #stage in the viewport matrix', () => {
  const { editFloatStagePos } = loadFns(['editFloatStagePos']);

  test('view.x/y + offset*k matches #viewport translate+scale', () => {
    assert.deepEqual(
      editFloatStagePos({ x: 80, y: 12, k: 1 }, { offsetLeft: 40, offsetTop: 10 }),
      { left: 120, top: 22 }
    );
  });

  test('pan and zoom both move the clone, so it cannot drift off the node', () => {
    assert.deepEqual(
      editFloatStagePos({ x: 10, y: 20, k: 2 }, { offsetLeft: 5, offsetTop: 7 }),
      { left: 20, top: 34 }
    );
  });
});

describe('flushOpenEditToModel — WK float is the live text, not the placeholder', () => {
  test('reads .edit-float even when the hidden card still says New topic', () => {
    const stale = { innerHTML: 'New topic', textContent: 'New topic' };
    const classes = new Set(['node', 'editing', 'edit-placeholder']);
    const el = {
      dataset: { id: 'n1' },
      classList: {
        contains: c => classes.has(c),
        remove: (...cs) => cs.forEach(c => classes.delete(c)),
      },
      querySelector: sel => sel === '.node-text' ? stale : null,
    };
    let removed = false;
    const float = {
      dataset: { nodeId: 'n1' },
      innerHTML: 'typed in float',
      textContent: 'typed in float',
      remove(){ removed = true; },
    };
    const map = { nodes: { n1: { text: 'New topic' } }, rootId: 'root' };
    const titleField = { value: '' };
    const removedFloats = [];
    global.document = {
      querySelector: sel => sel === '.node.editing' ? el : null,
      querySelectorAll: sel => {
        if(sel === '.edit-float') return removedFloats;
        if(sel === '.node.edit-placeholder') return [];
        return [];
      },
    };

    const { flushOpenEditToModel } = loadFns(
      ['captureNodeEditText', 'applyNodeEditCapture', 'syncAutoTitleFromRoot', 'editFloatLiveTextEl', 'discardEditOverlay', 'unmountEditFloat', 'flushOpenEditToModel'],
      {
        map,
        _editFloat: float,
        _liveEditing: true,
        INLINE_HTML_RE,
        sanitizeInlineHTML: html => html,
        $: sel => sel === '#mapTitle' ? titleField : null,
        refreshList(){},
      }
    );

    const id = flushOpenEditToModel();
    assert.equal(id, 'n1');
    assert.equal(map.nodes.n1.text, 'typed in float');
    assert.equal(removed, true);
    assert.equal(classes.has('editing'), false);
    assert.equal(classes.has('edit-placeholder'), false);
  });
});

describe('setMarker while the WK editor is open', () => {
  test('keeps the typed draft, sets the fire marker, and unmounts the float', () => {
    const stale = { innerHTML: 'New topic', textContent: 'New topic' };
    const classes = new Set(['node', 'editing', 'edit-placeholder']);
    const el = {
      dataset: { id: 'n1' },
      classList: {
        contains: c => classes.has(c),
        remove: (...cs) => cs.forEach(c => classes.delete(c)),
      },
      querySelector: sel => sel === '.node-text' ? stale : null,
    };
    let removed = false;
    const float = {
      dataset: { nodeId: 'n1' },
      innerHTML: 'typed in float',
      textContent: 'typed in float',
      remove(){ removed = true; },
    };
    const map = { nodes: { n1: { text: 'New topic' } }, rootId: 'root' };
    const titleField = { value: '' };
    let history = 0;
    let renders = 0;
    let layouts = 0;
    global.document = {
      querySelector: sel => sel === '.node.editing' ? el : null,
      querySelectorAll: () => [],
    };

    const { setMarker } = loadFns(
      ['captureNodeEditText', 'applyNodeEditCapture', 'syncAutoTitleFromRoot', 'editFloatLiveTextEl', 'discardEditOverlay', 'unmountEditFloat', 'flushOpenEditToModel', 'setMarker'],
      {
        map,
        _editFloat: float,
        _liveEditing: true,
        INLINE_HTML_RE,
        sanitizeInlineHTML: html => html,
        $: sel => sel === '#mapTitle' ? titleField : null,
        refreshList(){},
        pushHistory(){ history++; },
        render(){ renders++; },
        autoLayout(){ layouts++; },
      }
    );

    setMarker('n1', '\u{1F525}');

    assert.equal(map.nodes.n1.text, 'typed in float', 'draft must survive adding a marker');
    assert.equal(map.nodes.n1.marker, '\u{1F525}');
    assert.equal(removed, true, 'the stage clone must be removed so it cannot ghost');
    assert.equal(history, 1);
    assert.equal(renders, 1);
    assert.equal(layouts, 1);
  });
});

describe('edit float keeps task / marker chrome visible', () => {
  test('nodeEditChromeClone copies the in-flow badges and nothing else', () => {
    const kids = [
      { className: 'node-marker', cloneNode(){ return { className: 'node-marker' }; } },
      { className: 'task-check task-todo', cloneNode(){ return { className: 'task-check task-todo' }; } },
    ];
    const el = {
      querySelectorAll(sel){
        if(sel === '.node-marker, .task-check') return kids;
        return [];
      },
    };
    const { nodeEditChromeClone } = loadFns(['nodeEditChromeClone'], {
      document: {
        createElement(tag){
          const node = { tagName: tag, className: '', attrs: {}, childNodes: [] };
          node.setAttribute = (k, v) => { node.attrs[k] = v; };
          node.appendChild = c => node.childNodes.push(c);
          return node;
        },
      },
    });
    const wrap = nodeEditChromeClone(el);
    assert.equal(wrap.className, 'edit-float-chrome');
    assert.equal(wrap.attrs.contenteditable, 'false');
    assert.equal(wrap.childNodes.length, 2);
    assert.equal(wrap.childNodes[0].className, 'node-marker');
    assert.equal(wrap.childNodes[1].className, 'task-check task-todo');
  });

  test('capture reads .edit-float-text, not the cloned checkbox', () => {
    const float = {
      dataset: { nodeId: 'n1' },
      innerHTML: '<span class="edit-float-chrome"><span class="task-check">✓</span></span><span class="edit-float-text">typed draft</span>',
      textContent: '✓typed draft',
      querySelector(sel){
        if(sel === '.edit-float-text') return { innerHTML: 'typed draft', textContent: 'typed draft' };
        return null;
      },
    };
    const stale = { innerHTML: 'New topic', textContent: 'New topic' };
    const classes = new Set(['node', 'editing', 'edit-placeholder']);
    const el = {
      dataset: { id: 'n1' },
      classList: {
        contains: c => classes.has(c),
        remove: (...cs) => cs.forEach(c => classes.delete(c)),
      },
      querySelector: sel => sel === '.node-text' ? stale : null,
    };
    const map = { nodes: { n1: { text: 'New topic', task: 'todo' } }, rootId: 'root' };
    global.document = {
      querySelector: sel => sel === '.node.editing' ? el : null,
      querySelectorAll: () => [],
    };
    const { flushOpenEditToModel } = loadFns(
      ['captureNodeEditText', 'applyNodeEditCapture', 'syncAutoTitleFromRoot', 'editFloatLiveTextEl', 'discardEditOverlay', 'unmountEditFloat', 'flushOpenEditToModel'],
      {
        map,
        _editFloat: float,
        _liveEditing: true,
        INLINE_HTML_RE,
        sanitizeInlineHTML: html => html,
        $: () => null,
        refreshList(){},
      }
    );
    flushOpenEditToModel();
    assert.equal(map.nodes.n1.text, 'typed draft');
    assert.equal(map.nodes.n1.task, 'todo');
  });
});
