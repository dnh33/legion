# Plan: Project board (after 0.2.0; own branch `claude/project-board`)

Branch from `integration/v1`. **Not part of 0.2.0.** Off by default behind `config.json` `experimental.projectBoard` (only the literal `true` turns it on; nothing in the app or any route writes it). With it off nothing new is built, routed, listed as an MCP tool, given to a bot or shown in the UI. New code lives in `src/core/projects/board/*`, `ui/src/projects/board/*`, `test/project-board-*.test.ts`; the hooks elsewhere are additive (listed in section 9). Nothing here has run on Windows (section 10).

Goal: Legion feels like a project manager for the owner's agents: a small board inside a Project. Not Jira.

## 1. Research (what was looked up, 2026-10-02)

Several hosts (docs.github.com, linear.app, atlassian.com) were blocked from this cloud session; for those the facts come from web-search summaries only and are marked "summary".

| Documented behaviour (source) | What Legion copies | What Legion deliberately leaves out |
|---|---|---|
| **Claude projects**: instructions, knowledge, chats; sharing by plan ([support.claude.com](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)) | Board lives *inside* a Project; the project's instructions already reach every run | Sharing, permissions levels (single owner) |
| **Cowork projects** group files, instructions, memory and *scheduled tasks* per project; memory is project-scoped ([support.claude.com](https://support.claude.com/en/articles/14116274-organize-your-tasks-with-claude-cowork), search summary) | Project-scoped work list next to project context | **Scheduled/recurring tasks** (the owner's brief: no schedules, no automation) |
| **Claude Code task list**: Claude's own checklist, items pending / in progress / complete, `Ctrl+T` toggles it, can be shared across sessions by a named list id ([code.claude.com](https://code.claude.com/docs/en/interactive-mode), fetched, "Task list" section) | Small status vocabulary; the agent writes to its own items through a tool; a visible trail | Agent-created items going live directly: here they wait in an Inbox |
| **Linear**: status categories triage, backlog, unstarted, started, completed, canceled; default flow Backlog > Todo > In Progress > Done > Canceled; priority; labels; **Triage** inbox for new issues ([linear.app docs](https://linear.app/docs/configuring-workflows.md), search summary) | Triage idea = our **Inbox** for bot proposals; 3 priorities; few labels | Custom statuses, cycles, estimates, sub-issues, SLAs |
| **GitHub Projects**: Board (Status columns), Table, Roadmap views; fields; workflows (auto-add, item closed -> Done, auto-archive) ([docs.github.com](https://docs.github.com/en/issues/planning-and-tracking-with-projects), search summary) | Board + List views; filters | **All automation workflows** (auto-add, auto-move to Done, auto-archive) and Roadmap |
| **Cursor background agents / Codex cloud tasks**: agent statuses Running / Waiting / Complete / Failed; the result is *reviewed before it is merged*; owner decides ([search summaries](https://stevekinney.com/courses/ai-development/cursor-background-agents)) | A finished run lands in **Review**, never Done; a failed run lands in **Blocked** with the error; the run is linked | Branch/PR creation, parallel fleets |
| **Kanban**: columns per stage, cards move left to right, WIP limits ([Wikipedia](https://en.wikipedia.org/wiki/Kanban_(development)), search summary) | Columns + cards, drag *and* keyboard moves | WIP limits (could be Later), swimlanes |

Owner-side rules that shape it (from CLAUDE.md and the Projects plan): owner-only authority, native confirmation only where authority widens, taint wrapping of outside content, Library trust model (bot notes are untrusted until the owner accepts), no execution without the owner.

## 2. Data model (`src/shared/board.ts`)

`WorkItem`: `id` (`wi_<10 hex>`), `projectId`, `title` (1-120, one line), `description` (<= 2,000, clipped), `status` (`backlog | doing | review | done | blocked`), `assignee` (`null | {kind:'owner'} | {kind:'agent', id}`; an object because an agent id could be the word "owner"), `due` (`YYYY-MM-DD` or absent), `priority` (`low | normal | high`), `labels` (<= 5, each 1-24 chars of `a-z0-9 -`), `order` (integer, position inside its status column), `createdBy` / `updatedBy` (`Actor`), `createdAt`, `updatedAt`, `trust` (`human | untrusted`), `proposal` (`{suggestedAssignee?}` present only while the item waits in the Inbox), `taskIds` (<= 20), `roomIds` (<= 10), `activeRun` (task id while a Run-this-item run is live), `lastRun` (`{taskId, status, endedAt, tainted, preview <= 1,000}`), `activity` (<= 30 entries, each `{at, by, kind, text <= 200}`).
`Actor`: `{kind:'owner'} | {kind:'agent', id, tainted?} | {kind:'system'}`.

Limits: 200 items per project (Inbox included), Inbox <= 30 per project and <= 8 per agent, text sizes as above, board file <= 4 MB (larger = treated as corrupt: renamed, empty board).

## 3. Storage, migration, downgrade

- One JSONL file per project, `<dataDir>/board/<projectId>.jsonl`. Each line `{v:1, kind:'item'|'delete', at, item|id}` holds the **whole item snapshot**; replay = last line per id wins, a `delete` line removes it. Append is one `appendFileSync` of one line. A torn or unparsable last line is skipped on load. Compaction (when lines > 3x live items + 200) writes `<file>.tmp` then renames (Windows: unlink-then-rename fallback, like `projects.json`).
- Unknown fields on an item and whole lines with `v` > 1 are kept and re-emitted on compaction.
- Nothing in `config.json` except the flag, nothing in `projects.json`, `state.json` or the room index. An older build never opens `board/`. Flag off = files untouched and unread. Deleting a project does not exist (archive only), so files are never orphaned; an archived project's board is read-only.
- Corrupt file (not a line-wise problem: unreadable or over the size cap): renamed `.corrupt-<time>`, board starts empty.

## 4. Routes (all admin-only by the existing default-deny gate; **none** is added to the client route list)

Registered only when the flag is on; flag off = `404` even for the admin.

| route | notes |
|---|---|
| `GET /api/board` | `{enabled:true, limits}`; the UI's only probe (404 = hidden) |
| `GET /api/projects/:id/board` | items by column order + inbox; works on archived projects |
| `POST .../items` | create (owner); archived = 409; assignee must be owner or a member |
| `PATCH .../items/:iid` | title, description, priority, labels, due, assignee, `status` (including `done`), `trust:'human'` ("I reviewed this text") |
| `POST .../items/:iid/move` `{status, index}` | move + reorder, owner |
| `DELETE .../items/:iid` | owner |
| `POST .../items/:iid/accept` `{assignee?, status?}`, `POST .../reject` | Inbox decisions, owner |
| `POST .../items/:iid/run` | owner; item assigned to a member agent; starts a task through `engine.startTask({source:'ui', projectId})` (same project path, same approvals, same cost) |
| `PUT .../items/:iid/rooms` `{roomIds}` | owner links rooms |

Events `board.updated` (`{projectId}` only, no text) go to the admin stream only (prefix list gets `board.`).
MCP (token client): read-only `legion_board_read` (`list`, `get`), registered only when the flag is on. **No** token write route or tool exists.
Bot tool `legion_board` (in-process, per run): `list`, `get`, `propose`, `update_own`. Only offered when the run has a project (resolved by the engine, never an argument).

## 5. Authority matrix

| action | owner (app, admin header) | bot, member of the item's project | token client (MCP/curl) |
|---|---|---|---|
| list / get items | yes | yes (own project only; Inbox hidden except own pending count) | read-only, no activity text, no Inbox |
| create item live | yes | **no** (propose only) | no |
| propose (Inbox, untrusted) | n/a | yes, rate limited, caps | no |
| edit text, due, priority, labels | yes | no | no |
| change status | any, including `done` | only items **assigned to it**, only to `doing / review / blocked`, never `done`, never from `done` | no |
| add a note (activity) | yes | own assigned items, <= 500 chars, flagged if the run is tainted | no |
| assign / reassign | yes | no | no |
| delete | yes | no | no |
| accept / reject Inbox | yes | no | no |
| run an item | yes | no | no |
| touch another project | owner yes | no (project fixed by the engine) | n/a |

No board action needs the native secret: none widens authority (assignment only names an existing member; running goes through the normal approval cards). Say so in the UI help text; do not claim more.

## 6. Run this item

1. Item must be `active` (not in the Inbox), assigned to a member agent, project active, no live run (`activeRun` whose task is queued/running = 409).
2. Prompt = item title, description, priority, due; text wrapped in `<legion-work-item>`, closing/opening tags neutralised. The project section is added by the existing project path.
3. Status -> `doing`, task linked (`taskIds`, `activeRun`), activity line.
4. **Untrusted text** (`trust:'untrusted'`, i.e. a bot's proposal the owner accepted without marking reviewed): the run starts `tainted` with an `ask` approval ceiling (same as an MCP-started run). Owner presses "Mark reviewed" to lift it. The owner's own text runs as a normal owner run.
5. Run end (module `onTaskEnd`): if the item is still `doing` and this is its `activeRun`: done -> `review` with `lastRun` (result preview clipped, taint flag); error/cancelled -> `blocked` with the error line. **Never `done`.** If the owner moved the item meanwhile, only the link and `lastRun` are recorded.
6. Nothing auto-runs, schedules or triggers.

## 7. UI map (`ui/src/projects/board/`)

- Project page gets a "Board" tab strip: **Board | List | Inbox (n)**, only when `GET /api/board` answered 200.
- Board: 5 columns (Backlog, Doing, Review, Done, Blocked), cards with title, assignee chip, priority mark (text, not colour only), due date, labels. Moves: drag with pointer, or keyboard: focus a card, `Enter` opens it, `Alt+←/→` moves between columns, `Alt+↑/↓` reorders; a "Move to" select on every card; every move announced in a polite live region. At 390 px the columns stack as an accordion list.
- List: sortable table (status, priority, assignee, due), same actions.
- Filters per project: assignee, status, priority, label, "mine/agents", text; kept in `localStorage` (convenience only).
- Inbox: bot proposals with "Written by <agent>" and a taint warning, Accept (choose assignee) / Reject; untrusted items show a "Not reviewed" badge and "Mark reviewed".
- Item dialog (reuse `Modal`): fields, activity trail, linked tasks (open) and rooms (open), Run this item, Delete (confirm).
- Styles `board.css` using existing tokens; no art touched.

## 8. Controls (each has a test in `test/project-board-*.test.ts`; each mutation must turn it red)

| # | Control | Test | Mutation |
|---|---|---|---|
| C1 | Flag: only literal `true`; default false; nothing writes it; no route, tool, module, preamble or MCP tool exists with it off | `-flag` | accept `"true"`/1; register routes unconditionally; add a settings write |
| C2 | Every board route needs the admin header; token alone gets 403; none on the client list | `-http` | list a board route as a client route |
| C3 | Owner create/edit/move/delete with validation and caps (sizes, labels, due, items, inbox) | `-store` | skip a cap |
| C4 | Bot `propose` lands in Inbox as untrusted, never live; rate limit; per-agent and per-project caps | `-tools` | store as active; drop the limiter |
| C5 | Bot `update_own`: only own assigned items, only doing/review/blocked, never done, not from done, no field edits; note clipped | `-tools` | allow `done`; allow another's item |
| C6 | Bot cannot delete, reassign, change due, accept, or touch another project; project comes from the engine job, not an argument; no project = no tool | `-tools` | read project from args |
| C7 | Tainted run: proposals and notes carry the taint mark; accepted untrusted item stays `untrusted` until the owner marks reviewed; bulk accept does not exist | `-tools` | clear trust on accept |
| C8 | Run: starts through the project path as the owner, links the task, moves to doing; untrusted text runs tainted + `ask` ceiling | `-run` | drop the ceiling |
| C9 | Run end: -> review (done), blocked (error/cancel), never done; owner-moved item not overridden; result clipped and taint-flagged | `-run` | move to done |
| C10 | Prompt wrapper neutralises tags in item text; bot-visible `get` wraps untrusted text as data | `-run` | skip neutralise |
| C11 | Token client: `legion_board_read` read-only, no activity text, no Inbox; no write tool anywhere | `-http` | register a write tool |
| C12 | `board.*` events reach only the admin stream, and carry no item text | `-http` | drop the prefix |
| C13 | Storage: atomic compaction, torn last line skipped, unknown fields and `v:2` lines preserved, corrupt/oversize file backed up, old files load | `-store` | drop field preservation |
| C14 | Archived project: board read-only | `-store`, `-http` | ignore status |
| C15 | Order: moves keep a dense order per column; keyboard/pointer moves share one pure function | `-store`, `-ui` | skip renumber |
| C16 | UI logic (filters, move targets, keyboard) and accessible names/live region in the sources | `-ui` | remove a label |
| C17 | Tripwire, hedge, key-literal tests stay green; no child process or network code added (scan of new files) | existing + `-flag` | add `fetch(` |

## 9. Hooks outside new files (all additive)

`src/shared/config.ts` (flag), `src/bin/legion-core.ts` (build the store + module only when the flag is on), `src/shared/types.ts` (`board.updated` event), `src/core/server.ts` (`board?` in context, `board.` admin-only prefix), `src/core/mcp-tools.ts` (one call to register `legion_board_read`), `ui/src/api.ts`, `ui/src/projects/ProjectView.tsx` (mounts the tab strip), `ui/src/store.ts` (event case), `docs/` (a short section, kept scoped).

## 10. Documented fact / assumption / unknown

| Kind | Item |
|---|---|
| Fact (read in this repo) | Projects, native secret, admin gate, taint, `ModuleJob.projectId`, `onTaskEnd`, `startTask` params `origin` and `tainted`, Library untrusted/inbox model, existing `experimental.providers` pattern |
| Fact (fetched) | Claude Code task list statuses and `Ctrl+T`; Claude project contents |
| Fact (search summary, not fetched) | Cowork projects incl. scheduled tasks; Linear status categories and triage; GitHub Projects views and workflows; Cursor/Codex statuses; Kanban WIP |
| Assumption | Owners want 5 columns and 3 priorities; `blocked` as a column is fine; 200 items per project is enough; running a bot-written item at an `ask` ceiling is acceptable friction |
| Assumption | `appendFileSync` of one short line is atomic enough on NTFS/ext4; a torn line is the worst case and is skipped |
| Unknown | Screen reader behaviour of the keyboard move on real NVDA/Narrator; drag on a touch screen; Windows rename-over-open-file during compaction |

## 11. Owner-only PC checks

`claude/tracker-pc-checks-board.md`.

## 12. Known limits (kept honest, to be updated at the end)

- The board stores and shows; Legion's own code does not stop an allowed agent tool from doing things the approval mode permits.
- Room links are not checked for existence by the core (the UI only offers rooms of the project).
- A compromised app window holds the admin key and could edit items; it still cannot start anything outside the approval cards.
