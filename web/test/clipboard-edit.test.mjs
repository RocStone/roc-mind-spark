import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns } from './helpers/load-app-fns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'public', 'styles.css'), 'utf8');

const {
  clipboardEditAction,
  shouldHandleEditorTextPaste,
  editorCopyPayload,
  openEditorTextEl,
  clipboardPlainText,
  nodeClipboardPlain,
  isAppTextField,
  shouldTakeNodeClipboard,
  openOverlayTextField,
  overlayTextFieldOwnsClipboard,
} = loadFns([
  'clipboardEditAction',
  'shouldHandleEditorTextPaste',
  'editorCopyPayload',
  'openEditorTextEl',
  'openNotesEditorEl',
  'openOverlayTextField',
  'overlayTextFieldOwnsClipboard',
  'openClipboardTarget',
  'clipboardPlainText',
  'nodeClipboardPlain',
  'isAppTextField',
  'shouldTakeNodeClipboard',
]);

describe('clipboardEditAction — Cmd/Ctrl clipboard chords stay with the editor', () => {
  test('Cmd+C / Ctrl+C is copy', () => {
    assert.equal(clipboardEditAction({ key: 'c', metaKey: true }), 'copy');
    assert.equal(clipboardEditAction({ key: 'C', ctrlKey: true }), 'copy');
    assert.equal(clipboardEditAction({ key: 'Unidentified', code: 'KeyC', metaKey: true }), 'copy');
  });

  test('Cmd+X is cut, Cmd+V is paste, Cmd+A is selectAll', () => {
    assert.equal(clipboardEditAction({ key: 'x', metaKey: true }), 'cut');
    assert.equal(clipboardEditAction({ key: 'v', metaKey: true }), 'paste');
    assert.equal(clipboardEditAction({ key: 'v', metaKey: true, shiftKey: true }), 'paste');
    assert.equal(clipboardEditAction({ key: 'a', metaKey: true }), 'selectAll');
  });

  test('plain typing and other shortcuts are not clipboard', () => {
    assert.equal(clipboardEditAction({ key: 'c' }), null);
    assert.equal(clipboardEditAction({ key: 'v', altKey: true, metaKey: true }), null);
    assert.equal(clipboardEditAction({ key: 'c', metaKey: true, shiftKey: true }), null);
    assert.equal(clipboardEditAction({ key: 'f', metaKey: true }), null);
    assert.equal(clipboardEditAction(null), null);
  });
});

describe('shouldHandleEditorTextPaste', () => {
  test('plain text paste is handled', () => {
    assert.equal(shouldHandleEditorTextPaste({ imageFile: null, text: 'hello from Typeless' }), true);
  });

  test('image paste is left to the image handler', () => {
    assert.equal(shouldHandleEditorTextPaste({ imageFile: { type: 'image/png' }, text: '' }), false);
    assert.equal(shouldHandleEditorTextPaste({ imageFile: { type: 'image/png' }, text: 'also text' }), false);
    assert.equal(shouldHandleEditorTextPaste({ imageFile: { type: 'image/png' }, text: 'data:image/png;base64,xx' }), false);
  });

  test('empty clipboard is ignored', () => {
    assert.equal(shouldHandleEditorTextPaste({ imageFile: null, text: '' }), false);
    assert.equal(shouldHandleEditorTextPaste({ imageFile: null, text: null }), false);
  });
});

describe('editorCopyPayload', () => {
  test('uses the live selection when there is one', () => {
    assert.equal(editorCopyPayload({ selectedText: 'picked', allText: 'whole node', selectAllPending: true }), 'picked');
  });

  test('while select-all is still pending, copies the whole node', () => {
    assert.equal(editorCopyPayload({ selectedText: '', allText: 'whole node', selectAllPending: true }), 'whole node');
  });

  test('a collapsed caret does not invent a copy', () => {
    assert.equal(editorCopyPayload({ selectedText: '', allText: 'whole node', selectAllPending: false }), '');
  });
});

describe('openEditorTextEl', () => {
  test('returns the .node-text of the open editor', () => {
    const textEl = { id: 'text' };
    const node = {
      querySelector: sel => sel === '.node-text' ? textEl : null,
    };
    global.document = { querySelector: sel => sel === '.node.editing' ? node : null };
    assert.equal(openEditorTextEl(), textEl);
  });

  test('returns null when nothing is being edited', () => {
    global.document = { querySelector: () => null };
    assert.equal(openEditorTextEl(), null);
  });
});

