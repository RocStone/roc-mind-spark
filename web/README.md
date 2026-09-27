# Embedded canvas (internal)

This folder is the mind-map canvas and loopback Node server bundled inside **Roc Mind Spark**, a native macOS overlay.

It is **not** a supported product surface of its own. Do not treat Windows, Linux, Docker, Cloudflare Pages/Workers, GitHub Pages, `pkg` binaries, or a browser-only deploy as install paths for this repository.

Product docs, install, hotkeys, privacy, and contributing start at the repository root:

- [README.md](../README.md)
- [README.zh.md](../README.zh.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)

The Mac app starts `server.js` on `127.0.0.1:3034`. That bind is loopback-only.

## Map import: `POST /api/import`

Posts a JSON node list; the server stores it as a new map and answers `201 { id, url }`. Validation lives in `import-spec.js`. If `IMPORT_TOKEN` is set, send `Authorization: Bearer <token>`.

Top level:

- `nodes` (required, non-empty array)
- `title`, `color` (strings)
- `rootId`: optional. Without it, exactly one node must have `parent: null`.
- `links`: `[{ from, to, label? }]`. A link whose endpoint is missing is dropped.
- `layoutConfig`: per-layout knobs, e.g. `{ "timeline": { "gap": 60, "alternate": false, "start": "above" } }`. Engines: `balanced`/`right`/`left`/`down` (`hGap`, `vGap`), `radial` (`ring`, `startAngle`, `sweep`), `grid` (`columns`, `gapX`, `gapY`, `rowGap`, `indent`), `timeline` (`gap`, `stem`, `indent`, `alternate`, `start`). Numbers are rounded and clamped to the same bounds as the canvas; unknown keys are dropped.

Per node:

- `id` (unique non-empty string), `text` (string), `parent` (id, or `null` for the root). Missing parents and cycles are rejected with `400`.
- `color`, `notes`, `tag`, `collapsed: true`
- `url`: http(s) only, otherwise dropped
- `citation`: `{ authors (string or array), year, title, source, doi | arxiv }`. The node becomes a reference.
- Formatting: `bold`, `italic`, `highlight` (only `true`), `align` (`left`/`center`/`right`), `listType` (`ul`/`ol`, defaults align to left), `task` (`todo`/`doing`/`done`)
- `marker`: a badge of at most 2 characters after trimming

Invalid optional values are ignored rather than stored. Root children get `side` balanced automatically: the first half go right, the rest left.
