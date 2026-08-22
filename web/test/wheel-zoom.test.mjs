import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const { clampWheelSpeed, wheelZoomFactor } = loadFns([
  'clampWheelSpeed',
  'wheelZoomFactor',
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
