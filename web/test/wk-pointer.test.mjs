import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const stage = {
  offsetWidth: 1000,
  offsetHeight: 800,
  getBoundingClientRect: () => ({ left: 40, top: 10, width: 1000, height: 800 }),
};

const { _uiZ, _evtXY, _stagePoint, _stageSize, clientBoxFromGbr } = loadFns(
  ['_uiZ', '_evtXY', '_stagePoint', '_stageSize', 'clientBoxFromGbr'],
  { stage }
);

describe('pointer space is 1 CSS px = 1 mouse px', () => {
  test('_uiZ is identity; display-size tokens are not a coordinate scale', () => {
    assert.equal(_uiZ(), 1);
  });

  test('_evtXY returns clientX/Y unchanged', () => {
    assert.deepEqual(_evtXY({ clientX: 100, clientY: 40 }), {
      x: 100, y: 40, rawX: 100, rawY: 40,
    });
  });

  test('_stagePoint subtracts the stage origin', () => {
    assert.deepEqual(_stagePoint(140, 50), { x: 100, y: 40 });
  });

  test('_stageSize uses offsetWidth, not a zoomed GBR', () => {
    assert.deepEqual(_stageSize(), { w: 1000, h: 800 });
  });

  test('clientBoxFromGbr is the GBR itself', () => {
    assert.deepEqual(
      clientBoxFromGbr({ left: 10, top: 20, width: 30, height: 40 }),
      { x: 10, y: 20, w: 30, h: 40 }
    );
  });
});

describe('uiScaleBootCss', () => {
  const { uiScaleBootCss } = loadFns(['uiScaleBootCss']);

  test('does not scale .app with zoom or transform', () => {
    const css = uiScaleBootCss(0.9, true);
    assert.match(css, /--ui-zoom:\s*0\.9/);
    assert.doesNotMatch(css, /transform:\s*scale/);
    assert.doesNotMatch(css, /\.app\{[^}]*zoom:/);
  });

  test('same token for WK and non-WK', () => {
    assert.equal(uiScaleBootCss(0.9, true), uiScaleBootCss(0.9, false));
  });

  test('identity scale emits nothing', () => {
    assert.equal(uiScaleBootCss(1, true), '');
  });
});
