import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/load-app-fns.mjs';

// showNotesEditor is DOM-heavy; these pin the state rules at the source level.

test('notes save/remove only write when the node still exists and the map is editable', () => {
  const body = extractFunction('showNotesEditor');
  assert.match(body, /const canWrite=\(\)=>!!\(map && map\.nodes\[nodeId\] && !READONLY\);/);
  assert.match(body, /const save=\(\)=>\{\s*if\(!canWrite\(\)\)\{ close\(\); return; \}/);
  assert.match(body, /np-clear'\)\?\.addEventListener\('click',\(\)=>\{\s*if\(!canWrite\(\)\)\{ close\(\); return; \}/);
});

test('Esc with unsaved notes saves instead of discarding', () => {
  const body = extractFunction('showNotesEditor');
  assert.match(body, /if\(sanitizeNotes\(editor\.innerHTML\)!==editor\._initialHTML\) save\(\); else close\(\);/);
});

test('switching or creating a map closes the notes popup before replacing map', () => {
  for (const name of ['loadMap', 'createMap', 'createMapFromTemplate']) {
    const body = extractFunction(name);
    const close = body.indexOf('closeNotesPopup();');
    const swap = body.search(/\bmap\s*=\s*(m|\{)/);
    assert.ok(close > 0, `${name} closes the popup`);
    assert.ok(swap > close, `${name} closes it before swapping the map`);
  }
});
