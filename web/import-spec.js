'use strict';
/**
 * Map import (GPT integration): turns a node-list spec posted to
 * POST /api/import into a stored map. This is the loopback server's main
 * untrusted-input surface, so every field is read by name and validated.
 * Kept out of server.js so tests can load it without starting the server.
 */
const uid = () => Math.random().toString(36).slice(2, 9);

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
      if (typeof c.doi === 'string' && c.doi.trim()) cit.doi = c.doi.trim();
      else if (typeof c.arxiv === 'string' && c.arxiv.trim()) { cit.doi = 'arXiv:' + c.arxiv.trim(); cit.source = 'arXiv'; }
      if (Object.keys(cit).length) { node.citation = cit; node.ref = true; }
    }
    nodes[n.id] = node;
  }
  const links = Array.isArray(spec.links)
    ? spec.links.filter(l => l && byId.has(l.from) && byId.has(l.to))
                .map(l => { const o = { from: l.from, to: l.to }; if (l.label != null && l.label !== '') o.label = String(l.label); return o; })
    : [];
  return { id: uid(), title, titleAuto: false, color: (typeof spec.color === 'string' && spec.color) ? spec.color : '#e0613a',
           layout: 'balanced', rootId, nodes, links, _import: true, updated: Date.now() };
}

module.exports = { buildMapFromSpec };
