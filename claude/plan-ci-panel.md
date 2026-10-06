# Plan: Release B, the CI panel

Branch `feat/ci-panel` off main `e850201` (worktree `D:\bots\legion-ci`). Supersedes steps 5-8 of `plan-house-skills-ci.md`.
Ships only after the connectors session merges the real GitHub client; built now against a fake (gate the ship, not the build).

## What the owner gets
- **CI panel**: the current repo's runs for the current branch and main, live. Each run is a row: workflow, branch,
  commit title, status, duration. A run opens to its jobs (OS, shard, duration, status). A failed job opens to its log
  excerpt, or to "Logs are not available yet" when the client refuses logs (normal until PC check C-GH-2).
- **Buttons**: Re-run failed jobs, Cancel (owner clicks only, through admin routes), Open on GitHub. While
  `can('actions','write')` is not `'yes'`, those two are replaced by "Connect with write access" (links to Settings,
  Connectors). Not connected at all: public repos work anonymously (read-only, 60 requests per hour); private repos
  show "Connect GitHub".
- **Float or dock**: a reusable panel container (Legion's first): floats (drag, resize, stays above the chat) or docks
  to the right edge; position, size and mode remembered per window. Keyboard: Escape closes; focus returns to the chip.
- **Title-bar chip**: green / red / running with counts for the current branch; opens the panel. Hidden when no repo
  is known.

## Not in Release B (decided)
- **Agent tools.** The connectors gateway gives agents `github_*` reads and carded `github_ci_rerun` / `github_ci_cancel`
  (design rev 6, section 4.1). The connectors session accepted `github_ci_wait` (2026-10-07: read, no card, timeout
  ≤ 900 s, polls ≥ 10 s, returns `{status, conclusion, url, failedJobs:[{id,name,conclusion}]}`, never fetches logs),
  landing with connectors phase 1. Release B adds no agent tools.
- **Run workflow / `workflow_dispatch`.** Dropped (maintainer, 2026-10-07, question UI); starting a fresh run stays on
  GitHub via Open on GitHub.

## Shared shape
The panel's run summary uses the same shape as `github_ci_wait`: `{status, conclusion, url, failedJobs:[{id,name,
conclusion}]}`, from one parser of GitHub's run/jobs JSON (`src/core/ci/parse.ts`) that the connectors session will
import too.

## Interface (connectors design rev 6, section 4.3; do not rename without the connectors session)
```ts
interface Connection { auth:'github-app'|'pat'|'anonymous'; login?:string; expiresAt?:string;
  permissions?:Record<string,'read'|'write'>; scopes?:string[]; rate:{limit:number;remaining:number;resetAt:string} }
connection(): Promise<Connection>
can(area:'contents'|'issues'|'pull_requests'|'actions', level:'read'|'write'): 'yes'|'no'|'unknown'
request(path, init?): Promise<GhResponse>   // api.github.com only, typed errors
logs(jobId): Promise<{text:string; truncated:boolean}>   // never a URL; refuses while the host list is empty
// writes.ts (import only from admin routes and the gateway's carded handlers; a source test enforces it)
rerunFailed(runId): Promise<void>; cancel(runId): Promise<void>
```
**Pinned before the fake is written (proposed to the connectors session for acceptance):**
```ts
interface GhResponse { status:number; json:unknown; etag?:string; notModified?:boolean;   // 304 when If-None-Match matched
  rate:{limit:number;remaining:number;resetAt:string} }
type GhError =
  | { kind:'not-connected' }                       // private repo, no token
  | { kind:'auth-expired' }                        // 401 after one refresh attempt
  | { kind:'forbidden'; needs?:'write'|'read' }    // 403 missing permission
  | { kind:'rate-limited'; resetAt:string }        // 403/429 with rate headers
  | { kind:'not-found' }                           // 404 (or no access, GitHub hides it)
  | { kind:'logs-unavailable' }                    // storage-host list empty, or redirect refused
  | { kind:'network'; retryable:boolean }
