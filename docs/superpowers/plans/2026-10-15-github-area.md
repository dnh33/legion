# GitHub area (0.3.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect GitHub to Legion: choose which repos Legion sees, give each agent none / read / read-and-write per repo (every write carded), create repos from a lean GitHub area behind a title-bar icon.

**Architecture:** Three GitHub Apps (read, write, create) on the existing device-flow client; a Legion-side allowlist file enforced in the connector gateway; per-agent `githubWrite` repo list; owner-only create routes with a memory-only token; a right-hand GitHub panel in the UI. Work is split into units that own disjoint files and meet at a shared contract written first (Task 0).

**Tech Stack:** TypeScript (Node 22, ESM), the existing core HTTP routes, Electron main IPC, React UI. Tests: `node:test` via `npx tsx --test test/<file>.test.ts` locally; CI runs the built `dist/test`.

**Spec:** `docs/superpowers/specs/2026-10-15-github-area-design.md` (read it fully before your task; section numbers below refer to it).

## Global Constraints

- `package.json` and `package-lock.json` stay byte-identical to `main` (spec 9). Check before every push: `git diff --stat cloud/main -- package.json package-lock.json` prints nothing.
- No client secret, no private key, no new network file except as listed in the tripwire (`test/bsv-scan.ts`); every GitHub address lives in `src/core/connectors/github/hosts.ts`.
- Every write tool raises an approval card in every approval mode, including `full` (spec 4.3, rev 6 4.1).
- Never offered to agents: merge, API push or commit, branch create/delete, repo create/delete, any delete, workflow dispatch, repo settings, collaborators, secrets (spec 4.4).
- Defaults: allowlist empty; every agent level `none`; create form private on, README off, "Turn it on in Legion" off; GitHub icon shown with an off switch.
- Copy: plain English, no em dashes, "your computer" never "this computer".
- Agent rules for every implementer: `C:/Users/Danie/AppData/Local/Temp/claude/C--Windows-System32/da0bb71f-1c43-40db-b189-9afde55f2d08/scratchpad/impl/IMPLEMENTER-RULES.md` (TDD, REPO GUARD TESTS, CLEAN UP, NO WINDOW SPAM, TOOL BUDGET, no Co-Authored-By).

## Review Focus

1. A repo name with odd case or a trailing `.git` (`Dnh33/Legion`, `dnh33/legion.git`): tick, gateway check and write list must treat it as the same repo (Task 2 normalise test, Task 4 gateway test).
2. A repo unticked or removed from the GitHub install while an agent still lists it in `githubWrite`: the next write is refused with plain words, no card (Task 4).
3. The area opened while signed out, offline or rate limited: it shows the last list and the right state line, never a blank panel or a raw error (Task 7 state tests).
4. Double-click on Create or a slow GitHub: exactly one POST, no retry after send, 422 shown as "That name is taken" (Task 6).
5. Older saved agents (no `githubWrite`, `connectors: ['github']`) load as level Read and keep working (Task 4 level test).

---

### Task 0: Shared contract and seams (U0, do first, alone)

**Files:**
- Create: `src/shared/github-area.ts`
- Create: `src/core/connectors/github/write-tools.ts` (seam)
- Create: `src/core/connectors/github/repo-admin-routes.ts` (seam)
- Create: `src/core/connectors/github/allowlist.ts` (signatures throwing `not implemented`)
- Test: `test/github-area-contract.test.ts`

**Interfaces:**
- Produces (exact):

```ts
// src/shared/github-area.ts
import type { AgentProfile } from './types.js';
export type GithubApp = 'read' | 'write' | 'create';
export interface GithubRepoRow { fullName: string; private: boolean; installedRead: boolean; installedWrite: boolean; ticked: boolean; htmlUrl: string; installationSettingsUrl: string }
export interface GithubAreaView {
  registered: Record<GithubApp, boolean>; signedIn: Record<GithubApp, boolean>; login?: string;
  agentsEnabled: boolean; selection: 'selected' | 'all' | 'unknown'; repos: GithubRepoRow[]; truncated: boolean;
  rate?: { remaining: number; resetAt: string };
  problem?: { kind: 'not-connected' | 'auth-expired' | 'rate-limited' | 'network'; resetAt?: string };
}
export type GithubLevel = 'none' | 'read' | 'write';
export const CREATE_REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
export const normRepo = (s: string): string => s.trim().replace(/\.git$/i, '').toLowerCase();
export function validCreateName(n: string): boolean { return CREATE_REPO_NAME_RE.test(n) && n !== '.' && n !== '..'; }
export function agentGithubLevel(a: { connectors?: string[]; githubWrite?: string[] }): GithubLevel {
  if (!a.connectors?.includes('github')) return 'none';
  return a.githubWrite && a.githubWrite.length > 0 ? 'write' : 'read';
}
export function githubAgentsFor(repo: string, agents: Pick<AgentProfile, 'id' | 'connectors' | 'githubWrite'>[]): { read: string[]; write: string[] } {
  const r = normRepo(repo); const read: string[] = []; const write: string[] = [];
  for (const a of agents) {
    const lvl = agentGithubLevel(a); if (lvl === 'none') continue;
    if (lvl === 'write' && (a.githubWrite ?? []).map(normRepo).includes(r)) write.push(a.id); else read.push(a.id);
  }
  return { read, write };
}
```

