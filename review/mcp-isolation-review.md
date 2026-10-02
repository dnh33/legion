# Review: `claude/mcp-isolation` vs `rel2` (claude.inheritMcp)

Reviewer: independent, read from code (not from the builder's report). Defensive framing: gaps in controls only.
Reviewed commit: `0b912de` (one commit over `rel2`). The branch was not modified.

## Verdict: SHIP AFTER FIXES

The core control is wired on every `query()` path and the gate, migration and validation are sound. Two things stop me from saying SHIP:
(F1) the connector-off switch is a single env var that the inherited Claude Code settings may be able to undo, and nothing proves otherwise;
(F2) the self-MCP guard misses loopback spellings. Neither is a regression against `rel2` (today everything is inherited), so neither blocks shipping the default-off behaviour, but F1 should be closed or explicitly scoped in the copy first.

## 1. Build and test results (exact)

Fresh `npm ci` (exit 0), then on the branch head:

| Step | Result |
|---|---|
| `npm run build:ts` | exit 0 |
| `npm test` | **tests 1381, pass 1381, fail 0, cancelled 0, skipped 0** (baseline 1368; +13 = `test/mcp-isolation.test.ts`) |
| `npm run typecheck` | exit 0 |
| `npm run build:ui` | exit 0 |

No test was skipped or loosened. The only non-new test-tree edit is `test/helpers-c.ts` (adds `inheritMcp: false` to a fake config so it type-checks).
Nothing touched BSV wallet port 3321; no tokens or keys appear in this report.

## 2. Every `query()` path (read from code)

`grep` for `query(` / `queryFn(` over `src/` finds exactly three call sites. All are covered:

| Path | Site | strict flag | connector env |
|---|---|---|---|
| Task run, and the Sonnet to Opus retry | `engine.ts` `runOnce` -> `buildOptions` (single options builder; retry at `engine.ts:461-474` calls `runOnce` again) | `engine.ts:595` set unless `inheritMcp === true` | `buildChildEnv(this.config)` `engine.ts:600` |
| Catalog probe | `catalog.ts:50-53` | always `true` (already was) | `{probe:true}` -> always off |
| Doctor probe | `doctor.ts:34` | **newly** `true` (previously absent) | `{probe:true}` -> always off |

Good: the env var is assigned *after* `{...process.env}` is copied and scrubbed (`engine.ts:120`), so a user's shell value of `ENABLE_CLAUDEAI_MCP_SERVERS=true` is overwritten. `inheritMcp` is tested with `=== true`, so a hand-edited string/number/null in `config.json` fails safe (strict). The SDK's own doc for `strictMcpConfig` (`sdk.d.ts:2282`) confirms it also ignores project `.mcp.json`, user settings and plugins, which supports the ARCHITECTURE claim.

### F1 (medium): the connector switch is env-only; inherited settings may re-enable it, and it is unproven
- Evidence: `engine.ts:120` is the only connector control. Default `inheritClaudeCodeSettings` is `true` (`config.ts:79`), so `settingSources: ['user','project','local']` is passed (`engine.ts:592`). Claude Code settings files can carry an `env` block; whether a value there overrides the env Legion passes (and so can set `ENABLE_CLAUDEAI_MCP_SERVERS=true`) is not tested here and I could not verify it offline. The test `off: the user env cannot switch connectors back on` only covers the *process* env, not a settings-file `env`.
- Why it matters: the owner-visible promise is "connectors do not load when the toggle is off". A project-level `.claude/settings.json` (an untrusted repo an agent `cwd` points at) is a source an owner did not write.
- Fix: also pass the SDK `settings` option (`sdk.d.ts:2199`, flag-settings layer, highest user-controllable precedence) with `{ disableClaudeAiConnectors: true }` whenever `inheritMcp` is off (and for probes). The setting type exists (`sdk.d.ts:6843`) and is "any-source-true wins", so a project-level `false` cannot undo it. Keep the env var as the second layer. Add a test asserting `options.settings` carries it on run, retry, catalog and doctor. If the owner chooses not to, scope the copy: say "when Legion's own request is not overridden by settings you inherit".

### F2 (low): `claude.inheritMcp: true` + `inheritClaudeCodeSettings: false` is a silent combination
With inheritMcp on, `ENABLE_CLAUDEAI_MCP_SERVERS` is simply not set and strict is off, regardless of `settingSources: []`. That matches "as before" but the Settings text under "Inherit my Claude Code settings" no longer says anything about MCP. Polish: one sentence in the UI that the MCP toggle is independent.

## 3. Status route and leakage

- Gate: `route('GET','/api/mcp/status')` (`server.ts:205`) is not in `CLIENT_ROUTES` (`admin.ts:50-59`), so `gate()` returns 403 `admin_required` for a bearer-only (MCP token) caller and 401 with no token. The test asserts 401/403/200 and that `POST` is not 200. Default-deny holds. PASS.
- Payload is built from `name`, `state` (allow-listed enum), `origin` (the SDK `source`/`scope` string) and `message`. No `config`, `url`, `headers`, `env` or `command` field is copied (`McpStatusTracker.record` keeps name/status/source/error only). The UI renders as React text (escaped). PASS for headers/env/tokens.

### F3 (low-medium): server `error` text is untrusted and may carry a URL or token
- Evidence: `mcp-status.ts:28-30` `plainError` strips control chars and clips to 160 chars but does not redact. A failed remote connection error can echo the URL; URLs for some servers carry a key in the query string. The text reaches the admin UI (`describeState` -> `message`).
- Why it matters: admin-only, so not a privilege issue; but the owner may screenshot or paste Settings, and the clipped text can still contain a secret.
- Fix: in `plainError`, replace `https?://\S+` with the origin only (or `[url]`), and mask `[?&](token|key|auth|api[_-]?key|access_token)=[^&\s]*` plus `Bearer \S+`. Add a test with a query-string key.

### F4 (low): status tracker is last-writer-wins across concurrent runs
`McpStatusTracker.record` replaces the whole list on every `init`, so with two agents running the panel shows whichever started last, labelled "the last run". Polish: say so in the hint, or key by agent.

## 4. Migration and validation

- Existing installs: `loadConfig` deep-merges the file over `defaultConfig()` (`config.ts:99-109`), so a config with no `inheritMcp` gets `false`. The settings view uses `c.claude.inheritMcp === true`. PASS.
- Settings validation rejects non-boolean (`settings.ts:100-103`, tested with `'yes'`). PASS.
- `redactConfig` for `/api/config` is a pre-existing path; `inheritMcp` is a plain boolean. PASS.

## 5. Copy (overclaiming)

- `SECURITY.md`, `README.md`, `ARCHITECTURE.md` and the Settings text scope the claim to "Legion's own code asks ...", state it is not a sandbox, and say a future Claude Code may not honour the names. The new test bans guarantee/absolute phrases on those lines. `test/bsv-hedge.test.ts` passes unchanged. PASS.

### F5 (low): two absolutes slip past the copy test
- `Settings.tsx` (McpStatus hint): "**Only** Legion's own tools and the servers below are loaded." This states the result, not Legion's request, and is untrue when a module server (BSV, comms, Blender) is in the run, and per F1 not provable. Suggest: "Legion asks Claude Code to load only its own tools and the servers below."
- `engine.ts:594` comment: "nothing from user/project/local MCP config or plugins" (code comment only). Soften to "asks the CLI to ignore".
- The test regex for the ui lines only inspects lines matching a few keywords, so the status hint is not scanned. Extend the filter to the McpStatus block.

## 6. Self-MCP guard (`isSelfMcpUrl`) - URL variants

I ran the built function (`dist/src/core/mcp-status.js`) with port 4747:

| Variant | Result | Note |
|---|---|---|
| `127.0.0.1`, `localhost`, `[::1]`, `[::]`, `0.0.0.0`/`0`, `127.1`, `2130706433`, expanded IPv6 `[0:0:...:1]`, trailing slash, userinfo, leading-zero port, `/./mcp`, `/x/../mcp` | true | OK (WHATWG URL normalisation helps) |
| `LOCALHOST` host with `/MCP` path | false | host is lowercased fine; path case is correct to differ (server route is exact `/mcp`) |
| `127.0.0.2` (any 127/8) | **false** | **bypass** (binds only 127.0.0.1, so 127.0.0.2 does not reach it on Linux, but on macOS/Windows 127/8 behaviour differs; cheap to cover) |
| `[::ffff:127.0.0.1]` (IPv4-mapped) | **false** | **bypass**; URL normalises to `[::ffff:7f00:1]` |
| `localhost.` (trailing dot), `foo.localhost` | **false** | **bypass** (resolve to loopback) |
| `127.0.0.1.nip.io`, any DNS name pointing at loopback | false | cannot be fixed by string match |
| stdio entry, e.g. a bridge command whose args hold the URL | false | `isSelfMcpUrl` only looks at http/sse entries |

### F2b (low-medium): guard is string-based and misses loopback aliases
- Evidence: `mcp-status.ts:8-17`.
- Why it matters: it is loop-avoidance hygiene (the endpoint still needs the bearer token, and the server only listens on 127.0.0.1), so the impact is a confusing self-loop rather than a privilege gain. But the SECURITY text presents it as "a server which is Legion's own /mcp is switched off".
- Fix: strip a trailing dot; accept `*.localhost`; accept `127.0.0.0/8`; unwrap IPv4-mapped IPv6 (`::ffff:a.b.c.d`); optionally, as a stronger check, compare the presented `Authorization` header against `config.authToken` (an entry that carries Legion's own token is a self-connection whatever the host says). Add these to the test list. State plainly in SECURITY that stdio bridges and DNS aliases are not detected.

### F6 (low): the inherit-on guard is post-connect and best effort
`noteMcpInit` toggles the self server off only after `system/init`, asynchronously, with errors swallowed (`engine.ts:688-700`). The server is already connected for the first moments of the turn, and a failure is silent. Documented as best effort; acceptable. Optional: surface a one-line status row ("could not switch off") when toggling throws.

## 7. Existing controls

Admin gate (`admin.ts` unchanged; the full suite incl. token/admin harness passes), native-secret flow, taint wrapping, tripwire and `bsv-hedge` tests all pass unchanged (1381/1381, 0 failing, 0 skipped). The diff touches none of those modules.

## Ranked summary

| # | Severity | Item | Fix |
|---|---|---|---|
| F1 | medium | Connector-off relies on one env var; inherited settings `env` may override; untested | add `settings: { disableClaudeAiConnectors: true }` on all three paths + test, or scope the copy |
| F2b | low-medium | Self-guard misses `127/8`, IPv4-mapped IPv6, `localhost.`, `*.localhost`, stdio bridges | normalise host more; optional token-header check; document limits |
| F3 | low-medium | Server error text can echo a URL/key into the admin UI | redact URLs and key-like params in `plainError` |
| F5 | low | "Only ... are loaded" status hint and a code comment overclaim; copy test misses the hint | reword; widen test filter |
| F2 | low | inheritMcp/inheritClaudeCodeSettings interaction not explained | one UI sentence |
| F4 | low | status shows last run only, even with concurrent runs | label it or key per agent |
| F6 | low | inherit-on toggle is post-connect and silent on failure | optional status note |

Polish only: none of F2/F4/F5/F6 changes behaviour. Bugs: F1, F2b, F3.
