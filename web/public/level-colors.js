/* Same-level node colours. The file is loaded as a browser script by the
   canvas and is also CommonJS-compatible for the small, pure unit tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.RMSLevelColors = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function validNodes(map) {
    return !!(map && map.nodes && typeof map.nodes === 'object' && !Array.isArray(map.nodes));
  }

  function childIndex(nodes) {
    const children = new Map();
    Object.keys(nodes).forEach((id) => {
      const node = nodes[id];
      if (!node || typeof node !== 'object' || node.parent == null) return;
      const parent = String(node.parent);
      if (!own(nodes, parent)) return;
      let list = children.get(parent);
      if (!list) children.set(parent, list = []);
      list.push(id);
    });
    return children;
  }

  /* Visit only the tree rooted at map.rootId. The explicit stack avoids a
     call-stack limit on deep maps; visited also makes malformed cycles safe. */
  function walkRoot(map, visit) {
    if (!validNodes(map) || map.rootId == null) return;
    const rootId = String(map.rootId);
    if (!own(map.nodes, rootId)) return;
    const children = childIndex(map.nodes);
    const seen = new Set();
    const stack = [[rootId, 0]];
    while (stack.length) {
      const entry = stack.pop();
      const id = entry[0];
      const depth = entry[1];
      if (seen.has(id)) continue;
      const node = map.nodes[id];
      if (!node || typeof node !== 'object') continue;
      seen.add(id);
      visit(node, id, depth);
      const list = children.get(id) || [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (!seen.has(list[i])) stack.push([list[i], depth + 1]);
      }
    }
  }

  function rememberDefaultColor(node) {
    if (own(node, 'defaultColor')) return;
    node.defaultColor = (node.color === undefined) ? null : node.color;
  }

  function apply(map, palette) {
    if (!map || map.sameLevelColors !== true || !validNodes(map)) return map;
    if (!Array.isArray(palette) || palette.length === 0) return map;
    walkRoot(map, (node, id, depth) => {
      if (depth === 0) return;
      rememberDefaultColor(node);
      node.color = palette[(depth - 1) % palette.length];
    });
    return map;
  }

  function restore(map) {
    if (!validNodes(map)) return map;
    Object.keys(map.nodes).forEach((id) => {
      const node = map.nodes[id];
      if (!node || typeof node !== 'object' || !own(node, 'defaultColor')) return;
      if (node.defaultColor == null) delete node.color;
      else node.color = node.defaultColor;
      delete node.defaultColor;
    });
    delete map.sameLevelColors;
    return map;
  }

  function setEnabled(map, on, palette) {
    if (!map || typeof map !== 'object') return map;
    if (on) {
      map.sameLevelColors = true;
      return apply(map, palette);
    }
    return restore(map);
  }

  return { apply, setEnabled };
});
