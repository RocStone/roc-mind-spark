# Inherited worker modules (internal)

These files come from upstream MindSpark. Roc Mind Spark does **not** support deploying them to Cloudflare Workers, Pages, or any hosted collaboration service.

Kept because tests import them:

- `auth-core.js` — used by `web/test/auth-core.test.mjs`
- `import-core.js` — used by `web/test/import-core.test.mjs` and `web/test/import-handler.test.mjs`

Do not add wrangler config, Docker, or GitHub Pages workflows here. The supported product is the macOS overlay at the repository root.
