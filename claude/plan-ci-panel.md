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

## Interface (landed: `src/core/connectors/github/client.ts`; the CI module types itself from it)
```ts
class GitHubClient {            // the core's single instance: getGitHubClient(): GitHubClient | undefined
  connection(): Promise<Connection>           // NOT free: signed in it reads /user and /user/installations
  can(area, level): 'yes'|'no'|'unknown'      // 'unknown' until connection() ran, or while no permission map
  request(path, init?: GhInit): Promise<GhResponse>   // GhInit = { method?, body?, ifNoneMatch? }; api.github.com only
  logs(jobId, repo): Promise<{text, truncated}>       // repo is "owner/name"; never a URL; fails closed (logs-unavailable)
}
// request() refuses paths that start with "//" or contain a backslash, whitespace or "#"; errors are thrown as class GhError
// { kind, needs?, resetAt?, retryable? }, never with a URL, header or body inside.
```
- `GitHubPort = Pick<GitHubClient, 'connection'|'can'|'request'|'logs'>` (`src/core/ci/port.ts`). The module needs only these four.
- **Writes are optional and separate.** `GitHubWrites { rerunFailed(runId, repo), cancel(runId, repo) }` comes from connectors `writes.ts`
  (slice 2), loaded lazily through the literal `import('../connectors/github/writes.js')` (the tripwire needs a literal specifier). The CI
  module calls them from its two admin routes only (a source test enforces it). A missing module means: `canWrite` is `no`, the panel shows
  "Connect with write access", and Re-run and Cancel answer 403 with a plain line, never a 500.
- Wiring (`src/core/ci/wiring.ts`): the client is imported statically and asked via `getGitHubClient()` on every use (token refresh stays
  on one instance); `undefined` or an object without the four read members means unavailable. Writes resolve lazily as above.
- `src/core/ci/fake-github.ts` (tests and the harness only) has the real shapes (`ifNoneMatch`, path refusals, thrown `GhError`, `can()` is
  `unknown` without permissions) and NO write members unless a scenario enables them (`writes: true`). `test/ci-contract.test.ts` runs the
  module against the real `GitHubClient` with its fetch injected, so the swap itself is tested.

## Core (`src/core/ci/`)
- `index.ts` `createCiModule(deps, { github, writes })`, routes, **all admin-only** (default-deny gate, none in CLIENT_ROUTES):
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
  - Any 403/429 with rate headers: pause until `resetAt`. The pause is the account's: it survives a repo switch and blocks even `connection()`.
  - `connection()` is cached 30 s and counted as two requests when signed in (it reads /user and /user/installations).
  One shared cache; SSE event `ci.updated` to the UI.
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
