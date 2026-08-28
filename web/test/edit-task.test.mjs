// Editing a node and clicking ☑ (cycleTask) used to rebuild the card from
// the *old* n.text, because the toolbar is edit-session chrome and does not
// blur-commit. The live editor has to be flushed onto the model first.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const INLINE_HTML_RE = extractConst('INLINE_HTML_RE');

const { captureNodeEditText, applyNodeEditCapture } = loadFns(
  ['captureNodeEditText', 'applyNodeEditCapture'],
  { INLINE_HTML_RE, sanitizeInlineHTML: html => html }
);

describe('captureNodeEditText — live editor → model payload', () => {
  test('plain typing is stored as plain text', () => {
    const cap = captureNodeEditText({ innerHTML: 'buy milk', textContent: 'buy milk' });
    assert.equal(cap.text, 'buy milk');
    assert.equal(cap.image, null);
    assert.equal(cap.clearImage, true);
  });

  test('empty editor becomes an empty string; apply fills in Untitled', () => {
    const cap = captureNodeEditText({ innerHTML: '', textContent: '' });
    assert.equal(cap.text, '');
    const n = { text: 'old' };
    applyNodeEditCapture(n, cap);
    assert.equal(n.text, 'Untitled');
  });

  test('image markdown is pulled out of the caption', () => {
    const cap = captureNodeEditText({
      innerHTML: 'cover  ![alt](https://example.com/x.png)',
      textContent: 'cover  ![alt](https://example.com/x.png)',
    });
    assert.equal(cap.text, 'cover');
    assert.equal(cap.image, 'https://example.com/x.png');
    assert.equal(cap.imageAlt, 'alt');
    assert.equal(cap.clearImage, false);
  });

  test('a double-escaped entity is restored', () => {
    const cap = captureNodeEditText({ innerHTML: '&amp;rarr;', textContent: '&rarr;' });
    assert.equal(cap.text, '&rarr;');
  });
});

describe('applyNodeEditCapture', () => {
  test('writes the captured text and stamps updated', () => {
    const n = { text: 'old' };
    applyNodeEditCapture(n, captureNodeEditText({ innerHTML: 'new', textContent: 'new' }));
    assert.equal(n.text, 'new');
    assert.equal(typeof n.updated, 'number');
  });

  test('keeps a file-backed image when the caption has no markdown', () => {
    const n = { text: 'cap', image: '001.png', imageAlt: 'old' };
    applyNodeEditCapture(n, captureNodeEditText({ innerHTML: 'just text', textContent: 'just text' }));
    assert.equal(n.text, 'just text');
    assert.equal(n.image, '001.png');
    assert.equal(n.imageAlt, 'old');
  });

  test('still picks up a new ![alt](src) typed into the caption', () => {
    const n = { text: 'cap', image: '001.png' };
    applyNodeEditCapture(n, captureNodeEditText({
      innerHTML: 'cover ![a](https://example.com/x.png)',
      textContent: 'cover ![a](https://example.com/x.png)',
    }));
    assert.equal(n.text, 'cover');
    assert.equal(n.image, 'https://example.com/x.png');
    assert.equal(n.imageAlt, 'a');
  });
});

describe('cycleTask while a node is being edited', () => {
  test('keeps the typed draft and still advances todo → doing', () => {
    const textEl = { innerHTML: 'typed draft', textContent: 'typed draft' };
    const classes = new Set(['node', 'editing']);
    const el = {
      dataset: { id: 'n1' },
      classList: {
        contains: c => classes.has(c),
        remove: (...cs) => cs.forEach(c => classes.delete(c)),
      },
      querySelector: sel => sel === '.node-text' ? textEl : null,
    };
    const map = { nodes: { n1: { text: 'old title' } }, rootId: 'root' };
    const titleField = { value: '' };
    let history = 0;
    let renders = 0;
    global.document = { querySelector: sel => sel === '.node.editing' ? el : null };

    const { cycleTask } = loadFns(
      ['captureNodeEditText', 'applyNodeEditCapture', 'syncAutoTitleFromRoot', 'editFloatLiveTextEl', 'flushOpenEditToModel', 'cycleTask'],
      {
        map,
        INLINE_HTML_RE,
        sanitizeInlineHTML: html => html,
        $: sel => sel === '#mapTitle' ? titleField : null,
        refreshList(){},
        pushHistory(){ history++; },
        render(){ renders++; },
      }
    );

    cycleTask('n1');

    assert.equal(map.nodes.n1.text, 'typed draft', 'in-progress text must survive the task toggle');
    assert.equal(map.nodes.n1.task, 'todo');
    assert.equal(history, 1);
    assert.equal(renders, 1);
    assert.equal(classes.has('editing'), false);
  });

  test('a node that is not being edited still cycles and keeps its stored text', () => {
    const map = { nodes: { n1: { text: 'kept', task: 'todo' } }, rootId: 'root' };
    global.document = { querySelector: () => null };
    const { cycleTask } = loadFns(
      ['captureNodeEditText', 'applyNodeEditCapture', 'syncAutoTitleFromRoot', 'editFloatLiveTextEl', 'flushOpenEditToModel', 'cycleTask'],
      {
        map,
        INLINE_HTML_RE,
        sanitizeInlineHTML: html => html,
        $: () => null,
        refreshList(){},
        pushHistory(){},
        render(){},
      }
    );
    cycleTask('n1');
    assert.equal(map.nodes.n1.text, 'kept');
    assert.equal(map.nodes.n1.task, 'doing');
  });
});
