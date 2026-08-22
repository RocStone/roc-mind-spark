// Pure functions lifted out of the REAL public/app.js (see helpers/load-app-fns.mjs).
// app.js is a browser script with no exports, so these are read from source
// rather than imported — which means renaming or deleting one of them fails
// here loudly instead of silently passing against a stale copy.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

const { prettyUrl, pickContrast, escapeHtml, shade, edgePath, shouldShowNodeTokenBadge, canvasGestureBlocksTextSelection, resolveHistoryChordTarget, isNodeDoubleClick, shouldStartNodeDrag, shouldIgnoreTransientToolbarClick, shouldCloseNotesOnPointerLeave, notesPopupPosition } =
  loadFns(['prettyUrl', 'pickContrast', 'escapeHtml', 'shade', 'edgePath', 'shouldShowNodeTokenBadge', 'canvasGestureBlocksTextSelection', 'resolveHistoryChordTarget', 'isNodeDoubleClick', 'shouldStartNodeDrag', 'shouldIgnoreTransientToolbarClick', 'shouldCloseNotesOnPointerLeave', 'notesPopupPosition']);
const URL_RE = extractConst('URL_RE');

describe('prettyUrl — shortens link labels for display', () => {
  test('drops the scheme and a www. prefix', () => {
    assert.equal(prettyUrl('https://www.example.com'), 'example.com');
  });

  test('keeps a meaningful path but drops a trailing slash', () => {
    assert.equal(prettyUrl('https://example.com/docs/'), 'example.com/docs');
  });

  test('drops a bare root path entirely', () => {
    assert.equal(prettyUrl('https://prism.openai.com/'), 'prism.openai.com');
  });

  test('truncates very long labels with an ellipsis', () => {
    const label = prettyUrl('https://example.com/' + 'x'.repeat(120));
    assert.ok(label.length <= 44, `expected <= 44 chars, got ${label.length}`);
    assert.ok(label.endsWith('\u2026'), 'long labels end with an ellipsis');
  });

  test('returns the input unchanged when it is not a parseable URL', () => {
    assert.equal(prettyUrl('not a url'), 'not a url');
  });
});

describe('URL_RE — raw URL detection', () => {
  const matches = s => { URL_RE.lastIndex = 0; return s.match(URL_RE) || []; };

  test('finds a bare URL', () => {
    assert.deepEqual(matches('see https://example.com now'), ['https://example.com']);
  });

  test('finds several URLs in one string', () => {
    assert.equal(matches('https://a.com and https://b.com').length, 2);
  });

  test('matches http as well as https', () => {
    assert.equal(matches('http://example.com').length, 1);
  });

  test('does not match plain text without a scheme', () => {
    assert.equal(matches('example.com is not matched').length, 0);
  });

  test('stops at a closing paren so markdown-style links do not over-capture', () => {
    assert.deepEqual(matches('(https://example.com)'), ['https://example.com']);
  });
});

describe('pickContrast — readable text colour for a given background', () => {
  test('dark text on a light background', () => {
    assert.equal(pickContrast('#ffffff'), '#23201b');
    assert.equal(pickContrast('#cfe0ee'), '#23201b', 'the pastel node palette pairs with dark text');
  });

  test('light text on a dark background', () => {
    assert.equal(pickContrast('#000000'), '#ffffff');
    assert.equal(pickContrast('#23201b'), '#ffffff');
  });

  test('falls back to dark text for malformed input rather than throwing', () => {
    assert.equal(pickContrast(''), '#23201b');
    assert.equal(pickContrast(null), '#23201b');
    assert.equal(pickContrast('#abc'), '#23201b');
  });

  test('weights green more heavily than blue (per-channel luminance, not a plain average)', () => {
    // Same numeric value in the dominant channel, opposite results: green-dominant
    // #40ff40 lands at L=0.691 (dark text), blue-dominant #4040ff at L=0.336
    // (light text). A naive (r+g+b)/3 average would score both identically.
    assert.equal(pickContrast('#40ff40'), '#23201b', 'green-dominant reads as light');
    assert.equal(pickContrast('#4040ff'), '#ffffff', 'blue-dominant reads as dark');
  });
});

describe('escapeHtml', () => {
  test('escapes the characters that could break out of markup', () => {
    assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
    assert.equal(escapeHtml('a & b'), 'a &amp; b');
    assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
  });

  test('handles null and undefined without throwing', () => {
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
  });

  test('leaves ordinary text untouched', () => {
    assert.equal(escapeHtml('plain text 123'), 'plain text 123');
  });
});

