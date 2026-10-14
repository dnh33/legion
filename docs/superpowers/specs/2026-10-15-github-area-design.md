# GitHub area (Legion 0.3.0): design spec

Date 2026-10-15. Status: proposal for the owner. Base: `main` at 46ed7bc (0.2.6) plus `cloud/main:claude/design-connectors.md` rev 6 (called "rev 6" below). Nothing in this spec is built yet. Every file:line below was read in this session.

## 1. Answer first

1. Connect GitHub once. Two layers decide what Legion sees: the repos you install the GitHub App on at github.com, and a list Legion keeps on your computer that you tick. Default: nothing ticked.
2. Each agent gets one of three levels: none (default), read, read and write. Write is a list of repos for that agent, taken from the ticked repos. Every write still raises an approval card in every mode, including full access (rev 6 rule, unchanged).
3. Creating a repo is a button for you, never an agent tool. It uses a third, separate GitHub App ("Legion (create)") with the high "Administration" permission, signed in only for that action and never saved to disk. Until that app is registered and checked, the button opens github.com/new instead.
4. A GitHub icon button sits in the title bar before the CI chip and opens a lean area: connection, repos with toggles, create repo, per-repo links. Settings, GitHub stays for sign-in details.
5. No `package.json` or `package-lock.json` change. Plain `fetch`, Node `fs`, the React already in the UI.

## 2. What exists today (read from the code)

| Piece | State | Where |
|---|---|---|
| Device-flow sign-in for ONE app (read) | Built and tested | `src/core/connectors/github/client.ts:149-190` |
| Token store, encrypted at rest | Built; token id `github-read` | `src/core/connectors/store.ts`, `client.ts:16` |
| Refresh without a client secret | Built (`grant_type=refresh_token`, no secret). GitHub's docs confirm the secret is not needed for device-flow tokens (section 3) | `client.ts:244-275`, call at `:255` |
| Read client: `request`, `connection`, `can`, `logs` | Built. `logs` fails closed while the host list is empty | `client.ts:353, 396, 427, 441`; `hosts.ts:14` |
| 14 read tools in the in-process gateway | Built | `tools.ts:93-150`, `gateway.ts:131-146` |
| Per-agent opt-in `connectors: ['github']` (read only) | Built | `src/shared/types.ts:121-124`, `gateway.ts:77`, `AgentEditor.tsx:24,82,140-143` |
| Class table with the 6 write names as WRITE | Built (names only) | `classes.ts:18-35` |
| Admin routes: status, connection, connect, cancel, disconnect | Built | `src/core/connectors/index.ts:100-128` |
| Main-process connect, with core restart for the key | Built | `src/electron/connector-ipc.ts:30-75` |
| Settings, GitHub page | Built | `ui/src/connectors/GithubSection.tsx`, `Settings.tsx:31,85` |
| CI chip, panel, poller, repo from git remote | Built | `ui/src/ci/CiChip.tsx`, `CiPanel.tsx`, `src/core/ci/repo.ts` |

Missing:

| Gap | Evidence |
|---|---|
| **No GitHub App is registered.** `GITHUB_READ_APP_CLIENT_ID = 'unregistered'`; sign-in refuses to start and the UI says "not registered in this build" | `hosts.ts:20`, `connector-ipc.ts:41` |
| Write app and create app: no ids, token ids or client instances. The client holds one `clientId` and one token id | `client.ts:16, 132` |
| No write methods, no `writes.ts`, no write handlers, no connector cards. The gateway refuses anything not READ | `client.ts:11`, `gateway.ts:97` |
| No Legion-side repo list. `github_repo_list` calls `/user/repos` and every tool takes any `owner/name` | `tools.ts:97-103` |
| No per-agent write permission or per-repo scope. `connectors` is a flat opt-in | `types.ts:124` |
| No title-bar entry for GitHub. The only GitHub UI in the main window is the CI chip | `TitleBar.tsx:65-67` |
| No repo creation anywhere | search of `src/core/connectors` |
| The installation's repo list (`/user/installations/{id}/repositories`) is never read; `connection()` reads only the installations | `client.ts:409` |

## 3. Research (pages opened)

