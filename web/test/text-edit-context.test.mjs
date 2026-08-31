import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns } from './helpers/load-app-fns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(here, '..', 'public', 'styles.css'), 'utf8');

describe('md drag-select geometry', () => {
  const { mdColAtWidth, mdIndexAtLineCol } = loadFns(['mdColAtWidth', 'mdIndexAtLineCol']);
  test('col is the last prefix not wider than x', () => {
    const widthOf = s => s.length * 10;
    assert.equal(mdColAtWidth('abcd', 0, widthOf), 0);
    assert.equal(mdColAtWidth('abcd', 10, widthOf), 1);
    assert.equal(mdColAtWidth('abcd', 25, widthOf), 2);
    assert.equal(mdColAtWidth('abcd', 40, widthOf), 4);
  });
  test('index stacks line lengths plus newlines', () => {
    assert.equal(mdIndexAtLineCol(['ab', 'cd'], 1, 1), 4);
    assert.equal(mdIndexAtLineCol(['ab', 'cd'], 0, 2), 2);
  });
});

describe('mdHighlight fold marker', () => {
  test('fold count is a data-fold attribute, not extra text', () => {
    const view = {
      visLineToFull: [0],
      foldInfo: new Map([[0, { start: 0, end: 4, count: 3 }]]),
      fullLines: ['# a', 'b', 'c', 'd'],
    };
    const { mdHighlight, _hlLine } = loadFns(['_hlLine', 'mdHighlight']);
    void _hlLine;
    const html = mdHighlight('# a', view);
    assert.match(html, /data-fold="3"/);
    assert.doesNotMatch(html, /md-fold-chip/);
  });
});

describe('mdLineColFromPos', () => {
  const { mdLineColFromPos } = loadFns(['mdLineColFromPos']);

  test('counts lines and columns from a cold start', () => {
    assert.deepEqual(mdLineColFromPos('ab\ncd\nef', 0, null), { line: 0, col: 0 });
    assert.deepEqual(mdLineColFromPos('ab\ncd\nef', 2, null), { line: 0, col: 2 });
    assert.deepEqual(mdLineColFromPos('ab\ncd\nef', 3, null), { line: 1, col: 0 });
    assert.deepEqual(mdLineColFromPos('ab\ncd\nef', 8, null), { line: 2, col: 2 });
  });

  test('walks a cache forward and backward without recounting the whole prefix', () => {
    const cache = { pos: -1, line: 0 };
    const text = 'aa\nbb\ncc\ndd';
    assert.deepEqual(mdLineColFromPos(text, 7, cache), { line: 2, col: 1 });
    assert.equal(cache.pos, 7);
    assert.equal(cache.line, 2);
    assert.deepEqual(mdLineColFromPos(text, 9, cache), { line: 3, col: 0 });
    assert.deepEqual(mdLineColFromPos(text, 3, cache), { line: 1, col: 0 });
  });
});

describe('textEditContextTarget', () => {
  const { textEditContextTarget } = loadFns(['textEditContextTarget']);

  test('hits a textarea, input, and contenteditable', () => {
    const ta = { closest(sel){ return String(sel).includes('textarea') ? this : null; } };
    const inp = { closest(sel){ return String(sel).includes('input') ? this : null; } };
    const ed = { closest(sel){ return String(sel).includes('contenteditable') ? this : null; } };
    assert.equal(textEditContextTarget(ta), ta);
    assert.equal(textEditContextTarget(inp), inp);
    assert.equal(textEditContextTarget(ed), ed);
  });

  test('ignores chrome and empty targets', () => {
    const chrome = { closest(sel){ return String(sel).includes('.rms-ctx') ? this : null; } };
    assert.equal(textEditContextTarget(chrome), null);
    assert.equal(textEditContextTarget(null), null);
  });
});

