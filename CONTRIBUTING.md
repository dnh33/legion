# Contributing to Legion

Thanks for helping out. This guide covers setup, the everyday scripts, tests, style, how to add a mascot, and what a good pull request looks like. For how the pieces fit together, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node.js 22 (see `.nvmrc`; 20.10 or newer works) and npm.

```bash
git clone https://github.com/OWNER/legion.git
cd legion
npm ci
```

`npm ci` also downloads the Electron binary. If you only want to work on the core, tests or UI, skip that with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`. CI does the same.

To run the real app you also need Claude Code signed in (`claude`, then `/login`). Tests do not need it.

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | Type-checks the core (`tsconfig.json`) and the UI (`ui/tsconfig.json`). |
| `npm test` | Builds the TypeScript, then runs `node --test "dist/test/*.test.js"`. |
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

Mascots are hand-painted SVGs that follow a fixed layer contract, so the engine can split them into GPU-composited layers without redrawing or simplifying the art.

1. Paint your character to the contract in [docs/art/MASCOT_CONTRACT.md](docs/art/MASCOT_CONTRACT.md): required groups such as `L-aura`, `L-halo-back`, `L-helm` and `L-face` (with `L-visor-shape` and `L-eyes` made of 4 px cells), 3 to 8 `L-hang-N` groups, and a `data-crop` on the root. Save it as `docs/art/<name>.layered.svg`.
2. Build it: `python3 scripts/build-mascot.py docs/art/<name>.layered.svg <name>`. This writes `ui/src/mascot/data/<name>.json`. If you start from a flat painting, `scripts/relic-to-contract.py` shows how the Relic was converted.
3. Load it in `ui/src/mascot/` the way `Relic.tsx` loads `relic.json`.
4. Regenerate the Expression Lab with `python3 scripts/build-demo.py`, and check every state in the lab (idle, listening, thinking, hacking, awaiting, victory, error, sleeping, annoyed) at small and large sizes.
5. Keep animation CSS and SVG only, and respect `prefers-reduced-motion`.

Only contribute art you made or have the right to license under the MIT License.

## Pull requests

1. Open an issue first for anything large, so we can agree on the approach.
2. Branch from the default branch and keep the change focused.
3. Run the checks below.
4. Fill in the pull request template. Include a screenshot for UI changes.

Checklist:

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes, with tests added or updated
- [ ] `npm run build` passes
- [ ] No secrets, tokens, personal paths or email addresses in the diff
- [ ] Docs updated (README, `docs/ARCHITECTURE.md`, `CHANGELOG.md` under "Unreleased") if behaviour changed
- [ ] Third-party assets have a compatible licence and are listed in `NOTICE`

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