describe('editing host CSS', () => {
  test('the contentEditable node-text is selectable while editing', () => {
    assert.match(css, /\.node\.editing\s+\.node-text\{[^}]*user-select:\s*text/);
    assert.match(css, /\.node\.editing\s+\.node-text\{[^}]*-webkit-user-select:\s*text/);
  });
});

describe('clipboardPlainText / nodeClipboardPlain', () => {
  test('prefers text/plain, then text/html stripped to text', () => {
    assert.equal(clipboardPlainText({ getData: t => t === 'text/plain' ? 'hello' : '' }), 'hello');
    const prev = global.document;
    global.document = { createElement: () => ({ innerHTML: '', get textContent(){ return this.innerHTML.replace(/<[^>]+>/g,''); } }) };
    try{
      assert.equal(clipboardPlainText({ getData: t => t === 'text/html' ? '<b>hi</b>' : '' }).trim(), 'hi');
    } finally {
      global.document = prev;
    }
    assert.equal(clipboardPlainText(null), '');
  });

  test('strips tags from a node', () => {
    assert.equal(nodeClipboardPlain({ text: '<b>Topic</b>' }), 'Topic');
    assert.equal(nodeClipboardPlain({ text: 'plain' }), 'plain');
    assert.equal(nodeClipboardPlain(null), '');
  });
});

describe('shouldTakeNodeClipboard', () => {
  test('takes the event while a node is being edited', () => {
    const textEl = { id: 'text' };
    global.document = {
      activeElement: { tagName: 'BODY' },
      querySelector: sel => sel === '.node.editing' ? { querySelector: () => textEl } : null,
    };
    assert.equal(shouldTakeNodeClipboard(), true);
  });

  test('does not steal copy from the search box', () => {
    global.document = {
      activeElement: { tagName: 'INPUT', closest: () => null, isContentEditable: false },
      querySelector: () => null,
    };
    assert.equal(isAppTextField(global.document.activeElement), true);
    assert.equal(shouldTakeNodeClipboard(), false);
  });

  test('does not steal clipboard from an open URL picker even if the input is not focused', () => {
    const hrefIn = { tagName: 'INPUT', value: '', closest: () => null };
    global.document = {
      activeElement: { tagName: 'BODY' },
      querySelector: sel => (typeof sel === 'string' && sel.includes('.picker')) ? hrefIn : null,
    };
    const { openOverlayTextField, overlayTextFieldOwnsClipboard, shouldTakeNodeClipboard } = loadFns(
      ['openOverlayTextField', 'overlayTextFieldOwnsClipboard', 'openNotesEditorEl', 'openEditorTextEl', 'openClipboardTarget', 'isAppTextField', 'shouldTakeNodeClipboard']
    );
    assert.equal(openOverlayTextField(), hrefIn);
    assert.equal(overlayTextFieldOwnsClipboard(), true);
    assert.equal(shouldTakeNodeClipboard(), false);
  });
});

describe('onEditorPaste — Typeless / Cmd+V into an open node', () => {
  test('inserts text/plain even if the editor is not focused', () => {
    const textEl = {
      textContent: 'Untitled',
      focus(){},
      dispatchEvent(){ return true; },
    };
    const node = {
      querySelector: sel => sel === '.node-text' ? textEl : null,
    };
    global.document = { querySelector: sel => sel === '.node.editing' ? node : null, activeElement: { tagName: 'BODY' } };
    global.window = { getSelection: () => null };

    const { onEditorPaste, armEditReplaceAll } = loadFns(
      [
        'clipboardPlainText',
        'isAppTextField',
        'shouldHandleEditorTextPaste',
        'openEditorTextEl',
        'openNotesEditorEl',
        'openClipboardTarget',
        'armEditReplaceAll',
        'peekEditReplaceAll',
        'clearEditReplaceAll',
        'emitEditorInput',
        'selectEditorContents',
        'insertEditorText',
        'onEditorPaste',
      ],
      { READONLY: false, firstImageFile: () => null, execCmd: () => false }
    );

    armEditReplaceAll();
    let prevented = false;
    onEditorPaste({
      clipboardData: { getData: type => type === 'text/plain' ? 'hello from Typeless' : '' },
      preventDefault(){ prevented = true; },
    });

    assert.equal(prevented, true);
    assert.equal(textEl.textContent, 'hello from Typeless');
  });

  test('does not swallow an image paste', () => {
    global.document = { querySelector: () => ({ querySelector: () => ({}) }), activeElement: { tagName: 'BODY' } };
    const { onEditorPaste } = loadFns(
      [
        'clipboardPlainText',
        'isAppTextField',
        'shouldHandleEditorTextPaste',
        'openEditorTextEl',
        'openNotesEditorEl',
        'openClipboardTarget',
        'peekEditReplaceAll',
        'clearEditReplaceAll',
        'emitEditorInput',
        'selectEditorContents',
        'insertEditorText',
        'onEditorPaste',
      ],
      { READONLY: false, firstImageFile: () => ({ type: 'image/png' }), execCmd: () => false }
    );
    let prevented = false;
    onEditorPaste({
      clipboardData: { getData: () => 'ignore me' },
      preventDefault(){ prevented = true; },
    });
    assert.equal(prevented, false);
  });
});

