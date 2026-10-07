# Legion Mod: what the screen says, and what it leaves out

Draft for the owner's approval, 2026-10-05. Nothing in it is built yet.

The owner asked for more signal and less noise, and for every word to be there for the person using it. This page sets the rules. Each rule says what it removes from the current screen; the mockups show the result. A rule the owner rejects is dropped before any code changes.

## The three questions

Every view answers three questions, in this order and with this much weight:

1. **Does anything need me?** An approval, a paused task, an error. This is loud, it sits at the top or in the band, and the key to act on it is beside it.
2. **What is happening now?** Who is working, on what, doing what. This is normal weight.
3. **What happened?** Answers, finished pieces, cost. This is quiet. It shows the outcome; the detail opens on demand.

Anything that answers none of the three does not belong on the screen by default. That covers settings, identifiers, counters that do not change a decision, and decoration.

## Rules

| # | Rule | Removes from today's screen (J2 at 60 and 80 columns) |
|---|---|---|
| R1 | **One place per fact.** A count, a title or a cost appears once on screen. | The counts appear twice: "4 running · 1 paused" in the title, and "3 working · 4 in all" under the task. The task title appears in the tab and in the "you" line. Each delegated piece appears in the tree and again as a "▸ Told Builder: …" chip. |
| R2 | **Say what an agent is doing, not how it feels.** Use a verb from its current tool: reading, editing, running `npm test`, asking Scout, waiting for you. Mood words (Standing vigil, Deliberating) belong to the 2D stage and to Order's agent list, where character is the point. | "● Listening" in the footer, and "Executing" or "Deliberating" in work rows. |
| R3 | **Show change, not configuration.** The approval mode, the model and the turn count appear only when they explain something: the model differs from the agent's usual one, the mode just asked you something, or the run is within 20% of the turn limit. | "Asks first · sonnet · 4 turns" on every header. |
| R4 | **Quiet when nothing happens.** Agents with no work are dimmed and collapse to one line. A cost under ≈$0.01 is not shown. A zero count is not shown. | "≈$0.00" rows, "0 turns", and a full-weight list of 11 idle agents. |
| R5 | **Keys where they act, and only the likely ones.** One quiet footer line for the focused pane holds at most three keys (for example `s stop · c continue · ? keys`); `?` lists the rest. Labels carry no key prefixes except the view tabs. | "n: New task", "s: Stop" and the like scattered through the view. |
| R6 | **Tabs number what exists.** Today that is `1 Chat  2 Order`. They renumber when Rooms and the Library arrive, before release. | "1: Chat  5: Order", where the gap reads as a mistake. |
| R7 | **Narrow means fewer things, not smaller things.** Below 72 columns there is no rail and no glyph strip; the header names the shown agent. At 72–99 columns the rail shows glyph and name only. | The row of 11 glyphs at 60 columns, which carries almost nothing. |
| R8 | **The transcript shows the conversation, not the bookkeeping.** Delegations live in the tree. The thread keeps the person's words, the agent's answers, and tool lines only while they run or when they failed. Finished tool lines fold into a count ("4 steps"); a key opens them. | Rows of finished ▸ tool lines between answers. |
| R9 | **Plain words for state, one accent per region.** The accent marks only what is live or selected. Warn and danger mark only what needs the person. | Accent spread across the tab label, the tree bullets and the footer at once. |
| R10 | **Numbers right-aligned, one unit, one place.** Cost appears per piece in the tree and once as a total for the request, with no per-row turn counts. | Cost shown three ways (header, per row, title). |

## Before and after: watching a request at 80 columns

Before (today):

