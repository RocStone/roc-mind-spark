import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  nextImageName,
  saveMapImage,
  readMapImage,
  deleteMapImages,
  copyMapImages,
  sniffExt,
  extFor,
  mapImageDir,
} from '../map-images.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), 'rms-img-'));
  return join(dir, 'mindspark.db');
}

describe('sniffExt / extFor', () => {
  test('recognises PNG and JPEG magic', () => {
    assert.equal(sniffExt(PNG), '.png');
    assert.equal(sniffExt(JPEG), '.jpg');
    assert.equal(extFor('image/png', Buffer.alloc(0)), '.png');
    assert.equal(extFor('image/jpeg', Buffer.alloc(0)), '.jpg');
    assert.equal(extFor('text/plain', PNG), '.png');
  });
});

describe('nextImageName', () => {
  test('starts at 001 and increments from the highest existing number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rms-n-'));
    assert.equal(nextImageName(dir, '.png'), '001.png');
    writeFileSync(join(dir, '001.png'), PNG);
    writeFileSync(join(dir, '003.jpg'), JPEG);
    assert.equal(nextImageName(dir, '.png'), '004.png');
  });
});

describe('saveMapImage / readMapImage', () => {
  test('writes numbered files into a per-map folder', () => {
    const db = tmpDb();
    const a = saveMapImage(db, 'mapA', PNG, 'image/png');
    const b = saveMapImage(db, 'mapA', JPEG, 'image/jpeg');
    assert.equal(a.name, '001.png');
    assert.equal(b.name, '002.jpg');
    const read = readMapImage(db, 'mapA', '001.png');
    assert.equal(read.mime, 'image/png');
    assert.equal(Buffer.compare(read.buf, PNG), 0);
    assert.ok(existsSync(join(mapImageDir(db, 'mapA'), '002.jpg')));
  });

  test('rejects a bad map id or filename', () => {
    const db = tmpDb();
    assert.throws(() => saveMapImage(db, '../x', PNG, 'image/png'));
    saveMapImage(db, 'mapA', PNG, 'image/png');
    assert.equal(readMapImage(db, 'mapA', '../001.png'), null);
    assert.equal(readMapImage(db, 'mapA', 'note.txt'), null);
  });
});

describe('copyMapImages / deleteMapImages', () => {
  test('copies files to a new map folder and can delete the source', () => {
    const db = tmpDb();
    saveMapImage(db, 'from', PNG, 'image/png');
    saveMapImage(db, 'from', JPEG, 'image/jpeg');
    const copied = copyMapImages(db, 'from', 'to');
    assert.equal(copied.copied, 2);
    assert.ok(existsSync(join(mapImageDir(db, 'to'), '001.png')));
    assert.ok(existsSync(join(mapImageDir(db, 'to'), '002.jpg')));
    deleteMapImages(db, 'from');
    assert.equal(existsSync(mapImageDir(db, 'from')), false);
    assert.ok(existsSync(join(mapImageDir(db, 'to'), '001.png')));
  });
});
