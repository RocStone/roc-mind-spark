// buildMapFromSpec() is reached from the PUBLIC, unauthenticated /api/import
// endpoint, so it is the app's main untrusted-input surface. These tests pin
// down its validation rules and confirm hostile input can't corrupt the runtime.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMapFromSpec } from '../worker/import-core.js';

const spec = (over = {}) => ({
  title: 'Test map',
  nodes: [
    { id: 'r', text: 'Root', parent: null },
    { id: 'a', text: 'Child A', parent: 'r' },
  ],
  ...over,
});

describe('buildMapFromSpec — rejects malformed input', () => {
  const bad = [
    ['null body', null],
    ['a string body', 'not an object'],
    ['a number body', 42],
    ['no nodes key', { title: 'x' }],
    ['an empty nodes array', { nodes: [] }],
    ['nodes not an array', { nodes: 'nope' }],
  ];
  for (const [label, input] of bad) {
    test(`throws on ${label}`, () => {
      assert.throws(() => buildMapFromSpec(input));
    });
  }

  test('throws when a node has no id', () => {
    assert.throws(() => buildMapFromSpec({ nodes: [{ text: 'x', parent: null }] }), /non-empty string id/);
  });

  test('throws when a node is missing text', () => {
    assert.throws(() => buildMapFromSpec({ nodes: [{ id: 'r', parent: null }] }), /missing text/);
  });

  test('throws on duplicate node ids', () => {
    const s = { nodes: [{ id: 'r', text: 'a', parent: null }, { id: 'r', text: 'b', parent: 'r' }] };
    assert.throws(() => buildMapFromSpec(s), /duplicate node id/);
  });

  test('throws when a node points at a parent that does not exist', () => {
    const s = { nodes: [{ id: 'r', text: 'a', parent: null }, { id: 'b', text: 'b', parent: 'ghost' }] };
    assert.throws(() => buildMapFromSpec(s), /missing parent/);
  });

  test('throws when rootId names a node that does not exist', () => {
    assert.throws(() => buildMapFromSpec(spec({ rootId: 'ghost' })), /rootId does not match/);
  });

  test('throws when there is more than one parent-less node and no rootId', () => {
    const s = { nodes: [{ id: 'a', text: 'a', parent: null }, { id: 'b', text: 'b', parent: null }] };
    assert.throws(() => buildMapFromSpec(s), /exactly one root/);
  });

  test('throws on a node that is its own parent', () => {
    const s = { rootId: 'r', nodes: [{ id: 'r', text: 'r', parent: null }, { id: 'a', text: 'a', parent: 'a' }] };
    assert.throws(() => buildMapFromSpec(s));
  });

  test('detects a parent cycle rather than hanging forever', () => {
    // a -> b -> a never reaches the root; without the hop guard this loops.
    const s = {
      rootId: 'r',
      nodes: [
        { id: 'r', text: 'r', parent: null },
        { id: 'a', text: 'a', parent: 'b' },
        { id: 'b', text: 'b', parent: 'a' },
      ],
    };
    assert.throws(() => buildMapFromSpec(s), /cycle detected/);
  });
});

