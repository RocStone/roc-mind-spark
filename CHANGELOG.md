# Changelog

Versions follow the macOS bundle `CFBundleShortVersionString` and the matching Git tag.

## [Unreleased]

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
