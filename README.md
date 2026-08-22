# Roc Mind Spark

[English](README.md) · [中文](README.zh.md)

A **native macOS overlay** for mind mapping. Hit a hotkey from any app, any desktop, any fullscreen Space — the map comes up on top. Capture the thought, dismiss it, keep working. **No need to open browser, no Space to switch.**

The canvas is [MindSpark](https://github.com/prasadpatil25/MindSpark) by Prasad Patil (MIT). Roc Mind Spark wraps it in a Swift / AppKit / WKWebView shell so it behaves like a real overlay instead of a website.

<p align="center">
  <img src="docs/screenshot.png" alt="Roc Mind Spark overlay showing a research-and-engineering mind map titled In progress, with branches for Cursor Ultra, research (Trans Emb, J-Space), and daily notes." width="980">
</p>

**macOS 14+ only.** Windows is not supported.

## Why this exists

In a vibe-coding day you bounce between the editor, the model, papers, and a terminal. The expensive part is not typing — it is losing the thread. Before you leave a surface, hit the hotkey and drop *where you are* onto the map: what just worked, what is still fuzzy, what to run next. At the end of the day the map is the log. You are not reconstructing the afternoon from chat scrollback.

Same loop for research. The overlay covers the current Space, so you do not have to leave a paper, a GPU dashboard, or a coding session to take the note.

## Summon it

Default hotkey: **⌥⇧⌘Q** (Option + **Shift** + Command + Q). The **⇧** glyph is Shift.

That chord is busy on purpose so it rarely collides with the app you are in. It is also awkward — **change it in Settings** (gear in the toolbar, or **⌘,** while the overlay is open). The menu-bar extra also has Show / Hide.

Click the menu bar, the Dock, or another display to put it away. Escape stays with the canvas (cancel an edit) and does not close the overlay.

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

Settings → **Language**: English or 中文. **English is the default.** Chrome, the settings panel, and the menu-bar extra follow that choice. Maps you write stay in whatever language you typed.

## Install from source

Requires **macOS 14+**, **Xcode / Swift 6**, and **Node 22+** (the overlay launches the original MindSpark server locally; no `npm install` at runtime).

```bash
git clone https://github.com/RocStone/roc-mind-spark.git
cd roc-mind-spark
make install
```

That builds the app, copies it to `/Applications/Roc Mind Spark.app`, and opens the overlay. After that, use the hotkey. Maps are stored in `~/Library/Application Support/RocMindSpark/`.

```bash
make test    # canvas unit tests
make clean
```

## Credits

Roc Mind Spark is **based on [MindSpark](https://github.com/prasadpatil25/MindSpark)** by [Prasad Patil](https://github.com/prasadpatil25) and contributors. The editor, layouts, Markdown mode, templates, and local SQLite server are theirs. This repository adds the macOS overlay, global hotkey, in-app language switch, and the packaging around that canvas.

If the mind map itself is what you want in a browser, use upstream MindSpark. If you want it as a summonable native overlay on a Mac, this is the fork.

## License

[MIT](LICENSE) — same terms as MindSpark. See [NOTICE](NOTICE).