```
`request(path, init)` passes `If-None-Match` through and returns `notModified` (GitHub: a 304 does not count against
the primary rate limit). Errors are thrown as `GhError`-shaped objects, never with a URL, header or body inside.

Release B defines a port type `GitHubPort` in `src/core/ci/port.ts` with exactly these members, a fake
`src/core/ci/fake-github.ts` (tests and harness only), and the production wiring that resolves the real client when
it exists and otherwise reports `unavailable` (the panel then says GitHub support arrives with Connectors).

## Core (`src/core/ci/`)
- `index.ts` `createCiModule(deps, { github })`, routes, **all admin-only** (default-deny gate, none in CLIENT_ROUTES):
  `GET /api/ci/state` (repo, connection summary without secrets, can-write), `GET /api/ci/runs?branch=`,
  `GET /api/ci/runs/:id/jobs`, `GET /api/ci/jobs/:id/log`, `POST /api/ci/runs/:id/rerun-failed`,
  `POST /api/ci/runs/:id/cancel`. Ids validated as positive integers.
- **Repo**: from the active project's git remote (`origin` or `cloud`, github.com https or ssh form) or a repo the owner
  sets in the panel; `owner/name` validated `[A-Za-z0-9._-]`. Read with Node, never a child process (tripwire).
- **Watch signal**: the core cannot see the window, so the UI tells it. `POST /api/ci/watch {mode:'panel'|'chip'}`
  as a heartbeat every 30 s while visible (document visibility API); no heartbeat for 75 s means nobody watches.
- **Poller, budgeted by `connection().rate`**:
  - Nobody watching: no polling.
  - Connected (5,000/h): 10 s while a run is in progress, 60 s idle; ETag `If-None-Match` on every list call.
  - Anonymous (60/h): no idle polling at all; refresh on panel open, window focus and a manual Refresh; while a run is
    in progress and the panel is open, at most one poll per 60 s; stop when `rate.remaining` < 10 and show when it
    resets. A 304 still counts against the anonymous limit (GitHub REST best practices: the 304 saving applies only
    to requests "correctly authorized with an Authorization header"), so ETags save nothing here. The panel says
    "Connect GitHub for live updates".
  - Any 403/429 with rate headers: pause until `resetAt`.
  One shared cache; SSE event `ci:update` to the UI.
- **Log text** is outside content: shown as plain text, capped, never rendered as HTML; a secret-shaped value is
  masked before display.
- No new fetch file, no tripwire entry, no child process.

## UI (`ui/src/ci/`)
`FloatPanel` container, `CiPanel`, `CiChip`, `ciStore`. States to design and screenshot: no repo, not connected
(public / private), read-only, write-connected, rate-limited, offline, no runs, run in progress, 10-job run with long
names, red run with a 400-line log, logs unavailable; floating at the screen edge, docked, 0.75x and 1.5x UI scale,
light and dark. Focus rings via `:focus-visible` only; `.sr-only` live region for status changes; reduced motion.

## Tests (each with a demonstrated negative)
- Every CI route is admin-only: bearer token gets 403, no route in CLIENT_ROUTES.
- Re-run and Cancel call `writes` only from these admin routes; the connectors source test will cover the import rule.
- Bad ids and repo names are refused; the poller does not poll without a fresh heartbeat; anonymous mode makes no idle
  requests and never more than one per 60 s; a simulated hour of anonymous use with the panel open stays under 60
  requests (pinned clock); pause until `resetAt` after a rate-limit error; a 304 does not re-render.
- Logs unavailable is shown as a state, not an error; log text is escaped and secret-masked.
- Fake GitHub in the harness: runs, jobs, logs, logs refused, 403, 404, rate limit.

## Real-PC checks (to `claude/tracker-pc-checks.md`, ids CI1...)
Live runs for dnh33/legion with the real connector, read-only; Re-run failed on a deliberately red PR with the write
app; floating panel across two monitors and after a restart (Windows). Safety class: none.

## Build order
1. Port, fake, module, routes, tests. 2. Harness fake GitHub. 3. FloatPanel + CiPanel + CiChip. 4. Builder self-checks
in the browser. 5. One scoped review (security of routes and log handling; UX states). 6. PR; the orchestrating
session merges once the real client has landed and been swapped in.
