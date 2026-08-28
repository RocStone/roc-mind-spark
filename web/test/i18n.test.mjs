import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'public', 'i18n.js'), 'utf8');

function load(storage = {}) {
  const localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
  };
  const document = {
    documentElement: { lang: 'en', classList: { remove() {}, add() {} } },
    readyState: 'complete',
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { dispatchEvent() {} };
  const ctx = { window, document, localStorage, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } } };
  ctx.window = Object.assign(ctx.window, ctx);
  vm.runInNewContext(src, ctx);
  return { ctx, storage };
}

describe('i18n', () => {
  test('defaults to English', () => {
    const { ctx } = load();
    assert.equal(ctx.window.rmsLang(), 'en');
    assert.equal(ctx.window.rmsT('settings'), 'Settings');
    assert.equal(ctx.window.rmsT('showHide'), 'Show / hide');
    assert.equal(ctx.window.rmsT('imgPasting'), 'Pasting…');
  });

  test('switching to Chinese updates strings and persists', () => {
    const { ctx, storage } = load();
    ctx.window.rmsSetLang('zh');
    assert.equal(storage['rms:lang'], 'zh');
    assert.equal(ctx.window.rmsLang(), 'zh');
    assert.equal(ctx.window.rmsT('settings'), '设置');
    assert.equal(ctx.window.rmsT('showHide'), '显示 / 隐藏');
    assert.equal(ctx.window.rmsT('imgPasting'), '正在粘贴');
  });

  test('switching back to English restores the default locale', () => {
    const { ctx } = load({ 'rms:lang': 'zh' });
    assert.equal(ctx.window.rmsT('language'), '语言');
    ctx.window.rmsSetLang('en');
    assert.equal(ctx.window.rmsLang(), 'en');
    assert.equal(ctx.window.rmsT('language'), 'Language');
  });

  test('en and zh dictionaries have the same keys', () => {
    const { ctx } = load();
    const { en, zh } = ctx.window.rmsI18nKeys();
    assert.deepEqual(en, zh);
  });

  test('button labels match settings names', () => {
    const { ctx } = load();
    ctx.window.rmsSetLang('zh');
    const t = ctx.window.rmsT;
    assert.equal(t('actChild'), t('scAddChild'));
    assert.equal(t('actSibling'), t('scAddSibling'));
    assert.equal(t('actEdit'), t('scEditNode'));
    assert.equal(t('actDel'), t('scDeleteNode'));
    assert.equal(t('actCollapse'), t('scCollapse'));
    assert.equal(t('idAddChild'), t('scAddChild'));
    ctx.window.rmsSetLang('en');
    assert.equal(t('actChild'), t('scAddChild'));
    assert.equal(t('actSibling'), t('scAddSibling'));
    assert.equal(t('scAddSiblingMod'), 'Add sibling (⌘↩)');
  });

  test('Chinese mode does not fall back to English for chrome titles', () => {
    const { ctx } = load();
    ctx.window.rmsSetLang('zh');
    const t = ctx.window.rmsT;
    assert.equal(t('scAddChild'), '添加子节点');
    assert.equal(t('actBold'), '粗体');
    assert.equal(t('addChildBtn'), '＋ 子节点');
    assert.equal(t('themeColour'), '颜色主题');
    assert.equal(t('hrefSave'), '保存');
  });
});
