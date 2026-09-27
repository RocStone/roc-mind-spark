import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction, extractConst } from './helpers/load-app-fns.mjs';

// restore()/insertChildNode() assign to module-level `let`s (sel, multiSel).
// loadFns() passes deps as parameters, so writes would be invisible here —
// build the scope by hand with real `let`s and expose getters instead.
function historyScope(initial) {
  const src = `
    let map = init.map, sel = init.sel ?? null, multiSel = init.multiSel ?? new Set();
    let history = [], hpos = -1, mdMode = false, _mdSyncing = false;
    const MAP_HISTORY_KEYS = ${JSON.stringify(extractConst('MAP_HISTORY_KEYS'))};
    const NODE_COLORS = ['#fff', '#abc'];
    const $ = () => ({ value: '', disabled: false });
    const childrenOf = id => Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);
    let uidN = 0; const uid = () => 'n' + (++uidN);
    const autoLayout = () => {}, scheduleSave = () => {}, syncTextFromMap = () => {};
    let bulkBarHidden = 0; const hideBulkBar = () => { bulkBarHidden++; };
    ${extractFunction('mapHistorySnapshot')}
    ${extractFunction('restore')}
    ${extractFunction('insertChildNode')}
    return { restore, mapHistorySnapshot, insertChildNode,
      get sel() { return sel; }, get multiSel() { return multiSel; }, get map() { return map; },
      get bulkBarHidden() { return bulkBarHidden; } };
  `;
  return new Function('init', src)(initial);
}

const baseMap = () => ({
  id: 'm1', rootId: 'root', title: 'T', layout: 'balanced',
  nodes: {
    root: { id: 'root', parent: null, text: 'R', x: 0, y: 0 },
    a: { id: 'a', parent: 'root', text: 'A', x: 1, y: 1 },
  },
});

describe('restore() keeps the selection pointing at real nodes', () => {
  test('clears sel when the restored snapshot lacks the selected node', () => {
    const m = baseMap();
    const snap = historyScope({ map: m }).mapHistorySnapshot();
    m.nodes.b = { id: 'b', parent: 'root', text: 'B' };
    const s = historyScope({ map: m, sel: 'b' });
    s.restore(snap);
    assert.equal(s.sel, null);
    assert.equal(s.map.nodes.b, undefined);
  });

  test('keeps sel when the node survives', () => {
    const s = historyScope({ map: baseMap(), sel: 'a' });
    s.restore(s.mapHistorySnapshot());
    assert.equal(s.sel, 'a');
  });

  test('filters multiSel and clears it once fewer than two remain', () => {
    const m = baseMap();
    const snap = historyScope({ map: m }).mapHistorySnapshot();
    m.nodes.b = { id: 'b', parent: 'root', text: 'B' };
    const s = historyScope({ map: m, sel: 'a', multiSel: new Set(['a', 'b']) });
    s.restore(snap);
    assert.equal(s.multiSel.size, 0);
    assert.equal(s.bulkBarHidden, 1);
  });

  test('insertChildNode uses the resolved parent id when the requested one is gone', () => {
    const s = historyScope({ map: baseMap() });
    const id = s.insertChildNode('ghost');
    assert.equal(s.map.nodes[id].parent, 'root');
  });
});

describe('history snapshot covers layout settings', () => {
  test('MAP_HISTORY_KEYS includes the layout fields and not pinned', () => {
    const keys = extractConst('MAP_HISTORY_KEYS');
    for (const k of ['layoutConfig', 'layoutParams', 'layoutPreset', 'vars', 'frontmatter', 'nodes', 'rootId'])
      assert.ok(keys.includes(k), k);
    assert.ok(!keys.includes('pinned'));
  });

  test('undo restores layoutConfig and drops layoutParams/layoutPreset added later', () => {
    const m = baseMap();
    m.layoutConfig = { balanced: { hGap: 40 } };
    const s = historyScope({ map: m });
    const snap = s.mapHistorySnapshot();
    m.layoutConfig = { balanced: { hGap: 90 } };
    m.layoutParams = { gap: 3 };
    m.layoutPreset = 'fancy';
    s.restore(snap);
    assert.deepEqual(s.map.layoutConfig, { balanced: { hGap: 40 } });
    assert.equal('layoutParams' in s.map, false);
    assert.equal('layoutPreset' in s.map, false);
  });

  test('showLayoutConfigForm snapshots after autoLayout', () => {
    const body = extractFunction('showLayoutConfigForm');
    const al = body.indexOf('autoLayout();');
    const ph = body.indexOf('pushHistory();');
    assert.ok(al > 0 && ph > al, 'pushHistory must follow autoLayout');
  });
});
