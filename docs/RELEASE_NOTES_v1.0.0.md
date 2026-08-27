# Roc Mind Spark v1.0.0

> **Before downloading:** this release supports **macOS 14+ on Apple Silicon (arm64) only** and requires **Node.js 22.13.0+**. The App has an ad-hoc signature, no Developer ID signature, and no Apple notarization. macOS will normally block the first launch. Continue only after downloading from this official Release and verifying the attached SHA-256 checksum.

## English

This is Roc Mind Spark's first formal GitHub Release and a major update to the existing public repository.

### Download and install

Download these two assets from this Release:

- `Roc-Mind-Spark-v1.0.0-macos-arm64.zip`
- `Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256`

Install Node.js 22.13.0 or later first. In the download directory, verify the ZIP:

```bash
shasum -a 256 -c Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256
```

After the check reports `OK`, unzip the archive and drag **Roc Mind Spark.app** to `/Applications`. The ZIP is not an installer.

Try to open the App once. After macOS blocks it, open **System Settings → Privacy & Security**, scroll to Security, click **Open Anyway** beside Roc Mind Spark, authenticate, and confirm **Open**. Do not disable Gatekeeper globally. A managed work or school Mac may prevent this override.

### What's included

- Native macOS overlay over the current Space, summoned with **⌃⌥⇧⌘Q** by default
- Mind-map editing, layouts, templates, Markdown mode, cross-links, and local SQLite autosave
- English / 中文 canvas and menu-bar interface
- Loopback-only server on `127.0.0.1:3034`
- Visible startup errors and Retry instead of silently taking over or killing a port occupant
- Safer App and Node process ownership during upgrades
- Bilingual usage, privacy, security, contribution, and release documentation

User data stays under `~/Library/Application Support/RocMindSpark/`; replacing or deleting the App does not delete that folder. Optional LLM, DOI, favicon, and opened-link actions can contact external services as documented in `PRIVACY.md`.

The downloaded binary cannot run on Intel Macs. Source installation remains available in the README, but the supported product is Apple Silicon macOS 14+.

## 中文

这是 Roc Mind Spark 的第一个正式 GitHub Release，也是现有公开仓库的一次大更新。

### 下载与安装

从这个 Release 下载两个文件：

- `Roc-Mind-Spark-v1.0.0-macos-arm64.zip`
- `Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256`

先安装 Node.js 22.13.0 或更高版本。在下载目录核对 ZIP：

```bash
shasum -a 256 -c Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256
```

看到 `OK` 后再解压，把 **Roc Mind Spark.app** 拖到 `/Applications`。这个 ZIP 不是安装器。

先尝试打开一次 App。macOS 阻止启动后，进入 **系统设置 → 隐私与安全性**，向下找到“安全性”，在 Roc Mind Spark 旁边点 **仍要打开（Open Anyway）**，完成身份验证后再确认 **打开**。不要全局关闭 Gatekeeper。公司或学校管理的 Mac 可能禁止用户自行放行。

### 本次内容

- 覆盖当前 Space 的原生 macOS 浮层，默认用 **⌃⌥⇧⌘Q** 唤出
- 思维导图编辑、布局、模板、Markdown 模式、交叉连接和本机 SQLite 自动保存
- English / 中文画布与菜单栏界面
- 只监听 `127.0.0.1:3034` 的本地服务
- 可见的启动错误和“重试”，不会静默接管或结束占用端口的进程
- 升级时更严格的 App 与 Node 进程所有权
- 中英文使用、隐私、安全、贡献和发布文档

用户数据保存在 `~/Library/Application Support/RocMindSpark/`；替换或删除 App 不会删除这个目录。只有主动使用 LLM、DOI 查询、网站图标或打开链接时，应用才会按 `PRIVACY.md` 的说明访问外部服务。

下载版不能在 Intel Mac 上运行。README 仍提供源码安装方式，但受支持的产品范围是 Apple Silicon 上的 macOS 14+。

## Credits and license / 致谢与许可

Roc Mind Spark is based on [MindSpark](https://github.com/prasadpatil25/MindSpark) by Prasad Patil and contributors. Both projects use the MIT License; see `NOTICE` for attribution.

Roc Mind Spark 基于 Prasad Patil 与其他贡献者的 [MindSpark](https://github.com/prasadpatil25/MindSpark)。两个项目都采用 MIT License；归属信息见 `NOTICE`。
