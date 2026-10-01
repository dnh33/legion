# Lattice build notes (kg builder)

Implemented per docs/KNOWLEDGE-GRAPH.md. No shared-file changes are required. Decisions and assumptions the integration lead should know:

## Wiring
- `legion-core.ts` passes `bsvEnabled: () => false`; until the BSV toggle is wired, `POST /api/kg/seed/bsv` answers 409 and bsv nodes stay hidden.
- `approvals.ts` already lists `mcp__legion_kg__` as a Legion tool prefix, so the kg tools are auto-approved.
- `createKnowledgeModule(deps, opts?)`: optional second arg (debounce, compaction threshold, seed path) exists for tests only.

## Seed pack format (src/core/kg/seeds/bsv.json), read at runtime, validated by `validateSeedPack` (src/core/kg/seed.ts)
`{ "nodes": [{ id, type?, title, body?, tags?, props?, sources: [{ref, licence?}], confidence? }], "edges": [{ from, to, rel, weight?, note? }] }`
- ids must be stable (1-80 chars of `A-Za-z0-9_.:-`), edges reference node ids from the same file, every node needs >= 1 source.
- `scope` is forced to `bsv` and `createdBy` to `system` (the file may omit them; if present they must equal those values).
- Seeding is idempotent (upsert by id, links are idempotent). Route: 409 BSV off (checked first), 404 pack missing, 422 pack invalid (all problems listed).

## Behaviour choices where the spec was silent
- Human (HTTP) sees all scopes except bsv-while-off, including agent-private nodes (it is the owner's machine). Agents see shared + own private + bsv-when-on.
- Agents cannot choose node ids, cannot write `bsv` or another agent's scope, and a hidden node looks exactly like a missing one (404).
- Edges are visible only when both endpoints are visible. Agents may link to bsv nodes (visibility is enough); unlinking a link that touches bsv needs the creator or the human.
- Untrusted stickiness: an agent update can never clear an `untrusted` source flag; `props.reviewed` can be set only by the human, and any agent edit to title/body voids an earlier review.
- `kg_upsert_node` `untrusted: true` without sources is rejected. Deleting via HTTP needs no `confirm` (the verb is the confirmation); the MCP `kg_forget` requires `confirm: true`.
- The data-not-instructions line is appended once per tool result that contains wrapped text (not after every node). Titles sit outside the wrapper but are single-lined and have any `<kg-node` sequence neutralised; wrapped text has `</kg-node` and `<kg-node` escaped as `&lt;...`.
- Tool results are capped at 8,000 chars including the truncation note; cap keeps wrapper tags balanced and keeps the data line.
- `kg_recall` budget clamps to 120..8000 chars (default 4000); the outline never exceeds it.
- Vault: import ignores `scope`, `createdBy` and `id`-as-new-id from file content (never lets a vault pick scope or author); `type` is honoured only if valid. A note is matched for update by `props.vaultPath` (relative path), else by frontmatter `id` of an existing node, else by adopting an `entity` stub of the same title. Links to duplicate or bracketed titles carry an invisible `<!-- id:... -->` hint on export. Symlinks and dot folders are skipped.
- HTTP shapes: search returns `KgSearchHit[]`; `GET /nodes/:id` returns `{node, edges:{out,in}}`; `POST /nodes` and `POST /edges` return `{node|edge, created}` with 200 (they are upserts); `GET /subgraph` is 404 when none of the seeds exist.
- `kg.updated` carries the graph-wide node and edge counts plus the changed ids, debounced 250 ms, flushed on dispose.

## Follow-up fixes (Lattice UI findings)
- Source licence limit raised from 100 to 200 chars (`MAX_LICENCE_CHARS` in graph.ts, also the `kg_upsert_node` schema).
- `applySeedPack` vets the whole pack before the first write: every node via `upsertNode(..., {dryRun: true})` (validation, visibility, write rights, node limit) and every edge via `validateLinkFields`. Any problem gives 422 "nothing was written". Seeding while BSV is off and the pack touches already-seeded (now hidden) nodes is refused the same way.
- `GET /api/kg/stats` adds `bsvAvailable`. New `GET /api/kg/overview?limit=60` (1..200) returns the top nodes by visible degree plus the edges among them (`KgSubgraph`; `truncated` when more visible nodes exist). Human visibility rules apply (bsv hidden while off).
- `GET /api/kg/nodes/:id`: each edge in `edges.out/in` gains `title` and `type` of the other endpoint; existing fields are unchanged.
- Still open for the integration lead: `legion-core.ts` must pass the real BSV toggle instead of `() => false` (section e of LATTICE-UI-NOTES).