```ts
// write-tools.ts (seam; Task 5 fills it)
import type { ToolDef } from './tools.js'; // use the existing tool type name in tools.ts
export const GITHUB_WRITE_TOOLS: Record<string, ToolDef> = {};
// repo-admin-routes.ts (seam; Task 6 fills it)
export function addRepoAdminRoutes(_add: unknown, _deps: unknown): void {}
// allowlist.ts (signatures; Task 2 fills them)
export interface Allowlist { v: 1; ticked: string[]; agentsEnabled: boolean }
export function readAllowlist(dataDir: string): Allowlist { throw new Error('not implemented'); }
export function setTicked(dataDir: string, fullName: string, on: boolean): Allowlist { throw new Error('not implemented'); }
export function isTicked(dataDir: string, fullName: string): boolean { throw new Error('not implemented'); }
export function masterOn(dataDir: string): boolean { throw new Error('not implemented'); }
export function setMaster(dataDir: string, on: boolean): Allowlist { throw new Error('not implemented'); }
```

- [ ] **Step 1: Write the failing test** `test/github-area-contract.test.ts`: `agentGithubLevel({})==='none'`, `({connectors:['github']})==='read'`, `({connectors:['github'],githubWrite:['a/b']})==='write'`, `({githubWrite:['a/b']})==='none'`; `validCreateName` true for `legion`, `a.b-c_1`, false for `''`, `.`, `..`, `a/b`, `../x`, `%2e%2e`, 101 chars, `légion`; `normRepo('Dnh33/Legion.git')==='dnh33/legion'`; `githubAgentsFor('dnh33/legion', [...])` splits read and write correctly with mixed case input.
- [ ] **Step 2: Run** `npx tsx --test test/github-area-contract.test.ts`: FAIL (module missing).
- [ ] **Step 3: Implement** the files above exactly (adapt the `ToolDef` import to the real type name in `tools.ts`; add `githubWrite?: string[]` to `AgentProfile` in `src/shared/types.ts` beside `connectors` with the spec 4.3 doc comment, since the contract imports it).
- [ ] **Step 4: Run** the test and `npm run typecheck`: PASS.
- [ ] **Step 5: Commit** `github: shared contract for the GitHub area` and push branch `feat/0.3.0-github-u0`; open a PR; it merges first.

### Task 1: Client for three apps (U1)

**Files:** Modify `src/core/connectors/github/client.ts`, `hosts.ts`; create `github/apps.ts`; tests `test/github-apps-client.test.ts`; update the tripwire list in `test/bsv-scan.ts` only if a new file fetches.

**Interfaces:** Consumes Task 0 `GithubApp`. Produces `getGitHubClient(kind?: GithubApp)` (default `'read'`, existing callers unchanged), `client.installations(): Promise<Installation[]>` with `{ id: number; account: { login: string; type: 'User'|'Organization' }; repositorySelection: 'all'|'selected'; permissions: Record<string,string>; appSlug: string }`, `client.installationRepos(id: number): Promise<{ repos: { fullName: string; private: boolean; htmlUrl: string }[]; truncated: boolean }>`, constants `GITHUB_WRITE_APP_CLIENT_ID`, `GITHUB_CREATE_APP_CLIENT_ID` (`'unregistered'` until registration), `GITHUB_APP_SLUGS: Record<GithubApp,string>`, `githubInstallUrl(slug)`, `GITHUB_INSTALLATIONS_URL`, `githubInstallSettingsUrl(inst)`.

- [ ] **Step 1: Failing tests** with the existing fake GitHub (or Task 8's once merged): token ids `github-read` (unchanged), `github-write`, none persisted for `create` (assert the store's `set` is never called for create); `installationRepos` pages 100 at a time and stops at 10 pages with `truncated: true`; ETag passed and 304 handled; a 401 on read refreshes once; `looksLikeClientId('unregistered')` keeps sign-in refused for any app.
- [ ] **Step 2: Run, see FAIL.** **Step 3: Implement** the `AppKind` table per spec 6.1 (memory-only token for create, 15 min idle expiry, cleared on disconnect). **Step 4: PASS + typecheck + guard tests.** **Step 5: Commit** `github: one client per app, installation repo list`.

### Task 2: Allowlist (U2a)

