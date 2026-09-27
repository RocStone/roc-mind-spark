import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runImageGc, scanRow, summaryLine, startImageGc } from '../image-gc.js';
import { startApiServer } from './helpers/api-server.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-28T12:00:00Z');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'rms-image-gc-'));
  const dbPath = join(dir, 'mindspark.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE maps (id TEXT PRIMARY KEY, title TEXT, color TEXT, data TEXT NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE map_versions (id TEXT NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, started INTEGER, PRIMARY KEY (id, ts));
  `);
  const img = (mapId, name, ageMs) => {
    const d = join(dir, 'maps', mapId);
    mkdirSync(d, { recursive: true });
    const f = join(d, name);
    writeFileSync(f, Buffer.alloc(100));
    const t = new Date(NOW - ageMs);
    utimesSync(f, t, t);
    return f;
  };
  const map = (id, nodes) => JSON.stringify({ id, rootId: 'r', nodes });
  return { dir, dbPath, db, img, map, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe('image GC', () => {
  test('keeps referenced and recent files, removes old unreferenced ones', async () => {
    const t = setup();
    try {
      t.db.prepare('INSERT INTO maps VALUES (?,?,?,?,?)').run('A', 'A', null,
        t.map('A', { r: { id: 'r', text: 'root', image: '001.png' },
                     n: { id: 'n', text: 'x', notes: '![shot](/api/maps/B/images/002.jpg)' } }), NOW);
      // 003.png is only in history: a restore must still find it.
      t.db.prepare('INSERT INTO map_versions VALUES (?,?,?,?)').run('A', NOW - 1000,
        t.map('A', { r: { id: 'r', text: 'root', image: '003.png' } }), NOW - 1000);

      const kept1 = t.img('A', '001.png', 10 * DAY);      // referenced by maps
      const kept2 = t.img('B', '002.jpg', 10 * DAY);      // referenced via absolute URL from map A
      const kept3 = t.img('A', '003.png', 10 * DAY);      // referenced only by a version
      const fresh = t.img('A', '004.png', 60 * 1000);     // unreferenced but uploaded a minute ago
      const gone1 = t.img('A', '005.png', 2 * DAY);       // detached long ago
      const gone2 = t.img('deleted', '001.png', 3 * DAY); // map no longer exists
      const other = t.img('A', 'notes.txt', 10 * DAY);    // not an image name: never touched

      const dry = await runImageGc({ db: t.db, dbPath: t.dbPath, now: NOW, dryRun: true });
      assert.equal(dry.removed, 2);
      assert.ok(existsSync(gone1) && existsSync(gone2), 'dry run deletes nothing');

      const r = await runImageGc({ db: t.db, dbPath: t.dbPath, now: NOW });
      for (const f of [kept1, kept2, kept3, fresh, other]) assert.ok(existsSync(f), f + ' should survive');
      for (const f of [gone1, gone2]) assert.ok(!existsSync(f), f + ' should be removed');
      assert.deepEqual(r.removedFiles, ['A/005.png', 'deleted/001.png']);
      assert.equal(r.kept, 3);
      assert.equal(r.recent, 1);
      assert.equal(r.removed, 2);
      assert.equal(r.bytes, 200);
      assert.match(summaryLine(r), /^image-gc: removed 2 file\(s\)/);
    } finally { t.cleanup(); }
  });

  test('pages through many rows', async () => {
    const t = setup();
    try {
      const ins = t.db.prepare('INSERT INTO map_versions VALUES (?,?,?,?)');
      for (let i = 0; i < 75; i++) ins.run('A', i, t.map('A', { r: { id: 'r', text: '', image: String(i).padStart(3, '0') + '.png' } }), i);
      const files = [];
      for (let i = 0; i < 80; i++) files.push(t.img('A', String(i).padStart(3, '0') + '.png', 2 * DAY));
      const r = await runImageGc({ db: t.db, dbPath: t.dbPath, now: NOW });
      assert.equal(r.kept, 75);
      assert.equal(r.removed, 5);
      assert.deepEqual(r.removedFiles, ['A/075.png', 'A/076.png', 'A/077.png', 'A/078.png', 'A/079.png']);
    } finally { t.cleanup(); }
  });

  test('startImageGc runs after its delay and logs one summary line', async () => {
    const t = setup();
    try {
      const gone = t.img('X', '001.png', 0);
      const old = new Date(Date.now() - 2 * DAY);
      utimesSync(gone, old, old);
      const lines = [];
      const stop = startImageGc({ db: t.db, dbPath: t.dbPath, delayMs: 5, intervalMs: 60 * 60 * 1000, log: l => lines.push(l) });
      for (let i = 0; i < 100 && !lines.length; i++) await new Promise(r => setTimeout(r, 10));
      stop();
      assert.equal(lines.length, 1);
      assert.match(lines[0], /^image-gc: removed 1 file\(s\)/);
      assert.ok(!existsSync(gone));
    } finally { t.cleanup(); }
  });

  test('missing maps folder is a no-op', async () => {
    const t = setup();
    try {
      const r = await runImageGc({ db: t.db, dbPath: t.dbPath, now: NOW });
      assert.equal(r.scanned, 0);
      assert.equal(r.removed, 0);
    } finally { t.cleanup(); }
  });

  test('scanRow finds bare names, markdown, and full URLs', () => {
    const refs = scanRow(new Map(), 'A',
      '{"image":"012.PNG","text":"see http://127.0.0.1:3034/api/maps/Z-9/images/007.webp and v1.png"}');
    assert.deepEqual([...refs.get('A')].sort(), ['007.webp', '012.png']);
    assert.deepEqual([...refs.get('Z-9')], ['007.webp']);
  });
});

describe('GET /api/images/gc', () => {
  test('reports without deleting', async () => {
    const srv = await startApiServer();
    try {
      const r = await fetch(srv.base + '/api/images/gc');
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.dryRun, true);
      assert.equal(j.removed, 0);
    } finally { await srv.stop(); }
  });
});
