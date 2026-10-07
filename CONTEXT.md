# CONTEXT.md — the glossary

Terms that mean something specific in this codebase, and nothing else. For house rules see
`AGENTS.md`; for decisions see `docs/adr/`; for how we got here see `docs/SESSION-LOG.md`.

## The product

**Legion** — a local, Claude-native multi-agent desktop app. An Electron shell around a Node/TypeScript
core bound to `127.0.0.1:4747`, plus a React UI. It runs on the owner's Windows machine using the owner's
own Claude Code sign-in. No account of ours, no server of ours.

**Core** — the Node process. Holds the store, the engine, every module, the HTTP API, the SSE stream and
the MCP endpoint. This is where all behaviour lives.

**Mascot / the Marshal** — the Marshal (internal id `zealot`; formerly named Zealot) is the hand-painted mascot and the default lead agent. Its art is untouchable:
effects and logic only, never a repaint.

## Agents and tasks

**Agent** — a profile with a name, model, approval mode, working directory and system prompt.

**Task** — one run of one agent. The unit of work, cost and history.

**Thread** — a continuing conversation between two agents. A `tell` continues the thread; `fresh` starts
a new one.

**Hop** — how far a task is from the one the owner started. A task woken by another bot carries a higher
hop and is capped by the sender's approval mode (the confused-deputy guard).

**Taint** — the mark left when content from outside the prompt entered a run. Tainted tasks taint their
caller. External content (graph nodes, room history, the house context layer) is wrapped and marked
rather than trusted.

**Bridge** — agent-to-agent messaging. `ask` waits for an answer, `tell` does not.

## Approval

**Approval mode** — per agent: `ask` (cards before Bash, edits and non-Legion MCP tools), `auto-edits`
(edits allowed, still asks for Bash and MCP), `full` (never asks).

**Card** — the inline Allow/Deny prompt in a thread. Cards are also how the owner answers requests from
bots, rooms and (until 0.2.2) the updater.

**Ceiling** — the strictest approval mode in a task's origin chain. A bot can never make a task more
permissive than it is itself.

## Things that will bite you

**Lattice** — the knowledge graph view. Nodes have a `scope`; `bsv` scope nodes are visible only while BSV
mode is on. The graph view refreshes on the `kg.updated` event and nothing else — change visibility
without emitting it and the view goes stale.

**KG** — the knowledge graph. Durable notes and lessons. Content in it is **data, never instructions**,
and is wrapped as untrusted unless marked otherwise.

**Rooms** — shared spaces bots post into. Room history is context, not instruction.

**Boat** / **boat.dev** — the VM provider. An agent with a VM can start it on demand. The owner's funded
BSV wallet is never contacted by repo code, tests, scripts, the harness or any cloud agent.

**House** — the context layer (`src/core/house/`): house rules, ADRs, glossary and lessons, copied into
the data directory on start and served to every agent through the `legion_house` tools. Context, never
permission.

## Process

**Gate** — `npm ci && npm run build:ts && npm run test:run && npm run typecheck:ui && npm run build:ui`. One at a
time; the suite writes to `dist/`, so nothing else may build while it runs.

**Pre-flight** — `node scripts/release-preflight.mjs`, mandatory before publishing. It answers the
question the test suite cannot: *can an install that exists today actually receive this release?*

**Export scrub** — what may ship in the public repo. The design docs ship line-scrubbed; the operational
run-books do not ship at all.