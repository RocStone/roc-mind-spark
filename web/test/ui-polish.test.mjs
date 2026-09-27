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
