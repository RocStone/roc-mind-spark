// XSS hardening for every place app.js turns stored/imported text into HTML.
// Runs the REAL functions from public/app.js against a small spec-shaped DOM
// (helpers/mini-dom.mjs), since the repo has no jsdom.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadFns, extractConst } from './helpers/load-app-fns.mjs';
import { makeDocument } from './helpers/mini-dom.mjs';

const document = makeDocument();
const consts = {
  SAFE_TAGS: extractConst('SAFE_TAGS'),
  DROP_TAGS: extractConst('DROP_TAGS'),
  NOTES_TAGS: extractConst('NOTES_TAGS'),
  INLINE_HTML_RE: extractConst('INLINE_HTML_RE'),
  ENTITY_RE: extractConst('ENTITY_RE'),
  MATH_DELIM_RE: extractConst('MATH_DELIM_RE'),
  MD_PREVIEW_TAGS: extractConst('MD_PREVIEW_TAGS'),
};
const hasInlineMarkup = t => consts.INLINE_HTML_RE.test(t || '') || consts.ENTITY_RE.test(t || '');
// Stand-in for the real latexToMathML (which needs a dozen lookup tables):
// same contract — escaped literals inside a fixed MathML vocabulary.
const latexToMathML = (tex) => '<math><mi>' + String(tex).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</mi></math>';

const fns = loadFns([
  'escapeHtml', 'isSafeLinkUrl', 'sanitizeInlineHTML', 'sanitizeNotes', 'mdInlineToHtml',
  'mdInlineToHtmlWithMath', 'renderMdList', 'frontmatterFieldsToHtml', 'parseFrontmatterFields',
  'mdPreviewSanitize', 'mdToHtml',
], { document, latexToMathML, hasInlineMarkup, ...consts });

// Every element and attribute in `html`, as parsed by the same DOM.
function inventory(html){
  const tpl = document.createElement('template'); tpl.innerHTML = html;
  const tags = [], attrs = [];
  const walk = n => n.childNodes.forEach(c => {
    if(c.nodeType !== 1) return;
    tags.push(c.localName);
    c.attributes.forEach(a => attrs.push(c.localName + '.' + a.name + '=' + a.value));
    walk(c);
  });
  walk(tpl.content);
  return { tags, attrs };
}
function assertNoActiveContent(html){
  const { tags, attrs } = inventory(html);
  for(const a of attrs){
    assert.ok(!/\.on/i.test(a), `event handler survived: ${a}\n${html}`);
    assert.ok(!/javascript:/i.test(a), `javascript: URL survived: ${a}\n${html}`);
  }
  for(const t of tags) assert.ok(!['script', 'iframe', 'svg', 'object', 'embed', 'style'].includes(t), `dangerous tag survived: ${t}`);
}

describe('mdToHtml — Markdown preview / PDF output is whitelist-sanitized', () => {
  const vectors = [
    '<img src=x onerror=alert(1)>',
    '<img/src=x/onerror=1>',
    '<img src="x"/onerror=alert(1)>',
    'text <img src=x onerror=x> more',
    '<p onclick=alert(1)>hi</p>',
    '<div><svg/onload=alert(1)></div>',
    '<a href="javascript:alert(1)">x</a>',
    '<table><tr><td onmouseover=alert(1)>x</td></tr></table>',
    '- item <img src=x onerror=alert(1)>',
    '> quote <img src=x onerror=alert(1)>',
    '# Head <img src=x onerror=alert(1)>',
    '| a | b |\n| - | - |\n| <img src=x onerror=1> | 2 |',
    '[click](javascript:alert(1))',
    '[x](http://a.com" onclick="alert(1))',
    '![a](javascript:alert(1))',
  ];
  for(const v of vectors){
    test(`neutralizes ${JSON.stringify(v)}`, () => assertNoActiveContent(fns.mdToHtml(v)));
  }

  test('a normal heading, list, table, code block and link survive', () => {
    const html = fns.mdToHtml([
      '# Title',
      '',
      '- one **bold**',
      '- two',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '```',
      'x < y',
      '```',
      '',
      'see [docs](https://example.com/a?b=1&c=2) and ![pic](https://example.com/p.png)',
    ].join('\n'));
    const { tags, attrs } = inventory(html);
    for(const t of ['h1', 'ul', 'li', 'b', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'a', 'img', 'p']){
      assert.ok(tags.includes(t), `expected <${t}> in ${html}`);
    }
    assert.ok(attrs.includes('pre.class=mp-code'), 'code block keeps its preview class');
    assert.ok(attrs.includes('a.href=https://example.com/a?b=1&c=2'));
    assert.ok(attrs.includes('img.src=https://example.com/p.png'));
    assert.match(html, /x &lt; y/);
  });

  test('plain text with a literal "<" stays text', () => {
    const html = fns.mdToHtml('a <img src=x onerror=alert(1)> b');
    assert.deepEqual(inventory(html).tags, ['p']);
    assert.match(html, /&lt;img/);
  });

  test('math placeholders become MathML in text only', () => {
    const html = fns.mdToHtml('Energy $E=mc^2$ here');
    assert.match(html, /<math><mi>E=mc\^2<\/mi><\/math>/);
    assert.ok(!html.includes(''));
  });

  test('mailto links are kept, other schemes are left as literal text', () => {
    assert.match(fns.mdToHtml('[mail](mailto:a@b.c)'), /href="mailto:a@b.c"/);
    const html = fns.mdToHtml('[f](file:///etc/passwd)');
    assert.ok(!/<a /.test(html), html);
    assert.match(html, /\[f\]\(file:\/\/\/etc\/passwd\)/);
  });
});

