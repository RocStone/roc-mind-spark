# Embedded canvas (internal)

This folder is the mind-map canvas and loopback Node server bundled inside **Roc Mind Spark**, a native macOS overlay.

It is **not** a supported product surface of its own. Do not treat Windows, Linux, Docker, Cloudflare Pages/Workers, GitHub Pages, `pkg` binaries, or a browser-only deploy as install paths for this repository.

Product docs, install, hotkeys, privacy, and contributing start at the repository root:

- [README.md](../README.md)
- [README.zh.md](../README.zh.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)

`worker/auth-core.js` and `worker/import-core.js` remain because unit tests import them. They are inherited MindSpark code, not a supported cloud deploy.

The Mac app starts `server.js` on `127.0.0.1:3034`. That bind is loopback-only.