**Files:** Fill `src/core/connectors/github/allowlist.ts`; test `test/github-allowlist.test.ts`.

**Interfaces:** Consumes `normRepo`, `validRepoString` from `src/core/ci/repo.ts`. Produces the Task 0 signatures, file `<dataDir>/connectors/github-repos.json` `{ v:1, ticked:string[], agentsEnabled:boolean }`.

- [ ] **Step 1: Failing tests:** default (no file) = `{ticked:[], agentsEnabled:true}`; `setTicked` persists lower-cased and de-duplicated; invalid names throw; corrupt JSON reads as empty (fail closed, `isTicked` false); cap 500 entries refuses the 501st; write is atomic (write temp then rename: assert no partial file after a thrown write by stubbing `renameSync`).
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS. Step 5: Commit** `github: the repos you turn on in Legion`.

### Task 3: Area routes and connect flows (U2b)

**Files:** Modify `src/core/connectors/index.ts`, `src/electron/connector-ipc.ts`; create `src/core/connectors/github/area.ts`; test `test/github-area-routes.test.ts`.

**Interfaces:** Consumes Task 1 client methods, Task 2 allowlist, Task 0 `GithubAreaView`. Produces routes (spec 6.4): `GET /api/github/area` -> `GithubAreaView` (60 s cache unless `?force=1`); `PUT /api/github/repos/:owner/:name/tick {on}` (404 when not installed); `PUT /api/github/agents-switch {on}`; `POST /api/github/apps/write/connect|disconnect`; `GET /api/github/projects-using/:owner/:name`; one line calling `addRepoAdminRoutes(add, deps)`; IPC `connectGithub(app: GithubApp)`.

- [ ] **Step 1: Failing tests:** every route is admin-only (bearer and read-only tokens get 403); output JSON contains no `ghu_`, `ghr_`, device code or URL with a query string (snapshot scan); `selection:'all'` when an installation has `repository_selection:'all'`; rate-limit 403 maps to `problem.kind:'rate-limited'` with `resetAt`; offline maps to `network` and still returns the cached repos; tick of a repo not installed is 404.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS + guard tests. Step 5: Commit** `github: area routes and per-app sign-in`.

### Task 4: Gateway scope and agent level (U3)

**Files:** Modify `src/core/connectors/gateway.ts`, `tools.ts`, config validation for `githubWrite`, `src/shared/connectors-view.ts`; tests `test/github-gateway-scope.test.ts`, `test/github-agent-level.test.ts`.

**Interfaces:** Consumes `isTicked`, `masterOn` (Task 2), `GITHUB_WRITE_TOOLS` (seam), `agentGithubLevel`, `normRepo`. Produces the refusal step before the class check and the write order of spec 4.3: has `github` -> not MCP-client origin -> master on -> repo in `githubWrite` (write only) -> ticked -> write app signed in and `can(area,'write')` -> card -> call.

- [ ] **Step 1: Failing tests:** every read tool refuses an unticked repo with "That repo is not turned on in Legion. Turn it on in the GitHub area."; master off refuses all `github_*` and `connector_call_read`; `github_repo_list` returns ticked repos only and never calls `/user/repos`; Review Focus 1 (case and `.git`) and 2 (unticked after granting write: refused, no card); Review Focus 5 (legacy agent = read); config rejects a `githubWrite` entry that fails `validRepoString`. Each with a mutation negative noted in the test comment.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS. Step 5: Commit** `github: agents see only repos you turned on`.

### Task 5: Writes and cards (U4, may slip to 0.3.1 without blocking the rest)

**Files:** Create `src/core/connectors/github/writes.ts`, fill `write-tools.ts`; modify `src/core/approvals.ts` (dated exception comment only), `docs/TESTING.md`; tests `test/github-write-cards.test.ts`, `test/connector-imports.test.ts`.

**Interfaces:** Consumes the write client (Task 1), `ApprovalBroker.request`. Produces `GITHUB_WRITE_TOOLS` for the six names in `classes.ts:30-35`; `writes.ts` exports `rerunFailed(runId, repo)`, `cancel(runId, repo)`, `createIssue`, `commentOn`, `createPullRequest`, `submitReview`, never retried after send.

- [ ] **Step 1: Failing tests:** each write raises exactly one card in `ask`, `auto-edits` and `full`, on the Claude path and the provider path; Deny sends nothing; card text shows repo, tool, full argument text, agent name and the taint warning when the run read outside content; a thrown network error after send is reported, not retried; source test: only `write-tools.ts` and admin routes import `writes.ts` (mutation: add an import in `gateway.ts` fails it).
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS. Step 5: Commit** `github: agent writes, each one asks you first`.

### Task 6: Repo create (U5)

**Files:** Create `src/core/connectors/github/repo-admin.ts`, fill `repo-admin-routes.ts`; test `test/github-create-repo.test.ts`.