```
 ✠ LEGION  1: Chat  5: Order                               4 running · 1 paused
 ──────────────────────────────────────────────────────────────────────────────
 ▸✠ Zealot    ●│ ✠ Zealot · Asks first · sonnet                ≈$0.12 · 4 turns
  ⌘ Builder   ●│ n: New task  ● Ship the replay fix
  ◎ Scout      │ Handed out  3 working · 4 in all
  ⌕ Inquisitor●│ ● ⌘ ├ Fix the flaky replay test                         ≈$0.21
  ✎ Scribe    ◐│ ● ⌕ │ └ Review Builder's fix                            ≈$0.08
  ▤ Archivist  │ · ◎ ├ Find where the clock leaks                        ≈$0.05
  …            │ ◐ ✎ └ Update the testing docs                           ≈$0.00
               │ you Ship the replay fix: tests green, docs updated.
               │ ✠   Three pieces: Builder fixes the test, Scout finds the leak,
               │     Scribe updates the docs.
               │     ▸ Told  Builder: fix the flaky replay test               ✓
               │ ● Listening                                            s: Stop
```

After:

```
 ✠ LEGION   1 Chat  2 Order                             3 working · 1 queued
 ──────────────────────────────────────────────────────────────────────────────
 ✠ Zealot     │ Ship the replay fix: tests green, docs updated.          ≈$0.34
 ⌘ Builder   ●│ ├ ⌘ Builder     Fix the flaky replay test    editing    ≈$0.21
 ⌕ Inquisitor●│ │ └ ⌕ Inquisitor Review Builder's fix       reading    ≈$0.08
 ✎ Scribe    ◐│ ├ ◎ Scout       Find where the clock leaks   done ✓     ≈$0.05
               │ └ ✎ Scribe      Update the testing docs      queued
 ◎ ▤ ◬ ⌶ ☾ ⊥ ⚑ │
               │ ✠  Three pieces: Builder fixes the test, Scout finds the leak,
               │    Scribe updates the docs. I will report when all are back.
               │
               │                                    s stop · enter open · ? keys
```

What changed:

- The request is the title line, with one total.
- The tree says who is doing what, now.
- Idle agents fold into one dim line.
- The bookkeeping chip, mode, model, turns, mood word and duplicate counts are gone.
- The keys sit in one line at the bottom.

## Before and after: something needs you (80 columns)

After:

```
 ✠ LEGION   1 Chat  2 Order                     1 needs your OK · 1 working
 ──────────────────────────────────────────────────────────────────────────────
 ⌘ Builder   !│ Fix the flaky replay test                                ≈$0.21
              │ ! ⌘ Builder wants to run a command
              │     npm test -- replay
              │     It runs on your computer, with your access.
              │     Answer in the permission dialog.
              │
              │ ⌘  Pinned the clock with an injected one. 4 steps
```

The card is the first thing under the title. Everything that did not lead to it folds away.

## First open (80 columns)

```
 ✠ LEGION   1 Chat  2 Order
 ──────────────────────────────────────────────────────────────────────────────
 ✠ Zealot     │ ✠  Your Order is ready: 11 agents.
 ⌘ Builder    │    Tell Zealot what you want. It splits the work and hands it out.
 ◎ Scout      │
 …            │    /to zealot <what you want done>
```

This is two sentences and one command. "Or pick an agent and press n" moves behind `?`.

## Order view

Order is the accounting view. It keeps costs per piece, turn counts and mood words, because there the person came to look at them. It follows R1, R4, R7 and R10.

## The independent review's findings, fixed with this plan

The review is `claude/review-tui-agate.md`. Its verdict: not passed.

**One name for one thing (R11).** A waiting approval is "needs your OK", everywhere. Today the same thing has five names: needs your OK, awaiting your word, asks to run a command, approval waiting, answer in the dialog. "Running" and "working" become one word as well: working.