| Question | Finding | Source |
|---|---|---|
| Device-flow tokens | Permissions are the intersection of the app's and the user's | docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app |
| Refresh needs a secret? | `client_secret` is required "unless the user access token was generated using the device flow". Access token 8 h, refresh token 6 months. Each refresh rotates both; the old refresh token dies | .../authenticating-with-a-github-app/refreshing-user-access-tokens |
| List the chosen repos | `GET /user/installations` gives installations with `repository_selection` (`all`/`selected`) and `permissions`. `GET /user/installations/{id}/repositories` gives only repos the user can reach and the installation covers; `per_page` max 100; needs Metadata read | docs.github.com/en/rest/apps/installations; docs.github.com/en/rest/authentication/permissions-required-for-github-apps |
| Create a repo with an app user token | `POST /orgs/{org}/repos` lists "GitHub App user access tokens" and needs "Administration" repository permission (write). The permissions page lists `POST /user/repos` the same way | docs.github.com/rest/repos/repos; permissions page above |
| Personal account caveat | A community thread reports apps failing to create repos in a personal account. Not an official statement, so personal creation is **unproven** (check C-GH-7) | github.com/orgs/community/discussions/172926 |
| Do created repos join the install? | "If the app creates any repositories, the app will automatically be granted access to those repositories as well." That is the creating app only: a repo made by Legion (create) is not visible to Legion (read) or Legion (write) until added | docs.github.com/en/apps/using-github-apps/installing-your-own-github-app |
| Choosing repos at GitHub | Install page offers "All repositories" or "Only select repositories". Later: profile, Settings, Applications, Installed GitHub Apps, Configure (personal); org Settings, GitHub Apps, Configure (org). Click paths only, no documented URL pattern | docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps |
| Add a repo by API | `PUT /user/installations/{id}/repositories/{repo_id}` needs admin on the repo; the page does not say an app user token works. Treated as unusable. Legion links to GitHub instead | docs.github.com/en/rest/apps/installations |
| Cost of "Administration" | GitHub says to explain it on the app homepage because it is a high permission | docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app |

## 4. Decisions (reason for each; CHANGE marks a difference from rev 6)

### 4.1 App set and permissions

Three apps. All: device flow on, expire user tokens on, no webhook, no callback, no client secret, no private key.

| App | Repository permissions | Why |
|---|---|---|
| **Legion (read)** | Metadata read, Contents read, Issues read, Pull requests read, Actions read, Commit statuses read | Unchanged from rev 6 section 9. Can never write. |
| **Legion (write)** | Metadata read, Contents read, Issues write, Pull requests write, Actions write, Commit statuses read | Unchanged from rev 6. No Contents write, no Administration, no Workflows. Agents never push through the API. |
| **Legion (create)** (CHANGE: new) | Metadata read, **Administration write**. Nothing else | The only app with a dangerous permission, kept apart so a leaked read or write token can never delete or reconfigure a repo. |

Why a third app and not Administration inside "write": Administration write covers repo deletion, settings and collaborators. Rev 6 relies on the write app being low-power. Folding Administration in would make every agent-write token an admin token.

Create-app handling (CHANGE):
- The sign-in starts only when you press "Create". The token lives in memory in the core for at most 15 minutes after last use, is **never written to disk**, is cleared on Disconnect or quit, and is unreachable from the gateway (the module is not imported by `gateway.ts`; source test).
- No agent tool. No `github_repo_create` in 0.3.0. A later release that adds one must make it class WRITE, carded, off by default, behind its own switch.
- Delete, transfer, archive, collaborator and settings calls are not coded, so a leaked create-app token gives only what a same-user process could already do (stated limit, rev 6 section 4.4).
- Fallback and gate: if `GITHUB_CREATE_APP_CLIENT_ID` is not a real client id, or C-GH-7 has not passed, the form shows only "Create on GitHub", which opens `https://github.com/new`. So 0.3.0 can ship without the third app.
- A repo made by Legion (create) is covered by that app only. The area then says "Created. Legion (read) cannot see it yet. Add it at GitHub." with the install-settings link per installed app. Legion does not call the add-repository API.
- Owner choice in the form: "Your account" or an organisation. Organisations come from `GET /user/orgs` when the token may read it; if not, the owner types the organisation name. If C-GH-7 fails for personal accounts, the personal option is hidden and replaced by the "Create on GitHub" link. Organisation creation is documented but needs the org to approve the app; GitHub's refusal is shown in plain words.

### 4.2 Repo visibility: two layers

Layer 1, GitHub side (the hard wall). You install each app on selected repos only, never "All repositories" (rev 6 rule, kept). Legion cannot see anything else whatever its own code does. Legion shows the install state from `repository_selection`; if it reads `all`, the area warns and links to the change page. Legion cannot change it.

