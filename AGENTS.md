# AGENTS.md

Tampermonkey userscript + WebExtension that enhances HTML5 video playback. ESM source is bundled with Rollup into a single userscript. There is **no test suite** and no wired lint script.

## Build commands (Yarn, not npm)

- `yarn build` — prod build of the main userscript → `dist/h5player.user.js` (entry: `src/h5player/index.js`)
- `yarn build:inject` — builds `web-extension/inject.main.js` → `web-extension/inject.js`
- `yarn jsonEditor` — builds `src/tools/json-editor/index.js` → `src/tools/json-editor/assets/js/main.js` (terser-minified)
- `yarn start` — dev (watch) mode for both `h5player` and `h5playerUI`; `yarn h5player` / `yarn h5playerUI` run each alone
- `yarn server` — local static server for testing

The rollup config in `config/rollup.config.js` selects the project via the `PROJECT_NAME` env var; project definitions live in `config/rollup.tree.config.js`.

## Key gotchas

- **Standard JS style** (`eslint-config-standard`): no semicolons, 2-space indent, `prefer-const`. There is no `lint` script — run `yarn exec eslint <file>` manually.
- **Package manager is Yarn Berry 3** (`nodeLinker: node-modules` in `.yarnrc.yml`). Don't use npm; run via `yarn`.
- Import alias: `import ... from 'utils/...'` resolves to `src/libs/...` (defined in rollup config).
- **Build artifacts are committed** to the repo: `dist/h5player.user.js`, `dist/h5player-ui.js`, `web-extension/inject.js` (566KB), and `src/h5player/ui/h5playerUI.es.js` (IIFE-wrapped into an ES module via `config/rollup.codeWraper.js`). Don't delete them.
- `version` string lives in `src/h5player/version.js`; it is independent of (and currently out of sync with) the `version` in `package.json`.
- Babel transform is only applied in `MODE=prod` and only to projects whose name does **not** include `h5player`.
- `.npmrc` points the registry at the Taobao mirror (npmmirror); remove it before any publish.
- `.env` (not committed; see `.env.example`) is needed for docs release: `DOCS_TARGET_PATH`, `GITEE_DOCS_TARGET_PATH`.

## Docs

VitePress site in `docs/` (bilingual, `docs/` + `docs/zh/`). Dev/preview/build via `yarn docs:dev` / `yarn docs:preview` / `yarn docs:build`. Releasing docs (`yarn docs:release`, `yarn giteeDocs:release`) requires `.env` and copies the built userscript into an external docs repo.

## Layout

- `src/h5player/` — main script source; `index.js` is the entry, `h5player.js` the core.
- `src/libs/` — vendored/utility libs (the `utils` alias target): hotkeys, monkey APIs, network-hook, videoCapturer, TCC, etc.
- `web-extension/` — Chrome/Firefox extension wrapping the same core.
- `bin/` — build/doc/serve helpers; `bin/webpack` is legacy.
- `src/tools/json-editor/` — standalone demo tool (has its own example `package.json`s; don't confuse them with the root).
