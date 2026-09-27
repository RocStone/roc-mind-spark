import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';

function swatches(vars){
  global.document = { documentElement: {} };
  global.getComputedStyle = () => ({ getPropertyValue: k => vars[k] || '' });
  const fns = loadFns(['themeCssColor', 'isDarkNodeTheme', 'textColorSwatches', 'pickContrast', 'safeColor'], {
    TEXT_COLORS: extractConst('TEXT_COLORS'),
    SAFE_COLOR_NAMES: extractConst('SAFE_COLOR_NAMES'),
  });
  const out = fns.textColorSwatches();
  delete global.getComputedStyle;
  delete global.document;
  return out;
}

describe('toast duration', () => {
  const { toastDuration } = loadFns(['toastDuration'], { TOAST_ERROR_RE: extractConst('TOAST_ERROR_RE') });
  test('short messages stay at least 2 s, long ones scale up to 8 s', () => {
    assert.equal(toastDuration('Saved'), 2000);
    assert.equal(toastDuration('x'.repeat(100)), 5000);
    assert.equal(toastDuration('x'.repeat(1000)), 8000);
  });
  test('errors stay at least 6 s', () => {
    assert.equal(toastDuration('Copy failed'), 6000);
    assert.equal(toastDuration('无法打开'), 6000);
    assert.equal(toastDuration('Done', 'error'), 6000);
  });
  test('an explicit duration wins', () => {
    assert.equal(toastDuration('Copy failed', 3000), 3000);
  });
});

describe('text colour swatches follow the theme', () => {
  test('light theme keeps the dark ink first', () => {
    assert.equal(swatches({ '--node-bg': '#ffffff', '--node-ink': '#23201b' })[0], '#23201b');
  });
  test('dark theme puts its own node ink first', () => {
    const list = swatches({ '--node-bg': '#2d2d2d', '--node-ink': '#d4d4d4' });
    assert.equal(list[0], '#d4d4d4');
    assert.equal(list.length, extractConst('TEXT_COLORS').length);
  });
});
