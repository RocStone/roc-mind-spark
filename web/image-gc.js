'use strict';
/**
 * Garbage collection for map image files.
 *
 * Detaching an image or deleting a node leaves its file under
 * <db dir>/maps/<mapId>/. A sweep deletes a file only when
 *   1. no row of maps.data or map_versions.data references it, and
 *   2. its mtime is older than minAgeMs (default 24 h), so an image uploaded
 *      moments ago whose map save has not landed yet survives.
 *
 * References are found by scanning each row's raw JSON text, not by walking
 * n.image, so a name mentioned anywhere in the map (image field, markdown in
 * text or notes, an absolute /api/maps/<id>/images/<name> URL) keeps the file.
 * Over-keeping is harmless; under-keeping loses user data.
 *
 * Rows are read in small keyset pages with a yield to the event loop between
 * pages, and file work uses async fs in small batches, so a sweep never holds
 * request handling for long.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { SAFE_ID, SAFE_NAME, mapsRoot } = require('./map-images');

const DAY_MS = 24 * 60 * 60 * 1000;
const START_DELAY_MS = 30 * 1000;
const ROWS_PER_PAGE = 20;
const FS_BATCH = 32;

// Bare stored name such as "003.png". Attributed to the row's own map.
const BARE_NAME = /(?<![\w.])(\d+\.(?:png|jpe?g|gif|webp))(?!\w)/gi;
// Absolute reference, possibly inside a full URL. Attributed to the map it names.
const API_REF = /\/api\/maps\/([\w-]+)\/images\/([^"'\s)?#\\/]+)/gi;

const yieldNow = () => new Promise(r => setImmediate(r));

function addRef(refs, mapId, name) {
  let set = refs.get(mapId);
  if (!set) { set = new Set(); refs.set(mapId, set); }
  set.add(String(name).toLowerCase());
}

function scanRow(refs, mapId, text) {
  const s = String(text || '');
  for (const m of s.matchAll(BARE_NAME)) addRef(refs, mapId, m[1]);
  for (const m of s.matchAll(API_REF)) {
    let name = m[2];
    try { name = decodeURIComponent(name); } catch {}
    addRef(refs, m[1], name);
  }
  return refs;
}

/** Map<mapId, Set<lowercased file name>> from every map row and version row. */
async function collectImageRefs(db) {
  const refs = new Map();
  for (const table of ['maps', 'map_versions']) {
    const page = db.prepare(`SELECT rowid AS r, id, data FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${ROWS_PER_PAGE}`);
    let after = -1;
    for (;;) {
      const rows = page.all(after);
      if (!rows.length) break;
      for (const row of rows) scanRow(refs, row.id, row.data);
      after = rows[rows.length - 1].r;
      await yieldNow();
    }
  }
  return refs;
}

async function listDir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
}

/**
 * One sweep. Returns { scanned, kept, recent, removed, bytes, errors, removedFiles }.
 * dryRun reports what would be removed without touching anything.
 */
async function runImageGc({ db, dbPath, now = Date.now(), minAgeMs = DAY_MS, dryRun = false } = {}) {
  const refs = await collectImageRefs(db);
  const root = mapsRoot(dbPath);
  const out = { scanned: 0, kept: 0, recent: 0, removed: 0, bytes: 0, errors: 0, removedFiles: [] };
  for (const d of await listDir(root)) {
    if (!d.isDirectory() || !SAFE_ID.test(d.name)) continue;
    const dir = path.join(root, d.name);
    const used = refs.get(d.name);
    const files = (await listDir(dir)).filter(f => f.isFile() && SAFE_NAME.test(f.name));
    for (let i = 0; i < files.length; i += FS_BATCH) {
      await Promise.all(files.slice(i, i + FS_BATCH).map(async (f) => {
        out.scanned++;
        if (used && used.has(f.name.toLowerCase())) { out.kept++; return; }
        const full = path.join(dir, f.name);
        let st;
        try { st = await fsp.stat(full); } catch { return; }
        if (now - st.mtimeMs < minAgeMs) { out.recent++; return; }
        if (!dryRun) {
          try { await fsp.unlink(full); }
          catch (e) { if (!e || e.code !== 'ENOENT') out.errors++; return; }
        }
        out.removed++;
        out.bytes += st.size;
        out.removedFiles.push(d.name + '/' + f.name);
      }));
    }
  }
  out.removedFiles.sort();
  return out;
}

function summaryLine(r, dryRun) {
  return `image-gc: ${dryRun ? 'would remove' : 'removed'} ${r.removed} file(s), ${(r.bytes / 1024).toFixed(1)} KB; ` +
    `kept ${r.kept} referenced, ${r.recent} recent; scanned ${r.scanned}` + (r.errors ? `; ${r.errors} error(s)` : '');
}

/**
 * Schedules a sweep delayMs after start, then every intervalMs. Timers are
 * unref'd so they never keep the process alive. Returns a stop function.
 */
function startImageGc({ db, dbPath, delayMs = START_DELAY_MS, intervalMs = DAY_MS, log = console.log } = {}) {
  let running = false;
  let interval = null;
  const tick = async () => {
    if (running) return;
    running = true;
    try { log(summaryLine(await runImageGc({ db, dbPath }), false)); }
    catch (e) { log('image-gc failed: ' + (e && e.message || e)); }
    finally { running = false; }
  };
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalMs);
    interval.unref();
  }, delayMs);
  first.unref();
  return () => { clearTimeout(first); if (interval) clearInterval(interval); };
}

module.exports = {
  DAY_MS,
  START_DELAY_MS,
  scanRow,
  collectImageRefs,
  runImageGc,
  summaryLine,
  startImageGc,
};