describe('Markdown / field clipboard', () => {
  test('copy and paste use the focused textarea selection, not the whole file', () => {
    const ed = {
      tagName: 'TEXTAREA',
      id: 'mdEditor',
      value: 'hello world',
      selectionStart: 6,
      selectionEnd: 11,
      closest(){ return null; },
      focus(){},
      setSelectionRange(a, b){ this.selectionStart = a; this.selectionEnd = b; },
      dispatchEvent(){ return true; },
    };
    global.document = { activeElement: ed, querySelector: () => null };
    const {
      fieldSelectedText,
      focusedValueField,
      rmsClipboardCopy,
      rmsClipboardPaste,
      overlayTextFieldOwnsClipboard,
    } = loadFns(
      [
        'isAppTextField',
        'isValueTextField',
        'focusedValueField',
        'fieldSelectedText',
        'openOverlayTextField',
        'overlayTextFieldOwnsClipboard',
        'openNotesEditorEl',
        'openEditorTextEl',
        'openClipboardTarget',
        'insertFieldText',
        'emitEditorInput',
        'editorSelectedText',
        'editorCopyPayload',
        'peekEditReplaceAll',
        'shouldTakeNodeClipboard',
        'nodeClipboardPlain',
        'editorClipboardPayload',
        'rmsClipboardCopy',
        'rmsClipboardPaste',
      ],
      { READONLY: false }
    );
    assert.equal(focusedValueField(), ed);
    assert.equal(fieldSelectedText(ed), 'world');
    assert.equal(rmsClipboardCopy(), 'world');
    assert.equal(overlayTextFieldOwnsClipboard(), true);
    assert.equal(rmsClipboardPaste('there'), true);
    assert.equal(ed.value, 'hello there');
  });

  test('cut deletes only the selected span', () => {
    const ed = {
      tagName: 'TEXTAREA',
      value: 'hello world',
      selectionStart: 0,
      selectionEnd: 5,
      closest(){ return null; },
      setSelectionRange(a, b){ this.selectionStart = a; this.selectionEnd = b; },
      dispatchEvent(){ return true; },
    };
    global.document = { activeElement: ed, querySelector: () => null };
    const { rmsClipboardCut } = loadFns(
      [
        'isAppTextField',
        'isValueTextField',
        'focusedValueField',
        'fieldSelectedText',
        'fieldCutSelected',
        'openOverlayTextField',
        'openNotesEditorEl',
        'openEditorTextEl',
        'openClipboardTarget',
        'emitEditorInput',
        'editorSelectedText',
        'editorCopyPayload',
        'peekEditReplaceAll',
        'shouldTakeNodeClipboard',
        'nodeClipboardPlain',
        'editorClipboardPayload',
        'rmsClipboardCopy',
        'rmsClipboardCut',
      ]
    );
    assert.equal(rmsClipboardCut(), 'hello');
    assert.equal(ed.value, ' world');
  });
});

describe('click-and-drag selection hot path', () => {
  test('mousemove returns before _evtXY unless a canvas gesture is live', () => {
    assert.match(
      src,
      /window\.addEventListener\('mousemove',e=>\{\s*if\(!marquee && !panning && !resizing && !dragNode\) return;/
    );
  });

  test('a markdown click does not rebuild the highlight overlay', () => {
    assert.match(src, /ed\.addEventListener\('click',\s*\(\)=>\{\s*mdUpdateActive\(\);\s*syncNodeFromCaret\(\);/);
    assert.doesNotMatch(
      src,
      /ed\.addEventListener\('click',\s*\(\)=>\{\s*mdRefreshDecorations\(\)/
    );
  });

  test('WK node editor sits on #stage, outside #viewport canvas transform', () => {
    assert.match(src, /\(stage\|\|document\.body\)\.appendChild\(float\)/);
    assert.match(css, /\.edit-float\{[^}]*position:\s*absolute/);
    assert.match(css, /\.edit-float\{[^}]*transform:\s*none/);
    assert.match(src, /float\.style\.transform='none'/);
    assert.doesNotMatch(src, /class="md-gutter"/);
  });

  test('Markdown drag-select is native selection on contenteditable colored text', () => {
    assert.match(src, /<pre id="mdEditor"/);
    assert.match(src, /id="mdSelLayer"/);
    assert.match(src, /id="mdEditor"[^>]*contenteditable="true"/);
    assert.doesNotMatch(src, /<textarea id="mdEditor"/);
    assert.doesNotMatch(css, /#mdPane\.md-selecting/);
    assert.match(css, /#mdEditor::selection\{[^}]*background:/);
    assert.doesNotMatch(css, /#mdEditor\{[^}]*color:\s*transparent/);
  });

  test('display-size tokens are not a pointer scale', () => {
    assert.match(src, /function _uiZ\(\)\{\s*return 1;/);
    assert.doesNotMatch(src, /function _calibratePointer/);
    assert.doesNotMatch(src, /function _cssZoom/);
  });

  test('Markdown editor is a grid pane, not a body-fixed portal', () => {
    assert.match(src, /app\.insertBefore\(pane, stage\)/);
    assert.doesNotMatch(src, /slot\.id='mdSlot'/);
    assert.match(css, /#mdPane\{[^}]*position:\s*relative/);
  });
});

describe('text edit context menu', () => {
  test('right-click on a field still preventDefault, then opens the edit menu', () => {
    assert.match(src, /function suppressNativeContextMenu\(e\)\{/);
    assert.match(src, /showTextEditContextMenu\(e\)/);
    assert.match(src, /item\('cut'/);
    assert.match(src, /item\('copy'/);
    assert.match(src, /item\('paste'/);
    assert.match(src, /item\('undo'/);
    assert.match(src, /nativeEditAction\(act\)/);
  });
});
