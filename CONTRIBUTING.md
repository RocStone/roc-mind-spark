# Contributing

Roc Mind Spark is a **macOS 14+ overlay**. Please keep changes inside that product.

Chinese usage and privacy notes live in [README.zh.md](README.zh.md). This file is for people changing the code.

## What this repository is

- Swift 6 / AppKit / `NSPanel` / `WKWebView` overlay in `macos/`
- Embedded canvas in `web/public/`
- Loopback Node server `web/server.js` on `127.0.0.1:3034`

It is not a Windows, Linux, Docker, Cloudflare, or GitHub Pages product. Do not add those as supported entry points.

## Before you start

1. Read [README.md](README.md) and [PRIVACY.md](PRIVACY.md).
2. Keep the default global hotkey as **⌃⌥⇧⌘Q** unless you are intentionally changing it in Settings code.
3. Do not commit `web/data/`, `Archive/`, secrets, or `AGENTS.md`.
4. Do not kill whatever happens to be bound to port 3034. `ServerSupervisor` may terminate only the Node `Process` this app instance started. The install script may stop only the overlay whose text executable is exactly `$DEST/Contents/MacOS/RocMindSpark`.

## Dev loop

```bash
make test
make install
```

`make install` replaces `/Applications/Roc Mind Spark.app` and launches it. Editing `web/public/` without installing leaves the hotkey-launched app on stale files.

## Tests

`make test` runs:

- `web/test/*.test.mjs` (Node.js 22.13.0+, no `npm install`)
- `macos` Swift tests

Add coverage next to the behavior you change. Loopback bind, exact CORS origin, and “only our Process / exact DEST executable” already have tests; do not regress them.

## Code layout

| Work | Where |
|---|---|
| Node editing, copy/paste on the canvas, layout, theme, in-app language | `web/public/` |
| Overlay, hotkey, fullscreen cover, WKWebView | `macos/` |
| Cmd+C/V and IME inside a node | `macos/` first (accessory + `.nonactivatingPanel`) |
| Canvas strings | `web/public/i18n.js` |
| Menu-bar strings | `macos/Sources/RocMindSpark/L10n.swift` |

`web/worker/` is inherited internal code used by unit tests. It is not a deploy target.

## Pull requests

- Keep the diff on the bug or feature. No drive-by UI rewrites.
- Do not rewrite git history, author emails, or LICENSE copyright lines.
- Do not add GitHub Actions that publish Releases, Pages, or container images.
- Mention if you touched listening, process identity, packaging, or privacy-sensitive logs.

## Issues

Use the macOS bug / feature templates under `.github/ISSUE_TEMPLATE/`. Include the macOS version and whether you installed the v1.0.0 Release ZIP or built the app with `make install`. The downloadable binary supports Apple Silicon only.
