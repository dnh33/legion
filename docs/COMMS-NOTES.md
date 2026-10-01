# Comms bridge: builder notes

Proposed changes to shared files: none needed.

## Where the spec was ambiguous (decisions, easy to change)
- **Human message to a paused room.** The spec says both "a human message to a paused room resumes it" and "a paused room still stores human messages but wakes nobody until resumed". Implemented: a human message clears a `max-hops` or `cycle` pause (those only measure bot-to-bot traffic) and wakes normally. A `frozen` room (deliberate) and a `budget` stop (the next wake would trip again) only leave via `POST /resume`. Change in `CommsHub.postHuman`.
- **Hop counting.** A message with `hop > guards.maxHops` that would wake someone trips the guard (message is still stored). Default 6: the 6th bot-to-bot message wakes, the 7th pauses.
- **Cycle counting.** Counts per (sender, recipient, normalised-text hash) since the last human message or resume; the Nth identical message (`cycleRepeats`) is stored but does not wake, and pauses the room.
- **Manager strategy.** The lead receives every human message and any explicitly mentioned bots wake too. A non-lead bot's automatic reply with no @mention goes back to the lead.
- **`all` strategy.** Automatic replies never wake anyone (even with @mentions). Explicit tool sends (room_post, handoff) still do.
- **`NO_REPLY`.** A woken bot that answers exactly `NO_REPLY` posts nothing. Added to stop DM ping-pong; the delivered prompt tells bots about it.
- **DM replies** always address the peer, so the answer to `bot_send` wakes the asker (state `waiting-bot` until then).
- **Tool-sent messages inherit the chain.** `bot_send`, `room_post` and `handoff` use the hop, ceiling and human-presence of the agent's active woken tasks (strictest/highest), so a bot cannot launder a chain through a second room. With no active wake: hop 1, ceiling = the agent's own approval mode.
- **Human wakes pass no `origin`** (ceiling `full` is implied and cards are not labelled "via ..."). Only bot-originated wakes carry `origin`.
- **Queued messages are batched** into one wake (one reply) when the bot finishes.
- **409 handling.** If `startTask` throws 409 and the pair's remembered task is live, the messages wait in the inbox and flush when that task ends (its output is not posted). Other engine errors post a `note` message and drop the delivery; a stale remembered task (404/400) falls back to a fresh session.
- **Persistence layout.** `rooms/index.json` is a `Room[]`; `rooms/state.json` holds the per-(room, bot) task map + cost baseline, read cursors and round-robin positions; `rooms/<id>.jsonl` the messages.
- **Search response** is `{ q, rooms, messages }` (messages newest first, max 50). `GET /export` defaults to `md`; `POST /api/rooms` and `POST .../messages` answer 201.

## Notes for the UI builder
- `room.updated` carries a full `Room`; `room.message` the stored message; guard/system messages have `from: {kind:'system'}`.
- `comms.state` is emitted per bot: `listening` (task starting), `speaking` (first streamed delta), `queued`, `waiting-bot`, `idle`.
