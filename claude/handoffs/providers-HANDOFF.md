# Handoff: multi-provider pass 2 (Codex/OpenCode, review fixes, lead choices)

Branch `claude/providers-2` (from `integration/v1` at `76f3bda`). Written 2026-10-03. Everything below is committed and pushed to `origin/claude/providers-2`. The full detail lives in `claude/plan-providers.md` section 19 (19.1 to 19.9); this file is the map and the next steps.

## 1. Goal and owner decisions (quoted)

- Task: "You continue the Legion multi-provider work ... The owner has decided: Codex and OpenCode adapters MUST be built, and the review findings below MUST be fixed. An independent security review follows your work, so make it hard to break."
- Part A (review findings): stdio MCP servers for provider runs get a per-server opt-in "default OFF, changed only with admin plus native confirmation showing the command line", PID-tree kill, tripwire coverage; redact streamed deltas across chunk boundaries; custom remote endpoints start TAINTED unless relaxed with admin plus native; optional per-provider token caps per task and per day (default none) plus a visible room-budget sentence; Windows-semantics checks; plan and wording updates.
- Part B: B1 `vm_*`-style tool running the CLI inside the agent's boat.dev VM (approval card, tainted output, fake VM manager in tests). B2 provider `kind 'cli'`, opt-in per agent via admin plus native with a plain warning that "the CLI runs its own shell and file tools outside Legion's per-tool approvals and taint tracking"; spawn only in one new tripwire-listed file; scrubbed allowlisted env; agent's own workspace as cwd (never home or the repo); strictest sandbox flag, no network relaxation; whole run tainted; only the owner in the app can start it; start card every run; timeouts, output cap, PID-tree kill; fake CLI in tests. "Honest wording everywhere: Legion cannot see or stop individual actions of a CLI agent."
- Part C: "A lead should be able to change a model / provider of a sub agent": owner-granted allowlist (per sub-agent, or per provider lead-selectable), refusal sentence names the setting, approval ceiling/taint/origin still apply, a tainted lead cannot pick a provider not allowed for tainted runs, token clients still cannot, thread shows who chose; delegate-only (lead loses Bash/Write/Edit) "as an OPTIONAL per-agent setting, off by default, only if it stays small".
- Later owner decision: "providers move to v0.2.1. Your work will NOT be merged into v0.2.0 ... stay on your branch claude/providers-2 and push there only ... do not rebase onto integration/v1 again ... Make every NEW user-visible surface ... work only when config.experimental?.providers === true ... Do not add the flag to the UI; it is set by editing config.json only."
- Hard rules: never touch the owner's BSV wallet port from tests/scripts; no keys/tokens/.legion data; do not disable admin gate, native-secret flow, taint wrapping or tripwire/hedge tests; Zealot art untouchable; no accounts; downloads/spending need the owner's go-ahead; do not edit `src/core/bsv`, `src/core/blender`, the updater, README or docs (wording changes are listed in the plan).

## 2. Exact state

Built, committed, pushed (head `4fa482e`):
1. Part A1 to A6: done (A5 is as far as Linux can go).
2. Part B1 (`vm_cli`) and B2 (CLI provider): done, against fakes only.
3. Part C (lead choices, bridge/hub/engine checks, thread line) and optional delegate-only: done.
4. Experimental flag `config.experimental.providers === true` gates every new surface (routes, view, vm_cli, CLI runs, lead choices, delegate-only, UI, native dialogs).
5. Adversarial pass with the owner's skills: two error-handling fixes, five UI polish fixes found by rendering the panel (plan 19.9).
6. Plan section 19, PC checks PV-13 to PV-26, tracker line.

In progress: nothing. NOT done, in order: (a) any run on a real Windows PC, real Codex, real OpenCode or a real provider; (b) merge into the release branch (not requested yet); (c) the independent security review; (d) README/docs/SECURITY.md/CLAUDE.md wording changes (listed in plan 19.5, deliberately not applied); (e) a separate test for the hub's early lead check; (f) a Windows-specific test run.

## 3. Files that matter

