import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'rms-settings.js'),
  'utf8'
);

test('⌘, is reserved and must not become the overlay toggle', () => {
  const m = src.match(/function isReservedToggleSpec\(spec\)\{[\s\S]*?\n  \}/);
  assert.ok(m, 'isReservedToggleSpec() must exist in rms-settings.js');
  assert.match(src, /op:'listenToggle'/);
  const fn = new Function(`${m[0]}; return isReservedToggleSpec;`)();
  assert.equal(fn({ key:',', code:'Comma', meta:true, ctrl:false, alt:false, shift:false }), true);
  assert.equal(fn({ key:'q', code:'KeyQ', meta:true, ctrl:true, alt:true, shift:true }), false);
});
