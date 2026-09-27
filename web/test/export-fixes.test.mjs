// Export regressions: Word-export math images and prompt-export variables.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';
import { makeDocument } from './helpers/mini-dom.mjs';

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