New source (`src/core/providers/`): `proc.ts` (the ONLY providers file that spawns: killTree, resolveLaunch for `.cmd`, scrubbedEnv, spawnStdio, spawnManaged, process port), `stdio-transport.ts` (MCP stdio transport on top of proc.ts), `stdio-allow.ts` (fingerprint of the exact command line, command-line text), `stream-redact.ts` (hold-back redaction of live deltas), `usage.ts` (per-day token ledger, `providers/usage.json`), `cli.ts` (CLI plan/env/folder checks/`runCli`), `vm-cli.ts` (VM command builder), `flag.ts` (experimental switch).
Changed in providers: `config.ts` (entries incl. cli, trusted, caps, leadSelectable, stdioMcpAllow, leadChoices), `types.ts`, `runtime.ts` (startsTainted, leadDecision, stdioServers, view, flag gates), `routes.ts` (new routes `PUT /api/provider-mcp/:name`, `PUT /api/provider-lead/:agentId`, native rules), `tool-loop.ts` (caps, stream redactor, signal to connect), `openai-compat.ts` (output limit), `external-mcp.ts` (no SDK stdio client).
Shared files, small hooks: `src/core/engine.ts`, `agent-tools.ts` (`vm_cli`, `modelParamFor`), `comms/tools.ts`, `comms/hub.ts`, `bridge.ts`, `model-cap.ts`, `approvals.ts`, `server.ts` (delegateOnly), `src/shared/types.ts`, `src/shared/providers-view.ts`, `src/bin/legion-core.ts`, `src/electron/provider-ipc.ts`, `test/bsv-scan.ts` (allowlist entry for `proc.ts`; reason text of `external-mcp.ts` narrowed), `ui/src/providers/*`, `ui/src/components/AgentEditor.tsx`, `ui/src/rooms/RoomHeader.tsx`.
Tests (new): `providers-stream`, `-taint`, `-caps`, `-stdio`, `-cli`, `-vmcli`, `-lead`, `-delegate`, `-routes2`, `-native2`, `-experimental`; fixtures `test/fixtures/fake-cli.mjs`, `fake-mcp-tree.mjs`. Updated existing: `providers-config`, `-engine`, `-external`, `-routes`, `-native`, `-tripwire`, `-wording`, helpers `providers-fakes.ts`, `providers-harness.ts` (flag on by default there).
Docs: `claude/plan-providers.md` (section 19), `claude/tracker-pc-checks-providers.md` (PV-13 to PV-26), `claude/legion-release-tracker.md` (one appended line).

Scratch (lived in `/tmp/claude-0/mut/`, NOT in the repo; embedded below so they can be recreated):
- `mut.sh <file> <old> <new> <test.js>`: backs up the file, replaces the first occurrence, runs `tsc`, runs the named test file (150 s timeout, a hang counts as red), restores the file. Needs a clean tree and no source edits while it runs.
- Screenshot script (headless Chromium via `/opt/node-tools/node_modules/playwright`, static server of `dist-ui`, stubbed `/api/*`, fake `window.legion`) used for the Providers panel check; it is not saved. Recreate if wanted.

```bash
#!/bin/bash
# usage: mut.sh <file> <python-replace-old> <python-replace-new> <test dist file>
cd /home/user/legion
cp "$1" /tmp/claude-0/mut/backup.ts
python3 - "$1" "$2" "$3" <<'PY'
import sys
p,old,new=sys.argv[1:4]
s=open(p).read()
assert old in s, "mutation target not found"
open(p,'w').write(s.replace(old,new,1))
PY
[ $? -ne 0 ] && { cp /tmp/claude-0/mut/backup.ts "$1"; echo TARGET-NOT-FOUND; exit 1; }
npx tsc -p tsconfig.json >/dev/null 2>&1; node scripts/copy-static.mjs >/dev/null 2>&1
timeout --kill-after=3 150 node --test "$4" 2>&1 | grep -E "^# (pass|fail)|^not ok" | head -8; [ "${PIPESTATUS[0]}" = "124" ] && echo "TIMEOUT (the run hung: counts as red)"
cp /tmp/claude-0/mut/backup.ts "$1"
```