Layer 2, Legion side (CHANGE: new). A file on your computer, `<dataDir>/connectors/github-repos.json`, `{ v: 1, ticked: string[] }`. **Default: empty.** Reason: optionality first. "Installed at GitHub" means Legion may reach a repo. "Ticked in Legion" means Legion's agents and screens may use it. A new repo appears unticked.

What the tick controls:
- Agent tools: a `github_*` call on an unticked repo is refused ("That repo is not turned on in Legion. Turn it on in the GitHub area.") in the gateway, not only in the UI. `github_repo_list` returns ticked repos only.
- The per-agent picker offers ticked repos only.
- Not controlled: the CI chip and panel keep working for the project's own repo under your own session, as today. They are your screens, not an agent. The area says so.
- A file in `<dataDir>` can be changed by a same-user process. The tick is a guard against mistakes and agents, not against local malware; layer 1 is the wall.

A master switch "Let agents use GitHub" (default on after connecting) turns all `github_*` tools off in one click without signing out.

### 4.3 Per-agent GitHub permission

Model (CHANGE: extends `connectors`). `AgentProfile.connectors?: string[]` stays and `'github'` keeps meaning read, so old data works. Add:

```ts
// src/shared/types.ts, beside `connectors`
/** Repos ("owner/name") this agent may WRITE to through Legion's GitHub tools. Absent or empty: none. Needs connectors:['github'], the repo ticked in Legion and the write app installed on it. Every write still raises a card. */
githubWrite?: string[];
```

Three levels, derived from the two fields:
- **None**: `connectors` lacks `'github'`. Default for every agent, new or old.
- **Read**: `connectors` has `'github'`, `githubWrite` empty. Reads any ticked repo.
- **Read and write**: also `githubWrite` lists repos. Writes only to those, and only while each is still ticked.

Per repo, not per project: a repo is what GitHub scopes on, and a project may have no repo or agents with different needs. The project link is a convenience only. Project view shows the repo parsed from its git remote (`src/core/ci/repo.ts` `parseRemoteUrl`) with a button "Let this project's agents read it" (sets `connectors:['github']` on the members) and a separate "Let them write" button. Answer to "default read for agents in linked projects?": **no**. It would grant access with no click; the buttons make it one click.

Where it shows:
- Agent editor, Connectors fieldset (`AgentEditor.tsx:140`): None / Read / Read and write, and under Write a checklist of ticked repos. Note: "Every write asks you first, even with Full access."
- Agent list and card: a tag "GitHub: read" or "GitHub: write, 2 repos".
- Project view: repo line, tick state, the two buttons, count of members with access.
- Gates are unchanged. GitHub writes are handler cards (rev 6 4.1), not a gate verdict. A Gates rule may still Block the `connectors` group.

Write order in the gateway: agent has `'github'`, run is not MCP-client origin, master switch on, repo in `githubWrite`, repo ticked, write app signed in and `can(area,'write')`, then the card (full text, taint warning), then the call, never retried after send. A failed step gives a plain refusal and no card.

Approval modes (`ask`, `auto-edits`, `full`; `types.ts:19`) do not decide GitHub writes. The handler raises the card, so `approvals.ts:48` ("in `full` a guard never shows a card") gets the dated exception comment rev 6 step 6 asks for.

### 4.4 Never offered to agents (rev 6 list, kept and extended)

Merge, API push or commit, branch create or delete, repo create or delete, any delete, workflow dispatch, repo settings, collaborators, secrets. The write set stays the six names already in `classes.ts:30-35`: `github_issue_write`, `github_comment`, `github_create_pr`, `github_review`, `github_ci_rerun`, `github_ci_cancel`.

## 5. The GitHub area (UI)

### 5.1 Where

- **Icon**: a GitHub mark button in `.tb-right`, directly before `<CiChip />` (`TitleBar.tsx:67`). Reason: the CI chip is the only other GitHub item and the two belong together; Doctor is a setup check, not an integration. A small dot shows state (grey not connected, green connected, amber needs attention). Settings, GitHub has "Show the GitHub icon" (default on) so it can be hidden. Command palette entry "Open GitHub" (`ui/src/commands.ts`) always works.
- Click opens a right-hand panel, same pattern as the CI panel (small store, `aria-expanded`, Esc closes). No new top-level view, no nav change.
- Settings, GitHub (`GithubSection.tsx`) stays as the deep page: key and restart handling, memory-only sign-in, revoke link, the icon switch. The area links to it.

