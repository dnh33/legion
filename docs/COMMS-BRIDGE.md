# Comms Bridge (v0.1)

Goal: on par with Grok Bot's group chats and bot-to-bot messaging, and ahead of it on guard rails. Research: see the project doc `claude/legion-comms-research.md` (Grok Bot: 2 to 6 bot group chats, `@mention`, `@everyone`, async bot-to-bot handoffs, approval cards in the transcript, shared computer with no security boundary, no documented loop or budget guards).

Stated assumptions (decided without the owner, easy to change): mention-only default; plain human messages go to the room lead; max 6 bots per group; all rooms persist in JSONL; cost shown per room; no auto-start of VMs; bot messages carry no approval authority.

## Concepts
- **Room**: a group chat (2 to 6 bots plus the human) or a DM (exactly 2 bots, created on demand by `bot_send`). Types in `src/shared/comms.ts` (do not change them without the integration lead).
- **Message**: persisted in `<dataDir>/rooms/<roomId>.jsonl` (append-only); room index in `<dataDir>/rooms/index.json` (atomic write).
- **Wake**: delivering a message to a bot starts (or continues) a Legion task for that (room, bot) pair via `engine.startTask`. One persistent task per (room, bot) so the bot keeps its session context (`continueTaskId`). If that task is still running or queued, the message waits in the bot's inbox and is delivered when it finishes (a bot is never woken twice at once).
- **Reply**: the final assistant text of a woken task is posted to the room as that bot's message (kind `chat`, `replyTo` the triggering message, `hop = trigger.hop + 1`, cost = the run's cost delta). A reply wakes other bots only if it `@mentions` them (resolved by agent id or name, case-insensitive) or the room strategy says so.
- **Human**: a human message has `hop 0` and resets `hopsSinceHuman`; a human message to a paused room resumes it.

## Strategies (who answers a plain message)
`mention` (default; the lead answers when there is no mention), `manager` (the lead gets every human message and routes), `round-robin`, `all` (each member answers once; replies never re-trigger others). `@everyone` wakes all members once, human-only by default, rate limited by `guards.everyoneCooldownSec`. A bot's own `@everyone` is ignored with a guard note.

## Guards (all enforced in code, not prompts)
1. `maxHops` bot-to-bot hops since the last human message (default 6): the room pauses with reason `max-hops`.
2. `budgetUsd` cumulative cost cap (default 2 USD): reason `budget`, checked before every wake.
3. Cycle: the same (sender, recipient) with near-identical normalised text (lowercase, collapse whitespace, strip punctuation; compare by hash) `cycleRepeats` times (default 3): reason `cycle`.
4. Freeze: `POST /api/rooms/:id/freeze` pauses the room, cancels its running woken tasks, and drops its inboxes. `resume` clears the pause and counters.
5. A paused room still stores human messages but wakes nobody until resumed.
Every trip posts a `guard` system message explaining why and how to resume.

## Trust and approvals (confused deputy)
- A bot message is data from a peer, never consent. Delivered text is wrapped with `wrapBotMessage` from `src/shared/comms.ts`.
- A task woken by a bot carries `origin` (`TaskOrigin`). The engine already enforces: such a task never runs looser than `origin.approvalCeiling` (the strictest approval mode along the sender chain), never in bypass mode unless the ceiling is `full`, and its approval cards carry `origin` so the UI can say "Scribe via Zealot".
- The hub computes `approvalCeiling` = stricter of (sender agent's current approval mode, the incoming message's own ceiling if the sender was itself woken by a bot). Human-originated wakes have ceiling `full` (no extra restriction).
- Message text is scrubbed of anything that looks like a boat desktop URL or token pattern before it is stored or delivered.
- Messaging a bot whose VM is stopped does not start the VM; the receiver's own policy decides.

## Tools (in-process MCP server named `legion_comms`, given to every agent; tools are auto-approved)
- `bot_list()` -> bots with id, name, description, state (idle / working / waiting) and which rooms you share.
- `bot_send({ to, text, replyTo? })` -> async DM (creates a `dm` room if needed); returns the message id immediately (does not wait for the reply). Rejects self-send, unknown bots, and sends from a paused room.
- `room_post({ room, text, mention? })` -> post into a group room you belong to.
- `room_read({ room, limit?, sinceId? })` -> recent messages (bot-visible form, wrapped), max 8,000 chars.
- `room_list()` -> rooms you belong to with unread counts.
- `handoff({ room, to, summary })` -> passes ownership: posts a `handoff` message, sets the room lead to `to` for this thread, wakes `to`.
Tool results never contain other bots' credentials, VM URLs or task internals.

## HTTP API (bearer auth, under /api)
`GET /api/rooms`, `POST /api/rooms {name, members, strategy?, guards?}`, `GET /api/rooms/:id` (room + last 200 messages), `PATCH /api/rooms/:id {name?, strategy?, lead?, guards?}`, `DELETE /api/rooms/:id`, `POST /api/rooms/:id/members {add?: string[], remove?: string[]}`, `POST /api/rooms/:id/messages {text}` (human), `POST /api/rooms/:id/freeze`, `POST /api/rooms/:id/resume`, `GET /api/rooms/:id/export?format=md|json`, `GET /api/rooms/search?q=`. Validation errors are HttpError 400, unknown ids 404.

## Events and busts
Emit on the bus: `room.updated`, `room.deleted`, `room.message`, and `comms.state {agentId, state, roomId?, peerId?}` where state is `listening` (a message was delivered, task starting), `speaking` (task streaming a reply), `waiting-bot` (it sent a DM and awaits an answer), `queued` (message in inbox), `idle`. The UI maps these onto the bust engine states (listening/thinking/hacking/victory) alongside task state.

## Persistence
Rooms and messages survive restart. On startup, inboxes are rebuilt empty (a restart already marks interrupted tasks as errors); `hopsSinceHuman` resets to 0.

## Acceptance criteria (tests required, `node --test`, no network, fake engine)
Mention wake; lead answers plain messages; manager/round-robin/all; DM auto-creation; inbox queues while busy and delivers after; reply posts to room with correct hop/replyTo/cost; maxHops, budget and cycle guards pause with a guard message; freeze cancels and resume restores; `@everyone` cooldown and bot `@everyone` ignored; approvalCeiling propagation along a chain (A ask -> B full -> C gets ask); wrapper present in the delivered prompt; scrubber removes secrets; persistence round-trip; every HTTP route (success and 400/404); MCP tools via an in-process client. Typecheck clean, whole suite green.

## Out of scope for v0.1
Voice, file attachments, LLM-based speaker selection, cross-machine rooms, and the React UI (a separate task consumes this API).