Mutation list (batch script, each `run "<name>" <file> <old> <new> <test file>`; every one went RED, tree restored after each). Recreate from this table with `mut.sh`:

| Control | File: edit | Red test file |
|---|---|---|
| B2 owner-only | `cli.ts`: `if (host.ownerStarted !== true)` to `if (false as boolean)` | providers-cli |
| B2 owner-only (engine) | `engine.ts`: `ownerStarted: <expr>,` to `ownerStarted: true,` | providers-cli |
| B2 card skipped | `cli.ts`: `}) : false;` to `}) : true;` (green at first; test "no way to ask for the start card" added) | providers-cli |
| B2 card ignored | `cli.ts`: `if (!approved) return` to `if (false as boolean) return` | providers-cli |
| B2 env | `cli.ts`: `return scrubbedEnv(source, cliEnvAllow(kind, platform), extra, platform);` to pass all of `source` | providers-cli |
| B2 flag | `cli.ts`: add `'--full-auto'` to the codex args | providers-cli |
| B2 folder | `cli.ts`: remove `if (inside(home, real)) return`; remove `if (dirname(real) === real) return` (green at first; assertion on the rule's own reason added) | providers-cli |
| B2 agents | `cli.ts`: `!(entry.allowedAgents ?? []).includes(host.agentId)` to `false` | providers-cli |
| B2 limits | `proc.ts`: output cap `if (chunk.length > room) {` to `if (false as boolean) {`; time-out and cancel do not kill | providers-cli |
| B2 text | `cli.ts`: escapes not stripped; stderr not redacted | providers-cli |
| B2 config | `routes.ts`: native not needed for cli; created enabled; `config.ts` bare program name accepted | providers-routes2 |
| A1 | engine opt-in check; `stdioAllowed` always true; fingerprint ignores args; allow route without native; env not scrubbed; killTree no-op; `.cmd` metachars; Windows env case; planted SDK stdio import | providers-stdio, -routes2, -external, -tripwire |
| A2 | `tool-loop.ts` `onText: sr.push` to `host.onDelta`; `stream-redact.ts` hold = 1 | providers-stream |
| A3 | engine start-tainted check off; `startsTainted` returns false; relax without native | providers-taint, -routes2 |
| A4 | cap check off; `taskBefore` ignored; no output limit in request | providers-caps |
| B1 | no card; no taint; prompt in command; `--full-auto` in VM command | providers-vmcli |
| C | list check off; tainted-lead rule off; CLI selectable; engine check off; run-start recheck off; lead route without native | providers-lead, -routes2 |
| C delegate | `DELEGATE_ONLY_DISALLOWED` spread removed | providers-delegate |
| C22 | overclaim added to a dialog button | providers-wording |
| Flag | `runtime.experimental` returns true; CLI gate off; `needExperimental` no-op; NEW_FIELDS gate off; leadDecision gate off; `vmCli: true`; `setProviderChoices(true)`; delegate gate off; IPC gate off; `stdioServers` gate off | providers-experimental |

Full per-mutation outputs of the last batch were in `/tmp/claude-0/mut/results*.md` (not kept).

## 4. Build, test, gate

```bash
npm ci && npm run build:ts && node --test "dist/test/*.test.js"   # npm test does build:ts then the same
npm run typecheck && npm run build:ui
node --test dist/test/providers-*.test.js                          # provider tests only
```
Last gate (head `4fa482e`, Linux): 1809 tests, 1807 pass, 0 fail, 2 skipped; typecheck exit 0; build:ui exit 0; provider tests 135/135. Known flakes: `library-review-quota` R3.4 (timing, failed once under full load, passes alone 3/3), `server.test` "task archive / rename / delete" (did not appear). Tests spawn real node child processes (`process.kill(pid, 0)`); mutation runs that break the kill logic leave orphan `node -e setInterval` processes: kill them by PID.

## 5. Merge status and conflicts

Nothing of this pass is merged into `integration/v1`. Pass 1 (`claude/providers`) is merged there. `integration/v1` has since moved (at least `claude/skills/` and the orchestrator's `experimental.providers` switch); I did not merge or rebase. Expect conflicts in: the module list in `src/bin/legion-core.ts` (providers constructor now takes `dataDir`, `usageFile`); `src/core/engine.ts` (provider branch, `runProvider`, tool-server build, `disallowedTools`); `test/bsv-scan.ts` (allowlist: add `src/core/providers/proc.ts` kind `child-process`; `external-mcp.ts` is `fetch` only now); `claude/legion-release-tracker.md` and `claude/tracker-pc-checks-providers.md` (appended rows PV-13 to PV-26; ids may collide); `src/shared/providers-view.ts`; and the orchestrator's own `experimental.providers` field: mine reads it through `flag.ts` from the raw config object, so reconcile with its typed field. If the orchestrator's switch also hides pass-1 surfaces, my tests' harness (flag on) keeps working; `providers-experimental` and `providers-routes` assert the flag-off behaviour.

## 6. Open bugs and unverified claims (plainly)

- Nothing was run on Windows, against a real Codex or OpenCode, a real boat.dev VM, a real provider, or in Electron (native dialogs are tested through fakes only).
- Every CLI flag is assumed. From docs read: OpenCode `run` flags and `OPENCODE_PERMISSION`; Codex `exec` flags `--skip-git-repo-check --ephemeral --ignore-user-config --color --json --output-last-message --model`, prompt `-` from stdin. NOT confirmed: Codex `--sandbox read-only|workspace-write`, its login location, the OpenCode permission keys and whether `run` honours them, the OpenCode positional prompt, Codex's sandbox inside the VM.
- OpenCode prompt travels on the command line (visible to other local users in a process list). A read-only sandbox can still read your files. Killing the core leaves detached children running.
- Approvals/allowlists live in config.json: a same-user process that edits it (and the flag) bypasses the native confirmations.
- `.cmd` launchers refuse arguments with `& | < > ^ " % ! ( )`, so a CLI prompt with those characters cannot go to a `.cmd` launcher.
- The hub's early lead check has no test of its own. The Providers panel is long and was only polished, not redesigned. No mobile layout exists to check.
- Pass-1 bug found and fixed: adding a new custom endpoint from the app was refused ("Unknown provider").

## 7. Facts looked up and not looked up

Read: `https://raw.githubusercontent.com/sst/opencode/dev/packages/web/src/content/docs/cli.mdx` (OpenCode run flags, env vars); `https://raw.githubusercontent.com/openai/codex/main/codex-rs/exec/src/cli.rs` (Codex exec flags, summarized by a fetch tool, not read in full). Not reachable (egress blocked): `https://opencode.ai/docs/cli/`, `https://developers.openai.com/codex/noninteractive`. `https://raw.githubusercontent.com/openai/codex/main/docs/exec.md` only linked to the blocked page. The owner's skills were read from `origin/integration/v1:claude/skills/*` via `git show`.

## 8. Next steps, in order

1. Fetch `origin/integration/v1`, create a merge branch from it (not from this one), merge `claude/providers-2` (or cherry-pick), resolve the conflicts in section 5, reconcile the experimental flag, and run the gate (section 4).
2. Run the PC checks PV-13 to PV-26 (Windows PC; `account`/`spends-money` rows only with the owner present) and record results in `claude/real-pc-test-plan.md`; update the assumed flags with what the real CLIs accept.
3. Get the independent security review to try to refute the controls (start with: owner-only CLI start, folder check, env allowlist, stdio opt-in binding, lead allowlist and taint rule, config.json tampering class).
4. Fix what the review finds; add the missing hub test; consider moving the OpenCode prompt off the command line if a file/stdin option is confirmed.
5. Apply the wording changes in plan 19.5 to README, docs, SECURITY.md and CLAUDE.md once the checks pass; write `docs/PROVIDERS.md` from plan 19.1 to 19.3.
6. Only then drop the experimental flag, if the owner decides to.
