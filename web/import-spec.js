'use strict';
/**
 * Map import (GPT integration): turns a node-list spec posted to
 * POST /api/import into a stored map. This is the loopback server's main
 * untrusted-input surface, so every field is read by name and validated.
 * Kept out of server.js so tests can load it without starting the server.
 */
const uid = () => Math.random().toString(36).slice(2, 9);

// Same bounds as LAYOUT_CONFIG_BOUNDS in public/app.js. Imported values are
// clamped rather than trusted; the canvas re-validates on load as well.
const LAYOUT_BOUNDS = {
  balanced: { hGap: [8, 400], vGap: [4, 300] },
  right:    { hGap: [8, 400], vGap: [4, 300] },
  left:     { hGap: [8, 400], vGap: [4, 300] },
  down:     { hGap: [8, 400], vGap: [4, 300] },
  radial:   { ring: [60, 600], startAngle: [-360, 360], sweep: [30, 360] },
  grid:     { columns: [1, 8], gapX: [8, 300], gapY: [8, 300], rowGap: [0, 120], indent: [0, 120] },
  timeline: { gap: [8, 400], stem: [0, 300], indent: [0, 300] },
};
const isPlainObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// Only the knobs the caller actually supplied are kept (no defaults filled in),
// so an imported map still follows the app's defaults for everything else.
function sanitizeLayoutConfig(raw) {
  if (!isPlainObj(raw)) return null;
  const out = {};
  for (const engine of Object.keys(LAYOUT_BOUNDS)) {
    const sec = raw[engine];
    if (!isPlainObj(sec)) continue;
    const o = {};
    for (const [k, [lo, hi]] of Object.entries(LAYOUT_BOUNDS[engine])) {
      const v = sec[k];
      if (typeof v === 'number' && isFinite(v)) o[k] = Math.min(hi, Math.max(lo, Math.round(v)));
    }
    if (engine === 'timeline') {
      if (typeof sec.alternate === 'boolean') o.alternate = sec.alternate;
      if (sec.start === 'above' || sec.start === 'below') o.start = sec.start;
    }
    if (Object.keys(o).length) out[engine] = o;
  }
  return Object.keys(out).length ? out : null;
}

function buildMapFromSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('body must be a JSON object');
  const title = (typeof spec.title === 'string' && spec.title.trim()) ? spec.title.trim() : 'Imported map';
  const inNodes = Array.isArray(spec.nodes) ? spec.nodes : null;
  if (!inNodes || !inNodes.length) throw new Error('nodes[] is required and must be non-empty');
  const byId = new Map();
  for (const n of inNodes) {
    if (!n || typeof n.id !== 'string' || !n.id) throw new Error('every node needs a non-empty string id');
    if (byId.has(n.id)) throw new Error('duplicate node id: ' + n.id);
    if (typeof n.text !== 'string') throw new Error('node ' + n.id + ' is missing text');
    byId.set(n.id, n);
  }
  let rootId = (typeof spec.rootId === 'string' && spec.rootId) ? spec.rootId : null;
  if (rootId && !byId.has(rootId)) throw new Error('rootId does not match any node');
  if (!rootId) {
    const roots = inNodes.filter(n => n.parent == null);
    if (roots.length !== 1) throw new Error('exactly one root node (parent=null) required, found ' + roots.length);
    rootId = roots[0].id;
  }
  for (const n of inNodes) {
    if (n.id === rootId) continue;
    if (n.parent == null) throw new Error('node ' + n.id + ' has no parent (only the root may be parent-less)');
    if (!byId.has(n.parent)) throw new Error('node ' + n.id + ' references missing parent ' + n.parent);
    if (n.parent === n.id) throw new Error('node ' + n.id + ' is its own parent');
  }
  const N = byId.size;
  for (const n of inNodes) { let cur = n, hops = 0; while (cur && cur.id !== rootId) { cur = byId.get(cur.parent); if (++hops > N) throw new Error('cycle detected near node ' + n.id); } }
  const nodes = {};
  for (const n of inNodes) {
    const node = { id: n.id, text: String(n.text), parent: n.id === rootId ? null : n.parent,
      x: 0, y: 0, side: n.id === rootId ? 'root' : null, color: (typeof n.color === 'string' && n.color) ? n.color : '#fff' };
    if (typeof n.notes === 'string' && n.notes.trim()) node.notes = n.notes;
    if (n.collapsed === true) node.collapsed = true;
    if (n.tag != null && n.tag !== '') node.tag = String(n.tag);
    // Formatting. Only exact values are accepted; anything else is dropped
    // rather than stored, so no flag appears on a node that did not ask for it.
    if (n.listType === 'ul' || n.listType === 'ol') { node.listType = n.listType; node.align = 'left'; }
    if (n.bold === true) node.bold = true;
    if (n.italic === true) node.italic = true;
    if (n.highlight === true) node.highlight = true;
    if (n.align === 'left' || n.align === 'center' || n.align === 'right') node.align = n.align;
    if (n.task === 'todo' || n.task === 'doing' || n.task === 'done') node.task = n.task;
    // Marker badge: a short string, not checked against the palette, so maps
    // from a newer client with more markers still import. Trimmed before the
    // length check; the cap is 2 code points so it stays a badge.
    if (typeof n.marker === 'string') {
      const mk = n.marker.trim();
      if (mk && [...mk].length <= 2) node.marker = mk;
    }
    if (typeof n.url === 'string') {
      const u = n.url.trim();
      if (u && u.length <= 2000 && /^https?:\/\/[^\s<>"'`]+$/i.test(u)) node.url = u;
    }
    if (n.citation && typeof n.citation === 'object') {
      const c = n.citation, cit = {};
      if (Array.isArray(c.authors) && c.authors.length) cit.authors = c.authors.join(', ');
      else if (typeof c.authors === 'string' && c.authors.trim()) cit.authors = c.authors.trim();
      if (c.year != null) cit.year = c.year;
      if (typeof c.title === 'string' && c.title.trim()) cit.title = c.title.trim();
      if (typeof c.source === 'string' && c.source.trim()) cit.source = c.source.trim();
      if (typeof c.doi === 'string' && c.doi.trim()) cit.doi = c.doi.trim();
      else if (typeof c.arxiv === 'string' && c.arxiv.trim()) { cit.doi = 'arXiv:' + c.arxiv.trim(); if (!cit.source) cit.source = 'arXiv'; }
      if (Object.keys(cit).length) { node.citation = cit; node.ref = true; }
    }
    nodes[n.id] = node;
  }
  // Balance root branches like balanceRootSides(): first half right, rest left.
  const rootKids = inNodes.filter(n => n.id !== rootId && n.parent === rootId).map(n => n.id);
  const half = Math.ceil(rootKids.length / 2);
  rootKids.forEach((id, i) => { nodes[id].side = i < half ? 'right' : 'left'; });
  const links = Array.isArray(spec.links)
    ? spec.links.filter(l => l && byId.has(l.from) && byId.has(l.to))
                .map(l => { const o = { from: l.from, to: l.to }; if (l.label != null && l.label !== '') o.label = String(l.label); return o; })
    : [];
  const out = { id: uid(), title, titleAuto: false, color: (typeof spec.color === 'string' && spec.color) ? spec.color : '#e0613a',
                layout: 'balanced', rootId, nodes, links, _import: true, updated: Date.now() };
  const lc = sanitizeLayoutConfig(spec.layoutConfig);
  if (lc) out.layoutConfig = lc;
  return out;
}

module.exports = { buildMapFromSpec };