describe('buildMapFromSpec — builds a valid map', () => {
  test('produces the expected shape', () => {
    const m = buildMapFromSpec(spec());
    assert.equal(m.rootId, 'r');
    assert.equal(m.title, 'Test map');
    assert.equal(m.layout, 'balanced');
    assert.equal(Object.keys(m.nodes).length, 2);
    assert.equal(m.nodes.r.parent, null, 'root must have a null parent');
    assert.equal(m.nodes.r.side, 'root');
  });

  test('falls back to a default title when none is usable', () => {
    assert.equal(buildMapFromSpec(spec({ title: '   ' })).title, 'Imported map');
    assert.equal(buildMapFromSpec(spec({ title: 42 })).title, 'Imported map');
  });

  test('infers the root from the single parent-less node', () => {
    assert.equal(buildMapFromSpec({ nodes: [{ id: 'solo', text: 'x', parent: null }] }).rootId, 'solo');
  });

  test('balances root children — first half right, second half left', () => {
    const nodes = [{ id: 'r', text: 'r', parent: null }];
    for (let i = 0; i < 5; i++) nodes.push({ id: 'c' + i, text: 'c', parent: 'r' });
    const m = buildMapFromSpec({ rootId: 'r', nodes });
    const sides = ['c0', 'c1', 'c2', 'c3', 'c4'].map(id => m.nodes[id].side);
    assert.deepEqual(sides, ['right', 'right', 'right', 'left', 'left']);
  });

  test('keeps only links whose endpoints both exist', () => {
    const m = buildMapFromSpec(spec({
      links: [
        { from: 'r', to: 'a', label: 'ok' },
        { from: 'r', to: 'ghost' },   // dropped
        null,                          // dropped
      ],
    }));
    assert.equal(m.links.length, 1);
    assert.equal(m.links[0].label, 'ok');
  });

  test('carries through optional formatting without inventing values', () => {
    const m = buildMapFromSpec({
      rootId: 'r',
      nodes: [
        { id: 'r', text: 'r', parent: null },
        { id: 'a', text: 'a', parent: 'r', bold: true, task: 'done', listType: 'ul', align: 'right' },
        { id: 'b', text: 'b', parent: 'r' },
      ],
    });
    assert.equal(m.nodes.a.bold, true);
    assert.equal(m.nodes.a.task, 'done');
    assert.equal(m.nodes.a.listType, 'ul');
    assert.equal(m.nodes.b.bold, undefined, 'flags must not be set on nodes that did not ask for them');
  });

  test('ignores an invalid task value rather than storing it', () => {
    const m = buildMapFromSpec({
      rootId: 'r',
      nodes: [{ id: 'r', text: 'r', parent: null }, { id: 'a', text: 'a', parent: 'r', task: 'bogus' }],
    });
    assert.equal(m.nodes.a.task, undefined);
  });

  test('normalises a citation and marks the node as a reference', () => {
    const m = buildMapFromSpec({
      rootId: 'r',
      nodes: [{
        id: 'r', text: 'r', parent: null,
        citation: { authors: ['Smith', 'Jones'], year: 2024, title: 'A Study', doi: '10.1/x' },
      }],
    });
    assert.equal(m.nodes.r.citation.authors, 'Smith, Jones');
    assert.equal(m.nodes.r.ref, true);
  });

  test('an arXiv id becomes a doi and implies the arXiv source', () => {
    const m = buildMapFromSpec({
      rootId: 'r',
      nodes: [{ id: 'r', text: 'r', parent: null, citation: { arxiv: '2401.00001' } }],
    });
    assert.equal(m.nodes.r.citation.doi, 'arXiv:2401.00001');
    assert.equal(m.nodes.r.citation.source, 'arXiv');
  });
});

describe('buildMapFromSpec — hostile input', () => {
  test('a __proto__ key in the spec does not pollute Object.prototype', () => {
    const payload = JSON.parse(
      '{"title":"evil","nodes":[{"id":"r","text":"r","parent":null}],"__proto__":{"polluted":"yes"}}'
    );
    buildMapFromSpec(payload);
    assert.equal({}.polluted, undefined, 'Object.prototype must be untouched');
  });

  test('a __proto__ key inside a node does not pollute Object.prototype', () => {
    const payload = JSON.parse(
      '{"nodes":[{"id":"r","text":"r","parent":null,"__proto__":{"polluted2":"yes"}}]}'
    );
    buildMapFromSpec(payload);
    assert.equal({}.polluted2, undefined);
  });

  test('a node id of "__proto__" does not corrupt the nodes map', () => {
    const m = buildMapFromSpec({
      rootId: '__proto__',
      nodes: [{ id: '__proto__', text: 'sneaky', parent: null }],
    });
    assert.equal({}.text, undefined, 'writing that id must not reach Object.prototype');
    assert.equal(typeof m.nodes, 'object');
  });

  test('text is coerced to a string rather than kept as an object', () => {
    const m = buildMapFromSpec({ nodes: [{ id: 'r', text: 'plain', parent: null }] });
    assert.equal(typeof m.nodes.r.text, 'string');
  });
});
