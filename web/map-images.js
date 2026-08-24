'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SAFE_ID = /^[\w-]+$/;
const SAFE_NAME = /^(\d+)\.(png|jpe?g|gif|webp)$/i;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const EXT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function mapsRoot(dbPath) {
  return path.join(path.dirname(dbPath), 'maps');
}

function mapImageDir(dbPath, mapId) {
  if (!SAFE_ID.test(mapId || '')) return null;
  return path.join(mapsRoot(dbPath), mapId);
}

function sniffExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp';
  return null;
}

function extFor(mime, buf) {
  const fromMime = MIME_EXT[(mime || '').toLowerCase().split(';')[0].trim()];
  if (fromMime) return fromMime;
  return sniffExt(buf);
}

function nextImageName(dir, ext) {
  const e = (ext.startsWith('.') ? ext : '.' + ext).toLowerCase();
  let max = 0;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d+)\./.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
  }
  return String(max + 1).padStart(3, '0') + e;
}

function saveMapImage(dbPath, mapId, buf, mime) {
  if (!buf || !buf.length) throw new Error('empty image');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('image too large');
  const dir = mapImageDir(dbPath, mapId);
  if (!dir) throw new Error('invalid map id');
  const ext = extFor(mime, buf);
  if (!ext) throw new Error('unsupported image type');
  fs.mkdirSync(dir, { recursive: true });
  const name = nextImageName(dir, ext);
  fs.writeFileSync(path.join(dir, name), buf);
  return { name, mime: EXT_MIME[ext] || 'application/octet-stream' };
}

function readMapImage(dbPath, mapId, name) {
  const dir = mapImageDir(dbPath, mapId);
  if (!dir) return null;
  const file = String(name || '');
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return null;
  if (!SAFE_NAME.test(file)) return null;
  const full = path.join(dir, file);
  if (!full.startsWith(dir + path.sep)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  const ext = path.extname(file).toLowerCase();
  return { buf: fs.readFileSync(full), mime: EXT_MIME[ext] || 'application/octet-stream', name: file };
}

function deleteMapImages(dbPath, mapId) {
  const dir = mapImageDir(dbPath, mapId);
  if (!dir || !fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function copyMapImages(dbPath, fromId, toId) {
  const fromDir = mapImageDir(dbPath, fromId);
  const toDir = mapImageDir(dbPath, toId);
  if (!fromDir || !toDir) throw new Error('invalid map id');
  if (!fs.existsSync(fromDir)) return { copied: 0 };
  fs.mkdirSync(toDir, { recursive: true });
  let copied = 0;
  for (const f of fs.readdirSync(fromDir)) {
    if (!SAFE_NAME.test(f)) continue;
    fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
    copied++;
  }
  return { copied };
}

module.exports = {
  SAFE_ID,
  SAFE_NAME,
  MAX_IMAGE_BYTES,
  mapsRoot,
  mapImageDir,
  sniffExt,
  extFor,
  nextImageName,
  saveMapImage,
  readMapImage,
  deleteMapImages,
  copyMapImages,
};
