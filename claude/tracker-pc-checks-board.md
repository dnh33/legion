# Project board: checks only the owner's Windows PC can do

The board is on by default in v0.2.0; nothing to switch on. To test it off, set `"features": {"projectBoard": false}` in `%USERPROFILE%\.legion\config.json` and restart. Nothing here has been run on Windows.

1. The board appears by default; with `features.projectBoard` set to `false` it is gone (no tab, `GET /api/board` is 404); with the text `"false"` it stays on.
2. Create, edit, drag and keyboard-move items; restart Legion; the board is unchanged (`board\<proj>.jsonl`).
3. NVDA or Narrator: card is announced with title, status, assignee, priority; `Alt+←/→` moves and the live region announces the move.
4. Window at 390 px wide and at 150% display scale: no sideways page scroll, targets usable.
5. "Run this item" on an owner-written item: approval cards behave as in a normal project run; the item goes to Doing, then Review with the result linked, never Done.
6. Ask a member bot to propose an item: it shows in Inbox as "not reviewed"; accept; Run: the run shows the tainted/ask limits; "Mark reviewed" lifts it.
7. Compaction: add and delete ~300 items in a loop; the file shrinks, no `.tmp` left, no error with antivirus running.
8. Kill the core during a write (task manager, by PID); restart: board loads, at most the last line lost.
9. Downgrade: start an older build; it ignores `board\`; upgrade again; items are back.
10. Agents on the board: add two member agents, set one as Board leader, ask them (in a normal task inside the project) to create, claim, move and note items. Expected: the items appear live and are marked "Not reviewed"; neither agent can mark Done; a non-leader has no delete tool.
11. Leader delete: ask the leader to delete one of its items. Expected: an approval card naming the item appears; Deny leaves it; Allow removes it; a second request within the limits works, a fourth within 10 minutes is refused.
12. Save what we learned: move an item to Done in the List view. Expected: a banner (focus stays where it was, the screen reader announces the region), the draft opens prefilled, Save note creates a project note you can open from the item; a run in another project cannot find it, a run in this project can (ask an agent in the project to recall it).
13. Automatic note links: ask an agent, inside the project, to do an assigned item and save a project note with kg_capture (scope project). When the run ends the note appears under "Project notes" on the item.
14. Project context across sessions: start a second task in the project the next day; its prompt should carry the board digest and the agent should find the earlier episode through recall.
