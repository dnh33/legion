# Project board (experimental)

Status: built, not part of 0.2.0, off by default. Plan and controls: `claude/plan-project-board.md`. Nothing here has run on Windows (`claude/tracker-pc-checks-board.md`).

## Turn it on

Edit `config.json` and set `"experimental": { "projectBoard": true }` (only the literal `true`), then restart Legion. No setting or button in the app writes this switch. With it off, no board route, MCP tool, agent tool or screen exists.

## What it is

A small board inside a Project: work items with a title, description, status (Backlog, Doing, Review, Done, Blocked), one assignee (a member agent or you), a due date, a priority, up to five labels and an activity trail. Views: Board (drag, or focus a card and press Alt plus an arrow key), List, and an Inbox for items an agent suggests. The board stores and shows. It never starts anything by itself: no schedules, no automation, no auto-run.

## Who may do what

- **You** create, edit, move, delete, accept or reject suggestions, mark items Done, choose the board leader, and press "Run this item".
- **Member agents** (tool server `legion_board`) create items, edit them, move them between Backlog, Doing, Review and Blocked, reorder, assign them to member agents, label them, link project notes and leave notes. Text an agent writes marks the item "not reviewed" until you press "Mark as reviewed"; a run on unreviewed text starts with the stricter `ask` approvals.
- **Only you** mark an item Done or assign anything to yourself; items assigned to you take notes only from agents.
- **Delete** is for the board leader only (none by default) and shows you an approval card every time. A run that read outside content cannot delete or assign.
- **Token clients** (MCP, curl) get read-only `legion_board_read`.

Legion's own code makes these checks; the board does not limit what an allowed agent tool does during a run.

## Run this item

Starts the assigned member agent once through the ordinary project run path, with the item text and the project instructions and the same approval cards. The item moves to Doing, the task is linked, and when the run ends the item moves to Review (or Blocked on an error), never to Done.

## Project memory

Notes the agents save in the project's Library scope are linked to the item they worked on when a run ends. When you close an item, the board offers "Save what we learned": you edit a draft and save it as a project note linked to the item. A run in the project starts with a short board digest (counts, what is assigned to it, what others have in progress) and the titles of the project's recent notes; the project's long runs also leave their episode in the project scope.

## Files

`<dataDir>/board/<projectId>.jsonl`, one JSON line per change, compacted with a temporary file and a rename. Nothing is stored in `config.json` except the switch. An older build never reads these files.
