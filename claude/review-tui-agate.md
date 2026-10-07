# A-gate review: Legion Mod terminal UI (step 5)

Reviewer: independent, did not build it. Date 2026-10-05. Evidence: `art-review/tui/after/dumps.txt`, `side-by-side.txt`, `dark.html` and `light.html` (viewed in a browser), plus my own renders at in-between widths and with the wire's real band text (scratch `agate-ws/probe*.ts`). Code read: `mod/src/ui/**` and the parts of `src/wire/legion.tsx` the UI depends on.

## Verdict: NOT PASSED

The views at 60/80/100/120 are calm and plain, and well ahead of "before" (no dead Allow/Deny, real first-run copy). But six defects remain; three are hidden by the dumps (fixtures carry clean band text the wire never writes; the title row breaks at 56-68 columns, between the dumped widths). The approval card still splits its information across the thread. Fix the bugs, re-dump with wire-shaped fixtures at 56/60/64/68/72/76/80/100/120, and re-review.

## Bugs (ranked by what a user notices)

1. **Band, every width: the agent is named twice, and the action is given twice.**
   - What it shows, rendered with the text `wire/legion.tsx:917-918` really writes: `‖ ⌘ Builder · ⌘ Builder paused at the turn limit · /con…  c: Continue`, and `✕ ◎ Scout · ◎ Scout stopped on an error  o: Open`.
   - Cause: `band.ts` prefixes `agentLabel`, and the wire writes the toast line into the band.
   - Rules broken: no repeated information; every failure gives a next step (the error row has no cause and no step).
   - Fix (lead, wire): band text gets its own copy, and the toast keeps `line`:
     - paused: `Paused at the turn limit`
     - error: `Stopped: <task.error, cut>` with `o: Open` (the open task shows "Try again with /say")
     - done: `Finished · <title>`
   - Fix (UI): add a fixture whose band text is wire-shaped.
2. **`/continue` hints can continue the wrong task.**
   - Where: the dispatch card says `⌘ Builder · paused at the turn limit · … · /continue`, and so does the toast.
   - The `/continue` handler (`legion.tsx:656`, `:668`) continues `ctx.ui.taskId`, the task the pane shows, not the task on the card. The toast fires only when the paused task is not the shown one (`:919`), so the toast's hint is wrong exactly when it appears.
   - Fix: let `/continue` take an agent id and continue that agent's newest paused task, and print `/continue builder` on the card and the toast. Otherwise print `/legion, then c`.
3. **Title row, 56-68 columns: the tabs collide and one disappears.**
   - Renders: busy @64 `✠ LEGION1: Chat         1 running · …`; busy @65 `✠ LEGION1: Chat5: Order`; long @56-59 `✠ LEGION1: Chat5: Order  10 running`. At 64 the Order tab is gone. Cause: the `'  '` spacer spans in `pane.ts titleRow` are not `fixed`, so `shrinkTo` cuts them, then pops the Button.
   - At busy @60 the whole right side drops, `1 needs your OK` included, and at <72 the rail marks are gone too. Nothing in the chrome then says an approval waits.
   - Fix: mark the spacers `fixed`; the right side's parts leave in the order `running`, `paused`, and `N needs your OK` last (as `status.ts` does); below 64 shorten it to `!1` in warn.
4. **Chat, every width: the approval card is cut off from its tool chip.**
   - The chip `▸ Bash  npm test -- replay   Needs your OK` comes first. Then come Zealot's message and a system line. Only then does the card repeat `npm test -- replay`, indented at Zealot's text column (cards are appended after all thread rows, `chat.ts build()`), so it reads as part of Zealot's message.
   - Rules broken: card hierarchy (who → what → consequence → answer in one place); no repeated information.
   - Fix: draw the card in place of its awaiting chip, matched by tool name and summary, with an unmatched card appended as now. Start its head at the gutter like a speaker row, ` !   ⌘ Builder needs your OK to run a command`, with the body at column 7.
5. **Order heading counts and sums a different set from the title bar.**
   - J2 @80: the title says `4 running · 1 paused`, while the Order heading says `Running  5` over **6** rows, with `≈$1.43 running`.
   - The visible costs add up to ≈$1.48. The done Scout piece is drawn but not counted, and the paused Herald is counted as "running". Chat says `3 working · 4 in all` for the same pieces.
   - Fix: heading `Running  4 · 1 paused`. On the right, `≈$1.48 so far`, the sum of every drawn line. Use one word for the state: `running`, not `working` (`STATUS_WORDS.running`, the `Handed out` line).