describe('shade — lighten/darken a hex colour', () => {
  test('lightens with a positive amount and darkens with a negative one', () => {
    assert.notEqual(shade('#808080', 40), '#808080');
    assert.equal(shade('#808080', 0), '#808080');
  });

  test('clamps at white and black instead of wrapping around', () => {
    assert.equal(shade('#ffffff', 50), '#ffffff', 'must not overflow past white');
    assert.equal(shade('#000000', -50), '#000000', 'must not underflow past black');
  });

  test('always returns a full 6-digit hex colour', () => {
    for (const [c, amt] of [['#010101', -10], ['#fefefe', 10], ['#123456', 25]]) {
      assert.match(shade(c, amt), /^#[0-9a-f]{6}$/, `${c} @ ${amt}`);
    }
  });
});

describe('shouldCloseNotesOnPointerLeave', () => {
  test('hover preview closes; a clicked note stays', () => {
    assert.equal(shouldCloseNotesOnPointerLeave(false), true);
    assert.equal(shouldCloseNotesOnPointerLeave(true), false);
  });
});

describe('notesPopupPosition', () => {
  const popup = { w:340, h:220 };
  const view  = { w:1200, h:800 };

  test('sits to the right of the 📝 when there is room', () => {
    const p = notesPopupPosition({left:100, right:122, top:200, bottom:222}, popup, view, 8);
    assert.equal(p.left, 130);
    assert.equal(p.top, 200);
  });

  test('flips to the left when the right edge would clip', () => {
    const p = notesPopupPosition({left:1100, right:1122, top:40, bottom:62}, popup, view, 8);
    assert.equal(p.left, 1100-340-8);
    assert.equal(p.top, 40);
  });

  test('keeps the box inside the viewport', () => {
    const p = notesPopupPosition({left:4, right:26, top:700, bottom:722}, popup, view, 8);
    assert.ok(p.left >= 8);
    assert.ok(p.top + popup.h <= view.h - 8);
  });
});

describe('shouldShowNodeTokenBadge', () => {
  test('never shows the per-node ~Nt corner count', () => {
    assert.equal(shouldShowNodeTokenBadge(57, true), false);
    assert.equal(shouldShowNodeTokenBadge(80, true), false);
    assert.equal(shouldShowNodeTokenBadge(57, false), false);
    assert.equal(shouldShowNodeTokenBadge(10, false), false);
  });

  test('does not mount a token-badge or PNG ~Nt pill', () => {
    const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.equal(src.includes('token-badge'), false);
    assert.equal(src.includes("'~'+tokens+'t'"), false);
    assert.equal(src.includes('~${tokens}t'), false);
  });
});

describe('canvasGestureBlocksTextSelection', () => {
  test('blocks native text selection while dragging or dropping on a sibling', () => {
    assert.equal(canvasGestureBlocksTextSelection({dragNode: 'n1'}), true);
    assert.equal(canvasGestureBlocksTextSelection({marquee: {}}), true);
    assert.equal(canvasGestureBlocksTextSelection({resizing: {}}), true);
    assert.equal(canvasGestureBlocksTextSelection({panning: true}), true);
  });

  test('leaves text selectable while editing a node', () => {
    assert.equal(canvasGestureBlocksTextSelection({editing: true, dragNode: 'n1'}), false);
    assert.equal(canvasGestureBlocksTextSelection({}), false);
    assert.equal(canvasGestureBlocksTextSelection(null), false);
  });
});

describe('resolveHistoryChordTarget', () => {
  test('map undo when not editing', () => {
    assert.equal(resolveHistoryChordTarget({}), 'map');
    assert.equal(resolveHistoryChordTarget(null), 'map');
    assert.equal(resolveHistoryChordTarget({editing: true, typed: false}), 'map');
  });

  test('editor undo only after the user has typed in this session', () => {
    assert.equal(resolveHistoryChordTarget({editing: true, typed: true}), 'editor');
    assert.equal(resolveHistoryChordTarget({notesOpen: true, typed: false}), 'editor');
  });
});

describe('double-click vs drag / toolbar', () => {
  test('second click on the same node within the window is a double-click', () => {
    assert.equal(isNodeDoubleClick({id: 'n1', t: 1000}, 'n1', 1200, 450), true);
    assert.equal(isNodeDoubleClick({id: 'n1', t: 1000}, 'n1', 1600, 450), false);
    assert.equal(isNodeDoubleClick({id: 'n1', t: 1000}, 'n2', 1100, 450), false);
    assert.equal(isNodeDoubleClick(null, 'n1', 1100, 450), false);
  });

  test('the second click of a double-click does not start a drag', () => {
    assert.equal(shouldStartNodeDrag(1), true);
    assert.equal(shouldStartNodeDrag(2), false);
  });

  test('toolbar ignores the click that is actually a double-click', () => {
    assert.equal(shouldIgnoreTransientToolbarClick(2, 1300, 1000, 450), true);
    assert.equal(shouldIgnoreTransientToolbarClick(1, 1100, 1000, 450), true);
    assert.equal(shouldIgnoreTransientToolbarClick(1, 2000, 1000, 450), false);
  });
});

describe('edgePath — branch geometry per map style', () => {
  const args = (style, horizontal = true) => edgePath(0, 0, 100, 50, false, horizontal, style);

  test('sketch draws a straight line', () => {
    assert.equal(args('sketch'), 'M0,0 L100,50');
  });

  test('classic draws right-angle elbows', () => {
    const p = args('classic');
    assert.ok(p.includes('L'), 'uses line segments');
    assert.ok(!p.includes('C'), 'classic must not emit a bezier curve');
  });

  test('modern draws a bezier curve', () => {
    assert.ok(args('modern').includes('C'));
  });

  test('bubble uses the same path shape as modern (CSS makes it thicker)', () => {
    assert.equal(args('bubble'), args('modern'));
  });

  test('an unknown style falls back to the modern curve rather than producing nothing', () => {
    assert.equal(args('no-such-style'), args('modern'));
  });

  test('every style produces a path starting at the given origin', () => {
    for (const s of ['sketch', 'classic', 'modern', 'bubble']) {
      assert.match(args(s), /^M0,0/, `style ${s}`);
    }
  });

  test('vertical layout produces a different path than horizontal', () => {
    assert.notEqual(args('classic', false), args('classic', true));
  });
});
