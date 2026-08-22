import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatOp,
  appendOps,
  tailLines,
  maybeRotateOpsLog,
} from '../ops-log.js';

describe('formatOp', () => {
  test('writes a short one-line record', () => {
    const line = formatOp({
      t: Date.parse('2026-08-22T15:04:41.000Z'),
      op: 'edit',
      map: 'abc',
      id: 'n1',
      text: '不要 Readout，直接 Embedding 做混合 and then a lot more text that should be clipped',
    });
    assert.match(line, /^2026-08-22T15:04:41.000Z edit /);
    assert.match(line, /map=abc/);
    assert.match(line, /id=n1/);
    assert.ok(line.length <= 240);
    assert.ok(!line.includes('\n'));
  });

  test('drops junk input', () => {
    assert.equal(formatOp(null), '');
    assert.equal(formatOp('x'), '');
  });
});

describe('tailLines', () => {
  test('keeps the last N lines and a trailing newline', () => {
    assert.equal(tailLines('a\nb\nc\n', 2), 'b\nc\n');
    assert.equal(tailLines('a\nb\nc', 2), 'b\nc\n');
    assert.equal(tailLines('', 100), '');
  });
});

describe('maybeRotateOpsLog', () => {
  function tmpLog() {
    const dir = mkdtempSync(join(tmpdir(), 'ops-log-'));
    return join(dir, 'ops.log');
  }

  test('does nothing when the last check was less than 7 days ago', () => {
    const file = tmpLog();
    writeFileSync(file, 'old\n');
    const now = Date.parse('2026-08-22T00:00:00Z');
    writeFileSync(file + '.meta.json', JSON.stringify({ lastCheck: now - 1000 }));
    const r = maybeRotateOpsLog({ logPath: file, now, maxBytes: 1, keepLines: 1 });
    assert.equal(r.skipped, true);
    assert.equal(readFileSync(file, 'utf8'), 'old\n');
  });

  test('leaves a small file intact after the 7-day check', () => {
    const file = tmpLog();
    writeFileSync(file, 'keep-me\n');
    const now = Date.parse('2026-08-22T00:00:00Z');
    const r = maybeRotateOpsLog({
      logPath: file, now, force: true, maxBytes: 10 * 1024 * 1024, keepLines: 100
    });
    assert.equal(r.rotated, false);
    assert.equal(readFileSync(file, 'utf8'), 'keep-me\n');
  });

  test('when over the size cap, keeps only the last 100 lines', () => {
    const file = tmpLog();
    const lines = [];
    for (let i = 1; i <= 130; i++) lines.push('line-' + String(i).padStart(3, '0'));
    writeFileSync(file, lines.join('\n') + '\n');
    // Force the size check regardless of the 7-day gate, with a tiny cap.
    const r = maybeRotateOpsLog({
      logPath: file,
      now: Date.now(),
      force: true,
      maxBytes: 10,
      keepLines: 100
    });
    assert.equal(r.rotated, true);
    assert.equal(r.kept, 100);
    const kept = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(kept.length, 100);
    assert.equal(kept[0], 'line-031');
    assert.equal(kept[99], 'line-130');
    assert.ok(statSync(file).size < 2000);
  });
});

describe('appendOps', () => {
  test('appends one formatted line per event', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ops-log-')), 'ops.log');
    appendOps([
      { t: Date.parse('2026-08-22T15:04:41.000Z'), op: 'addChild', id: 'n2', parent: 'n1' }
    ], file);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /addChild /);
    assert.match(text, /id=n2/);
    assert.match(text, /parent=n1/);
  });
});
