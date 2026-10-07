# Chat: message queue and copy menu

UI notes for the composer and the message list. Code: `ui/src/chat/` (pure logic), `ui/src/components/Composer.tsx`, `QueueStrip.tsx`, `CopyMenu.tsx`.

## Message queue

While an agent is working, **Enter queues** your message instead of refusing it. Queue as many as you like (in order); when the run ends the next one is sent by itself.

| Key | Agent idle | Agent busy |
|---|---|---|
| `Enter` | send | queue |
| `Ctrl+Enter` (`Cmd+Enter`) | send | **interrupt**: cancel the current run, send this message now, the rest of the queue stays queued behind it |
| `Shift+Enter` | newline | newline |
| `Up` in an empty input | | pull the last queued message back into the input |

The queue is a list above the composer: a count badge, one line per message (click to edit it in place; `Enter` saves, `Esc` cancels), a "send now" button (same as Ctrl+Enter for that message), a remove button, and the state ("Waiting for the current run to finish", "Sending", "Paused"). A **Queue** button next to Stop does the same as Enter for mouse and touch users.

### What counts as busy

- the thread's own run is queued or running;
- an approval card for the thread is waiting (the run is paused on you, which still counts as running: the queue holds);
- the same agent is busy with a task that did not start in this window: a room, an agent-to-agent call, an MCP client. Your own other tab of the same agent does **not** count, so running two tabs in parallel works as before.

A "thread" is a task. Each task has its own queue, and every agent keeps its queues while you look at another agent (they keep sending in the background). The New task view of a busy agent has a queue too; it becomes the new task's queue after its first message.

### When the queue stops by itself (hold)

Nothing is ever sent "silently" after something went wrong. The queue pauses and shows a banner with **Resume** and **Clear**:

- **You stopped the run** (Stop button, the task menu, or another window): `Queue paused: you stopped the run`.
- **The run failed**: the error text is shown.
- **Sending a queued message failed** (offline, refused): the message stays in the queue.
- **After a reload**: the queue comes back from `sessionStorage` (it survives a window reload, not an app restart) but held: `Restored after reload`. Nothing goes out until you press Resume.

While a queue is held and the agent is idle, a fresh Enter sends right away; the held messages are not touched.

### Limits and details

