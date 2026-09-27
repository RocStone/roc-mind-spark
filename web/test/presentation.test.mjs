import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractFunction } from './helpers/load-app-fns.mjs';

function keyEvent(key) {
  return {
    key, prevented: 0, stopped: 0,
    preventDefault() { this.prevented++; },
    stopPropagation() { this.stopped++; },
  };
}

test('presKey swallows editing keys so the map cannot change underneath', () => {
  const steps = [];
  const { presKey } = loadFns(['presKey'], {
    _pres: { order: ['r'], idx: 0 },
    presStep: d => steps.push(d),
    endPresentation() {},
  });
  for (const k of ['Backspace', 'Tab', 'a', 'Enter', 'Delete']) {
    const e = keyEvent(k);
    presKey(e);
    assert.equal(e.prevented, 1, k);
    assert.equal(e.stopped, 1, k);
  }
  assert.deepEqual(steps, []);
  presKey(keyEvent('ArrowRight'));
  assert.deepEqual(steps, [1]);
});

test('presentation layout never persists and start is not re-entrant', () => {
  const start = extractFunction('startPresentation');
  const end = extractFunction('endPresentation');
  assert.match(start, /^function startPresentation\(\)\{\s*if\(_pres\) return;/);
  assert.match(start, /autoLayout\(false, \{persist:false\}\)/);
  assert.match(end, /autoLayout\(false, \{persist:false\}\)/);
});
