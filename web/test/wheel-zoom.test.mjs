import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const { clampWheelSpeed, wheelZoomFactor, mapViewRect, nodeOutsideRect } = loadFns([
  'clampWheelSpeed',
  'wheelZoomFactor',
  'mapViewRect',
  'nodeOutsideRect',
], {
  WHEEL_ZOOM_IN: 1.12,
  WHEEL_ZOOM_OUT: 0.89,
  WHEEL_SPEED_DEFAULT: 40,
});

describe('clampWheelSpeed', () => {
  test('keeps 0–100 and rounds', () => {
    assert.equal(clampWheelSpeed(0), 0);
    assert.equal(clampWheelSpeed(100), 100);
    assert.equal(clampWheelSpeed(40.4), 40);
    assert.equal(clampWheelSpeed(40.6), 41);
  });

  test('out of range and junk fall back', () => {
    assert.equal(clampWheelSpeed(-12), 0);
    assert.equal(clampWheelSpeed(180), 100);
    assert.equal(clampWheelSpeed(NaN), 40);
    assert.equal(clampWheelSpeed(undefined), 40);
  });
});

describe('wheelZoomFactor', () => {
  test('100% matches the historical step', () => {
    assert.equal(wheelZoomFactor(-1, 100), 1.12);
    assert.equal(wheelZoomFactor(1, 100), 0.89);
  });

  test('0% does not change zoom', () => {
    assert.equal(wheelZoomFactor(-1, 0), 1);
    assert.equal(wheelZoomFactor(1, 0), 1);
  });

  test('40% is a linear fraction of the historical step', () => {
    assert.ok(Math.abs(wheelZoomFactor(-1, 40) - (1 + 0.12 * 0.4)) < 1e-12);
    assert.ok(Math.abs(wheelZoomFactor(1, 40) - (1 - 0.11 * 0.4)) < 1e-12);
  });
});

describe('mapViewRect / nodeOutsideRect', () => {
  test('identity view covers the stage in map space', () => {
    const r=mapViewRect({x:0,y:0,k:1}, 800, 600, 0);
    assert.equal(r.x0+0, 0);
    assert.equal(r.y0+0, 0);
    assert.equal(r.x1, 800);
    assert.equal(r.y1, 600);
  });

  test('pad expands the cull window', () => {
    const r=mapViewRect({x:0,y:0,k:1}, 100, 100, 10);
    assert.equal(r.x0, -10);
    assert.equal(r.x1, 110);
  });

  test('zoomed-out view covers more map space', () => {
    const r=mapViewRect({x:0,y:0,k:0.5}, 200, 200, 0);
    assert.equal(r.x1, 400);
    assert.equal(r.y1, 400);
  });

  test('node entirely left of the window is outside', () => {
    const r=mapViewRect({x:0,y:0,k:1}, 400, 400, 0);
    assert.equal(nodeOutsideRect({x:-200,y:0,w:50,h:40}, r), true);
    assert.equal(nodeOutsideRect({x:10,y:10,w:50,h:40}, r), false);
  });
});
