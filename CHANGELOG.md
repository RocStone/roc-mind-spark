# Changelog

Versions follow the macOS bundle `CFBundleShortVersionString` and the matching Git tag.

## [Unreleased]

### Fixed (2026-09-28 audit)

- File exports (PNG, Markdown, JSON, Word, Mermaid, references) now save through a native Save panel. WKWebView previously cancelled the `blob:` download and only showed the success toast.
- Delete map, save as template, remove image, insert link in notes, and import errors now use in-page dialogs. The native `confirm()` / `prompt()` / `alert()` were no-ops in the overlay, so those actions silently did nothing. The Swift shell also implements the JS dialog delegates as a fallback.
- Quit no longer interrupts macOS logout, restart or shutdown when nothing is pending; a 7-second native timeout, a "Quit Anyway" choice, and WebContent-crash recovery were added.
- Map JSON larger than one socket chunk is decoded as a whole, so Chinese text is no longer corrupted into U+FFFD on save. Oversized bodies get 413, invalid bodies 400, cross-origin writes 403.
- Pinned maps are pinned again in the sidebar; the row menu no longer toggles the wrong way.
- Grid, timeline, matrix, fishbone and radial layouts are no longer staircased by the sibling-overlap pass on every render.
- Undo/redo after deleting the selected node no longer throws; history snapshots include layout config/params/preset; restoring a version keeps map-level fields and is itself undoable, and never overwrites the pre-restore version.
- Markdown preview / PDF, the node toolbar, sidebar, minimap, breadcrumb, global search results and PNG export no longer inject unescaped HTML or colours; imported maps are sanitized on load; links are restricted to http(s)/mailto in both the page and the shell.
- Word export math images are no longer blank; PNG export draws formula results, tables and dividers like the canvas; a failed remote image no longer fails the export.
- Permanent save failures stop retrying, show a red status and a distinct message instead of blocking quit forever; a failed map delete keeps the pending edit.
- Version history keeps one version per 5-minute editing window (up to 50) instead of one per autosave.
- Presentation mode no longer persists the temporary unfold or lets Backspace/Tab edit the map; replace matches what find matches and skips HTML entities; CRLF Markdown imports keep their structure; notes popup closes on map switch and saves on Escape; IME Enter no longer triggers find/replace; search highlights survive a re-render.
- Global hotkey: a chord that fails to register (already taken) is rolled back and reported instead of leaving no hotkey; ⌥⇧⌘Q (macOS log-out) is rejected at entry instead of being silently rewritten on the next launch.
- Node lookup covers nvm and `node@22` Homebrew paths and reports a too-old Node instead of a generic timeout.
- Performance: cached node elements during subtree drag, marquee and off-screen culling; image loads coalesce into one non-persisting relayout; global search aborts stale runs and caches maps; large-map find debounces; formula references use a label index.

### Added (2026-09-28)

- Focus mode now focuses a branch: with a topic selected it shows only that subtree plus a dimmed ancestor chain, without touching fold state; Escape restores the full map.
- Built-in templates open fully in 中文 when the interface language is 中文 (names, descriptions, topics and notes; 50 templates).
- Unreferenced image files older than a day are removed on startup and daily, after checking every map and every stored version.
- The export Save panel remembers the last folder.
- Quit and logout skip the save round-trip whenever the page reports nothing dirty, including open node, notes and Markdown editors.
- `POST /api/import` accepts `marker`, formatting fields, citation `source`, balanced root sides and `layoutConfig` again (parity with the removed worker builder); the fields are listed in `web/README.md`.
- Find inside branch focus searches only the focused branch; hits elsewhere are counted and Enter leaves branch focus to reach them.
- The operations log no longer records topic text. Removed the inherited `web/worker/` modules; the import endpoint's map builder lives in `web/import-spec.js`.
- ⌘V with a topic selected pastes the copied subtree (or a multi-line outline) as children; ⌘C copies the subtree outline. ⌘A selects all visible topics, ⌘⇧A selects siblings, ⇧Esc cancels an edit.
- Right-click menu on a topic (add child/sibling, edit, notes, marker, copy as Markdown, duplicate subtree, fold, delete).
- Layout presets shipped in `web/public/layouts/` appear in the look panel; the JSON import dialog has an entry point again.
- Shortcuts help reflects current bindings and lists find, replace, settings, help and clipboard actions; settings can reset canvas shortcuts.
- Hint bar dismissal persists; toast duration scales with length and stays above overlays; save status turns red on failure; the diff panel opens beside the history panel; highlighted topics keep readable text on dark themes.