- 20 messages per thread, 50,000 characters per message. The 21st message is refused with a visible message and stays in the input.
- A queued message keeps the model that was selected when you queued it.
- Slash commands: `/opus text`, `/sonnet text` and Claude Code commands queue and send like any message. Commands Legion runs itself (`/new`, `/agent`, `/vm`, `/doctor`, a bare `/model`) still run at once, they are not queued.
- A message long enough to matter is shown clipped in the list (160 characters) and sent whole.
- Ctrl+Enter only cancels the thread's own run. If only another source is busy (a room task), it just sends now and leaves that task alone.
- The cancel goes through the normal cancel path; the interrupted run shows "Cancelled" and the new message continues the same task (and session) once the old run has unwound. No engine change was needed.
- **IME**: while an input method is composing (Japanese, Chinese, Korean), Enter only confirms the candidate text. It never sends, queues, interrupts or saves a queue edit (`isComposing`, plus keyCode 229 for Safari's confirming Enter).
- **Deleted tasks and agents** take their queues with them, in memory and in `sessionStorage`; nothing is ever sent to a dead task or comes back after a reload.
- **A failed send gives the text back.** If Enter or Ctrl+Enter cannot send (offline, refused), the message returns to the input; whatever you typed meanwhile stays after it. A queued message that fails to send stays in the queue and holds it.
- If the core says "still running" for a moment after our copy says idle (event ordering), the send is retried a few times before the queue is held.

### Runs with background agents

A Claude run that started background agents (Claude Code's own subagents) is **held open** until they report: the working row says "waiting on N background agents", and a message you add with plain Enter joins the run as before. Legion closes such a run only when its last background agent has reported and the model has answered, when you stop it, or when nothing at all has come from the agents for 60 minutes (the thread says so). Stop, `Ctrl+Enter` and "send now" cancel the run, and that ends the background agents too, so a run that has some asks first ("Stop anyway?"); answering no sends nothing and cancels nothing. Background shells (a dev server) are not waited on. Replies from other agents (`tell`) reach a held run when it closes, not before.

### Implementation

- `queue.ts`: a pure state machine (enqueue, dequeue on run end, override lock, pause, resume, clear, edit, rekey, persistence round trip with sanitising). `busy.ts`: the busy rules. Both are unit-tested (`test/chat-queue.test.ts`).
- `queueStore.ts`: a store of its own (queue changes never write to the main app store), `sessionStorage` persistence, and the runner. The runner listens to every store write but returns after three reference comparisons unless `tasks`, `approvals` or `loaded` changed, so streaming costs nothing extra. No timers, except the retry after a 409.
- The composer keeps its text in local state; the queue strip is memoised on two strings, so typing never re-renders it.
- `store.ts`: `sendPromptTo(target, prompt, opts)` sends to any thread (the queue sends to threads you are not looking at); `sendPrompt` is now a thin wrapper. A task row from an HTTP response is never allowed to replace a newer one (`upsertTaskIfNewer`, rule in `tasksync.ts`): a fast run's events could otherwise be overwritten by the older "queued" snapshot, leaving the UI busy forever. When both rows carry the same millisecond, the more advanced lifecycle state (queued, then running, then an end state) is kept, so a tie can never move a finished task back to running.

## Copy menu

Under every finished assistant reply: **Markdown** and **Plain text** (with a copy icon). It shows on hover or keyboard focus of the message, is always visible on touch screens, and is always in the DOM, so Tab reaches it.

- **Copy as Markdown**: the message's own source text, exactly as the model wrote it.
- **Copy as plain text**: what the bubble shows, without the syntax. Headings, bold, italic and inline code lose their markers; `[text](url)` becomes `text (url)`; lists keep their structure (`- item`, `1. item`); code blocks become plain lines (no fences, indentation kept); a table becomes one line per row, header first, with the cells separated by tabs (it pastes into a spreadsheet); a line break stays a line break.
- Tool chips and tool output are never included, only the message's own text. A streaming reply has no menu until it is complete.
- A short "Copied Markdown" / "Copied text" note appears next to the buttons for about two seconds. No animation or transition.
- It uses `navigator.clipboard` and falls back to a hidden textarea with `execCommand('copy')` (focus returns to the button). The code blocks keep their own Copy button.
- Menu state is local to the small `CopyMenu` component, and the message view stays memoised, so using the menu never re-renders the thread.
- `mdparse.ts` is the one Markdown parser: `Markdown.tsx` draws its blocks, `plaintext.ts` flattens the same blocks, so the two cannot drift apart (`test/chat-copy.test.ts`). Tables are GitHub-style: a header row, a `|---|:--:|--:|` delimiter row with the same number of cells, then body rows until a blank line, a fence or a line without a pipe (a table may follow a paragraph line directly). `\|` and pipes inside `code` spans stay in their cell; short rows are padded and long rows cut to the header's width; no delimiter row means no table. At most 200 columns (a wider header is plain text) and 5,000 rows (the rest are plain lines after the table). They draw as a `<table>` in a focusable, horizontally scrollable region. It is linear: every parse step advances at least one line, fence lines are read without regex backtracking, link text and addresses are length-bounded, and a single line over 20,000 characters is shown as plain text. An odd fence line such as ```` ```js title=x ```` is ordinary text (it used to stall the parser). `test/chat-mdparse.test.ts` feeds pathological inputs to a worker thread that is killed after a few seconds.

## Proof

`test-perf/chat-ui/` drives the real built UI with Playwright against a real core (real engine, real HTTP server) whose Claude SDK is scripted (`harness.mjs`): `queue.mjs` (25 checks: order and auto-send, Ctrl+Enter, pause on stop, resume and clear, edit and remove, approval hold, failed run, failed send, 409 retry, room-busy, reload restore, limits, slash commands, long messages, IME, deleted task and agent, text restored after a failed send), `copy.mjs` (11 checks: both variants on the real clipboard, keyboard, touch, fallback, light and dark), `perf.mjs` (typing, streaming and idle cost). Run `node test-perf/chat-ui/queue.mjs [dist-ui dir]`; Playwright is found through `PLAYWRIGHT_PATH`. The data directory is under `/tmp/m/wt-chat-home-<port>` and is removed on exit.