**Interfaces:** Consumes the create client (Task 1), `validCreateName`. Produces `POST /api/github/repos {owner?, name, description?, private, readme, tick}` -> `{phase:'pending', userCode} | {phase:'done', fullName, htmlUrl, visibleToRead:false}` and `GET /api/github/orgs`.

- [ ] **Step 1: Failing tests** (fake GitHub with `/user/repos`, `/orgs/:org/repos`, 422, 403, 404, 429): Review Focus 4 (two concurrent POSTs: one GitHub call, the second gets 409 "A create is already running"); no retry after send; 422 -> "That name is taken."; 403 org -> "The organisation must approve Legion (create) first."; invalid names refused before any call; private defaults true; `tick:true` ticks it; the create token is never written under `<dataDir>` (scan the folder); route admin-only; source test: only `repo-admin*.ts` import the create client.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS. Step 5: Commit** `github: create a repo from Legion`.

### Task 7: GitHub area UI (U6)

**Files:** Create `ui/src/github/GithubArea.tsx`, `githubStore.ts`, `GithubChip.tsx`, `github.css`; one line each in `ui/src/components/TitleBar.tsx` (before `<CiChip />`), `Icon.tsx` (inline GitHub mark SVG), `ui/src/commands.ts` ("Open GitHub"), `App.tsx`, typed calls in `ui/src/api.ts`; tests `test/github-area-ui.test.ts` (logic + source).

**Interfaces:** Consumes `GithubAreaView` and Task 3/6 routes (build against a mock until merged). Produces the panel with the four blocks of spec 5.2 and every state in 5.4, plus Settings, GitHub "Show the GitHub icon" switch (default on).

- [ ] **Step 1: Failing tests:** a pure `areaState(view)` returns the right state id and copy for each row of spec 5.4 (Review Focus 3: offline and rate-limited keep the last repos); no em dash in any string under `ui/src/github`; chip dot grey/green/amber mapping; create form defaults (private on, README off, tick off) and the confirm line repeats `owner/name` and visibility; Esc closes; `aria-expanded` on the chip.
- [ ] **Step 2: FAIL. Step 3: Implement** matching Legion's Settings and CI panel patterns (switch component, spacing, tokens; light and dark). **Step 4: PASS** + headless harness screenshots of each state, dark and light, 1280 and 960, saved to `scratchpad/github-shots/`. **Step 5: Commit** `github: a GitHub area behind a title-bar icon`.

### Task 8: Agent and project UI (U7)

**Files:** Modify `ui/src/components/AgentEditor.tsx` (Connectors fieldset), `ui/src/projects/ProjectView.tsx` (repo line), the agent card tag file; test `test/github-agent-ui.test.ts`.

**Interfaces:** Consumes `agentGithubLevel`, `githubAgentsFor`, ticked repos from `GET /api/github/area`.

- [ ] **Step 1: Failing tests:** editor offers None / Read / Read and write, write shows a checklist of ticked repos only, with the note "Every write asks you first, even with Full access."; saving Read sets `connectors:['github']` and clears `githubWrite`; tag text "GitHub: read" / "GitHub: write, 2 repos"; project repo line buttons "Let this project's agents read it" and "Let them write" change only that project's members.
- [ ] **Step 2: FAIL. Step 3: Implement. Step 4: PASS** + screenshots. **Step 5: Commit** `github: choose each agent's GitHub access`.

### Task 9: Fakes, checks and release items (U8)

**Files:** Modify `src/core/ci/fake-github.ts` (installations, installation repos, create, 422, 403, 429); append C-GH-1..13 to `claude/tracker-pc-checks.md`; add the package-files check to the release checklist doc.

- [ ] **Step 1: Failing test** `test/fake-github.test.ts`: the fake serves the new endpoints with ETag and the error shapes used by Tasks 1, 3 and 6. **Step 2: FAIL. Step 3: Implement. Step 4: PASS. Step 5: Commit** `test: GitHub fake covers installations and create`.

### Task 10: Registration and wiring of real ids (owner session, Rune)

- [ ] Register "Legion (read)", "Legion (write)", "Legion (create)" in the owner's Edge exactly per spec section 8 (never a client secret or private key). Install each on one throwaway repo, selected repositories only.
- [ ] Put the three client ids and slugs into `hosts.ts`; record them in the vault with the aetherkeep-secrets skill; prove C-GH-1 for each id.
- [ ] Commit `github: the registered Legion apps`.

## Merge order and parallelism

Task 0 alone first. Then Tasks 1, 2, 9 in parallel. Then Tasks 3, 4, 6, 7, 8 in parallel (each against the merged contract; UI against mocks). Task 5 last. Task 10 runs any time after Task 0 (browser only) and lands before the hands-on checks. Each task: implementer -> independent reviewer -> fix -> merge on green CI.