### 5.2 Contents for 0.3.0

1. **Connection card**: signed in as `login` or not connected; Connect / Sign out; write app row ("Writes: off. Turn on"); create row ("Create repos: signs in when you use it"); rate limit left; master switch.
2. **Repos list** (from the installation endpoint): name, private or public tag, install badges "Read" and "Write", a toggle "Turn on in Legion", ticked first, search box, 100 per page with "Show more". Buttons per row: Open on GitHub, Change repos at GitHub.
3. **Per-repo detail** (expand): CI status (reuse the CI store summary when this repo is the watched one, else "Watch in CI panel"), projects using it (git remote match, click opens the project), agents with read or write on it (click opens the agent).
4. **Create repo**: owner (your account or an organisation), name, description, private (default on), add README (default off), "Turn it on in Legion" (default off). Button "Create". Without the create app: one button, "Create on GitHub".

### 5.3 Explicitly OUT of 0.3.0

Browsing or creating issues, PRs and code by hand; webhooks and live events; merge; branch tools; repo delete, archive, transfer, settings; collaborators; clone button; GitHub Enterprise Server; PAT sign-in; more than one account; an agent tool to create repos; adding repos to an installation by API; log viewing beyond the CI panel.

### 5.4 States (plain English)

| State | What the area shows |
|---|---|
| App not registered | "GitHub sign-in is not available in this build yet." Connect disabled |
| Not connected | "GitHub is not connected. Connect it to choose which repos Legion can use." [Connect GitHub] |
| Signing in | The code in large type, "Enter this code at github.com/login/device", [Open GitHub] [Cancel]; polls every 2 s as today |
| Loading repos | Skeleton rows; connection card already usable |
| Connected, nothing installed | "GitHub is connected, but Legion is not installed on any repo. Pick repos at GitHub." [Choose repos at GitHub] |
| Installed, none ticked | "No repo is turned on. Agents cannot see any repo until you turn one on." Normal state, not an error |
| Install covers all repos | Amber: "Legion can reach every repo on this account. Narrow it at GitHub." [Change at GitHub] |
| Sign-in ended | "Your GitHub sign-in ended. Sign in again." [Sign in] |
| Rate limited | "GitHub asks you to wait until 14:32." GitHub buttons disabled with that time; the list shows what it has |
| Offline or GitHub down | "Legion could not reach GitHub. Showing the last list." [Try again] |
| Create failed | GitHub's reason in plain words (name taken, no right to create here, organisation must approve) and the next step; never raw bodies |
| Created, not yet visible | "Created. Legion (read) cannot see it until you add it at GitHub." [Add it at GitHub] |
| Writes off | "Agents cannot write. Turn on writes to let chosen agents comment, open issues and pull requests, and re-run CI. Every write asks you first." |

No em dashes in any string; "your computer", never "this computer". A lint test enforces the dash rule over the new files.

## 6. Core design

### 6.1 Client (`src/core/connectors/github/`)

- `hosts.ts`: add `GITHUB_WRITE_APP_CLIENT_ID`, `GITHUB_CREATE_APP_CLIENT_ID` (both `'unregistered'`), the three app slugs, `githubInstallUrl(slug)` = `https://github.com/apps/<slug>/installations/new`, `GITHUB_INSTALLATIONS_URL = 'https://github.com/settings/installations'` (safe fallback that lists every installed app), and `githubInstallSettingsUrl(installation)` (shape verified at registration, section 8). All addresses stay in `hosts.ts` because the tripwire lets only that file name hosts.
- `client.ts`: replace the module constants with `AppKind = 'read' | 'write' | 'create'` and a table `{ clientId, tokenId }`. `createGitHubClient({ app })` builds one instance per kind. Token ids: `github-read` (unchanged, so existing sign-ins survive), `github-write`, none for create (memory only). `getGitHubClient()` still returns the read client; `getGitHubClient('write' | 'create')` the others. Refresh logic is shared and unchanged. New read methods: `installations()` from `GET /user/installations` (id, account login and type, `repository_selection`, `permissions`, `app_slug`), and `installationRepos(id)` paging `GET /user/installations/{id}/repositories?per_page=100` (cap 10 pages, then "showing the first 1000"). Both use ETags.

### 6.2 Allowlist (`github/allowlist.ts`, new)

