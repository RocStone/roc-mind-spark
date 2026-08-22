'use strict';
/**
 * Append-only operation log for reproducing bugs from the overlay App.
 * One short line per action. Rotation: every 7 days, if the file is over
 * 10MB, keep only the last 100 lines.
 */
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP_LINES = 100;
const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

function defaultLogPath() {
  return process.env.OPS_LOG_PATH || path.join(__dirname, 'data', 'ops.log');
}

function clip(v, n) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
}

function formatOp(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const t = Number.isFinite(ev.t) ? new Date(ev.t) : new Date();
  const iso = Number.isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();
  const parts = [iso, clip(ev.op || '?', 32)];
  for (const k of ['map', 'id', 'parent', 'sel', 'from', 'to', 'key', 'layout', 'look', 'theme', 'zoom', 'dir', 'mode']) {
    if (ev[k] == null || ev[k] === '') continue;
    parts.push(k + '=' + clip(ev[k], 40));
  }
  if (ev.text) parts.push('"' + clip(ev.text, 40).replace(/"/g, '') + '"');
  return parts.join(' ').slice(0, 240);
}

function appendOps(events, logPath) {
  const file = logPath || defaultLogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const list = Array.isArray(events) ? events : [events];
  const lines = list.map(formatOp).filter(Boolean).map(l => l + '\n').join('');
  if (!lines) return 0;
  fs.appendFileSync(file, lines);
  return lines.length;
}

function tailLines(text, n) {
  const parts = String(text || '').split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  const kept = parts.slice(-n);
  return kept.length ? kept.join('\n') + '\n' : '';
}

function readMeta(metaPath) {
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
  catch { return { lastCheck: 0 }; }
}

function maybeRotateOpsLog(opts) {
  const file = (opts && opts.logPath) || defaultLogPath();
  const now = (opts && opts.now) || Date.now();
  const maxBytes = (opts && opts.maxBytes != null) ? opts.maxBytes : MAX_BYTES;
  const keep = (opts && opts.keepLines != null) ? opts.keepLines : KEEP_LINES;
  const interval = (opts && opts.intervalMs != null) ? opts.intervalMs : CHECK_EVERY_MS;
  const metaPath = file + '.meta.json';
  const meta = readMeta(metaPath);
  if (!(opts && opts.force) && now - (meta.lastCheck || 0) < interval) {
    return { rotated: false, skipped: true };
  }
  meta.lastCheck = now;
  try { fs.writeFileSync(metaPath, JSON.stringify(meta)); } catch {}
  let st;
  try { st = fs.statSync(file); }
  catch { return { rotated: false, missing: true, lastCheck: now }; }
  if (st.size <= maxBytes) return { rotated: false, size: st.size, lastCheck: now };
  const kept = tailLines(fs.readFileSync(file, 'utf8'), keep);
  fs.writeFileSync(file, kept);
  return {
    rotated: true,
    size: st.size,
    kept: kept ? kept.split('\n').filter(Boolean).length : 0,
    lastCheck: now
  };
}

function startOpsLogChecker(opts) {
  maybeRotateOpsLog(opts);
  // Wake hourly; the 7-day gate lives in maybeRotateOpsLog.
  return setInterval(() => {
    try { maybeRotateOpsLog(opts); }
    catch (e) { console.warn('ops-log rotate failed:', e && e.message); }
  }, 60 * 60 * 1000);
}

module.exports = {
  formatOp,
  appendOps,
  tailLines,
  maybeRotateOpsLog,
  startOpsLogChecker,
  MAX_BYTES,
  KEEP_LINES,
  CHECK_EVERY_MS,
  defaultLogPath
};
