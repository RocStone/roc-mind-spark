import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns } from './helpers/load-app-fns.mjs';

const {
  splitPipeRow,
  isGfmSepLine,
  parseGfmMarkdownTable,
  parseDelimitedTable,
  parseFlatCopiedTable,
  parseMarkdownTable,
  markdownTableToHtml,
} = loadFns([
  'splitPipeRow',
  'isGfmSepLine',
  'normalizeTableGrid',
  'parseGfmMarkdownTable',
  'parseDelimitedTable',
  'parseFlatCopiedTable',
  'parseMarkdownTable',
  'markdownTableToHtml',
]);

const messyCopied = [
  ['层','probe mass','probe lift','curr_hallu mass','curr_hallu lift','curr_sent mass','curr_sent lift','prev_hallu mass','prev_hallu lift','prev_resp mass','prev_resp lift','prompt mass','prompt lift'].join('\t'),
  'L3','0.100','81.3','0.028','1.523','0.030','1.920','0.007','0.798','0.115','1.388','0.720','0.842',
  'L7','0.121','100.5','0.043','2.357','0.046','3.054','0.006','0.689','0.082','1.021','0.702','0.821',
  'L11','0.281','236.5','0.030','1.619','0.036','2.325','0.004','0.391','0.053','0.682','0.596','0.696',
  'L15','0.096','81.1','0.121','6.903','0.109','7.047','0.009','1.042','0.089','1.074','0.576','0.672',
  'L19','0.383','318.2','0.122','7.191','0.082','5.149','0.005','0.500','0.041','0.504','0.367','0.431',
  'L23','0.646','534.2','0.049','2.837','0.043','2.847','0.004','0.444','0.040','0.489','0.218','0.255',
  'L27','0.403','334.1','0.051','2.895','0.045','2.842','0.007','0.805','0.076','0.958','0.418','0.489',
  'L31','0.455','375.5','0.033','1.746','0.031','1.984','0.006','0.706','0.071','0.881','0.404','0.473',
].join('\n');

describe('parseMarkdownTable — GFM', () => {
  test('reads a standard pipe table', () => {
    const g = parseMarkdownTable('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |');
    assert.deepEqual(g.headers, ['A', 'B']);
    assert.deepEqual(g.rows, [['1', '2'], ['3', '4']]);
  });

  test('reads a pipe table without outer pipes', () => {
    const g = parseGfmMarkdownTable('A | B | C\n--- | --- | ---\nx | y | z');
    assert.deepEqual(g.headers, ['A', 'B', 'C']);
    assert.deepEqual(g.rows, [['x', 'y', 'z']]);
  });

  test('splitPipeRow keeps empty cells', () => {
    assert.deepEqual(splitPipeRow('| a | | b |'), ['a', '', 'b']);
  });

  test('isGfmSepLine accepts alignment markers', () => {
    assert.equal(isGfmSepLine('| :--- | ---: | --- |'), true);
    assert.equal(isGfmSepLine('| A | B |'), false);
  });
});

describe('parseMarkdownTable — copied / messy', () => {
  test('reads a TSV table', () => {
    const g = parseDelimitedTable(['A\tB\tC', '1\t2\t3', '4\t5\t6'], '\t');
    assert.deepEqual(g.headers, ['A', 'B', 'C']);
    assert.deepEqual(g.rows, [['1', '2', '3'], ['4', '5', '6']]);
  });

  test('reads a header-with-tabs then one-cell-per-line paste', () => {
    const g = parseMarkdownTable(messyCopied);
    assert.ok(g);
    assert.equal(g.headers.length, 13);
    assert.equal(g.headers[0], '层');
    assert.equal(g.headers[1], 'probe mass');
    assert.equal(g.rows.length, 8);
    assert.equal(g.rows[0][0], 'L3');
    assert.equal(g.rows[0][2], '81.3');
    assert.equal(g.rows[7][0], 'L31');
    assert.equal(g.rows[7][12], '0.473');
  });

  test('rejects a single column of notes', () => {
    assert.equal(parseMarkdownTable('hello\nworld\n'), null);
  });
});

describe('markdownTableToHtml', () => {
  test('escapes cells and builds thead/tbody', () => {
    const html = markdownTableToHtml({ headers: ['A', 'B<'], rows: [['1', '2&']] });
    assert.match(html, /<thead>/);
    assert.match(html, /<th>B&lt;<\/th>/);
    assert.match(html, /<td>2&amp;<\/td>/);
  });
});
