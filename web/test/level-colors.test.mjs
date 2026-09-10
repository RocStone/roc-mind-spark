import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = join(here, '..', 'public', 'level-colors.js');
const require = createRequire(import.meta.url);
const RMSLevelColors = require(modulePath);

function treeMap() {
  return {
    rootId: 'root',
    sameLevelColors: true,
    nodes: {
      root: { id: 'root', color: '#root' },
      left: { id: 'left', parent: 'root', color: '#left', collapsed: true },
      right: { id: 'right', parent: 'root', color: '#right' },
      leftChild: { id: 'leftChild', parent: 'left' },
      rightChild: { id: 'rightChild', parent: 'right', color: '#rightChild' },
      deep: { id: 'deep', parent: 'leftChild', color: '#deep' },
    },
  };
}

describe('RMSLevelColors', () => {
  test('exports CommonJS API and installs the browser global', () => {
    assert.equal(typeof RMSLevelColors.apply, 'function');
    assert.equal(typeof RMSLevelColors.setEnabled, 'function');

    const source = readFileSync(modulePath, 'utf8');
    const browserContext = {};
    vm.runInNewContext(source, browserContext);
    assert.equal(typeof browserContext.RMSLevelColors.apply, 'function');
    assert.equal(typeof browserContext.RMSLevelColors.setEnabled, 'function');
  });

  test('colours every branch by relative depth, including collapsed descendants', () => {
    const map = treeMap();
    RMSLevelColors.apply(map, ['level-1', 'level-2']);

    assert.equal(map.nodes.root.color, '#root');
    assert.equal(map.nodes.left.color, 'level-1');
    assert.equal(map.nodes.right.color, 'level-1');
    assert.equal(map.nodes.leftChild.color, 'level-2');
    assert.equal(map.nodes.rightChild.color, 'level-2');
    assert.equal(map.nodes.deep.color, 'level-1');

    assert.equal(map.nodes.left.defaultColor, '#left');
    assert.equal(map.nodes.right.defaultColor, '#right');
    assert.equal(map.nodes.leftChild.defaultColor, null);
    assert.equal(map.nodes.rightChild.defaultColor, '#rightChild');
    assert.equal(map.nodes.deep.defaultColor, '#deep');
    assert.equal(map.nodes.left.collapsed, true);
  });

  test('keeps the first default, handles added and moved nodes, then restores on disable', () => {
    const map = treeMap();
    RMSLevelColors.apply(map, ['level-1', 'level-2']);

    map.nodes.left.color = '#edited-after-first-apply';
    map.nodes.added = { id: 'added', parent: 'leftChild', color: '#new-original' };
    RMSLevelColors.apply(map, ['level-1', 'level-2']);
    assert.equal(map.nodes.left.defaultColor, '#left');
    assert.equal(map.nodes.added.color, 'level-1');
    assert.equal(map.nodes.added.defaultColor, '#new-original');

    map.nodes.added.parent = 'root';
    RMSLevelColors.apply(map, ['level-1', 'level-2']);
    assert.equal(map.nodes.added.color, 'level-1');

    RMSLevelColors.setEnabled(map, false, ['level-1', 'level-2']);
    assert.equal(map.sameLevelColors, undefined);
    assert.equal(map.nodes.root.color, '#root');
    assert.equal(map.nodes.left.color, '#left');
    assert.equal(map.nodes.right.color, '#right');
    assert.equal(map.nodes.leftChild.color, undefined);
    assert.equal(map.nodes.rightChild.color, '#rightChild');
    assert.equal(map.nodes.deep.color, '#deep');
    assert.equal(map.nodes.added.color, '#new-original');
    Object.values(map.nodes).forEach((node) => assert.equal('defaultColor' in node, false));
  });

  test('JSON reload preserves enabled colours and allows a later restore', () => {
    const original = treeMap();
    RMSLevelColors.setEnabled(original, true, ['one', 'two']);
    const reloaded = JSON.parse(JSON.stringify(original));

    RMSLevelColors.apply(reloaded, ['one', 'two']);
    assert.equal(reloaded.sameLevelColors, true);
    assert.equal(reloaded.nodes.left.color, 'one');
    assert.equal(reloaded.nodes.leftChild.color, 'two');
    assert.equal(reloaded.nodes.deep.color, 'one');

    RMSLevelColors.setEnabled(reloaded, false, ['one', 'two']);
    assert.equal(reloaded.nodes.left.color, '#left');
    assert.equal(reloaded.nodes.leftChild.color, undefined);
    assert.equal(reloaded.nodes.deep.color, '#deep');
    assert.equal('sameLevelColors' in reloaded, false);
    Object.values(reloaded.nodes).forEach((node) => assert.equal('defaultColor' in node, false));
  });

  test('is cycle-safe and does not recolour a disconnected cycle', () => {
    const map = {
      rootId: 'root',
      sameLevelColors: true,
      nodes: {
        root: { id: 'root', color: '#root' },
        child: { id: 'child', parent: 'root', color: '#child' },
        cycle: { id: 'cycle', parent: 'cycle', color: '#cycle' },
      },
    };
    assert.doesNotThrow(() => RMSLevelColors.apply(map, ['level-1']));
    assert.equal(map.nodes.child.color, 'level-1');
    assert.equal(map.nodes.cycle.color, '#cycle');
    RMSLevelColors.setEnabled(map, false);
    assert.equal(map.nodes.child.color, '#child');
    assert.equal(map.nodes.cycle.color, '#cycle');
  });
});
