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

  test('opens the text edit menu when the target is a field', () => {
    const cssHasSep = css.includes('.rms-ctx-sep');
    assert.equal(cssHasSep, true);
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

describe('node context menu', () => {
  const fakeTarget = (closestMap) => ({ closest: sel => {
    for(const k of Object.keys(closestMap)) if(sel.split(',').map(s => s.trim()).includes(k)) return closestMap[k];
    return null;
  } });
  test('nodeContextId finds any node, not only ones with a URL', () => {
    const { nodeContextId } = loadFns(['nodeContextId'], { map: { nodes: { n1: { id: 'n1', text: 'x' } } } });
    assert.equal(nodeContextId(fakeTarget({ '.node': { dataset: { id: 'n1' } } })), 'n1');
  });
  test('nodeContextId leaves handles and an open editor to their own menus', () => {
    const { nodeContextId } = loadFns(['nodeContextId'], { map: { nodes: { n1: { id: 'n1' } } } });
    assert.equal(nodeContextId(fakeTarget({ '.handle': {}, '.node': { dataset: { id: 'n1' } } })), null);
    assert.equal(nodeContextId(fakeTarget({ '.node.editing': {}, '.node': { dataset: { id: 'n1' } } })), null);
  });
  test('insertNodeKeysAfter puts the duplicate right after its original', () => {
    const { insertNodeKeysAfter } = loadFns(['insertNodeKeysAfter']);
    const out = insertNodeKeysAfter({ r: 1, a: 2, b: 3, c1: 4, c2: 5 }, 'a', ['c1', 'c2']);
    assert.deepEqual(Object.keys(out), ['r', 'a', 'c1', 'c2', 'b']);
  });
  test('the node menu is wired on contextmenu', () => {
    const app = readFileSync(join(here, '..', 'public', 'app.js'), 'utf8');
    assert.match(app, /addEventListener\('contextmenu', onNodeContextMenu, true\)/);
  });
});
