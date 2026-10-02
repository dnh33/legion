# Project board: checks only the owner's Windows PC can do

Set `"experimental": {"projectBoard": true}` in `%USERPROFILE%\.legion\config.json`, restart Legion. Nothing here has been run on Windows.

1. Board tab appears only with the flag on; flag off (or `"true"` as a string) = no tab, `GET /api/board` is 404.
2. Create, edit, drag and keyboard-move items; restart Legion; the board is unchanged (`board\<proj>.jsonl`).
3. NVDA or Narrator: card is announced with title, status, assignee, priority; `Alt+←/→` moves and the live region announces the move.
4. Window at 390 px wide and at 150% display scale: no sideways page scroll, targets usable.
5. "Run this item" on an owner-written item: approval cards behave as in a normal project run; the item goes to Doing, then Review with the result linked, never Done.
6. Ask a member bot to propose an item: it shows in Inbox as "not reviewed"; accept; Run: the run shows the tainted/ask limits; "Mark reviewed" lifts it.
7. Compaction: add and delete ~300 items in a loop; the file shrinks, no `.tmp` left, no error with antivirus running.
8. Kill the core during a write (task manager, by PID); restart: board loads, at most the last line lost.
9. Downgrade: start an older build; it ignores `board\`; upgrade again; items are back.
