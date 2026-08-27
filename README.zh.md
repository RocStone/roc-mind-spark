# Roc Mind Spark

[English](README.md) · [中文](README.zh.md)

macOS **原生浮层**思维导图。任意 App、任意桌面、任意全屏 Space 上按全局快捷键，导图盖在当前画面上。记完收起，继续干活。这不是网站，也不是浏览器标签。

画布来自 Prasad Patil 的 [MindSpark](https://github.com/prasadpatil25/MindSpark)（MIT）。Roc Mind Spark 用 Swift 6 / AppKit / `NSPanel` / `WKWebView` 包了一层壳，并在 `127.0.0.1:3034` 拉起本地 Node 服务。

**只支持 Apple Silicon 上的 macOS 14+。** v1.0.0 下载版是 arm64 构建，不能在 Intel Mac 上运行。Windows、Linux、Docker、Cloudflare Pages/Workers、GitHub Pages，以及单独的网页产品，**都不是**本产品的受支持发行方式。

## 能做什么

- 在当前 Space 上唤出完整思维导图画布
- 编辑节点、子树、Markdown 模式、模板和布局
- 全局快捷键、菜单栏图标、登录时启动
- 应用内 English / 中文，作用在界面，不翻译你在节点里写的字
- 地图自动保存到本机 SQLite

## 30 秒上手

下载版和源码版都要求这台 Mac 已经安装 **Node.js 22.13.0 或更高版本**，App 不内置 Node。先检查：

```bash
node --version
```

如果找不到这个命令，或版本低于 22.13.0，请从 [nodejs.org](https://nodejs.org/) 安装新版 Node.js，或执行 `brew install node`。然后到[最新 GitHub Release](https://github.com/RocStone/roc-mind-spark/releases/latest)下载 **Roc-Mind-Spark-v1.0.0-macos-arm64.zip** 和 **Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256**。先在下载目录核对 ZIP：

```bash
shasum -a 256 -c Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256
```

核对通过后再解压，把 **Roc Mind Spark.app** 拖到 `/Applications`。这个 ZIP 不是安装器。

下载包是 ad-hoc 签名，没有 Developer ID，也没有 Apple 公证。第一次启动：

1. 先双击一次 App，然后关闭 macOS 的阻止提示。
2. 打开 **系统设置 → 隐私与安全性**。
3. 向下滚动到“安全性”，在 Roc Mind Spark 旁边点 **仍要打开**。这个选项通常只会在被阻止后保留大约一小时。
4. 输入 Mac 登录密码，再确认一次 **打开**。

macOS 会把这份 App 保存为例外，以后可以正常双击。公司或学校管理的 Mac 可能禁止用户自行放行；不要全局关闭 Gatekeeper。如果你更愿意自己编译，使用[从源码安装](#从源码安装)。

默认快捷键：**⌃⌥⇧⌘Q**（Control-Option-Shift-Command-Q，也叫 Hyper Q）。如果 Caps Lock 映射成 Hyper，那就是 **Caps + Q**。到设置里改（工具栏齿轮，或浮层打开时按 **⌘,**）。

点菜单栏、Dock 或另一块屏幕会收起。Escape 留给画布（取消编辑），不会关浮层。

## 默认快捷键

| 项目 | 值 |
|---|---|
| 默认 | **⌃⌥⇧⌘Q** |
| Caps Lock 映射成 Hyper | **Caps + Q** |
| 修改 | 设置 → 浮层，或 **⌘,** |
| 菜单栏 | 显示 / 隐藏 |

默认快捷键故意用了较多修饰键，减少它与浮层后面那个 App 的快捷键冲突。

## 操作

| 操作 | 作用 |
|---|---|
| 画布上 **⌘ + 拖拽** | 框选节点 |
| **⌘ + 点击** | 把节点加入 / 移出多选 |
| **拖拽** 节点 | 移动（子树跟着走） |
| **丢到另一个节点中心** | 变成它的子节点 |
| **丢到上 / 下边缘** | 插入同级或排序 |
| **Tab** | 子节点 |
| **Enter** | 同级节点 |
| **↑ ↓ ← →** | 移动选中 |
| **F2** 或双击 | 编辑 |
| **L** | 连到另一个节点 |
| **Delete** | 删除 |
| **Space** | 折叠 / 展开 |
| **?** | 全部快捷键 |

滚轮缩放，拖空白处平移。任意工具栏按钮上右键可以绑自定义快捷键。

## 语言

设置 → **Language**：English 或 中文。**默认英文。**

这个选项会带动：

- WKWebView 画布界面：工具栏、侧栏、设置面板、空状态（`web/public/i18n.js`）
- macOS 菜单栏图标菜单（`macos/.../L10n.swift`）

这里说的不是 Google Chrome。你在节点里写的字也不会被翻译。

## 数据保存在哪

安装后的 App 自动写到：

```
~/Library/Application Support/RocMindSpark/
  mindspark.db          SQLite 地图
  maps/                 拖到图上的图片
  server.log            Node 标准输出 / 错误
  ops.log               短操作日志（可能含地图标题、节点文字前 40 字）
  overlay.log           原生浮层事件
```

从源码 debug 跑时，可以用 `web/data/`，而不是 Application Support。正式打包的 release 不会走这条路径。

编辑时自动保存。没有单独的“保存文档”按钮。

## 从源码安装

源码构建还需要 **Swift 6 / Xcode 命令行工具**，最终在本机安装同样采用 ad-hoc 签名的 App：

```bash
git clone https://github.com/RocStone/roc-mind-spark.git
cd roc-mind-spark
make install
```

| 命令 | 作用 |
|---|---|
| `make test` | 画布 Node 测试和 Swift 测试 |
| `make build` | `swift build -c release` |
| `make app` | ad-hoc `.app`，在 `dist/` |
| `make release-archive` | arm64 发布 ZIP 和 SHA-256，放在 `dist/` |
| `make install` | 打包、放到 `/Applications/Roc Mind Spark.app`、启动 |
| `make clean` | 删除 `macos/.build` 和 `dist/` |

运行时不需要 `npm install`。画布服务只用 Node 内置模块。

## 备份

把 `~/Library/Application Support/RocMindSpark/` 整个文件夹拷走，就备份了地图、图片和日志。恢复时先退出 App，再把文件夹放回去，然后打开。

如果还有 debug 源码数据，也在 `web/data/`。

## 升级

下载版先退出 Roc Mind Spark，再下载新版 ZIP，并替换 `/Applications/Roc Mind Spark.app`。源码版拉取新代码后再执行 `make install`。两种方式都不会动 Application Support 里的用户数据。

## 卸载

这是两件不同的事：

1. **删 App：** 删除 `/Applications/Roc Mind Spark.app`。可以先在设置里关掉 **登录时启动**，或到系统设置里移除登录项。
2. **删用户数据：** 删除 `~/Library/Application Support/RocMindSpark/`。只做第 1 步，地图还在磁盘上。

## 隐私（要点）

Roc Mind Spark 是本机浮层。它 **不是**“完全离线”，也 **不会**声称什么都不上传。

- **保存在这台 Mac：** 地图、图片、日志、语言、快捷键、登录时启动
- **在界面里显示：** 你编辑的图、设置、菜单栏
- **给人工诊断：** `server.log`、`ops.log`、`overlay.log`（ops 行可能含标题和节点文字片段）
- **只有你主动触发才会出机器：** LLM 调用（API key 在 WKWebView `localStorage`）、DOI 查询（Crossref）、网站图标（DuckDuckGo）、以及你打开的 http(s) 链接，包括 GitHub 仓库/issue 链接。Mac 产品不启用继承来的 GitHub cloud 或 OAuth。

第一次启动会打开 **登录时启动**。到设置里可以关。完整说明见 [PRIVACY.md](PRIVACY.md)。

## 故障排查

| 现象 | 先看什么 |
|---|---|
| 浮层显示画布错误 | 先读浮层上的说明。修好后点 **重试**。不用重启电脑。 |
| 端口 3034 已被占用 | 浮层会写出端口和占用进程。应用 **不会**杀掉它。停掉那个进程、释放 3034，再点 **重试**。 |
| 找不到 Node / server.js / 启动超时 | 同一块错误界面。装好 Node.js 22.13.0+，或看 `~/Library/Application Support/RocMindSpark/server.log`，再点 **重试**。 |
| 快捷键没反应 | 到设置里确认组合键。默认是 ⌃⌥⇧⌘Q |
| 下载的 `.app` 被系统拦住 | 正常：它是 ad-hoc 签名，没有公证。先尝试打开一次，再到 系统设置 → 隐私与安全性 → **仍要打开**。受管理的 Mac 需要联系管理员，或改用源码构建。 |
| 语言看起来不一致 | 画布界面和菜单栏跟 设置 → Language。节点文字是你自己写的 |
| 重建后画布还是旧的 | `make install` 才会替换 App。刷新浏览器是另一个产品 |

## 项目结构

| 路径 | 作用 |
|---|---|
| `macos/` | Swift 6 浮层、快捷键、`NSPanel`、`WKWebView` |
| `web/public/` | 内嵌画布 |
| `web/server.js` | 只监听回环的 Node + SQLite 服务 |
| `scripts/` | 打包和安装 `.app` |
| `web/test/` | 画布单测 |
| `web/worker/` | 测试会用到的 inherited/internal 代码，**不是**受支持的部署面 |
| `docs/RELEASING.md` | 维护者发布清单 |

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。Issue 用 `.github/ISSUE_TEMPLATE/` 下的 macOS 模板。

## 致谢

Roc Mind Spark **基于 [MindSpark](https://github.com/prasadpatil25/MindSpark)**，作者 [Prasad Patil](https://github.com/prasadpatil25) 与贡献者。编辑器、布局、Markdown 模式、模板、本地 SQLite 服务都是他们的。这个仓库加的是 macOS 浮层、全局快捷键、应用内语言切换，以及打包。

只想在浏览器里用思维导图，去上游 MindSpark。想在 Mac 上随时唤出一层原生浮层，用这个 fork。

## 许可与当前分发限制

[MIT](LICENSE) —— 与 MindSpark 相同。见 [NOTICE](NOTICE) 和 `web/LICENSE`。

v1.0.0 同时提供 **Apple Silicon、ad-hoc 签名、未公证的 ZIP** 和源码。下载版要求 Node.js 22.13.0+，第一次启动要按上面的步骤手动放行 Gatekeeper。arm64 ZIP 不能在 Intel Mac 上运行；当前也没有 Developer ID / 公证构建。见 [docs/RELEASING.md](docs/RELEASING.md)。