`readAllowlist`, `setTicked(fullName, on)`, `isTicked(fullName)`, `masterOn()`, `setMaster(on)`. Every name passes `validRepoString` (`src/core/ci/repo.ts`). Atomic write (temp file, rename). A corrupt file means empty (fail closed). Cap 500 entries. Case-insensitive, stored lower-case.

### 6.3 Gateway (`gateway.ts`, `tools.ts`)

- New step before the class check (`gateway.ts:97`): take the `repo` argument (or `owner` for `github_repo_list`) and refuse if not ticked or the master switch is off.
- `github_repo_list` lists ticked repos only; it never calls `/user/repos`.
- Write tools: `github/write-tools.ts` exports `GITHUB_WRITE_TOOLS`. Each handler calls `ApprovalBroker.request` and then `writes.ts` (rev 6: `rerunFailed`, `cancel`, plus `createIssue`, `commentOn`, `createPullRequest`, `submitReview`). `writes.ts` is importable only by `write-tools.ts` and admin routes (source test).
- Card text: full argument text, repo, tool, class, taint warning (rev 6 4.1 step 4), and the agent's name.

### 6.4 Admin routes (admin-only by the default-deny gate)

| Route | Purpose |
|---|---|
| `GET /api/github/area` | One call for the area: `GithubAreaView`. No GitHub call if cached under 60 s and not forced |
| `PUT /api/github/repos/:owner/:name/tick` `{on}` | Tick or untick; 404 if the repo is not in the installed list |
| `PUT /api/github/agents-switch` `{on}` | Master switch |
| `POST /api/github/apps/write/connect`, `.../disconnect` | Same device flow for the write app; disconnect deletes `github-write` locally and returns the revoke link |
| `POST /api/github/repos` `{owner?, name, description?, private, readme, tick}` | Create. Runs the create-app device flow if needed (returns `{phase:'pending',...}` like the read flow), then `POST /user/repos` or `/orgs/{org}/repos`. Validates every field, never logs the body |
| `GET /api/github/projects-using/:owner/:name` | Projects whose git remote matches (reuse `repo.ts`) |

The existing `/api/connectors/github/*` routes stay for `GithubSection`. The device flow for write and create goes through `connector-ipc.ts` `connectGithub(app)` with an `app` parameter; only the fixed `GITHUB_DEVICE_PAGE_URL` is ever opened.

### 6.5 Shared contract (`src/shared/github-area.ts`, new, written first)

```ts
export type GithubApp = 'read' | 'write' | 'create';
export interface GithubRepoRow { fullName: string; private: boolean; installedRead: boolean; installedWrite: boolean; ticked: boolean; htmlUrl: string; installationSettingsUrl: string }
export interface GithubAreaView {
  registered: Record<GithubApp, boolean>; signedIn: Record<GithubApp, boolean>; login?: string;
  agentsEnabled: boolean; selection: 'selected' | 'all' | 'unknown'; repos: GithubRepoRow[]; truncated: boolean;
  rate?: { remaining: number; resetAt: string };
  problem?: { kind: 'not-connected' | 'auth-expired' | 'rate-limited' | 'network'; resetAt?: string };
}
export type GithubLevel = 'none' | 'read' | 'write';
export function agentGithubLevel(a: { connectors?: string[]; githubWrite?: string[] }): GithubLevel;
export function githubAgentsFor(repo: string, agents: AgentProfile[]): { read: string[]; write: string[] };
export const CREATE_REPO_NAME_RE: RegExp; // ^[A-Za-z0-9._-]{1,100}$, and not '.' or '..'
```

## 7. Security

### 7.1 Threats added