describe('mdInlineToHtml — plain branch escapes "<"', () => {
  test('plain text without "<" is returned unchanged', () => {
    assert.equal(fns.mdInlineToHtml('Tom & Jerry "quoted"'), 'Tom & Jerry "quoted"');
  });
  test('"<" in plain text is escaped once', () => {
    assert.equal(fns.mdInlineToHtml('a <img src=x onerror=1>'), 'a &lt;img src=x onerror=1>');
  });
  test('already-escaped input (table cells) is not escaped twice', () => {
    assert.equal(fns.mdInlineToHtml('a &lt; b'), 'a &lt; b');
  });
  test('links only for http(s)/mailto', () => {
    assert.match(fns.mdInlineToHtml('[a](https://x.y)'), /<a href="https:\/\/x.y"/);
    assert.equal(fns.mdInlineToHtml('[a](javascript:alert(1))'), '[a](javascript:alert(1))');
  });
});

describe('sanitizeInlineHTML — node/notes sanitizer', () => {
  test('strips handlers, scripts and non-http links; keeps formatting', () => {
    const out = fns.sanitizeInlineHTML('<b onclick="x()">B</b><script>alert(1)</script><a href="javascript:1">l</a><img src=x onerror=1><span style="color:red;background:url(x)">c</span>');
    assertNoActiveContent(out);
    assert.match(out, /<b>B<\/b>/);
    assert.ok(!out.includes('<img'), 'img is not an inline node tag');
    assert.match(out, /<span style="color:red">c<\/span>/);
  });
  test('img is kept only with opts.img and a safe src', () => {
    assert.match(fns.sanitizeInlineHTML('<img src="/api/maps/x/img.png" alt="a">', ['img'], { img:true }), /<img src="\/api\/maps\/x\/img.png" alt="a">/);
    assert.equal(fns.sanitizeInlineHTML('<img src="javascript:1">', ['img'], { img:true }), '');
  });
});

