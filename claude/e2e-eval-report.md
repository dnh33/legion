# e2e (tester.army) evaluation for Legion UI tests

**Throwaway branch `claude/e2e-eval`. Never merge.** Package `e2e@0.15.2` + `@e2e-dev/web@0.11.1`, Apache-2.0, pre-1.0. Base `integration/v1`. Reproduce: `eval/e2e-scratch/reproduce.sh`. Telemetry off, `--ignore-scripts`, no keys. Linux only (see Limits).

## What it is
Tests are TypeScript (`test`, `expect`, `screen.getByRole(...)`, `.tap()`), strict locators, Playwright underneath. `agent.act/assert/extract` call an LLM; the **replay cache** records verified `act` steps and replays them without the model. Tests without agent steps need no model. Reports: `.e2e/report.json`, junit, markdown, GitHub PR comment; CI mode = 1 retry, 1 worker. Failures save an accessibility-tree `screen.txt` (readable, useful).

## Findings (each run here)
| Claim | Result |
|---|---|
| Install lifecycle scripts | none; `npm i --ignore-scripts` fine. 133 packages in the tree, 91 MB with playwright |
| `init --yes` writes | `package.json` (+5 devDeps, `test:e2e`), `e2e.config.ts`, `tests/example.e2e.ts`, `.gitignore` (+11 lines), `.agents/skills/e2e/` (9 files), `.claude/skills/e2e` symlink, `.mcp.json`, `.cursor/mcp.json`. No install without asking. Skill/MCP files are agent-config you may not want |
| Network at run | **it tries to download Chromium from cdn.playwright.dev on first run** (blocked here). Needed a browser-path shim in this sandbox |
| Pilot (a) Name focused + budget field | 5/5 pass, ~2.1 s each |
| Pilot (b) Settings→MCP status text | 5/5 pass, ~1.6 s |
| Pilot (c) Blender "Where scripts run" | 5/5 pass, ~1.8 s (3 choices) |
| Negatives (a2 "No limit", c2 four choices) | 5/5 fail as intended; plus a focus mutation failed correctly |
| Whole file wall time | 17 s (16.8-18.2) for 5 tests; 0 flakes in 25 test runs |
| Agentic step, no key | works only via a **custom scripted executor** (`e2e.offline.config.ts`): act+assert passed 1/1, unknown instruction → `blocked`. This proves plumbing, not AI |

**Base mismatches (not e2e faults):** `integration/v1` has 3 Blender choices (not 4) and a required "Budget (USD)" field (no "No limit"). The UI mock server has no `/api/rooms` or `/api/blender`, so tests stub them with `browser.route` (worked well).

## Agentic needs
Real `act` needs the `ai` package plus a provider and **an API key**. Claude is supported only by API key through `@ai-sdk/anthropic` or a gateway (AI Gateway/OpenRouter); **Claude subscriptions are not supported** (docs say so). Subscriptions work for ChatGPT, Copilot, SuperGrok. Not run: no key. Cost per run unknown; docs show token and cache counts per run.

## Compare
| | node:test + API harness | test-perf Playwright scripts | e2e |
|---|---|---|---|
| UI in a real browser | no | yes, ad hoc `.mjs` | yes, structured |
| Runner, retries, reports, CI | yes | no | yes |
| Model-free | yes | yes | yes (deterministic mode) |
| Electron native dialogs / native-secret flow | no | no | **no** |
| Real Blender / wallet | no | no | no |
| Adds | | | locators with strict errors, a11y snapshot on failure, request stubbing, replay cache |
| Cost | none | none | +91 MB dev deps, 0.x API churn, Linux/WSL only |

## Limits for Legion
No Electron driver (web engine only; mobile engine is iOS/Android). Windows: docs say "run inside WSL", but the owner's checks are on Windows. Agent steps would send page text to a third-party model API and need a key (Legion rule: no keys in repo). Our UI is already covered by `test-perf/ui-app` scripts (e.g. `check-dialog-focus.mjs`, 118 lines).

## Recommendation: **PILOT ONLY**
Deterministic mode is solid, fast and stable here, but it duplicates what a few Playwright scripts already do, and the value-add (agent steps) needs a Claude API key and has no Windows story. Adopt as an optional UI layer only if: (1) kept out of the root `package.json` (own folder, `--ignore-scripts`), (2) deterministic tests only, no `agent` steps, (3) telemetry env set in the wrapper script, (4) the first-run browser download is replaced by a pinned browser, (5) re-evaluate at 1.0 and when Windows is supported.