| Threat | Control | Test |
|---|---|---|
| Create-app token (Administration write) stolen from disk | Memory only, 15 min idle expiry, cleared on quit | After a create, no file in `<dataDir>` holds the token; `tokens.set` is never called for the create app |
| Create-app token reachable by an agent | No tool; not imported by the gateway; the log redactor already covers `ghu_` | Source test: only `repo-admin*.ts` import the create client; mutation negative (add an import to `gateway.ts`) |
| Repo name injection (path, query, `../`) in create and tick | Name regex, `.`/`..` check, `encodeURIComponent`, JSON body (never string-built); org must come from the owner's own org list or typed and then confirmed by GitHub | Table test: `../x`, `a/b`, `%2e%2e`, 101 chars, empty, unicode lookalikes |
| Prompt injection through repo names or descriptions into cards or logs | Plain text, scrubbed, clipped | Card shows text verbatim and escaped |
| Public repo made by mistake | Private is the default; the button reads "Create public repo" when off | UI test |
| Repo made in the wrong owner | Confirm line repeats `owner/name` and visibility | UI test |
| Tick file edited by an agent shell | Stated limit (same-user file). Layer 1 at GitHub is the wall. No tool writes the file; the rev 6 D11 warning covers connectors with full access and a shell | Source test: no gateway tool writes the file |
| Agent reads an installed but unticked repo | Gateway check | One test per read tool and `connector_call_read`; mutation negative |
| Agent writes to a repo outside its `githubWrite` | Gateway check before the card | Test with mutation negative |
| Write without a card in `full` | Handler card (rev 6 4.1 step 7) | Claude-path and provider-path tests with mutation negatives |
| A new or created repo silently reachable | New repos arrive unticked; a created repo is ticked only if the form box was ticked (default off) | Test |
| Install set to "All repositories" widens layer 1 | Detected; amber warning; layer 2 still limits agents | UI test |
| Org creation without org consent | GitHub enforces org approval; Legion shows GitHub's reason | Fake returns 403 and 404; copy test |
| New network surface | Only `client.ts` and the device-flow code fetch; addresses in `hosts.ts`; tripwire list extended for any new fetching file | A planted fetch elsewhere fails |
| Double create (double click, retry) | Button disabled while pending; one in flight per core; **no retry after send**; a 422 "name exists" is shown, not retried | Test |
| Secrets in the new routes | No token, device code or query-string URL in any response | Snapshot test of route output |

### 7.2 Tests that must exist

1. `github-allowlist.test.ts`: default empty, persists, corrupt file is empty, validation, atomic write.
2. `github-gateway-scope.test.ts`: every read tool refuses an unticked repo; master switch off refuses all; `connector_call_read` the same.
3. `github-agent-level.test.ts`: `agentGithubLevel` for all combinations; write needs repo in the list, ticked, and the write app.
4. `github-write-cards.test.ts`: every write raises a card in `ask`, `auto-edits` and `full`, on the Claude path and the provider path, with mutation negatives.
5. `github-create-repo.test.ts` (fake GitHub with both create endpoints, 422, 403, 429): memory-only token, no retry, validation table, private default.
6. `github-area-routes.test.ts`: admin-only, no secret in output, caching, rate-limit handling.
7. `connector-imports.test.ts` (source test): importers of `writes.ts` and the create client are exactly the allowed files.
8. `ui/src/github/*.test.tsx`: each state in 5.4, keyboard path, no em dash in any string.
9. Existing tripwire, transport and `bsv-scan` tests are updated, never deleted.

## 8. Registration (owner's browser session)

