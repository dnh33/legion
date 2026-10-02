# Plan: Project board (IN v0.2.0, on by default; branch `claude/project-board`)

**Status (owner decision 2026-10-03): the board is part of v0.2.0 and ON by default.** The 'experimental, after 0.2.0' gate is gone. It is covered by the one independent security review, including agent access. Owner-only switch: `features.projectBoard = false` in `config.json` (only the literal `false` turns it off; no UI or route writes it; with it off nothing new is built, routed, listed as an MCP or agent tool, or shown); an old `experimental.projectBoard` entry is ignored. New code lives in `src/core/projects/board/*`, `ui/src/projects/board/*`, `test/project-board-*.test.ts`; the hooks elsewhere are additive (section 9). Merged with `origin/integration/v1` on 2026-10-03 (both module lists kept, harness mirrors the composition root). Nothing here has run on Windows (section 10).

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

`WorkItem`: `id` (`wi_<12 hex>`), `projectId`, `title` (1-120, one line), `description` (<= 2,000, clipped), `status` (`backlog | doing | review | done | blocked`), `assignee` (`null | {kind:'owner'} | {kind:'agent', id}`; an object because an agent id could be the word "owner"), `due` (`YYYY-MM-DD` or absent), `priority` (`low | normal | high`), `labels` (<= 5, each 1-24 chars of `a-z0-9 -`), `order` (integer, position inside its status column), `createdBy` / `updatedBy` (`Actor`), `createdAt`, `updatedAt`, `trust` (`human | untrusted`), `proposal` (`{suggestedAssignee?}` present only while the item waits in the Inbox), `taskIds` (<= 20), `roomIds` (<= 10), `activeRun` (task id while a Run-this-item run is live), `lastRun` (`{taskId, status, endedAt, tainted, preview <= 1,000}`), `activity` (<= 20 entries, each `{at, by, kind, text <= 500}`).
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

## 5. Authority matrix (revised 2026-10-02: agents are the team, the board is their shared workspace)

Design stance: guards exist against bad things spreading (taint, secrets, runaway runs, unreviewed text getting full permissions), not to rank agents below the owner. A member agent works the board like a teammate.

