import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFunction, loadFns } from './helpers/load-app-fns.mjs';

const appSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js'),
  'utf8'
);

function makeMap() {
  const map = {
    rootId: 'root',
    nodes: {
      root: { id: 'root', parent: null, text: 'Mind' },
      tools: { id: 'tools', parent: 'root', text: 'tools', collapsed: true },
      kernel: { id: 'kernel', parent: 'tools', text: 'linux kernel' },
      other: { id: 'other', parent: 'tools', text: 'other' },
      os: { id: 'os', parent: 'root', text: 'os', collapsed: true },
      distro: { id: 'distro', parent: 'os', text: 'linux distro' },
      mint: { id: 'mint', parent: 'root', text: 'linux mint' },
    },
  };
  const childrenOf = id =>
    Object.values(map.nodes).filter(n => n.parent === id).map(n => n.id);
  const fns = loadFns(
    [
      'nodeSearchText',
      'searchWalkIds',
      'collectSearchMatches',
      'searchCollapsedAncestors',
      'searchExpandAncestors',
      'searchIsDescendantOf',
      'searchNodeFingerprint',
      'searchNodeWasModified',
      'searchIdsToRestore',
      'findChordShouldClose',
    ],
    {
      map,
      childrenOf,
      hasInlineMarkup: () => false,
      nodeTextPlain: t => t,
    }
  );
  return { map, childrenOf, ...fns };
}

describe('collectSearchMatches — collapsed cards are still in the list', () => {
  test('linux hits kernel and distro even while their parents are folded', () => {
    const { collectSearchMatches } = makeMap();
    assert.deepEqual(collectSearchMatches('linux'), ['kernel', 'distro', 'mint']);
  });

  test('walks tree preorder, not Object.keys of visible cards', () => {
    const { searchWalkIds } = makeMap();
    assert.deepEqual(searchWalkIds(), [
      'root', 'tools', 'kernel', 'other', 'os', 'distro', 'mint',
    ]);
  });

  test('empty / whitespace query is no hits', () => {
    const { collectSearchMatches } = makeMap();
    assert.deepEqual(collectSearchMatches(''), []);
    assert.deepEqual(collectSearchMatches('   '), []);
  });

  test('match is case-insensitive', () => {
    const { collectSearchMatches } = makeMap();
    assert.deepEqual(collectSearchMatches('LINUX'), ['kernel', 'distro', 'mint']);
  });
});

describe('search expand / restore of the ancestor chain', () => {
  test('first hit reports the folded ancestors that must open', () => {
    const { searchCollapsedAncestors, searchExpandAncestors, map } = makeMap();
    assert.deepEqual(searchCollapsedAncestors('kernel'), ['tools']);
    assert.deepEqual(searchExpandAncestors('kernel'), ['tools']);
    assert.equal(map.nodes.tools.collapsed, false);
  });

  test('deep folds open every ancestor on the path', () => {
    const { map, searchCollapsedAncestors, searchExpandAncestors } = makeMap();
    map.nodes.tools.collapsed = true;
    map.nodes.kernel.collapsed = true;
    map.nodes.deep = { id: 'deep', parent: 'kernel', text: 'linux deep' };
    assert.deepEqual(searchCollapsedAncestors('deep'), ['kernel', 'tools']);
    searchExpandAncestors('deep');
    assert.equal(map.nodes.kernel.collapsed, false);
    assert.equal(map.nodes.tools.collapsed, false);
  });

  test('leaving an unmodified hit restores folds the next hit does not need', () => {
    const { searchIdsToRestore, searchIsDescendantOf } = makeMap();
    assert.equal(searchIsDescendantOf('distro', 'os'), true);
    assert.equal(searchIsDescendantOf('distro', 'tools'), false);
    assert.deepEqual(
      searchIdsToRestore(['tools'], 'distro', false, 'kernel'),
      ['tools']
    );
  });

  test('a shared ancestor stays open for the next hit', () => {
    const { map, searchIdsToRestore } = makeMap();
    map.nodes.os.parent = 'tools';
    assert.deepEqual(
      searchIdsToRestore(['tools'], 'distro', false, 'kernel'),
      []
    );
  });

  test('a modified hit keeps its chain open', () => {
    const { searchIdsToRestore } = makeMap();
    assert.deepEqual(
      searchIdsToRestore(['tools'], 'distro', true, 'kernel'),
      []
    );
  });

  test('fingerprint changes when the node text changes, not when it is only selected', () => {
    const { map, searchNodeFingerprint, searchNodeWasModified } = makeMap();
    const snap = searchNodeFingerprint('kernel');
    assert.equal(searchNodeWasModified('kernel', snap), false);
    map.nodes.kernel.text = 'linux kernel edited';
    assert.equal(searchNodeWasModified('kernel', snap), true);
  });

  test('adding a child counts as a structural edit', () => {
    const { map, searchNodeFingerprint, searchNodeWasModified } = makeMap();
    const snap = searchNodeFingerprint('kernel');
    map.nodes.child = { id: 'child', parent: 'kernel', text: 'c' };
    assert.equal(searchNodeWasModified('kernel', snap), true);
  });
});

describe('⌘F chord', () => {
  test('second press closes find; replace chord stays open', () => {
    const { findChordShouldClose } = makeMap();
    assert.equal(findChordShouldClose(false, false), false);
    assert.equal(findChordShouldClose(true, false), true);
    assert.equal(findChordShouldClose(true, true), false);
  });
});

describe('shipped wiring — these names are what the UI actually calls', () => {
  test('doSearch walks the map via collectSearchMatches', () => {
    const body = extractFunction('doSearch');
    assert.match(body, /collectSearchMatches/);
    assert.doesNotMatch(body, /querySelectorAll\(['"]\.node['"]\)/);
  });

  test('Enter cycles through focusNextMatch, which restores then reveals', () => {
    const body = extractFunction('focusNextMatch');
    assert.match(body, /searchLeaveCurrent/);
    assert.match(body, /searchEnterExpand/);
    assert.match(body, /keepSearchFocus/);
    assert.match(body, /persist:\s*false/);
  });

  test('⌘F uses findChordShouldClose so a second press closes the box', () => {
    assert.match(appSrc, /findChordShouldClose\(\$\('#searchWrap'\)\?\.classList\.contains\('open'\), false\)/);
  });
});