describe('sanitizeMap — one gate for maps from imports, the store, share links and peers', () => {
  let n = 0;
  const { sanitizeMap } = loadFns(['escapeHtml', 'isSafeLinkUrl', 'safeColor', 'sanitizeInlineHTML', 'sanitizeNotes', '_sanitizeStoredHtml', 'sanitizeMapNode', 'sanitizeMap'], {
    document, hasInlineMarkup, ...consts,
    SAFE_COLOR_NAMES: extractConst('SAFE_COLOR_NAMES'),
    SAFE_NODE_ID_RE: extractConst('SAFE_NODE_ID_RE'),
    NODE_HTML_TAGS: extractConst('NODE_HTML_TAGS'),
    uid: () => 'fresh' + (++n),
  });
  const evil = () => ({
    id: 'm1', rootId: 'r"><img src=x onerror=1>', color: 'red;background:url(x)',
    nodes: {
      'r"><img src=x onerror=1>': { id: 'r"><img src=x onerror=1>', text: '<b onclick="alert(1)">Root</b><img src=x onerror=alert(1)>', color: '#fff" onmouseover="x' },
      a: { id: 'a', parent: 'r"><img src=x onerror=1>', text: 'plain <b>bold</b> &rarr; $x^2$', textColor: 'expression(alert(1))', highlight: '#ffee00',
           notes: '<h2>N</h2><p onmouseover="x">note</p><script>alert(1)</script>' },
      t: { id: 't', parent: 'a', html: '<table><thead><tr><th style="text-align:left" onclick="x">A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><a href="javascript:alert(1)">l</a></td></tr></tbody></table>' },
      c: { id: 'c', parent: 'a', html: '<pre><code>x &lt; y</code></pre>' },
      p: { id: 'p', parent: 'a', text: 'a < b & c <img src=x onerror=1>' },
    },
    links: [{ from: 'a', to: 'r"><img src=x onerror=1>' }, { from: 'a', to: 'bad"id' }],
  });

  test('unsafe node ids are remapped everywhere they are referenced', () => {
    const m = sanitizeMap(evil());
    const rid = m.rootId;
    assert.match(rid, /^[\w-]+$/);
    assert.ok(m.nodes[rid], 'root still resolves');
    assert.equal(m.nodes[rid].id, rid);
    assert.equal(m.nodes.a.parent, rid);
    assert.deepEqual(m.links, [{ from: 'a', to: rid }], 'dangling unsafe link dropped');
    for(const id of Object.keys(m.nodes)) assert.match(id, /^[\w-]+$/);
  });

  test('colors are validated', () => {
    const m = sanitizeMap(evil());
    assert.equal(m.color, '#e0613a');
    assert.equal(m.nodes[m.rootId].color, undefined);
    assert.equal(m.nodes.a.textColor, undefined);
    assert.equal(m.nodes.a.highlight, '#ffee00');
  });

  test('text / notes / html lose handlers and scripts but keep legitimate markup', () => {
    const m = sanitizeMap(evil());
    for(const n of Object.values(m.nodes)){
      for(const f of ['text', 'notes', 'html']){
        if(typeof n[f] === 'string' && (f !== 'text' || hasInlineMarkup(n[f]))) assertNoActiveContent(n[f]);
      }
    }
    assert.equal(m.nodes[m.rootId].text, '<b>Root</b>');
    assert.equal(m.nodes.a.text, 'plain <b>bold</b> &rarr; $x^2$', 'harmless HTML text keeps its exact bytes');
    assert.equal(m.nodes.a.notes, '<h2>N</h2><p>note</p>');
    assert.match(m.nodes.t.html, /<table><thead><tr><th style="text-align:left">A<\/th>/);
    assert.match(m.nodes.t.html, /<td><a target="_blank" rel="noopener noreferrer">l<\/a><\/td>/);
    assert.equal(m.nodes.c.html, '<pre><code>x &lt; y</code></pre>', 'code block untouched');
    assert.equal(m.nodes.p.text, 'a < b & c <img src=x onerror=1>', 'plain-text node stays plain text (it is rendered as text)');
  });

  test('a clean map comes back unchanged', () => {
    const clean = { id: 'm', rootId: 'r', color: '#e0613a', nodes: { r: { id: 'r', text: 'Root' }, a: { id: 'a', parent: 'r', text: '<i>x</i> &amp; y', notes: '<p>hi &amp; bye</p>', color: '#cfe0ee' } }, links: [] };
    const before = JSON.stringify(clean);
    assert.equal(JSON.stringify(sanitizeMap(clean)), before);
  });
});

describe('safeColor — only well-formed color literals reach style/fill attributes', () => {
  const { safeColor } = loadFns(['safeColor'], { SAFE_COLOR_NAMES: extractConst('SAFE_COLOR_NAMES') });
  test('accepts hex, rgb/rgba/hsl and a few names', () => {
    for(const c of ['#fff', '#FFFFFF', '#e0613a', '#11223344', 'rgb(1, 2, 3)', 'rgba(1,2,3,.5)', 'hsl(120 50% 40%)', 'hsla(120, 50%, 40%, 0.3)', 'red', 'transparent']){
      assert.equal(safeColor(c), c, c);
    }
  });
  test('rejects anything that could break out of an attribute or load a resource', () => {
    for(const c of ['red" onmouseover="alert(1)', '#fff;background:url(x)', 'url(javascript:1)', 'expression(alert(1))', 'var(--x)', '#ggg', 'rgb(1,2)', '', null, 42, {}]){
      assert.equal(safeColor(c), '', String(c));
    }
  });
});
