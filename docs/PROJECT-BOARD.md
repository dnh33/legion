# Project board

Part of Legion 0.2.0, on by default. Plan, controls and known limits: `claude/plan-project-board.md`. Nothing here has run on Windows yet; the checks that need your PC are PB1 to PB10 in `claude/tracker-pc-checks.md`.

## Where it is

Open a project (the rail's Project select, then "Project page"). The board is under "Work items": Board, List and Inbox.

## Turn it off

In `config.json`, set `"features": { "projectBoard": false }` and restart Legion. Only the literal `false` turns it off; a missing key, `true`, the text "false" or anything else leaves it on. No setting or button in the app writes this switch. With it off, no board file is created, no route, MCP tool, agent tool or screen exists. An old `experimental.projectBoard` entry in the file is ignored.

## What it is

A small board inside a Project. Work items have a title, a description, a status (Backlog, Doing, Review, Done, Blocked), one assignee (a member agent or you), a due date, a priority, up to five labels, linked tasks, rooms and project notes, and an activity trail. The board stores and shows. It starts nothing by itself: no schedules, no automation, no auto-run.

## What the owner controls

You create, edit, move and delete items, mark them Done, assign anything to yourself, accept or reject agent suggestions in the Inbox, mark agent-written text as reviewed, choose the board leader, and press "Run this item". Nothing an agent does starts a run: only your click does, through the ordinary project run path with the same approval cards. A finished run puts the item in Review (or Blocked after an error), never in Done.

## What member agents may do now

Any agent that is a member of the project, in a run that belongs to it (tool server `legion_board`):

- **Create** items in Backlog, Doing, Review or Blocked, up to 10 per 10 minutes, 50 open items per agent, and never into the last 40 places of the 200-item board, which stay free for you.
- **Edit** the title, description, priority, labels and due date of any open item, **move and reorder** items between Backlog, Doing, Review and Blocked, **claim or assign** an item to a member agent (or clear the assignee), add short **notes**, and **link project notes** that exist in this project's Library.
- **Suggest** an item to your Inbox when it would rather you decide.
- **Read** the board of its own project.

What agents may not do:

- Mark an item Done, assign anything to you, or change an item assigned to you (they can add a note).
- Change an item you closed, or touch another project's board or notes.
- Delete, unless it is the **board leader** (none by default; you choose one in the board header). The leader's delete shows you an approval card every time, and a declined or unanswered card deletes nothing. Done items and items assigned to you are not deletable by an agent.
- Assign or delete from a **limited run**: a run that read outside content (web, shell, external tools), or that another bot or an MCP client started under "ask" approvals.
- Put a key, seed phrase or private key on the board (refused), or leave a credential-shaped string in it (redacted).

Text an agent writes is marked "not reviewed" until you press "Mark as reviewed". An agent editing the text of an item you already reviewed clears your review. A run on unreviewed text starts tainted with the stricter "ask" approvals. Item text that other agents read is wrapped as data: it carries no approval.

Token clients (MCP, curl) get read-only `legion_board_read`.

Legion's own code makes these checks. The board does not limit what an allowed agent tool does during a run, and a compromised app window holds the admin key, so it can edit the board; it still goes through the approval cards for runs and agent deletes.

## Project memory

Notes the agents save in the project's Library scope are linked to the item they worked on when a run ends. When you close an item, the board offers "Save what we learned": you edit a draft and save it as a project note linked to the item (the Library refuses seed phrases and keys and redacts credentials). A run in the project starts with a short board digest (counts, what is assigned to it, what others have in progress) and the titles of the project's recent notes. A long project run leaves its episode in the project's scope, so the project's other agents and later sessions can find it.

## Files

`<dataDir>/board/<projectId>.jsonl`, one JSON line per change, compacted with a temporary file and a rename. Nothing is stored in `config.json` except the switch. An older build never reads these files.
