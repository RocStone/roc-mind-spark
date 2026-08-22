/* Interface language. Default English. Canvas editor strings from upstream
   MindSpark stay English; chrome, settings, and native menus follow this. */
(function () {
  const KEY = 'rms:lang';
  const EN = 'en';
  const ZH = 'zh';

  const dict = {
    en: {
      brand: 'Roc Mind Spark',
      newMap: '＋ New mind map',
      newMapMenu: 'Start from a template',
      yourMaps: 'Your maps',
      footerHtml: 'Based on MindSpark · <b>MIT</b>',
      github: 'GitHub',
      githubTitle: 'View source on GitHub',
      reportBug: 'Report bug',
      reportBugTitle: 'Report an issue',
      toggleSide: 'Toggle sidebar',
      untitled: 'Untitled map',
      undo: 'Undo (⌘Z)',
      redo: 'Redo (⌘⇧Z)',
      addTopic: 'Add child (Tab)',
      tidyLayout: 'Tidy layout (rearrange topics into a balanced tree)',
      collapseAll: 'Collapse / expand all branches, one level per click',
      markdownMode: 'Markdown mode — edit as text with live preview',
      findPlaceholder: 'Find in nodes…',
      searchAllMaps: 'Search across all maps',
      toggleReplace: 'Toggle replace (⌘H)',
      replacePlaceholder: 'Replace with…',
      replace: 'Replace',
      replaceAll: 'All',
      search: 'Search',
      variables: 'Map variables — set {{placeholder}} defaults',
      theme: 'Theme',
      export: 'Export',
      focusMode: 'Focus mode (Esc to exit)',
      settingsTitle: 'Settings (⌘,)',
      emptyTitle: 'A blank canvas',
      emptyBody: 'Create your first mind map and start branching ideas. Everything saves automatically.',
      emptyCreate: '＋ Create a map',
      zoomFit: 'Fit all topics to screen (camera only)',
      minimap: 'Overview — click to jump',
      hintHtml: '<b>⌘+drag</b> box-select · <b>drag</b> move / nest / reorder · <b>Tab</b> child · <b>Enter</b> sibling · <b>↑↓←→</b> navigate · <b>F2</b>/dbl-click edit · <b>L</b> link · <b>Del</b> remove · <b>?</b> all shortcuts',
      saved: 'Saved',

      settings: 'Settings',
      settingsSub: '⌘, opens settings while the overlay is up. Show / hide is the only global hotkey (default Caps + Q if Caps Lock is Hyper).',
      close: 'Close',
      language: 'Language',
      startup: 'Startup',
      launchAtLogin: 'Launch at login',
      overlay: 'Overlay',
      showHide: 'Show / hide',
      canvas: 'Canvas',
      buttonShortcuts: 'Button shortcuts',
      buttonShortcutsHelp: 'Right-click any button → Add custom shortcut. Example: bind Todo to ⌘L and tap it to cycle states.',
      noButtonShortcuts: 'No button shortcuts yet',
      pressKey: 'Press a key…',
      notSet: 'Not set',
      addShortcut: 'Add custom shortcut',
      changeShortcut: 'Change shortcut…',
      clear: 'Clear',
      shortcutNeedsMod: 'Button shortcuts need ⌘ / ⌃ / ⌥',
      btn: 'Button',

      scOpenSettings: 'Open settings',
      scAddChild: 'Add child',
      scAddSibling: 'Add sibling',
      scEditNode: 'Edit node',
      scDeleteNode: 'Delete node',
      scCollapse: 'Collapse / expand',
      scLink: 'Cross-link',
      scUndo: 'Undo',
      scRedo: 'Redo',
      scFind: 'Find',
      scHelp: 'Shortcut list',

      actTask: 'Todo state',
      actChild: 'Add child',
      actSibling: 'Add sibling',
      actEdit: 'Edit',
      actDel: 'Delete',
      actCollapse: 'Collapse',
      actNotes: 'Notes',
      actMarker: 'Marker',
      actCite: 'Cite',
      actImage: 'Image',
      actBold: 'Bold',
      actItalic: 'Italic',
      actStrike: 'Strikethrough',
      actUnderline: 'Underline',
      actUl: 'Bulleted list',
      actOl: 'Numbered list',
      idSettings: 'Settings',
      idAddChild: 'Add topic',
      idUndo: 'Undo',
      idRedo: 'Redo',
      idSearch: 'Search',
      idLayout: 'Tidy layout',
      idCollapseAll: 'Collapse all',
      idMarkdown: 'Markdown',
      idTheme: 'Theme',
      idExport: 'Export',
      idFocus: 'Focus',
      idNewMap: 'New map',

      kbTitle: 'Keyboard shortcuts',
      kbFootHtml: 'Press <kbd>?</kbd> any time to open this list.',
      kbBuilding: 'Building the map',
      kbNav: 'Navigation',
      kbEditing: 'Editing text',
      kbHistory: 'History',
      kbAddChild: 'Add a child node',
      kbAddSibling: 'Add a sibling node',
      kbMoveSibling: 'Move / swap sibling node up / down',
      kbMoveSiblingAlt: 'Same, if Option is taken by the OS',
      kbEdit: 'Edit the selected node',
      kbRemove: 'Remove the selected node',
      kbCollapse: 'Collapse / expand',
      kbLink: 'Cross-link to another node',
      kbDrag: 'Move a topic (subtree follows)',
      kbNest: 'Nest it as a child of that topic',
      kbReorder: 'Insert as a sibling / reorder',
      kbBox: 'Box-select topics',
      kbMulti: 'Add / remove a topic from the selection',
      kbDragSel: 'Move the selected topics together',
      kbArrows: 'Move selection between nodes',
      kbScroll: 'Zoom canvas (mouse) / two-finger pinch (trackpad)',
      kbPan: 'Pan the map',
      kbFormat: 'Bold / italic / underline the selection',
      kbLists: 'Make each selected line a bullet',
      kbSaveChild: 'Save and add a child node',
      kbSaveSibling: 'Save and add a sibling node',
      kbNewline: 'Newline within the node text',
      kbEsc: 'Cancel an edit / close a popup',
      kbUndo: 'Undo',
      kbRedo: 'Redo',
    },
    zh: {
      brand: 'Roc Mind Spark',
      newMap: '＋ 新建思维导图',
      newMapMenu: '从模板开始',
      yourMaps: '你的图',
      footerHtml: '基于 MindSpark · <b>MIT</b>',
      github: 'GitHub',
      githubTitle: '在 GitHub 查看源码',
      reportBug: '反馈问题',
      reportBugTitle: '报告问题',
      toggleSide: '展开 / 收起侧栏',
      untitled: '未命名',
      undo: '撤销 (⌘Z)',
      redo: '重做 (⌘⇧Z)',
      addTopic: '添加子节点 (Tab)',
      tidyLayout: '整理布局',
      collapseAll: '全部折叠 / 展开（每点一层）',
      markdownMode: 'Markdown 模式',
      findPlaceholder: '在节点中查找…',
      searchAllMaps: '在所有图中搜索',
      toggleReplace: '替换 (⌘H)',
      replacePlaceholder: '替换为…',
      replace: '替换',
      replaceAll: '全部',
      search: '查找',
      variables: '图变量 — 设置 {{占位符}} 默认值',
      theme: '主题',
      export: '导出',
      focusMode: '专注模式（Esc 退出）',
      settingsTitle: '设置 (⌘,)',
      emptyTitle: '空白画布',
      emptyBody: '新建一张思维导图，开始往外长。内容会自动保存。',
      emptyCreate: '＋ 新建图',
      zoomFit: '缩放到全部可见',
      minimap: '总览 — 点击跳转',
      hintHtml: '<b>⌘+拖拽</b> 框选 · <b>拖拽</b> 移动 / 嵌套 / 排序 · <b>Tab</b> 子节点 · <b>Enter</b> 同级 · <b>↑↓←→</b> 移动选中 · <b>F2</b>/双击 编辑 · <b>L</b> 连线 · <b>Del</b> 删除 · <b>?</b> 全部快捷键',
      saved: '已保存',

      settings: '设置',
      settingsSub: '浮层打开时 ⌘, 打开设置。显示 / 隐藏是唯一的全局快捷键（Caps 映射成 Hyper 时默认 Caps + Q）。',
      close: '关闭',
      language: '语言',
      startup: '启动',
      launchAtLogin: '登录时启动',
      overlay: '浮层',
      showHide: '显示 / 隐藏',
      canvas: '画布',
      buttonShortcuts: '按钮快捷键',
      buttonShortcutsHelp: '在任意按钮上右键 → 添加自定义快捷键。例如把 Todo 绑成 ⌘L，每按一次就切换一档。',
      noButtonShortcuts: '还没有按钮快捷键',
      pressKey: '按下新按键…',
      notSet: '未设置',
      addShortcut: '添加自定义快捷键',
      changeShortcut: '更改快捷键…',
      clear: '清除',
      shortcutNeedsMod: '按钮快捷键需要带 ⌘ / ⌃ / ⌥',
      btn: '按钮',

      scOpenSettings: '打开设置',
      scAddChild: '添加子节点',
      scAddSibling: '添加同级节点',
      scEditNode: '编辑节点',
      scDeleteNode: '删除节点',
      scCollapse: '折叠 / 展开',
      scLink: '交叉连接',
      scUndo: '撤销',
      scRedo: '重做',
      scFind: '查找',
      scHelp: '快捷键列表',

      actTask: 'Todo 状态',
      actChild: '添加子节点',
      actSibling: '添加同级',
      actEdit: '编辑',
      actDel: '删除',
      actCollapse: '折叠',
      actNotes: '笔记',
      actMarker: '标记',
      actCite: '引用',
      actImage: '图片',
      actBold: '粗体',
      actItalic: '斜体',
      actStrike: '删除线',
      actUnderline: '下划线',
      actUl: '无序列表',
      actOl: '有序列表',
      idSettings: '设置',
      idAddChild: '添加主题',
      idUndo: '撤销',
      idRedo: '重做',
      idSearch: '查找',
      idLayout: '整理布局',
      idCollapseAll: '全部折叠',
      idMarkdown: 'Markdown',
      idTheme: '主题',
      idExport: '导出',
      idFocus: '专注',
      idNewMap: '新建图',

      kbTitle: '键盘快捷键',
      kbFootHtml: '随时按 <kbd>?</kbd> 打开这份列表。',
      kbBuilding: '搭建导图',
      kbNav: '导航',
      kbEditing: '编辑文字',
      kbHistory: '历史',
      kbAddChild: '添加子节点',
      kbAddSibling: '添加同级节点',
      kbMoveSibling: '上移 / 下移同级节点',
      kbMoveSiblingAlt: '若 Option 被系统占用，用这一组',
      kbEdit: '编辑选中节点',
      kbRemove: '删除选中节点',
      kbCollapse: '折叠 / 展开',
      kbLink: '连接到另一个节点',
      kbDrag: '移动节点（子树跟着走）',
      kbNest: '拖到中心：变成它的子节点',
      kbReorder: '拖到上 / 下边缘：插入同级或排序',
      kbBox: '框选节点',
      kbMulti: '把节点加入 / 移出多选',
      kbDragSel: '一起移动选中的节点',
      kbArrows: '在节点间移动选中',
      kbScroll: '滚轮缩放 / 触控板双指捏合',
      kbPan: '平移画布',
      kbFormat: '加粗 / 斜体 / 下划线',
      kbLists: '把选中的每一行变成列表项',
      kbSaveChild: '保存并添加子节点',
      kbSaveSibling: '保存并添加同级节点',
      kbNewline: '在节点内换行',
      kbEsc: '取消编辑 / 关闭弹层',
      kbUndo: '撤销',
      kbRedo: '重做',
    },
  };

  function normalize(raw) {
    if (raw === ZH || raw === 'zh-CN' || raw === 'zh-Hans') return ZH;
    return EN;
  }

  function stored() {
    try {
      return normalize(localStorage.getItem(KEY) || EN);
    } catch (e) {
      return EN;
    }
  }

  function t(key) {
    const lang = stored();
    return (dict[lang] && dict[lang][key]) || dict[EN][key] || key;
  }

  function applyLangClass(lang) {
    document.documentElement.lang = lang === ZH ? 'zh-CN' : 'en';
    document.documentElement.classList.remove('lang-en', 'lang-zh');
    document.documentElement.classList.add('lang-' + lang);
  }

  function apply() {
    const lang = stored();
    applyLangClass(lang);
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => {
      el.innerHTML = t(el.getAttribute('data-i18n-html'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  function setLang(next) {
    const lang = normalize(next);
    try { localStorage.setItem(KEY, lang); } catch (e) {}
    apply();
    try {
      window.webkit.messageHandlers.rmsNative.postMessage({ op: 'setLanguage', lang: lang });
    } catch (e) {}
    window.dispatchEvent(new CustomEvent('rms-lang', { detail: lang }));
  }

  window.rmsT = t;
  window.rmsLang = stored;
  window.rmsSetLang = setLang;
  window.rmsApplyI18n = apply;

  applyLangClass(stored());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }
})();