| action | owner (app, admin header) | member agent (in-process `legion_board`) | token client (MCP/curl) |
|---|---|---|---|
| list / get items | yes | yes (own project only) | read-only (`legion_board_read`), no activity, no Inbox |
| create a live item | yes | **yes** (backlog/doing/review/blocked; rate limited; item is `untrusted` until the owner marks it reviewed) | no |
| suggest an item to the Inbox (`propose`) | n/a | yes | no |
| edit title, description, priority, labels, due | yes | **yes**, any open item (a text edit makes the item `untrusted`) | no |
| move / reorder | any column | **yes**, to backlog/doing/review/blocked | no |
| assign / claim | yes | **yes** to a member agent or unassigned; never to the owner; not from a tainted run | no |
| note | yes | **yes** (<= 500 chars) | no |
| mark **Done** | yes | **no** (the owner's review gate; a finished run lands in Review) | no |
| items assigned to the owner | yes | notes only | no |
| delete | yes | **leader only**, and the owner sees an approval card for every delete; never from a tainted run, never Done items or owner-assigned items; 3 requests / 10 min | no |
| choose the leader | yes (`PUT .../board/leader`, admin) | no | no |
| accept / reject Inbox, run an item | yes | no | no |
| touch another project | yes | no (project fixed by the engine) | n/a |

Why this is safe enough: nothing a member does can start a run (the owner's click does), approvals and the `ask` ceiling for agent-written text are unchanged, the delete is behind a card, and a tainted run cannot assign or delete. Token clients stay read-only because they carry no agent identity (a leader or member cannot be told apart from any local process holding the token).
The leader is a per-project setting (none by default, so by default only the owner can delete), stored in the board file; if the leader leaves the project the power goes with the membership. No native confirmation: choosing a leader grants only "may ask", and every delete still needs the card.

## 5b. The project as a context layer (Cowork-style)

Projects already scope Library notes (`agent:project.<id>`): the owner and runs of that project see them, recall boosts them. Added with the board:
- **Episodes in the project scope.** A project run's automatic episode (long or costly tasks) is written to the project's scope, not the agent's private one, so other agents and later sessions in the project find what was done. They stay `untrusted` leads; any other run keeps its private episode (`kg/graph.ts` `recordEpisode` takes an optional project id, `kg/index.ts` passes the task's).
- **Board digest in the run's prompt.** `<legion-board-digest>`: counts per column, what is assigned to this agent, what others have in progress; titles only, <= 900 chars, data-labelled. A new session picks up where the last stopped.
- **Project-memory habit.** The board preamble tells agents to save what is worth keeping as a project note (`kg_capture` with scope `project`) and name its id in their note on the item.
- **Notes linked to items** (`WorkItem.noteIds`, <= 10, project-scope notes only). Three ways in: (1) *automatic*: when a run ends, the project-scope notes it saved (not automatic episodes) are linked to the item(s) it worked on (the one it was started for, or the ones it updated); (2) an agent names them in `update` (`noteIds`, each must exist in THIS project's Library, so no private or other-project note can be linked); (3) the owner.
- **Save what we learned.** When the owner closes an item that has no note, a banner offers it (focus is not taken); the item dialog also has the button on Review and Done items. The owner edits a prefilled draft (what the last run reported, the agents' notes; a warning if the run read outside content) and saves it as a project note (human-written, scope `project`, tags `board`, `learned`, `props.boardItem` = the item id), linked to the item. The dialog lists the item's notes and opens them in the Library.
- **Project notes in the briefing.** The same digest names the project's 5 most recently updated notes that are safe to name (active, not untrusted, not from a tainted run, not automatic episodes) with their ids, so every run in the project starts knowing what the project has written down (`BoardNotes.recent`).
Not built (deliberate): an agent removing a link (only the owner can); a briefing of untrusted leads.

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
| C1 | Switch: default ON, only the literal `false` turns it off; old `experimental.projectBoard` ignored; nothing writes it; with it off no route, tool, module, preamble or MCP tool exists; harness mirrors the core | `-flag`, `-http` | default off; loose falsy turns it off; build unconditionally; honour the old key |
| C2 | Every board route needs the admin header; token alone gets 403; none on the client list | `-http` | list a board route as a client route |
| C3 | Owner create/edit/move/delete with validation and caps (sizes, labels, due, items, inbox) | `-store` | skip a cap |
| C4 | Bot `propose` lands in Inbox as untrusted, never live; rate limit; per-agent and per-project caps | `-tools` | store as active; drop the limiter |
| C5 | Agent edits: any member edits any open item; never `done`, never from done; owner-assigned items take notes only; text edits clear trust; no assigning the owner; tainted cannot assign; bad field changes nothing | `-store`, `-tools` | allow `done`; drop the owner-item rule; keep trust on text edit |
| C6 | Delete: only the owner-chosen leader, owner approval card each time, never tainted/Done/owner items, rate limited; leader tool only offered to the leader; project comes from the engine, not an argument; no project = no tool | `-store`, `-tools`, `-http` | skip the leader check; skip the card; offer the tool to all |
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
| C19 | Notes: agents link only this project's notes; automatic linking at run end (not episodes, not other projects); the owner's note lands in project scope, linked, refused when archived/empty/secret; offer only on a fresh close without a note; link cap | `-notes`, `-ui` | allow any note id; link every scope; save in `shared`; skip the cap |
| C20 | Briefing names only clean project notes (not untrusted, tainted, other-scope), capped at 5, also on an empty board | `-kg` | drop the trust filter; drop the scope filter; drop the section |
| C18 | Project as context: episodes in project scope (members only), board digest capped and neutralised, preamble only for members of active projects | `-kg` | always-private episodes; uncap the digest |
| C17 | Tripwire, hedge, key-literal tests stay green; no child process or network code added (scan of new files) | existing + `-flag` | add `fetch(` |

## 9. Hooks outside new files (all additive)

`src/shared/config.ts` (flag), `src/bin/legion-core.ts` (build the store + module only when the flag is on), `scripts/harness/core-entry.mjs` (the harness test requires it to mirror the composition root), `src/shared/types.ts` (`board.updated` event), `src/core/server.ts` (`board?` in context, `board.` admin-only prefix), `src/core/mcp-tools.ts` (one call to register `legion_board_read`), `ui/src/api.ts`, `ui/src/projects/ProjectView.tsx` (mounts the tab strip), `ui/src/store.ts` (event case), `docs/` (a short section, kept scoped).

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

## 12. Result (not run on Windows)

Gates (2026-10-03, after merging `origin/integration/v1`): see section 14.
Rendered in headless Chromium (real core, flag on, seeded board): 1440 and 960 px with the full app, 390 px with the app shell hidden (the Electron window has a 960 px minimum, so the shell itself is not built for 390), light and dark, Board / List / Inbox / item dialog; no horizontal page scroll; a keyboard Alt+Right move was announced in the live region, kept focus and persisted.

## 13. Known limits (kept honest)

- No board action is checked against what an allowed agent tool can do: Legion's own code decides who may write the board, not what a run does.
- A compromised app window holds the admin key and could edit or delete items, choose a leader and click "Run this item"; the run and every agent delete still go through approval cards. A bot's text the owner accepted unedited runs under the `ask` ceiling, but once the owner presses "Mark as reviewed" it runs with the agent's own setting.
- `Mark as reviewed` is one click for the whole item (title and description together).
- Room links are checked for shape only by the core; the dialog offers only this project's rooms (and agents' room runs add theirs).
- Appending one line per change is not a transaction: a crash mid-line loses at most that line (skipped on load). Compaction is tmp + rename; Windows rename-over-open-file and antivirus behaviour are unverified.
- The 5 columns are fixed; there is no WIP limit, no sub-items, no comments, no schedules or auto-run (Later).
- Pointer drag-and-drop is not touch-tested; touch and narrow screens use the "Move to" select.
- A task cancelled by the owner while an item is `doing` moves the item to Blocked, not back to Backlog.
- The activity trail keeps the newest 20 entries per item.
- A tainted bot's note is stored with a taint mark and shown as plain text; it is not blocked.

- The board stores and shows; Legion's own code does not stop an allowed agent tool from doing things the approval mode permits.
- Room links are not checked for existence by the core (the UI only offers rooms of the project).
- A compromised app window holds the admin key and could edit items; it still cannot start anything outside the approval cards.

## 14. Agent access: rules now, guards, proof (2026-10-03)

**Rules that apply now.**
- *Agents may:* create items (Backlog, Doing, Review, Blocked), edit title, description, priority, labels and due date of any open item, move and reorder (not to Done), claim or assign to a member agent (or clear), add notes, link project notes of this project, suggest to the Inbox, read their own project's board.
- *Owner only:* mark Done; assign to the owner; change items assigned to the owner (agents add notes only); change closed (Done) items; accept or reject the Inbox; mark text reviewed; run an item; choose the leader; delete Done and owner-assigned items.
- *Delete:* the owner-chosen leader only (none by default), an owner approval card every time, re-checked after the card.
- *Limited runs* (tainted, or started by another bot or an MCP client under `ask`): may create, edit, move and note; may not assign or delete.
- *Due dates:* agents MAY set and clear them (not owner-only).

**Guards, each with a test in `test/project-board-agent-access.test.ts` (G1..G10) and the mutation that turns it red:**

| # | Guard | Mutation that must go red |
|---|---|---|
| G1 | Tool set is create/get/list/propose/update (+delete for the leader); no argument can name a project, trust, reviewer, run or leader; `update` cannot set `done` | offer `done` in the schema |
| G2 | Items an agent creates are `untrusted`, tainted or not; an agent's text edit clears the owner's review; metadata edits do not; notes from tainted runs are marked | create trusted |
| G3 | Another project is out of reach for get, update, delete (no card), notes link, list; a non-member has no board tool | (project fixed by the engine; checked in `-tools`) |
| G4 | Done, assigning the owner, owner-assigned items and closed items are owner-only; agent paths start no run, process or request (source scan) | drop a rule |
| G5 | What agents may do (due, priority, labels, claim, move, note) works; bad values change nothing | n/a (positive) |
| G6 | Limited runs may not assign or delete and never reach the approval card | capped run may assign / delete; capped never detected |
| G7 | Delete: leader only, card each time, declined deletes nothing, re-check after the card (item closed meanwhile), Done/owner items protected | skip the re-check |
| G8 | Abuse limits: 40 board writes and 10 creates per 10 minutes, 50 open items per agent, the last 40 places reserved for the owner | remove the reserve / the open cap / the create limiter |
| G9 | No key, seed phrase or private key by any agent text path (create, update description/note/title, propose); credential shapes redacted; run results redacted | skip the check on the description edit |
| G10 | "Save what we learned" cannot write a secret, seed phrase or key (title or body) and redacts a credential in the stored note | (Library guard; asserted in the test) |

Gaps found and fixed in this pass: agents together could fill the 200-item board (now an owner reserve and a per-agent open cap); runs started by MCP or another bot under `ask` were not limited like tainted ones (now they cannot assign or delete). The last two fixtures showed the Library's seed detector needs distinct words (a repeated-word phrase is not detected; real phrases are).

**Gate (after the merge):** `npm ci && npm run build:ts && node --test "dist/test/*.test.js"`: 2,267 tests, 2,264 pass, 0 fail, 3 skipped (the skips were there before); `npm run typecheck` and `npm run build:ui` exit 0; the tripwire, hedge and harness tests pass unchanged.

**Mutations (this pass):** 15 of 15 red (default-on switch: 5; agent guards: 10). Earlier passes: about 50 more, all red, one equivalent mutant (episodes are always untrusted, so the trust filter also covers the episode filter).

**Not protected / still imperfect:**
- Legion's own code makes the board checks; it does not limit what an allowed agent tool does during a run (shell, files, web) under the approval mode.
- A compromised app window holds the admin key: it can edit or delete items, choose a leader and press Run; runs and agent deletes still go through approval cards.
- Any member agent can reword an open item or take items assigned to other agents (by design); the activity trail shows who did what, and the owner reviews agent-written text before a full-permission run.
- "Mark as reviewed" is one click for title and description together.
- Agents can add note links but not remove them.
- The rate limits are per core process and reset on restart.
- Windows behaviour (file rename during compaction with antivirus, screen readers, touch drag) is unverified: PB1 to PB10.

## 15. Website-ready paragraph

**Project boards for your agents.** Open a project in Legion and you get a small board: work items that move from Backlog to Doing, Review and Done, each with an assignee, a priority, a due date and an activity trail. The agents you added to the project work the board like teammates: they create items, claim them, move them along, leave notes and link what they learn to the project's notes, which every later session in that project can find. You stay in charge: only you mark an item Done, you decide what actually runs (an agent's work lands in Review for you to check), text the agents write is marked until you have read it, and deleting needs your approval each time. The board never starts anything by itself, and there are no schedules or automations. It runs on your computer, it is on by default, and one line in your settings file turns it off. Not done yet: it has not been tried on a real Windows computer with a screen reader, there is no sub-item or comment threading, and there are no automatic rules.
