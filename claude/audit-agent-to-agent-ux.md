# Audit: agent-to-agent communication in task chats (2026-10-06)

Owner's ask: nothing indicates that an agent answered back to a bot that contacted it, or the other way round. Audit the
areas, find lacking UX, learn from Claude Code, find parity gaps. Read-only audit; screens from the mock core
(`ui/dev/mock-server.mjs`, token `bridge`) serving the built UI, in `<session scratchpad>/audit-a2a/`. Running, waiting,
timeout, failure and approval-blocked states were read from code, not rendered.

**Bottom line:** an `ask` answer is hidden inside a collapsed chip (`ToolChip.tsx:82`); a `tell` answer arrives as a visible
bubble (`MessageView.tsx:65-83`). "Builder answered Zealot" looks completely different per verb, and is invisible for `ask`,
the common case. Under it: no waiting state, no way back from the callee, failures look like successes.

## Bugs (wrong or misleading today)
| # | What the person sees | Where | Fix |
|---|---|---|---|
| B1 | A refused `tell` still reads "Sent. X's reply will arrive in this task." (verified by the lead) | ToolChip.tsx:39,80-81 | Parse `Error:` / missing taskId: "Not sent: <reason>" in error style |
| B2 | A model-override notice shows as a message FROM the target agent; for provider agents it is replayed to the model as a user turn (read, not run) | bridge.ts:355, MessageView.tsx:29, tool-loop.ts:247 | Store as a system notice without fromAgentId |
| B3 | A pending `ask` chip says "No result was recorded for this call." (verified by the lead) | ToolChip.tsx:82 | "Waiting for <X>…" while the task runs |
| B4 | An `ask` timeout shows raw JSON | ToolChip.tsx:14-20 | Render the note: "Still working after 600 s; <X> keeps going." |
| B5 | A refused/failed `ask` shows its error under a neutral "Result" heading | ToolChip.tsx, bridge.ts:192, engine.ts:1143-1150 | Style by status / `Error:`; optionally store isError on tool results |
| B6 | A failed `tell` comes back as an ordinary reply bubble "(failed) …" | bridge.ts:210 | Status on the reply; "Builder could not finish: …" |
| B7 | The working row shows `mcp__legion__ask` | WorkingRow.tsx:25 | "Waiting on Builder" |

## Gaps (ranked)
G1 one hand-off card for both verbs that holds its own answer · G2 status pill + "Open Builder's task" for ask too; readable aria-label instead of raw JSON · G3 callee breadcrumb back to the caller task (parentTaskId unused in the UI) · G4 "Returned to Zealot" footer on the callee's final message · G5 caller waiting on a callee that waits for YOUR approval: say so and link (most likely "why is it stuck") · G6 chain/tree view A→B→C with (+N) · G7 reply head "Scout answered your request" + quote · G8 taint never shown in threads · G9 callee composer hint "goes to Builder only" · G10 reuse the rooms hand-off card language.

Constraint C1: one callee thread holds requests from several caller tasks (`findPair` keys on the agent pair; `engine.ts:271` overwrites parentTaskId), so per-request links need `ChatMessage.bridge?: { mode, parentTaskId, fromTaskId, status? }`.

## Proposed design (core fix)
1. Caller: a hand-off card, not a chip. Head `Zealot → Builder · asked (waits for the answer)` / `· told (keeps working)`; request clipped to 2 lines; `Open Builder's task ↗`. States: `Waiting on Builder · 1m 12s` (+ `Builder needs your OK → Open`), `Builder answered · 38s` with the answer inline (collapsed after ~6 lines), `Builder could not finish: …`, `Cancelled`, `Still working after 600 s; Zealot moved on`, `Not sent: <reason>`. A tell card: `Sent · answer will arrive below` → `Scout answered ↓`.
2. Tell reply bubble: `Scout answered Zealot · re: "…" · Open Scout's task ↗`, failure styled.
3. Waiting row: `Waiting on Builder (asked 1m ago)`; several: `Waiting on Builder, Scout`.
4. Callee: breadcrumb `From Zealot › "…" ↗`; first bubble `Zealot asked Builder · waiting for this answer`; footer `Returned to Zealot ↗`.

## Claude Code parity (documented at code.claude.com/docs unless noted)
Delegation row `code-improver(Suggest code improvements)`; running subagents in a panel, nested as a tree with (+N); failed rows kept 30 s; background subagent permission prompts name the asking subagent; background results arrive as a completion notification; teammates panel, Enter opens a transcript; cross-session messages as a one-line preview `› Message from @api-worker: …`. Inferred only: the "Done (N tool uses · tokens · time)" line.
Legion behind: no in-flight list, no nesting, no named asker on approvals with a link, no failed state, ask results hidden. Legion ahead: delegations are persistent tasks with tabs, reply bubbles link to the source task, the bridge header tells the receiver it is not the user, taint follows answers (unseen).
