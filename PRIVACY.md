# Privacy

Roc Mind Spark runs as a local macOS overlay. Maps are stored on this Mac. The app is **not** fully offline: some features send data to other services **when you use them**.

Chinese readers can get the usage and privacy points from [README.zh.md](README.zh.md). This file is the detailed map.

## Saved on this Mac

Installed app, under `~/Library/Application Support/RocMindSpark/`:

| Item | What it holds |
|---|---|
| `mindspark.db` | SQLite maps: titles, nodes, notes, links, layout, citations |
| `maps/` | Images dropped onto a map |
| `server.log` | Node process stdout/stderr |
| `ops.log` | Short operation log |
| `overlay.log` | Native overlay events (show/hide, webview attach, errors) |

A debug run from the source tree can write maps to `web/data/` instead. Release builds use Application Support only.

Also on this Mac, not in that folder:

| Item | Where |
|---|---|
| Language, shortcuts, “already enabled login item” flag | App `UserDefaults` |
| Canvas look/theme, view camera, templates, LLM provider/model/key | WKWebView `localStorage` |
| Launch at login | `SMAppService` login item for `com.roc.mindspark` |

`ops.log` lines can include the map id/title and the first **40 characters** of node text, plus layout/theme/zoom crumbs. That file is for reproducing bugs. Treat it as user content.

## Shown in the UI

- Maps and images you edit
- Toolbar, sidebar, settings, shortcut editor
- Menu-bar extra (Show / Hide, Settings, Quit)
- Language of the interface: English or 中文 from Settings

Node text is displayed as you typed it. It is not sent to a translation service.

## For human diagnosis

If something breaks, these local files are what a person would read:

- `~/Library/Application Support/RocMindSpark/overlay.log`
- `~/Library/Application Support/RocMindSpark/server.log`
- `~/Library/Application Support/RocMindSpark/ops.log`
- `/tmp/rms-boot.log` (short boot stamp)

They stay on the machine unless you copy them somewhere.

## Sent off this Mac when you trigger it

The loopback server binds **127.0.0.1 only**. Other machines on your LAN cannot call the API.

The **canvas page** can still make outbound requests from WKWebView:

| Trigger | Destination | What goes out |
|---|---|---|
| You run a prompt against Anthropic or OpenAI | `api.anthropic.com` / `api.openai.com` | Prompt text plus the API key from `localStorage` |
| You paste a DOI and autofill | `api.crossref.org` | The DOI |
| A node URL shows a favicon | `icons.duckduckgo.com` | The site host |
| You open a node link, a GitHub repo/issue link, or `window.open` | the URL you chose | A normal system open |

The Mac product does **not** enable the inherited GitHub cloud store or OAuth worker. Those UI leftovers in the canvas are not a supported path and are not configured.

LLM keys are stored in WKWebView `localStorage` (`mindspark:llm:key:…`) and sent **directly** to the provider from the page. They are not stored in SQLite. Do not put a production key on a shared Mac.

The local `/api/import` endpoint has no token unless you set `IMPORT_TOKEN`. That is acceptable only because the process listens on loopback.

## Launch at login

On **first launch** the app enables “Launch at login” once (`loginItem.autoEnabled`). After that, Settings → Startup controls it. Disabling the toggle unregisters the login item.

Launch at login starts the menu-bar extra and warms the canvas. It does not by itself upload maps.

## What we do not claim

- Not “completely offline”
- Not “never uploads”
- Not a hosted account product
- Not a multi-user cloud in this fork (inherited worker files are test-only internal code)

## See also

- [SECURITY.md](SECURITY.md) for reporting issues that affect other users
- [README.md](README.md) / [README.zh.md](README.zh.md) for install, backup, and uninstall (deleting the `.app` does not delete Application Support)
