// Export regressions: Word-export math images and prompt-export variables.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';
import { makeDocument } from './helpers/mini-dom.mjs';

describe('PNG export — table / block nodes draw as a grid, not raw pipes', () => {
  const document = makeDocument();
  const INLINE_HTML_RE = extractConst('INLINE_HTML_RE');
  const ENTITY_RE = extractConst('ENTITY_RE');
  const hasInlineMarkup = t => INLINE_HTML_RE.test(t || '') || ENTITY_RE.test(t || '');
  const { exportNodeBlocks, drawExportBlocks } = loadFns([
    'splitPipeRow', 'isGfmSepLine', 'normalizeTableGrid', 'parseGfmAligns', 'nodeTextForTableScan',
    'splitTextWithGfmTables', 'nodeTextHasGfmTable', 'htmlTableToGrid', 'nodeTextPlain',
    'isSafeLinkUrl', 'sanitizeInlineHTML', 'sanitizeNotes', 'escapeHtml', 'mdInlineToHtml', 'formatNodeTableCell', 'exportNodeBlocks', 'drawExportBlocks',
  ], {
    document, hasInlineMarkup,
    INLINE_HTML_RE, SAFE_TAGS: extractConst('SAFE_TAGS'), DROP_TAGS: extractConst('DROP_TAGS'), NOTES_TAGS: extractConst('NOTES_TAGS'),
  });

  test('GFM text becomes text + table blocks with plain cell text', () => {
    const blocks = exportNodeBlocks({ text: 'Scores\n| Name | **Pts** |\n| :-- | --: |\n| a | 1 |' });
    assert.deepEqual(blocks, [
      { type: 'text', lines: ['Scores'] },
      { type: 'table', grid: { headers: ['Name', 'Pts'], rows: [['a', '1']], aligns: ['left', 'right'] } },
    ]);
  });

  test('n.html table and code blocks', () => {
    assert.deepEqual(exportNodeBlocks({ html: '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>' }),
      [{ type: 'table', grid: { headers: ['A', 'B'], rows: [['1', '2']] } }]);
    assert.deepEqual(exportNodeBlocks({ html: '<pre><code>x = 1\ny = 2</code></pre>' }),
      [{ type: 'text', lines: ['x = 1', 'y = 2'] }]);
  });

  test('ordinary text and dividers are left to the normal path', () => {
    assert.equal(exportNodeBlocks({ text: 'just text' }), null);
    assert.equal(exportNodeBlocks({ hr: true }), null);
  });

  test('drawExportBlocks writes every cell and no pipe characters', () => {
    const drawn = [];
    const ctx = {
      font: '', fillStyle: '', strokeStyle: '', textAlign: '', textBaseline: '', lineWidth: 1,
      save(){}, restore(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){},
      measureText: s => ({ width: String(s).length * 6 }),
      fillText: s => drawn.push(s),
    };
    drawExportBlocks(ctx, exportNodeBlocks({ text: '| A | B |\n| - | - |\n| 1 | 2 |' }),
      { x: 0, y: 0, w: 200, h: 60, fontPx: 15, color: '#000', lineColor: '#ccc', family: 'sans-serif' });
    assert.deepEqual(drawn, ['A', 'B', '1', '2']);
  });
});

describe('exportAsPrompt — map variables beat stale remembered values', () => {
  function harness({ mapVars, saved, found }){
    const calls = { form: null, built: null };
    const store = { ['mindspark:vars:m1']: JSON.stringify(saved) };
    const { exportAsPrompt } = loadFns(['exportAsPrompt'], {
      map: { id: 'm1', rootId: 'r', title: 'T', vars: mapVars },
      sel: null,
      findVariables: () => found,
      buildPrompt: (_id, values) => { calls.built = values; return 'x'; },
      navigator: {},
      download: () => {},
      toast: () => {},
      localStorage: { getItem: k => store[k] ?? null },
      showVariableForm: (_names, defaults) => { calls.form = defaults; },
    });
    exportAsPrompt();
    return calls;
  }

  test('all variables covered by map.vars: map values are used, not remembered ones', () => {
    const c = harness({ mapVars: { topic: 'new' }, saved: { topic: 'old' }, found: ['topic'] });
    assert.deepEqual(c.built, { topic: 'new' });
  });

  test('form defaults: map.vars first, remembered values fill the gaps, blanks ignored', () => {
    const c = harness({ mapVars: { a: 'map', b: '' }, saved: { a: 'old', b: 'remembered', c: '  ' }, found: ['a', 'b', 'c'] });
    assert.deepEqual(c.form, { a: 'map', b: 'remembered' });
  });
});

describe('mathToImgTag — draws onto the canvas it exports', () => {
  test('glyphs land on the output canvas, not the measuring one', () => {
    const base = makeDocument();
    const canvases = [];
    const document = {
      ...base,
      createElement(tag){
        if(tag !== 'canvas') return base.createElement(tag);
        const cv = { width: 0, height: 0, fills: [] };
        cv.getContext = () => ({
          font: '', fillStyle: '', textBaseline: '', textAlign: '',
          measureText: s => ({ width: String(s).length * 8 }),
          save(){}, restore(){}, scale(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){},
          fillText: (s) => cv.fills.push(s),
        });
        cv.toDataURL = () => 'data:image/png;base64,' + (cv.fills.length ? 'DRAWN' : 'BLANK');
        canvases.push(cv);
        return cv;
      },
    };
    const { mathToImgTag } = loadFns(['_layoutMath', 'escapeHtml', 'mathToImgTag'], {
      document,
      latexToMathML: () => '<math><mi>x</mi><mo>+</mo><mn>1</mn></math>',
    });
    const tag = mathToImgTag('x+1', 16, '#000');
    assert.ok(tag, 'returns an <img> tag');
    assert.match(tag, /DRAWN/, 'the exported data URL comes from a canvas that was drawn on');
    const out = canvases[canvases.length - 1];
    assert.deepEqual(out.fills, ['x', '+', '1']);
  });
});
