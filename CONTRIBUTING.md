# Contributing to Legion

Thanks for helping out. This guide covers setup, the everyday scripts, tests, style, how to add a mascot, and what a good pull request looks like. For how the pieces fit together, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first.

## Setup

You need Node.js 22 (see `.nvmrc`; 22.12 or newer is the minimum, set by the build tools and Electron) and npm.

```bash
git clone https://github.com/dnh33/legion.git
cd legion
npm ci
```

`npm ci` also downloads the Electron binary. If you only want to work on the core, tests or UI, skip that with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`. CI does the same.

To run the real app you also need Claude Code signed in (`claude`, then `/login`). Tests do not need it.

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | Type-checks the core (`tsconfig.json`) and the UI (`ui/tsconfig.json`). |
| `npm test` | Builds the TypeScript, then runs `node --test "dist/test/*.test.js"`. Refuses locally: the full suite runs on the PR's CI (set `LEGION_LOCAL_GATE=1` to run it here). |
| `npm run build` | Builds the core into `dist/` and the UI into `dist-ui/`. |
| `npm start` | Builds, then opens the Electron app. |
| `npm run app` | Opens the app without rebuilding. |
| `npm run core` | Runs the headless core. |
| `npm run dev:ui` | Vite dev server on port 5173. Point it at a core with `?base=http://127.0.0.1:4747&token=<token>`. |
| `npm run mcp-config` | Prints the MCP hookup snippets with your real token. |

### UI without a real core

`ui/dev/mock-server.mjs` is a fake Legion Core with realistic sample data and scenario flags (first run, long names, VM states, pending approvals, API errors). It serves `dist-ui/` too:

```bash
npm run build:ui
node ui/dev/mock-server.mjs 47811
# open dist-ui/index.html?base=http://127.0.0.1:47811&token=x
```

Scenario flags ride in the token, dot-separated, for example `token=doctor-pass.vm-running.approval`. The list is at the top of the mock server.

## Tests

- Framework: `node:test` with `node:assert/strict`. Files live in `test/*.test.ts`.
- Tests must not use the network or call Claude. Inject fakes: the engine and catalog accept a `queryFn`, the VM manager takes a fake boat client and clock. See `test/helpers-c.ts` for shared fakes.
- Add or update tests with every behaviour change. Bug fixes should come with a test that fails without the fix.

## Code style

- TypeScript, strict mode, ESM with NodeNext. Relative imports end in `.js`.
- Two-space indentation, single quotes, semicolons, LF line endings (`.editorconfig` covers the basics).
- Keep runtime dependencies to a minimum. Adding one needs a good reason in the pull request.
- Use `path.join` and avoid shell-specific commands so everything works on Windows. Never hard-code `/tmp` on the host.
- Comments explain why, not what. Keep exported names and signatures stable unless you are changing a contract on purpose; if you change one, update `src/shared/types.ts`, the tests and `docs/ARCHITECTURE.md` together.
- Never read, copy or log Claude credentials. See the security section of the architecture doc.

## Regenerating icons and screenshots

Playwright is only needed for regenerating icons and screenshots. It is not a dependency of the project and is not in `package.json`. Install it on the side when you need it:

```bash
npm i --no-save playwright
npx playwright install chromium
```

Then:

| Command | Output |
|---|---|
| `node scripts/make-icons.mjs` | `assets/icon*.png`, `assets/icon.ico`, tray icons, from `docs/art/relic-icon.svg`. |
| `npm run build:ui && node ui/dev/docs-shots.mjs` | The README images in `docs/images/`, using the mock server. |
| `node ui/dev/mock-server.mjs` then `node ui/dev/shoot.mjs` | Scratch screenshots in `ui/dev/shots/` (git-ignored) for visual checks. |

If Playwright lives somewhere other than a normal `node_modules`, set `PLAYWRIGHT_PATH` to its package directory. To use an existing Chromium binary, set `CHROMIUM_PATH`. Look at the images before you commit them.

## Adding a mascot