- Removed the inherited cloud store, share links, live collaboration, and GitHub OAuth sign-in code from the Mac canvas, along with the unused service worker.
- A GFM Markdown table in a topic is rendered as a table while the topic is not being edited. Double-click or F2 still edits the Markdown source. The add-child plus stays outside the card; the table scrolls inside the topic text. Header tint follows the topic colour; table type size and weight match the topic.
- Find in the current map includes topics hidden by a **−** fold. Enter cycles hits, unfolds the ancestor chain, and refolds the previous path when that topic was not edited. A second **⌘F** closes the find box.
- Added a feature requirement baseline and implementation review with acceptance criteria.
- Markdown drag selection now uses WebKit glyph geometry, a per-gesture text index, and visible-range painting once per frame. Removed the retired textarea highlight/gutter path.
- Markdown edits retain node identity, marker/dimension metadata, and valid cross-links. Closing the pane flushes pending text; selection and navigation work in wrapped and read-only text.
- Saves are serialized per map with immutable snapshots, latest-edit status, retry, and ordered deletion. Map/history reads ignore stale responses; storage failures no longer masquerade as empty data. Undo restores complete content snapshots and persists the restored state.
- Launcher window queries run off the main thread. Server startup/retry no longer synchronously waits for process probes, and an unexpected child exit offers Retry without discarding the live page.
- Normal quit waits for pending saves and stays open on failure. Installation aborts if the app refuses to quit, with a 15-second graceful-exit allowance. Keeping the canvas warm no longer prevents idle system sleep.

- Click-and-drag text selection in a node no longer tracks through a CSS transform. The editor sits on `#stage`, sized by font and padding, with `transform: none`.
- The Markdown editor paints drag-select itself from the pointer, because WK native `::selection` trails the mouse by a hundred-plus pixels even when `selectionchange` is firing.
- Display size scales chrome density via `--ui-zoom`. Pointer math no longer treats that token as a coordinate scale.
- Right-click in a text field offers Cut / Copy / Paste / Undo / Redo / Select All. Cmd+C / Cmd+V in the Markdown editor copy and paste the selection.

## [1.0.0] - 2026-08-27

Roc Mind Spark's first formal GitHub Release and a major open-release update to the existing public repository.

### Added

- Native macOS overlay with a global **⌃⌥⇧⌘Q** hotkey, menu-bar control, launch-at-login setting, and full-screen Space support.
- Embedded mind-map canvas with local SQLite autosave, image storage, English / 中文 interface, layouts, templates, and Markdown editing.
- Apple Silicon release ZIP plus a matching SHA-256 checksum file.
- Visible canvas startup errors and **Retry** for missing Node.js, timeout, missing packaged files, and port conflicts.

### Security

- Canvas server binds to `127.0.0.1` only. CORS reflects only `http://127.0.0.1:<bound-port>`.
- The overlay owns only the Node `Process` it launches. A pre-existing listener on port 3034 is reported and left running.
- `make install` stops only an existing App whose text executable exactly matches `/Applications/Roc Mind Spark.app/Contents/MacOS/RocMindSpark`. It rechecks that identity immediately before signaling, waits 10 seconds for graceful App shutdown, and never searches for or kills Node by command-line text.
- Inherited GitHub OAuth worker configuration is disabled in the Mac product.
- Release builds do not compile the source-tree fallback, preventing a developer checkout path from being embedded through `#filePath`.
- The App bundle includes the root `LICENSE` and `NOTICE`.

### Removed

- Toolbar donation UI, personal UPI address, QR image, and a private screenshot.
- Upstream Windows, Linux, `pkg`, Docker, Cloudflare Pages, and container release paths that are not this Mac product.

### Documentation

- Added English and Chinese usage, installation, upgrade, uninstall, backup, privacy, troubleshooting, security, contribution, and release documentation.
- Added read-only macOS CI for tests and packaging checks. CI does not publish GitHub Releases.

### Distribution

- Download: `Roc-Mind-Spark-v1.0.0-macos-arm64.zip` for **Apple Silicon only**; it cannot run on Intel Macs.
- Requirements: macOS 14+ and an external Node.js 22.13.0+ installation.
- The App is ad-hoc signed, is not Developer ID signed, and is not notarized. Gatekeeper normally blocks the first launch; users must verify the SHA-256 checksum and explicitly choose **Open Anyway** in System Settings.

[Unreleased]: https://github.com/RocStone/roc-mind-spark/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/RocStone/roc-mind-spark/releases/tag/v1.0.0
