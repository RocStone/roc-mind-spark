// 内置模板的中文覆盖层（web/public/templates.zh.js）必须覆盖 templates.js 的
// 每个模板、每个节点 k；合并后结构不变，只换文字。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractConst, loadFns } from './helpers/load-app-fns.mjs';

const TEMPLATES = extractConst('TEMPLATES');
const TEMPLATES_ZH = extractConst('TEMPLATES_ZH');
const { mergeTemplateZh } = loadFns(['mergeTemplateZh']);

// 中英文完全相同也算翻译到位的文字：代码标识符、缩写、专有名词。
const SAME_AS_EN_OK = new Set([
  'function_name',
]);

const hasCjk = s => /[一-鿿]/.test(s);

test('每个内置模板都有中文 name 和 desc', () => {
  const ids = Object.keys(TEMPLATES);
  assert.ok(ids.length >= 50, `expected ~50 templates, got ${ids.length}`);
  for (const id of ids) {
    const zh = TEMPLATES_ZH[id];
    assert.ok(zh, `TEMPLATES_ZH 缺少模板 ${id}`);
    assert.ok(zh.name && hasCjk(zh.name), `${id}.name 没有中文`);
    assert.ok(zh.desc && hasCjk(zh.desc), `${id}.desc 没有中文`);
  }
});

test('TEMPLATES_ZH 没有多余的模板或节点 key', () => {
  for (const [id, zh] of Object.entries(TEMPLATES_ZH)) {
    assert.ok(TEMPLATES[id], `TEMPLATES_ZH.${id} 在 TEMPLATES 里不存在`);
    const ks = new Set(TEMPLATES[id].nodes.map(n => n.k));
    for (const k of Object.keys(zh.nodes || {})) {
      assert.ok(ks.has(k), `TEMPLATES_ZH.${id}.nodes.${k} 在英文模板里不存在`);
    }
  }
});

test('每个节点 k 都有中文 text，且不与英文相同（白名单除外）', () => {
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    const zn = TEMPLATES_ZH[id].nodes || {};
    for (const n of tpl.nodes) {
      const z = zn[n.k];
      assert.ok(z && typeof z.text === 'string', `${id}.${n.k} 缺少中文 text`);
      if (n.text === '') {
        // 块节点（如 frontmatter 表格）靠 html 显示，text 本来就是空的。
        assert.equal(z.text, '', `${id}.${n.k} 英文 text 为空，中文也应为空`);
        if (n.html) assert.ok(z.html && hasCjk(z.html), `${id}.${n.k} 缺少中文 html`);
        continue;
      }
      assert.notEqual(z.text.trim(), '', `${id}.${n.k} 中文 text 为空`);
      if (z.text === n.text) {
        assert.ok(SAME_AS_EN_OK.has(z.text), `${id}.${n.k} 未翻译：「${z.text}」`);
      } else {
        assert.ok(hasCjk(z.text), `${id}.${n.k} 看起来不是中文：「${z.text}」`);
      }
      if (n.notes) {
        assert.ok(z.notes && hasCjk(z.notes), `${id}.${n.k} 缺少中文 notes`);
        const tags = s => (s.match(/<\/?[a-z]+/g) || []).join(',');
        assert.equal(tags(z.notes), tags(n.notes), `${id}.${n.k} notes 的 HTML 标签与英文不一致`);
      }
    }
  }
});

test('mergeTemplateZh 只换文字，节点数量和结构不变', () => {
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    const merged = mergeTemplateZh(tpl, TEMPLATES_ZH[id]);
    assert.equal(merged.nodes.length, tpl.nodes.length, `${id} 节点数变了`);
    assert.equal(merged.name, TEMPLATES_ZH[id].name);
    assert.equal(merged.color, tpl.color);
    assert.equal(merged.group, tpl.group);
    assert.deepEqual(merged.links, tpl.links);
    merged.nodes.forEach((m, i) => {
      const n = tpl.nodes[i];
      assert.equal(m.k, n.k);
      assert.equal(m.parent, n.parent);
      assert.equal(m.task, n.task);
      assert.equal(m.frontmatter, n.frontmatter);
      assert.equal(m.text, TEMPLATES_ZH[id].nodes[n.k].text);
    });
  }
  // 英文模板本身不能被改动。
  assert.equal(TEMPLATES.agent_architecture.nodes[0].text, 'AI Agent Architecture');
});

test('没有中文覆盖时 mergeTemplateZh 原样返回（用户自存模板）', () => {
  const user = { name: 'Mine', desc: 'x', nodes: [{ k: 'root', text: 'Hello' }], _user: true };
  assert.equal(mergeTemplateZh(user, undefined), user);
});

test('templateForLang 按界面语言返回中文或英文，用户模板不动', () => {
  const user = { name: 'Mine', desc: 'x', nodes: [{ k: 'root', text: 'Hello' }], _user: true };
  const all = { ...TEMPLATES, user_1: user };
  const load = lang => loadFns(['templateForLang', 'templateUiIsZh', 'mergeTemplateZh'],
    { TEMPLATES: all, TEMPLATES_ZH, window: { rmsLang: () => lang } }).templateForLang;
  const zh = load('zh'), en = load('en');
  assert.equal(zh('swot').name, 'SWOT 分析');
  assert.equal(zh('swot').nodes[1].text, '优势');
  assert.match(zh('claude_skill').nodes[1].html, /字段/);
  assert.equal(en('swot'), TEMPLATES.swot);
  assert.equal(zh('user_1'), user);
  assert.equal(zh('nope'), undefined);
});