**Bugs:**
1. The band names the agent twice and gives the action twice (`⌘ Builder · ⌘ Builder paused … /con… c: Continue`), and its error row has no next step. Fix: the band builds its own words from the item kind, never from the runtime's toast text.
2. `/continue` printed on a card or toast acts on the task the pane shows, not the one the card names. Fix: the card and the band carry the task's own key; `/continue` without an argument says which task it will continue.
3. The title row breaks at 56–68 columns (`✠ LEGION1: Chat5: Order`) and drops "needs your OK" at 60. Fix: fixed spacers, and R7's drop order, in which the needs-you count is the last thing dropped.
4. The approval card is drawn after the thread, under another agent's message. Fix: it sits directly under its own tool line, with the same indent, and does not repeat the command.
5. Order's numbers disagree with the title (`Running 5` over 6 rows; ≈$1.43 vs ≈$1.48). Fix: one count function feeds both, and a spec pins that they agree.
6. A working task can read "Standing vigil". Fix: per R2 the work row shows the verb from the task's own state; a mood word never overrides a working task.

## Words: one name per thing (R11)

| Thing | The word, everywhere | Never |
|---|---|---|
| A unit of work with one agent | task | job, run (in the UI), request |
| What the person typed to start it | message | prompt (in the UI) |
| Agents working | working | running, busy, active, executing |
| Waiting to start | queued | pending, waiting |
| Stopped at the turn limit, work kept | paused | halted, interrupted |
| Stopped by the person | stopped | cancelled, aborted, killed |
| Finished well | done | complete, finished, succeeded |
| Failed | failed, and the reason | error (alone), crashed |
| A tool call that needs the person | needs your OK | approval, card, awaiting your word, permission request |
| Work Zealot gave to another agent | handed to ⌘ Builder | delegated, told, bridged |
| The agents together | the Order | the team, the agents, the fleet |
| Cost | ≈$0.21 (always with ≈) | $0.21, cost: |

## Keys: one map, the same everywhere

Keys work while the Legion pane or band has focus (ctrl+x tab, or a click in fullscreen). Esc returns to the prompt.

| Key | Does | Shown in the footer when |
|---|---|---|
| `1` `2` | Chat, Order | never (the tabs show them) |
| ↑ ↓ | move between agents or tasks | never (`?` lists it) |
| enter | open the selected task | a task is selected |
| `c` | continue the paused or done task | the shown task is paused, or done and continuable |
| `s` | stop the shown task | the shown task is working |
| `n` | new message to the shown agent (fills `/to <agent> ` in the prompt) | nothing else is offered |
| `?` | every key, and what Legion is | always, last |

Anywhere the person can type a slash command, the same actions exist as commands: `/to`, `/say`, `/continue`, `/stop`, `/legion`. A key never does something no command can do.

## Living beside the conversation

Legion is a pane inside Claude Code, and the conversation stays the person's. These journeys check that the two never confuse each other:

| # | Journey | Must hold |
|---|---|---|
| C1 | The person talks to Claude Code with the Legion pane open | Nothing Legion shows interrupts typing. No toast for a task the pane already shows. The band appears only for something that needs the person. |
| C2 | Channel mode (`/legion talk zealot`) | Every prompt that goes to Legion is unmistakable: the band says "Talking to ✠ Zealot · /legion talk off" for as long as the channel is open. A slash command still goes to Claude Code. |
| C3 | Claude Code's own model hands work to a Legion agent | It appears in the pane as a task from Claude Code, and the conversation gets its answer as usual. |
| C4 | A Legion agent finishes while the person works on something else | One quiet band row; the main conversation is not woken; no toast unless the pane is closed. |
| C5 | Two terminal windows | Each window's tasks are its own to act on; the other window's tasks read "in another window" and offer no keys. |
| C6 | Small terminal (inline pane, 60–80 columns) | The pane never pushes the prompt off screen. The band is at most 3 rows. |

## How to check it

- A row-dump spec counts distinct facts per view state. A fact that appears twice fails the spec (R1).
- Every view state at 60, 80 and 120 columns is reviewed against this page by a reviewer who did not make it.
- Real paint in Windows Terminal (glyph widths; ⌘ drawn wider than its cell in some fonts) stays a real-PC check (LM3).