Where: github.com, your account, Settings, Developer settings, GitHub Apps, New GitHub App (https://github.com/settings/apps/new). One app at a time, one OK from you per app. Never click "Generate a new client secret". Never click "Generate a private key". No payment.

Same on all three:

| Field | Value |
|---|---|
| Homepage URL | the public Legion repository URL |
| Callback URL | the homepage URL if the form insists (device flow ignores it) |
| Expire user authorization tokens | checked |
| Request user authorization (OAuth) during installation | unchecked |
| Enable Device Flow | **checked** |
| Setup URL | empty |
| Webhook, Active | unchecked |
| Account permissions, Organization permissions, Events | none |
| Where can this GitHub App be installed | Any account (or "Only on this account" while testing) |

Different per app:

| Field | Legion (read) | Legion (write) | Legion (create) |
|---|---|---|---|
| Name (max 34) | `Legion (read)` | `Legion (write)` | `Legion (create)` |
| Description | "Lets the Legion desktop app read repositories, issues, pull requests and CI status for you. Read only." | "Lets the Legion desktop app comment, open issues and pull requests, and re-run CI for you, after you approve each action." | "Lets the Legion desktop app create a repository when you press Create. Nothing else. High permission on purpose; Legion keeps this sign-in in memory only." |
| Repository permissions | Metadata R, Contents R, Issues R, Pull requests R, Actions R, Commit statuses R | Metadata R, Contents R, Issues **RW**, Pull requests **RW**, Actions **RW**, Commit statuses R | Metadata R, **Administration RW** |

After creating each app:
1. Copy the **Client ID** (public) and the **slug** from the app's public page address. They go into `hosts.ts`. Record them in the tracker. No secret is involved.
2. Install it at `https://github.com/apps/<slug>/installations/new`, choose **Only select repositories**, pick one throwaway test repo. For the create app GitHub may need one repo selected; use the throwaway.
3. Open the installation page and note the address shape (`.../settings/installations/<id>`; for an org `.../organizations/<org>/settings/installations/<id>`). Write it into section 6.1 so `githubInstallSettingsUrl` is checked, not guessed. If it differs, use `GITHUB_INSTALLATIONS_URL`.
4. Prove device flow is on: one `POST https://github.com/login/device/code` with the client ID returns a user code (C-GH-1).

Order: read app first and stop until its sign-in works. Write app second. Create app last and optional.

### Hands-on checks (append to `claude/tracker-pc-checks.md` when built)

| Id | Check | Pass |
|---|---|---|
| C-GH-1 | Device code request with each client id | A user code returns |
| C-GH-3 | Connect the read app in Legion | The area lists only repos installed at GitHub, all unticked |
| C-GH-4 | Tick one repo. An agent with Read can use it; an unticked repo is refused | Refusal text is plain |
| C-GH-5 | Agent with Write on repo A tries to comment on repo B | Refused, no card |
| C-GH-6 | Agent in `full` comments on repo A | A card appears; nothing posts until Allow; Deny posts nothing |
| C-GH-7 | Create app: make a private repo (a) in your account (b) in an organisation | Repo exists; the token is in no file under `<dataDir>`; if (a) fails the personal option is hidden |
| C-GH-8 | Let the access token expire (8 h) | Refresh works with no new sign-in |
| C-GH-9 | Sign out in Legion | Local tokens gone; the revoke link opens the right GitHub page |
| C-GH-10 | Install set to all repos | Amber warning shows |
| C-GH-11 | Rate limit (fake or a real 403) | "Wait until" message |
| C-GH-12 | Keyboard and screen-reader pass over the area | Reachable and labelled |
| C-GH-13 | Turn the icon off in Settings | Icon gone; area still opens from the palette |

## 9. Hard rule: no package changes

`package.json` and `package-lock.json` stay byte-identical to `main` on the release branch. A full install would end the updater stepping stone. Controls: every unit PR runs `git diff --stat -- package.json package-lock.json` and it must be empty; the release checklist compares both files' hashes against `main`. Allowed: `fetch`, `node:fs`, `node:crypto`, the React and `zod` already in the tree. Not allowed: an Octokit, an icon package, a new test runner. The GitHub mark is an inline SVG glyph in `Icon`.

## 10. Work breakdown (parallel units)

Unit U0 first (one agent, about 30 minutes): write `src/shared/github-area.ts` (6.5), plus the empty seams `write-tools.ts` (`GITHUB_WRITE_TOOLS = {}`) and `repo-admin-routes.ts` (`addRepoAdminRoutes`), plus the `allowlist.ts` function signatures. Everyone builds against these.

| Unit | Owns (only these files) | Provides / needs |
|---|---|---|
| **U1 Client** | `github/client.ts`, `github/hosts.ts`, `github/apps.ts` (new), client tests, tripwire list in `test/bsv-scan.ts` | Provides `getGitHubClient(kind)`, `installations()`, `installationRepos(id)`, the id constants. Needs nothing |
| **U2 Area routes and flows** | `connectors/index.ts`, `github/area.ts` (new), `github/allowlist.ts` (new), `src/electron/connector-ipc.ts`, tests | Provides the 6.4 routes returning `GithubAreaView`. Needs U1 methods (use the fake until merged) and U0 types; calls `addRepoAdminRoutes` in one line |
| **U3 Gateway scope and agent level** | `gateway.ts`, `tools.ts`, `classes.ts` (only if a name changes), `src/shared/types.ts` (add `githubWrite`), `src/shared/connectors-view.ts`, config validation of `githubWrite` | Provides refusal of unticked repos and the write order. Imports `isTicked`, `masterOn` (U2) and `GITHUB_WRITE_TOOLS` (U4) from the U0 seams |
| **U4 Writes and cards** | `github/writes.ts`, `github/write-tools.ts`, `approvals.ts` (the dated comment only), `docs/TESTING.md` entry, tests 4 and 7 | Provides `GITHUB_WRITE_TOOLS`. Needs U1 write client and the U3 seam. Ships only after the write app is registered; otherwise the area shows "Writes: not available yet" and only U4 slips |
| **U5 Repo create** | `github/repo-admin.ts`, `github/repo-admin-routes.ts`, test 5 | Provides `addRepoAdminRoutes(add, deps)`. Needs U1 create client and `CREATE_REPO_NAME_RE` |
| **U6 Area UI** | `ui/src/github/*` (new: `GithubArea.tsx`, `githubStore.ts`, `GithubChip.tsx`, `github.css`, tests), one line each in `TitleBar.tsx`, `Icon.tsx`, `commands.ts`, `App.tsx`, and typed calls in `ui/src/api.ts` | Consumes `GithubAreaView` and the routes; builds against a mock until U2 lands |
| **U7 Agent and project UI** | `ui/src/components/AgentEditor.tsx`, `ui/src/projects/ProjectView.tsx`, the agent-card tag file, tests | Consumes `agentGithubLevel`, `githubAgentsFor` and ticked repos from `GET /api/github/area` |
| **U8 Fakes and release** | `src/core/ci/fake-github.ts` (installations, installation repos, create, 422, 403, 429), tracker entries, release checklist with the section 9 check | Provides the fake all tests use. The owner session runs section 8 |

Overlap: none by design. Shared touch points are single lines owned by one unit each (U6 for the title bar, app mount, palette; U2 for the `addRepoAdminRoutes` call). `types.ts` is U3 only.

Merge order: U0, then U1 and U8, then U2, U3, U5, U6, U7 in parallel, U4 last. Cut line: U4 and U5 may slip; the area still ships with the allowlist, the per-agent read level and the browser fallback for create.

## 11. Open questions for the owner

1. Register all three apps, or two now (create later)? Recommendation: all three, create last.
2. If personal-account creation fails check C-GH-7, is the browser fallback enough? Recommendation: yes.
3. Confirm that agent-side repo creation stays out of 0.3.0.
4. GitHub icon visible by default? Recommendation: yes, with the off switch.
5. Agent writes (U4) in 0.3.0, or 0.3.1? It is the biggest unit and needs the write app; the area is useful without it.

## 12. Changes against rev 6

1. Refresh needs no secret for device-flow tokens (GitHub's docs). Rev 6 D2 and the "sign in again every 8 h" fallback are dropped; the refresh already built stays.
2. Third app "Legion (create)" with Administration write, memory-only token, owner-only UI.
3. Repo list comes from the installation repository endpoint, not `/user/repos`.
4. New Legion-side allowlist, default none, with a master switch.
5. New `AgentProfile.githubWrite` repo list; `connectors: ['github']` keeps meaning read.
6. Writes are per agent and per repo, on top of the write app and a card. Rev 6 had one global write switch.
7. Unchanged: handler cards in every mode, selected-repos installs, the never-offered list, encrypted store, log redactor, tripwires.

## 13. Amendment, 2026-10-15 (owner decisions after registration)

1. **Two Apps, not three.** GitHub offers a narrow repository permission "Repository creation: Create repositories" (seen on the registration form). It is added to **Legion (write)**; there is no "Legion (create)" App and no Administration permission anywhere. A repo created by Legion (write) is granted to that App automatically, so it appears in the GitHub area at once (the area merges the read and write installations). Section 4.1's create App, memory-only create token and the "Created. Legion (read) cannot see it yet" state are dropped; create goes through the write App's normal (encrypted) token and is still an owner-only UI action, never an agent tool. C-GH-7 still proves `POST /user/repos` with this permission on a personal account; if it fails, the form falls back to "Create on GitHub".
2. **Registered.** Legion (read): slug `legion-read`, App ID 5314210, client ID `Iv23liIt2yvFfWgPrZfK`. Legion (write): slug `legion-write`, App ID 5314282, client ID `Iv23li7s6igxaj3TZMa3`. Both: device flow on (C-GH-1 passed for both), expire tokens on, no webhook, any account. Write App permissions: Metadata R, Contents R, Commit statuses R, Issues RW, Pull requests RW, Actions RW, Repository creation RW. GitHub requires a private key before install; the keys live only in the owner's encrypted vault and are never used or shipped by Legion.
3. **CI and agents are core of the area (owner: "it also should have the good ci stuff and agent stuff").** Per repo: latest runs with status, failed jobs, links to logs on GitHub, and "Re-run failed" / "Cancel" through the write App with a card (reuse the CI store and `github_ci_*` handlers). Per repo: the agents with read or write, and what agents did there through Legion (comments, issues, pull requests opened, re-runs; from the gateway's own records, no extra GitHub calls), plus one-click "Let this project's agents read it / write". The CI chip opens the area at the watched repo.