describe('onEditorCopyCut — copy a selected node that is not being edited', () => {
  test('writes the node text onto the copy event', () => {
    global.document = {
      activeElement: { tagName: 'BODY' },
      querySelector: () => null,
    };
    global.window = { getSelection: () => null };
    const { onEditorCopyCut } = loadFns(
      [
        'openEditorTextEl',
        'openNotesEditorEl',
        'openClipboardTarget',
        'isAppTextField',
        'shouldTakeNodeClipboard',
        'editorCopyPayload',
        'editorSelectedText',
        'peekEditReplaceAll',
        'nodeClipboardPlain',
        'editorClipboardPayload',
        'writeClipboardText',
        'onEditorCopyCut',
      ],
      {
        sel: 'n1',
        map: { nodes: { n1: { text: 'copied topic' } } },
      }
    );
    let stored = '';
    let prevented = false;
    onEditorCopyCut({
      clipboardData: { setData(type, v){ if(type==='text/plain') stored = v; } },
      preventDefault(){ prevented = true; },
    }, false);
    assert.equal(stored, 'copied topic');
    assert.equal(prevented, true);
  });
});

describe('onEditorClipboardKeydown — must not cancel the copy event', () => {
  test('Cmd+C does not preventDefault', () => {
    const textEl = { textContent: 'abc', focus(){}, tagName: 'SPAN' };
    global.document = {
      querySelector: sel => sel === '.node.editing' ? { querySelector: () => textEl } : null,
    };
    global.window = { getSelection: () => ({ rangeCount: 0, isCollapsed: true, toString: () => '' }) };
    const { onEditorClipboardKeydown } = loadFns(
      [
        'clipboardEditAction',
        'openEditorTextEl',
        'openNotesEditorEl',
        'openClipboardTarget',
        'peekEditReplaceAll',
        'selectEditorContents',
        'onEditorClipboardKeydown',
      ]
    );
    let prevented = false;
    onEditorClipboardKeydown({
      key: 'c', metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, code: 'KeyC',
      preventDefault(){ prevented = true; },
      stopPropagation(){},
    });
    assert.equal(prevented, false);
  });
});