Every built-in agent has a hand-painted bust. The painting is never redrawn or simplified at runtime or in the build: the pipeline only regroups the maker's paths into layers, adds overlays (eyes, code scroll, glows) and animates them.

1. **Paint** one layered SVG that follows [docs/art/MASCOT_CONTRACT.md](docs/art/MASCOT_CONTRACT.md) (layer ids and paint order, 4 px pixel eyes, `data-crop`, `data-crop-rail` that holds the whole halo at any rotation, absolute `M/L/C/Q/Z` in `L-visor-shape`). Add `data-flip="none"` to a sigil token, and `data-alarm` / `data-badge` / `data-vm` only if the defaults land in the wrong place.
2. **File it** in `docs/art/muster/<id>/`: `<id>.layered.svg`, `<id>.portrait.svg` and the maker's `notes.md`. The folder name is the agent id: the bust is looked up by `agent.id`.
3. **Build** the json: `python3 scripts/build-mascot.py docs/art/muster/<id>/<id>.layered.svg <id>` (or `--all` to rebuild everything). Ids are prefixed with the bot name so busts never collide. `ui/src/mascot/data/<id>.json` is generated, never hand-edited.
4. **Give it a persona** in `ui/src/mascot/personas/<id>.json`: 12 quips, the annoyed line, a tempo multiplier, optional flare/halo options, and 3 to 6 weighted, cooldown-gated idle verbs built from `lean`, `nod`, `scan`, `flutter`, `flare`, `wave` (see `ui/src/mascot/verbs.js`). Keep the motion solemn.
5. **Register** it in `ui/src/mascot/busts.ts` (one loader line).
6. **Check it like a maker would**: render every state at the size it ships (44 px rail, about 200 px stage) on dark and light, awaiting and error included; run `npm test` (`test/mascot.test.ts`) and `npx vite build --config ui/vite.config.ts`.

Golden rule: `ui/src/mascot/data/relic.json` and the Relic stage stay byte-identical (a test pins the hash).

## The gate

The PR's CI runs this; locally set `LEGION_LOCAL_GATE=1` to run the chain yourself. Report the exact test counts in the pull request:

```bash
npm ci && npm run build:ts && npm run test:run && npm run typecheck:ui && npm run build:ui
```

Every new test needs a negative: temporarily break the code it covers, see the test fail, then put the code back.

## Windows notes

Windows is where tests break. Things that have bitten before:

- Use `fileURLToPath`, never `new URL(...).pathname`.
- Windows PowerShell 5.1 does not unroll a JSON array from `ConvertFrom-Json`; pipe it through `ForEach-Object { $_ }`.
- File symlinks need privilege: use junctions or hard links in tests.
- `Path` and `PATH` differ in case in the environment.
- Never kill processes by name pattern; kill by PID.
- Node loads each ES module once, so a running server keeps old code until you restart it.

## Security issues

Do not open a public issue for a vulnerability. Use private vulnerability reporting: the **Security** tab, then **Report a vulnerability** (see [SECURITY.md](SECURITY.md)). Never put keys, tokens or `.legion` data in an issue, a pull request, a log or a test fixture. A few areas have tests that guard the safety rules (`test/bsv-*.test.ts`, the admin gate); do not weaken those to make something pass.

## Pull requests

1. Open an issue first for anything large, so we can agree on the approach.
2. Branch from the default branch and keep the change focused.
3. Run the gate above.
4. Fill in the pull request template. Include a screenshot for UI changes.

Checklist:

- [ ] `npm run typecheck` passes
- [ ] CI is green on this PR, with tests added or updated
- [ ] `npm run build:ts` and `npm run build:ui` pass
- [ ] No secrets, tokens, personal paths or email addresses in the diff
- [ ] Docs updated (README, `docs/ARCHITECTURE.md`, `CHANGELOG.md` under "Unreleased") if behaviour changed
- [ ] Third-party assets have a compatible licence and are listed in `NOTICE`

By contributing you agree that your contribution is licensed under the [Apache License, Version 2.0](LICENSE).
