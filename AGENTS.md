# AGENTS

这是用户日常用的 MindSpark。macOS 浮层 App，快捷键默认 `⌃⌥⇧⌘Q`（Caps 当 Hyper 之后的 Q）。

旁边的 `../MindSpark` 是旧网页版，已经不维护。不要去那个仓库、也不要去 Chrome / `localhost:3000` 查用户反馈的 bug。

## 运行形态

- 壳：`macos/`（Swift 6 + `NSPanel` + `WKWebView`）
- 画布：`web/public/`，由 `web/server.js` 提供，地址 `http://127.0.0.1:3034/`
- 装好的包：`/Applications/Roc Mind Spark.app`
- 包内页面来自打包时拷进去的 `Contents/Resources/web/`。只改源码、不 `make install`，用户按快捷键打开的还是旧文件。

## 改完怎么生效

```bash
make install
```

`scripts/install-app.sh` 会杀掉旧进程、换包，再带 `--show` 把浮层拉起来。不要只让用户刷新浏览器，也不要停在「请再按一次快捷键」。改完必须重启 App。

## 该改哪

| 事情 | 目录 |
|---|---|
| 节点编辑、复制粘贴、Typeless、布局、主题 | `web/public/` |
| 弹出、热键、盖全屏、WKWebView 行为 | `macos/` |
| 节点里 Cmd+C/V、Typeless | 先看 `macos/`：这是 accessory + `.nonactivatingPanel`。Command 键和 AX 焦点会落到后面那个前台 App，只改 `web/public` 没用。 |
| 单测 | `web/test/`，`make test` |
