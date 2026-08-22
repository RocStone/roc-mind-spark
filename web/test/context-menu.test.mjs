import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadFns } from './helpers/load-app-fns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'public', 'styles.css'), 'utf8');
const rms = readFileSync(join(here, '..', 'public', 'rms-settings.js'), 'utf8');
const { suppressNativeContextMenu } = loadFns(['suppressNativeContextMenu']);

describe('closed search wrap', () => {
  test('does not paint a border when collapsed', () => {
    assert.match(css, /\.search-wrap\{[^}]*display:\s*none/);
    assert.match(css, /\.search-wrap\.open\{display:\s*flex\}/);
  });
});

describe('suppressNativeContextMenu', () => {
  test('always preventDefault', () => {
    let prevented = false;
    suppressNativeContextMenu({ preventDefault(){ prevented = true; } });
    assert.equal(prevented, true);
  });
});

describe('rms-settings context menu', () => {
  test('preventDefault runs before the eligible-button check', () => {
    const m = rms.match(/document\.addEventListener\('contextmenu',\s*e=>\{([\s\S]*?)\},\s*true\)/);
    assert.ok(m, 'missing contextmenu listener');
    const body = m[1];
    const preventAt = body.indexOf('e.preventDefault()');
    const eligibleAt = body.indexOf('eligible(');
    assert.ok(preventAt >= 0, 'listener must preventDefault');
    assert.ok(eligibleAt >= 0, 'listener still opens the button shortcut menu');
    assert.ok(preventAt < eligibleAt, 'native menu must be killed even when the click is not on a button');
  });
});
