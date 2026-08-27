# Roc Mind Spark

[English](README.md) · [中文](README.zh.md)

A **native macOS overlay** for mind mapping. Press a global hotkey from any app, desktop, or fullscreen Space. The map covers the current screen. Capture the thought, dismiss the overlay, keep working. This is not a website and not a browser tab.

The canvas is [MindSpark](https://github.com/prasadpatil25/MindSpark) by Prasad Patil (MIT). Roc Mind Spark wraps it in Swift 6 / AppKit / `NSPanel` / `WKWebView` and starts a local Node server on `127.0.0.1:3034`.

**Supported platform: macOS 14+ on Apple Silicon.** The v1.0.0 download is an arm64 build and cannot run on Intel Macs. Windows, Linux, Docker, Cloudflare Pages/Workers, GitHub Pages, and a standalone web app are **not** supported distribution paths for this product.

## What it does

- Summon a full mind-map canvas over the current Space
- Edit nodes, subtrees, Markdown mode, templates, and layout
- Global hotkey, menu-bar extra, launch-at-login
- In-app English / 中文 for the interface (not for the text you type in nodes)
- Autosave maps to a local SQLite file

## 30-second start

Both the download and source build need **Node.js 22.13.0 or later** on the Mac. The app does not bundle Node. Check first:

```bash
node --version
```

If the command is missing or reports an older version, install Node.js 22.13.0 or later from [nodejs.org](https://nodejs.org/) or with `brew install node`. Then download **Roc-Mind-Spark-v1.0.0-macos-arm64.zip** and **Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256** from the [latest GitHub Release](https://github.com/RocStone/roc-mind-spark/releases/latest). In the download directory, verify the ZIP before opening it:

```bash
shasum -a 256 -c Roc-Mind-Spark-v1.0.0-macos-arm64.zip.sha256
```

Unzip it and drag **Roc Mind Spark.app** to `/Applications`. The ZIP is not an installer.

The download is ad-hoc signed, not Developer ID signed, and not notarized. On first launch:

1. Double-click the app once and dismiss the macOS warning.
2. Open **System Settings → Privacy & Security**.
3. Scroll to Security and click **Open Anyway** beside Roc Mind Spark. This choice is normally available for about one hour after the blocked launch.
4. Enter your Mac login password, then confirm **Open**.

macOS saves that app as an exception, so later launches work normally. A managed work or school Mac may prevent this override. Do not disable Gatekeeper globally. If you prefer to compile the app yourself, use [Install from source](#install-from-source).

Default hotkey: **⌃⌥⇧⌘Q** (Control-Option-Shift-Command-Q, also called Hyper Q). If Caps Lock is remapped to Hyper, that is **Caps + Q**. Change it in Settings (toolbar gear, or **⌘,** while the overlay is open).

Click the menu bar, the Dock, or another display to dismiss. Escape stays with the canvas (cancel an edit) and does not close the overlay.

## Default hotkey

| Item | Value |
|---|---|
| Default | **⌃⌥⇧⌘Q** |
| Caps Lock remapped to Hyper | **Caps + Q** |
| Change it | Settings → Overlay, or **⌘,** |
| Menu bar | Show / Hide |

The default shortcut is deliberately busy so it rarely collides with the app behind the overlay.

## Controls

| Action | What it does |
|---|---|
| **⌘ + drag** on the canvas | Box-select topics |
| **⌘ + click** | Add / remove a topic from the selection |
| **Drag** a topic | Move it (the subtree follows) |
| **Drop on the centre** of another topic | Nest it as a child |
| **Drop on the top / bottom edge** | Insert as a sibling / reorder |
| **Tab** | Child node |
| **Enter** | Sibling node |
| **↑ ↓ ← →** | Move the selection |
| **F2** or double-click | Edit |
| **L** | Cross-link to another node |
| **Delete** | Remove |
| **Space** | Collapse / expand |
| **?** | Full shortcut list |

Scroll to zoom, drag empty canvas to pan. Right-click any toolbar button to bind a custom shortcut.

## Language

Settings → **Language**: English or 中文. **English is the default.**

This choice drives:

- The WKWebView canvas UI: toolbar, sidebar, settings panel, empty states (`web/public/i18n.js`)
- The macOS menu-bar extra (`macos/.../L10n.swift`)

It does **not** mean Google Chrome, and it does not translate the words you type into nodes.

## Where data is saved

The installed app autosaves here:

```
~/Library/Application Support/RocMindSpark/
  mindspark.db          SQLite maps
  maps/                 images dropped onto maps
  server.log            Node stdout/stderr
  ops.log               short operation log (may include map titles and the first 40 characters of node text)
  overlay.log           native overlay events
```

A debug run from the source tree can use `web/data/` instead of Application Support. Packaged release builds do not.

Maps autosave while you edit. You do not press a separate Save command for the document itself.

## Install from source

The source build additionally needs **Swift 6 / Xcode command-line tools**. It installs the same ad-hoc-signed app locally:

```bash
git clone https://github.com/RocStone/roc-mind-spark.git
cd roc-mind-spark
make install
```

| Command | What it does |
|---|---|
| `make test` | Canvas Node tests and Swift tests |
| `make build` | `swift build -c release` |
| `make app` | Ad-hoc `.app` in `dist/` |
| `make release-archive` | arm64 release ZIP and SHA-256 in `dist/` |
| `make install` | Package, move to `/Applications/Roc Mind Spark.app`, launch |
| `make clean` | Remove `macos/.build` and `dist/` |

Runtime does not run `npm install`. The canvas server uses Node built-ins only.

## Backup

Copy `~/Library/Application Support/RocMindSpark/` (the whole folder) to back up maps, images, and logs. Restoring is the reverse: quit the app, replace that folder, reopen.

Debug-source maps, if any, also live under `web/data/`.

## Upgrade

For a downloaded release, quit Roc Mind Spark, download the new ZIP, and replace `/Applications/Roc Mind Spark.app`. For a source build, pull or copy a newer tree and run `make install` again. Both paths leave user data in Application Support in place.

## Uninstall

These are two different actions:

1. **Remove the app:** delete `/Applications/Roc Mind Spark.app`. Optionally turn off **Launch at login** in Settings first, or remove the login item in System Settings.
2. **Remove user data:** delete `~/Library/Application Support/RocMindSpark/`. Doing only step 1 leaves maps on disk.

## Privacy (summary)

Roc Mind Spark is a local Mac overlay. It is **not** “fully offline” and it does **not** claim that nothing ever leaves the machine.

- **Saved on this Mac:** maps, images, logs, language, shortcuts, launch-at-login
- **Shown in the UI:** the maps you edit, settings, menu-bar extra
- **For diagnosis:** `server.log`, `ops.log`, `overlay.log` (ops lines can include titles and node text clips)
- **Sent off-machine only when you trigger it:** LLM calls (API key lives in WKWebView `localStorage`), DOI lookup (Crossref), favicons (DuckDuckGo), and any http(s) link you open, including GitHub repo/issue links. The Mac product does not enable inherited GitHub cloud or OAuth.

First launch enables **Launch at login**. Turn it off in Settings. Details: [PRIVACY.md](PRIVACY.md).

## Troubleshooting

| Symptom | What to check |
|---|---|
| Overlay shows a canvas error | Read the message on the overlay. Tap **Retry** after you fix it. Do not restart the Mac. |
| Port 3034 is already in use | The overlay names the port and the occupant. The app will **not** kill that process. Stop it to free 3034, then tap **Retry**. |
| Node missing / server.js missing / timeout | The overlay shows the same error surface. Install Node.js 22.13.0+ or check `~/Library/Application Support/RocMindSpark/server.log`, then tap **Retry**. |
| Hotkey does nothing | Confirm the chord in Settings. Default is ⌃⌥⇧⌘Q |
| Downloaded `.app` is blocked | Expected: it is ad-hoc signed and not notarized. Try to open it once, then use System Settings → Privacy & Security → **Open Anyway**. On a managed Mac, ask the administrator or build from source. |
| Language looks mixed | Canvas UI and the menu-bar extra follow Settings → Language. Node text is whatever you typed |
| Old canvas after rebuild | `make install` replaces the app. A browser refresh is the wrong product |

## Project layout

| Path | Role |
|---|---|
| `macos/` | Swift 6 overlay, hotkey, `NSPanel`, `WKWebView` |
| `web/public/` | Embedded canvas UI |
| `web/server.js` | Loopback Node + SQLite server (`127.0.0.1`) |
| `scripts/` | Package and install the `.app` |
| `web/test/` | Canvas unit tests |
| `web/worker/` | Inherited internal modules used by tests — **not** a supported deploy |
| `docs/RELEASING.md` | Maintainer release checklist |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Open issues with the macOS templates under `.github/ISSUE_TEMPLATE/`.

## Credits

Roc Mind Spark is **based on [MindSpark](https://github.com/prasadpatil25/MindSpark)** by [Prasad Patil](https://github.com/prasadpatil25) and contributors. The editor, layouts, Markdown mode, templates, and local SQLite server are theirs. This repository adds the macOS overlay, global hotkey, in-app language switch, and packaging.

If you want the mind map in a browser, use upstream MindSpark. If you want a summonable native overlay on a Mac, this is the fork.

## License and distribution limits

[MIT](LICENSE) — same terms as MindSpark. See [NOTICE](NOTICE) and `web/LICENSE`.

v1.0.0 is available as an **Apple Silicon, ad-hoc-signed, unnotarized ZIP** and as source. The download requires Node.js 22.13.0+ and a one-time Gatekeeper override described above. The arm64 ZIP cannot run on Intel Macs. There is no Developer ID/notarized build. See [docs/RELEASING.md](docs/RELEASING.md).
