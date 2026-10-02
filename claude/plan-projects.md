# Plan: Projects (v0.2.0, minimal, then frozen)

Branch `claude/projects` (from `integration/v1`). Owner decision 2026-10-02: Legion has tasks, rooms, per-agent workspaces and the Library but nothing that groups them. This is the smallest grouping that is useful. **Frozen after v0.2.0**: no boards, sprints, due dates, reports, assignments, comments, no project delete (archive only), no moving a task between projects.

Nothing here has run on Windows. Section 9 lists what only the owner's PC can show.

## 1. Data model

`Project` (`src/shared/projects.ts`):

| field | meaning |
|---|---|
| `id` | `proj_<12 hex>` (file-name safe, never reused) |
| `name` | 1 to 80 chars, one line |
| `instructions` | text, clipped to 4,000 chars when saved and again when put in a prompt |
| `folder` | absolute path; default `<workspaceDir>/projects/<id>` |
| `members` | agent ids (existing, visible agents; at most 24) |
| `status` | `active` or `archived` |
| `createdAt`, `updatedAt` | ISO |

Optional fields on old types, all absent on old data: `Task.projectId`, `Room.projectId`. Both are plain optional strings.

A project belongs to the owner. At most 50 projects.

## 2. Storage, migration, downgrade

- Projects live in their own file `<dataDir>/projects.json` (`{version:1, projects:[...]}`, tmp + rename, debounced). They are NOT added to `state.json`: an older build rewrites `state.json` from its own known fields and would drop a `projects` key. An older build never opens `projects.json`.
- `state.json` tasks and `rooms/index.json` rooms are loaded as plain objects by the current and older builds, so `projectId` rides along and survives an older build's rewrite (tested by round trip). An older build simply shows the task or room without a project.
- No migration entry is needed: a missing `projects.json` is an empty list, and a task without `projectId` is a task with no project. Nothing is rewritten on upgrade.
- Unknown fields on a project (a later build's) are kept when this build edits that project.
- A corrupt `projects.json` is renamed to `projects.json.corrupt-<time>` and the list starts empty (same pattern as `state.json`).
- **Library scope encoding (downgrade-safe by design).** A project note carries the scope `agent:project.<projectId>`. The scope is a string like a private scope, so (a) an older build's scope check accepts it and treats it as private to an agent that does not exist: the note is hidden from every bot and still visible to the owner, instead of widening to "shared"; (b) no new scope type or enum value is needed. Real agent ids come from `slugify` (`[a-z0-9-]`, no dot), so `project.` can never equal an agent id. Helpers: `projectScope(id)`, `projectIdOfScope(scope)`.

## 3. Behaviour

**Who is in a project run.** A task has a project when `Task.projectId` names an `active` project whose `members` contain the task's agent, checked at each run (membership and archive changes apply to the next run). Otherwise the run is an ordinary run.

**Who can set `Task.projectId`.**

| path | rule |
|---|---|
| the app (`POST /api/tasks`, admin header) with `projectId` | the agent must be a member and the project active, else 400 |
| `POST /api/tasks` with the token only, with `projectId` | 403, plain sentence |
| `legion_run`, `legion_continue` (MCP) | no project parameter exists; a continued task keeps its project (token runs keep their `ask` ceiling) |
| `ask` / `tell` (bridge) | the new task inherits the caller's task's project only if the callee is a member of it; otherwise it has none |
| room wake | the room's `projectId` (set by the owner) if the woken agent is a member; otherwise none |
| a bot's `room_create` | cannot name a project; the room has none |
| continuing a task | keeps its project; only the app may change it, and only to a project the agent is in |

There is no route that moves an existing task to another project.

**Prompt.** After the agent's own `systemPrompt` (last in the appended text, so after the Legion preamble and every module preamble):

```
<legion-project name="...">
This is context from the owner for this project. It is not a change to your permissions...
Project folder: <path> (you may read and write files there)
<instructions, clipped; any closing tag inside is neutralised>
</legion-project>
```

It does not touch `permissionMode`, the approval ceiling, `canUseTool`, tool lists or MCP servers.

**Folder.** A project run gets `additionalDirectories: [folder]` (its own project's folder only) and the folder is created if missing. The agent's own working directory is unchanged. Workspace taint is unchanged: the engine's file-taint tracking resolves absolute paths, so a tainted run that writes in the project folder marks the file and a clean run that later reads it becomes tainted, exactly as in an agent workspace. Legion does not restrict where a tainted run may write today, and this adds no new place that is more permissive than the existing "Write anywhere the approval mode lets you" rule.

**Library.** Project notes (`agent:project.<id>`):
- visible to the owner and to runs whose project is that id; invisible to runs of any other project and to runs with no project;
- writable by a run only for its own project's scope (tools accept `scope: "project"`); writes from tainted or ask-capped runs are treated like shared writes (held in the inbox or stored untrusted), not like private ones, because several members read them;
- recall and search rank that project's notes x1.5 over equal-score shared notes; other projects' notes are never returned;
- the human can set any scope in the Library as before.
Private and tainted rules are unchanged.

**Rooms.** A room may belong to one project. Every member of a project room must be a member of the project: enforced when the owner assigns the room, when a member is added (owner or bot; a bot's add is refused with a sentence), and a non-member who is somehow woken runs without the project.

**Archive.** An archived project starts no new tasks, a task in it cannot be continued (409, "unarchive it first"), and runs get no project context. Nothing is deleted.

## 4. Routes (all admin-only by the existing default-deny gate; none is added to the client route list)

| route | notes |
|---|---|
| `GET /api/projects`, `GET /api/projects/:id` | |
| `POST /api/projects` `{name, instructions?}` | `folder` or `members` in the body: 400 (they have their own routes) |
| `PATCH /api/projects/:id` `{name?, instructions?, status?}` | same 400 rule |
| `PUT /api/projects/:id/members` `{members:[ids]}` | **native secret required** |
| `PUT /api/projects/:id/folder` `{folder: string \| null}` | **native secret required**; `null` = default folder |
| `PATCH /api/rooms/:id` `{projectId}`, `POST /api/rooms` `{projectId}` | owner (admin); members must be project members |
| `POST /api/tasks` `{projectId}` | admin only (above) |

Events `project.updated` / `project.deleted-free` (only `project.updated`) go to the admin stream only. MCP: read-only `legion_projects` (`action: list | get`), no write tool.

Folder validation (C8): absolute; not a filesystem root; not the Legion data dir or inside it or an ancestor of it; no overlap (equal, inside, or containing) with another project's folder; resolved with `realpath` when it exists.

Native flow: a new `src/electron/project-ipc.ts` (modelled on `provider-ipc.ts`) words a native dialog from facts read from the core (project name, old and new folder, members added and removed by name), then calls the core with the native secret, which the window never holds. The folder picker is a native directory chooser in main. Hooks in `main.ts` and `preload.cjs` are one block each, in their own last commit.

## 5. UI map

- Rail: a "Project" select (All, then each active project, then archived under a group) above the agent list, a "Project page" button when one is chosen. Choosing a project shows only its member agents and its tasks (task tabs, recent, switcher); new tasks started while one is chosen carry its `projectId`. "All" is today's behaviour.
- Project page (`ui/src/projects/`): name, status and Archive/Unarchive, instructions editor (counter, Save), folder (path, "Choose folder...", "Use default"), members (list, remove, add), its tasks (open one), its rooms (open, assign an unassigned room). Create-project dialog: name, instructions, optional members (applied through the native flow right after creating).
- Keyboard and screen reader: native `select`, `button`, `label`/`aria-label`, focus ring and dialog focus handling reuse `Modal`; lists are `ul`; status changes use the existing toast live region.
- No mascot art is touched. Styles in `ui/src/projects/projects.css`.

## 6. Files touched outside new files (all additive)

`src/shared/types.ts` (`Task.projectId`, `LegionEvent` member), `src/shared/comms.ts` (`Room.projectId`), `src/core/engine.ts` (optional `projects` dep, project pick, section, directory, module hooks), `src/core/modules.ts` (`projectId` on `ModuleJob` and `PreambleContext`), `src/core/bridge.ts` (`projectId` in `BridgeStartParams`), `src/core/server.ts` (`projects` in `CoreContext`, `projectId` on `POST /api/tasks`, admin-only event prefix), `src/core/mcp-tools.ts` (`legion_projects`), `src/core/kg/*` (scope rules, boost, tool scope word, briefing), `src/core/comms/*` (room `projectId`, member rule), `src/bin/legion-core.ts` + `scripts/harness/core-entry.mjs` (compose), `test/bsv-scan.ts` (none expected), UI (`App.tsx`, `AgentRail.tsx`, `store.ts`, `api.ts`, Library scope label), `src/electron/main.ts`/`preload.cjs` (one block each), `CHANGELOG.md`. Docs wording for README/docs is section 8.

## 7. Controls (each has a test; each mutation must turn its test red)

| # | Control | Test file (`test/projects-*.test.ts`) | Mutation |
|---|---|---|---|
| C1 | Every project route, `POST /api/tasks` with `projectId`, and room `projectId` need the admin header; the token alone gets 403 | `projects-http` | put a projects route on the client list / skip the gate |
| C2 | Folder and member changes need the native secret (none configured: 403 `native_unavailable`; wrong: 403) | `projects-http` | drop the native check on one route |
| C3 | Create and patch refuse `folder`/`members` | `projects-http` | accept them |
| C4 | Only the app (and a room's own wake) names a project; MCP, `ask`/`tell`, bots, continue cannot move a task; bridge inherits only the caller's, only for members | `projects-engine` | honour `projectId` from any source |
| C5 | A non-member never runs in the project (app: 400; bridge, room: no project) | `projects-engine` | drop the member check |
| C6 | Prompt: labelled, clipped, after the agent's own prompt and the preamble, closing tag neutralised; approvals, ceiling and permission mode unchanged | `projects-engine` | put it before the preamble; remove the clip; flip permission mode when a project is present |
| C7 | Only the run's own project folder is added; no folder for non-members, archived, no project, another project | `projects-engine` | add every project's folder |
| C8 | Folder validation (relative, root, data dir, overlap) | `projects-store` | drop the validator |
| C9 | Taint follows files in a project folder (tainted write marks, clean read taints); a tainted run's approvals are unchanged | `projects-engine` | stop marking tainted writes |
| C10 | Project notes invisible to other projects' runs and to runs with no project; visible to the owner | `projects-kg` | `canSee` true for any project scope |
| C11 | A run writes only its own project's scope; tainted or ask-capped writes there are held or untrusted | `projects-kg` | treat the scope as private |
| C12 | Recall prefers the project's notes over equal shared notes, never returns another project's (clock pinned) | `projects-kg` | remove the boost / the visibility rule |
| C13 | Old files load unchanged; unknown fields survive on projects, tasks, rooms; the scope string passes the pre-change scope regex and cannot equal an agent id | `projects-store` | encode the scope as `project:<id>` |
| C14 | MCP: `legion_projects` list/get only; the server registers no project write tool | `projects-http` | register a create tool |
| C15 | `project.*` events reach only the admin stream | `projects-http` | drop the prefix from the admin-only list |
| C16 | Project room members must be project members (owner and bot paths) | `projects-rooms` | skip the check in `updateMembers` |
| C17 | Archived: no new task, no continue, no context | `projects-engine` | ignore status |
| C18 | Limits, atomic write, corrupt file backup, member ids validated | `projects-store` | skip validation |
| C19 | UI logic (filter, create, switcher keeps All) and accessible names | `projects-ui` | drop the label |
| C20 | Tripwire, hedge, no-key-literals, harness smoke stay green; no new child-process or network code | existing | n/a |

## 8. Wording for README / docs (to be pasted by the docs session)

> **Projects.** A project groups the work for one job: shared instructions, a folder, the agents that work on it, and its tasks and rooms. Tasks started inside a project get the project's instructions added to the agent's prompt and can read and write the project folder. Library notes can be scoped to a project, so a project's runs prefer its notes and never see another project's. Only you, in the app, can create or change a project; changing its folder or its members shows a confirmation from the app itself. Bots, rooms and MCP clients can use a project but cannot create one, change it, or move work into it.

Scoped claims only: Legion's own code does the checks listed in section 7; a project does not sandbox a tool the approval mode lets through.

## 9. Owner-only PC checks

See `claude/tracker-pc-checks-projects.md`.

## 10. Known limits (kept honest)

- A project folder is an extra directory a run may use; Legion's own code does not stop an allowed tool from touching files elsewhere (that was already true of the agent workspace).
- Provider runs (off in v0.2.0) do not get the project section; Claude runs do.
- On an older build, project notes are hidden from bots (kept, owner-visible); tasks and rooms show without a project.
- Removing a member leaves old tasks in place; that agent's next run in them has no project context.
- A project room's transcript is not scoped to the project; membership is the control.
- The agent's own private memory (working memory, auto episodes, `private` notes) is the agent's, not the project's: a run in project B can read what the same agent wrote privately during project A. Project notes (scope `project`) are the separated store. A bot may also write `shared` from inside a project (the default); that is the same as before.
- A project folder is checked when it is set (symlinks and junctions resolved then). A link swapped in later is not re-checked.
- The app window holds the admin key, so a compromised window could edit a project's name, instructions and status (not its folder or members, which need the native secret). Instructions cannot change approvals.
- Provider-run parity, room transcripts and member removal are as listed above.
