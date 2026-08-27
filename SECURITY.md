# Security

## Supported product

Roc Mind Spark is a **macOS 14+ overlay** built from this tree. The canvas Node server must listen on **127.0.0.1** only. There is no supported Windows, Linux, Docker, or hosted web deploy.

## Report a vulnerability

Open a GitHub issue **without secrets, maps, API keys, or logs that contain node text**. Describe the impact, the macOS version, and how to reproduce from a source build (`make install`).

If the report includes user content or keys, leave those out of the public issue and say you can share them privately.

There is no separate security inbox in this repository yet. Do not paste production LLM keys into issues.

## Local server rules

- Bind host is `127.0.0.1`. A LAN bind is a bug.
- `ServerSupervisor` may terminate only the Node `Process` this instance created. A PID already on 3034 is `portInUse`: do not attach, reuse, or kill it.
- `/healthz` may echo a launch nonce so the overlay can confirm the child it just started. That nonce is not API authentication.
- `scripts/install-app.sh` may stop only a process whose text executable is exactly `$DEST/Contents/MacOS/RocMindSpark`. It must not kill Node, including a hand-started `server.js` with the same path.
- CORS may reflect only `http://127.0.0.1:<bound-port>`. `localhost`, `https`, other ports, LAN, and missing OPTIONS Origin are forbidden.

`make test` covers the bind host, a live `/healthz`, exact CORS origin, and the “do not kill occupants / exact DEST executable” checks. Do not land a change that skips those tests.

## Packaging

`scripts/package-app.sh` ad-hoc codesigns the bundle. That is **not** Developer ID signing and **not** notarization. The v1.0.0 ZIP is intentionally distributed this way, so Gatekeeper normally blocks its first launch. Users must verify the SHA-256 checksum and follow the explicit **Open Anyway** steps in the README. See [docs/RELEASING.md](docs/RELEASING.md).

Release binaries must not embed a developer source path via `#filePath`.

## Secrets that are not secrets

Code and tests talk about `token`, `password` fields, and `IMPORT_TOKEN` as **protocol names**. Those are not credentials checked into the tree. Real secrets belong in the user's `localStorage` or environment, never in git.