describe('rmsClipboardPaste — native shell Cmd+V / Typeless', () => {
  test('writes into the open editor without a paste event', () => {
    const textEl = {
      textContent: 'old',
      focus(){},
      dispatchEvent(){ return true; },
    };
    global.document = {
      querySelector: sel => sel === '.node.editing' ? { querySelector: () => textEl } : null,
      activeElement: { tagName: 'BODY' },
    };
    global.window = { getSelection: () => null };
    const { rmsClipboardPaste, armEditReplaceAll } = loadFns(
      [
        'isAppTextField',
        'openEditorTextEl',
        'openNotesEditorEl',
        'openClipboardTarget',
        'armEditReplaceAll',
        'peekEditReplaceAll',
        'clearEditReplaceAll',
        'emitEditorInput',
        'selectEditorContents',
        'insertEditorText',
        'rmsClipboardPaste',
      ],
      { READONLY: false, execCmd: () => false }
    );
    armEditReplaceAll();
    assert.equal(rmsClipboardPaste('from native pasteboard'), true);
    assert.equal(textEl.textContent, 'from native pasteboard');
  });

  test('pastes into the URL picker instead of the selected node', () => {
    const hrefIn = {
      tagName: 'INPUT',
      value: '',
      selectionStart: 0,
      selectionEnd: 0,
      focus(){},
      setSelectionRange(a, b){ this.selectionStart = a; this.selectionEnd = b; },
      dispatchEvent(){ return true; },
    };
    let started = false;
    global.document = {
      activeElement: { tagName: 'BODY' },
      querySelector: sel => {
        if(typeof sel === 'string' && sel.includes('.picker')) return hrefIn;
        return null;
      },
    };
    const { rmsClipboardPaste } = loadFns(
      [
        'isAppTextField',
        'openOverlayTextField',
        'overlayTextFieldOwnsClipboard',
        'insertFieldText',
        'emitEditorInput',
        'openEditorTextEl',
        'openNotesEditorEl',
        'openClipboardTarget',
        'insertEditorText',
        'rmsClipboardPaste',
      ],
      {
        READONLY: false,
        sel: 'n1',
        map: { nodes: { n1: { text: 'SPT 2025 ACL' } } },
        startEdit(){ started = true; },
        execCmd: () => false,
      }
    );
    assert.equal(rmsClipboardPaste('https://arxiv.org/html/2601.03511v2'), true);
    assert.equal(hrefIn.value, 'https://arxiv.org/html/2601.03511v2');
    assert.equal(started, false);
  });

  test('pastes into the notes editor when that popup is open', () => {
    const notesEl = {
      textContent: 'old note',
      tagName: 'DIV',
      closest: sel => sel === '.notes-popup' ? {} : null,
      focus(){},
      dispatchEvent(){ return true; },
    };
    global.document = {
      querySelector: sel => sel === '.notes-popup .np-editor' ? notesEl : null,
      activeElement: notesEl,
    };
    global.window = { getSelection: () => null };
    const { rmsClipboardPaste } = loadFns(
      [
        'isAppTextField',
        'openEditorTextEl',
        'openNotesEditorEl',
        'openClipboardTarget',
        'peekEditReplaceAll',
        'clearEditReplaceAll',
        'emitEditorInput',
        'selectEditorContents',
        'insertEditorText',
        'rmsClipboardPaste',
      ],
      { READONLY: false, execCmd: () => false }
    );
    assert.equal(rmsClipboardPaste('pasted into note'), true);
    assert.equal(notesEl.textContent, 'old note' + 'pasted into note');
  });
});

describe('rmsClipboardPasteImage — native shell image paste', () => {
  test('window.__rmsClipboardPasteImage is the native image entry', () => {
    const src = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');
    assert.match(src, /window\.__rmsClipboardPasteImage\s*=\s*rmsClipboardPasteImage/);
    assert.match(src, /window\.__rmsClipboardPasteImageFile\s*=\s*rmsClipboardPasteImageFile/);
    assert.match(src, /window\.__rmsClipboardCopyPayload\s*=\s*rmsClipboardCopyPayload/);
    assert.match(src, /window\.__rmsClipboardWantsText\s*=\s*overlayTextFieldOwnsClipboard/);
  });
});

describe('rmsClipboardCopyImageUrl — copy a selected image node', () => {
  test('returns the map image URL for a file-backed node', () => {
    global.document = { querySelector: () => null, activeElement: { tagName: 'BODY' } };
    const { rmsClipboardCopyImageUrl } = loadFns(
      ['apiUrl', 'nodeImageSrc', 'openNotesEditorEl', 'openEditorTextEl', 'openClipboardTarget', 'isAppTextField', 'shouldTakeNodeClipboard', 'rmsClipboardCopyImageUrl'],
      {
        API_BASE: '',
        sel: 'n1',
        map: { id: 'm1', nodes: { n1: { id: 'n1', text: '', image: '001.png' } } },
      }
    );
    assert.equal(rmsClipboardCopyImageUrl(), '/api/maps/m1/images/001.png');
  });

  test('an image-only node still has a copy payload when text is empty', () => {
    global.document = { querySelector: () => null, activeElement: { tagName: 'BODY' } };
    const { rmsClipboardCopyPayload } = loadFns(
      [
        'apiUrl',
        'nodeImageSrc',
        'openNotesEditorEl',
        'openEditorTextEl',
        'openClipboardTarget',
        'isAppTextField',
        'shouldTakeNodeClipboard',
        'nodeClipboardPlain',
        'editorCopyPayload',
        'editorSelectedText',
        'peekEditReplaceAll',
        'editorClipboardPayload',
        'rmsClipboardCopy',
        'rmsClipboardCopyImageUrl',
        'rmsClipboardCopyPayload',
      ],
      {
        API_BASE: '',
        sel: 'n1',
        map: { id: 'm1', nodes: { n1: { id: 'n1', text: '', image: '001.png' } } },
      }
    );
    const payload = JSON.parse(rmsClipboardCopyPayload());
    assert.equal(payload.text, '');
    assert.equal(payload.image, '/api/maps/m1/images/001.png');
  });
});