6. **A running task can read "Standing vigil".** Order long @100/120: `● ⌘ Builder  task …  Standing vigil  ≈$1,234.56`, and the Agents row `⌘ Builder  Standing vigil  99+ need your OK`.
   - Cause: `tasks.ts` and `order.ts` take the agent's mood with no check against the task's state. Mood is per agent; the 60 s Dormant rule, or a sibling task's Victory, can show beside a live task.
   - Fix: running with an idle, sleeping or victory mood → `Running`; an agent with cards → `Awaiting your word` (as the chat footer's fallback does).

## Polish (ranked)

7. **One concept has five names.** The same waiting approval appears as:
   - `needs your OK` (title bar, Order);
   - `awaiting your word` (status line, `status.ts`);
   - `asks to run a command` (card);
   - `1 approval waiting in another task` (chat notice);
   - `answer in the dialog` (band).

   Use `needs your OK` everywhere: status line `1 needs your OK`; card head `⌘ Builder needs your OK to run a command`; notice `! 1 needs your OK in another task · ⌘ Builder   o: Open`.

   `Awaiting your word` stays a mood word only.
8. **Band @72-79: the verb is cut mid-word**, `! ⌘ Builder asks to run a c…  npm test -- replay`. Use the short form whenever the full verb does not fit whole: `! ⌘ Builder · Bash  npm test -- replay`. At 60, `answer in the dialog` (fixed, 20 cells) squeezes the command to 13 cells. Use `in the dialog` below 72.
9. **Chat task tabs are cut while half the row is empty.** @80 shows `● fix the flaky rep…` with about 19 free cells. @100 shows `‖ Draft the 0.3 release no…` with about 50 free cells. The tab is the only place the chat view shows the task's title. Fix: share the row's room across the shown tabs, giving the selected tab up to all of it, instead of `tabMax = width/3`.
10. **Too much accent in the Order view and the J2 tree.** A row carries a green `●`, a green glyph and a green mood word, and @100 there are about 15 accents in one panel. The rule is one accent per region. Fix: keep the accent on the state mark and the selected agent only, and draw mood words in `text`.
11. **Dispatch lines are inconsistent with every other surface.**
   - Only the running card has a state mark. Use it everywhere: `· ✎ Scribe · done`, `‖ ⌘ Builder · paused …`, `✕ ◎ Scout · failed`.
   - The numbers read `9 turns · ≈$0.21`, while the header and Order read `≈$0.21 · 9 turns`. Use `≈$0.21 · 9 turns`.
   - The failed card has no next step. Add a second line, `  /say to try again`.
   - The live card repeats `⌘ Builder` and the command on its card line. Use `  ! Needs your OK · Bash   answer in the dialog`.
12. **The now-column mixes case**: `Executing` and `Deliberating` beside `queued`, `paused` and `other window`, while the chat footer says `Queued`. Use `Queued`, `Paused`, `Other window`.
13. **Order Agents @60 truncates a name**: `⌶ Forgemast…`. `nameCol` is at least 12, and `⌶ Forgemaster` needs 13. Raise the minimum to 13; the rail already uses 13.
14. **System notes read as speech.** `Continued where it stopped.` sits at Zealot's text column under `✠ Zealot · via Legion`. Fix: give system rows their own lead, ` ·   Continued where it stopped.`, in muted text.
15. **99+ cards flood the thread.** In the long state, four identical 8-line cards fill the screen, and `↑ 124 earlier rows` gives no way to reach the rest. Fix:
   show the first card in full, then `! 123 more need your OK · 5: Order`; say `lines`, not `rows`.
16. **The feature name changes case.** `The order has not mustered yet.` (chat and Order empty) against `Your Order: 11 agents, ready.` Use `The Order has not mustered yet.`
17. **Card copy:** the footer is a second warn line under a warn head; draw `Answer in the permission dialog.` in `text`. Drop `it` from `Answer it in the window that runs this task.`
18. **The WebFetch consequence claims more than the code does** (`cards.ts`): "what comes back is treated as untrusted". Scope it: `Legion's own code marks what comes back as untrusted.`
19. **Two counts are formatted differently.** `<≈$0.01` stacks two qualifiers (`format.ts`); the desktop says `<$0.01`. The band uses `count(more, 999)` (`+124 more`), while the title caps at `99+`. Pick one cap.
20. **Discoverability: nothing on screen says how to pick an agent below 72 columns, or that Tab reaches a control.**
   The plan's `?` help is not built, and "Or pick an agent and press n." is a dead end at 60. Fix: at <72, add a muted footer line on the first run: `Tab picks an agent · n new task · 5 Order`.

## What only a real terminal can settle (record as real-PC checks)

- Glyph widths: are `✠ ⌘ ◬ ⚑ ☾ ⌶ ⊥` 1 cell in Windows Terminal and conhost (East Asian Ambiguous)? One cell off moves every rail separator and right-aligned number.
- Is Claude Code's permission dialog for a Legion run visible while the pane is open (docked and inline)? The card's "where to answer" depends on it.
- Can keyless band Buttons (rows 2-3 `Open  Dismiss`) be reached with Tab outside fullscreen? If not, they look clickable but are not. Button rest/focus look (the dotted underline is HTML-only).
- Rail `estRows` pad against the real Markdown wrap; colour of muted vs warn/accent on real dark and light themes.

Housekeeping: no product code edited, nothing committed. Probes in scratchpad `agate-ws/`; Playwright screenshots landed in `D:/bots/legion/.playwright-mcp` (the tool's allowed root), delete with that folder.
