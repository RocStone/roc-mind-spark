import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const { _uiZResolve, _choosePointerScale, _evtXY, _cssZoom } = loadFns(
  ['_uiZResolve', '_choosePointerScale', '_evtXY', '_calibratePointer', '_cssZoom', '_uiZ'],
  {
    document: {
      documentElement: { style: { zoom: '', getPropertyValue: (k) => k==='--ui-zoom' ? '0.9' : '' }, classList: { contains: () => true } },
      querySelector: (sel) => sel==='.app' ? { style: { zoom: '', transform: 'scale(0.9)' } } : null,
      getElementById: () => null,
      addEventListener: () => {},
    },
    stage: undefined,
    _rzCache: null,
    _ptrMul: 1,
  }
);

describe('_uiZResolve', () => {
  test('prefers on-screen stage visual/layout ratio', () => {
    assert.ok(Math.abs(_uiZResolve({
      stageRectWidth: 1116, stageOffsetWidth: 1240, probeWidth: 100, cssZoom: 0.9,
    }) - 0.9) < 0.01);
  });

  test('ignores a lying 100px off-screen probe when CSS zoom is 0.9', () => {
    assert.equal(_uiZResolve({
      stageRectWidth: 0, stageOffsetWidth: 0, probeWidth: 100, cssZoom: 0.9,
    }), 0.9);
  });

  test('trusts a real probe when it matches zoom', () => {
    assert.equal(_uiZResolve({
      stageRectWidth: 0, stageOffsetWidth: 0, probeWidth: 90, cssZoom: 0.9,
    }), 0.9);
  });
});

describe('_choosePointerScale', () => {
  test('picks 1 when clientX already sits in the visual rect', () => {
    const rect={left:180, right:280, top:80, bottom:140, width:100, height:60};
    assert.equal(_choosePointerScale(230, 110, rect, 0.9, 0.9), 1);
  });

  test('picks zoom when only clientX*z sits in the visual rect', () => {
    const rect={left:180, right:280, top:80, bottom:140, width:100, height:60};
    assert.equal(_choosePointerScale(230/0.9, 110/0.9, rect, 0.9, 0.9), 0.9);
  });

  test('a click on the left edge under 90% UI scale stays at 1, not 1/0.9', () => {
    const rect={left:180, right:280, top:80, bottom:140, width:100, height:60};
    assert.equal(_choosePointerScale(185, 110, rect, 0.9, 0.9), 1);
  });
});

describe('_evtXY with a locked multiplier', () => {
  test('applies the calibrated multiplier', () => {
    const p=_evtXY({clientX:100, clientY:40});
    assert.equal(p.x, 100);
    assert.equal(p.rawX, 100);
  });
});

describe('_cssZoom', () => {
  test('reads --ui-zoom from the document element', () => {
    assert.equal(_cssZoom(), 0.9);
  });
});
