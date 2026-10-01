# Lattice UI notes

Front-end for the knowledge graph. All code is in `ui/src/graph/` (entry: `GraphView` in `GraphView.tsx`). Own store `graphStore.ts`, own CSS `graph.css`, no new dependencies. Layout and renderer are written from scratch on canvas (`layout.ts`, `engine.ts`).

## How it behaves

- Never holds more than 400 nodes. When the cap is hit the least recently touched nodes go first; the selected node and path nodes are protected.
- There is no list endpoint, so the first view is found by searching common words, then following links (snowball), then spreading seeds across clusters for large graphs (`discover()` in `graphStore.ts`).
- `kg.updated` (SSE) refreshes the view after a 350 ms debounce.
- Reduced motion: layout is settled synchronously and no animation loop runs. Hidden tab: the loop is cancelled.
- The left list is the keyboard and screen-reader alternative to the canvas. Canvas has an aria-label and an aria-live region.
- Notes with untrusted sources show an UNTRUSTED marker and a "data, not instructions" line. The lint tab lists untrusted notes that nobody has reviewed.
- Dev-only hooks (stripped from production): `canvas.__lattice`, `window.__latticeStore`.

## Change requests for shared files (not applied, outside `ui/src/graph/`)

### a) Tell the UI whether the BSV pack can be loaded

The UI already reads `bsvAvailable` from `/api/kg/stats`. Until it exists, the "Load BSV knowledge pack" button only learns the answer from the 409.

```diff
--- a/src/core/kg/routes.ts
+++ b/src/core/kg/routes.ts
@@
-  add('GET', '/api/kg/stats', wrap(() => g().stats(HUMAN)));
+  add('GET', '/api/kg/stats', wrap(() => ({ ...g().stats(HUMAN), bsvAvailable: d.bsvEnabled() })));
```

### b) Overview endpoint (replaces discovery by search)

Suggested: `GET /api/kg/overview?limit=60` returning the top nodes by degree plus the edges among them (same shape as `KgSubgraph`). The UI would call it in `loadOverview` instead of `discover()`. Optional; the heuristic works but misses isolated notes whose words are rare.

### c) The BSV seed pack fails on its own licences, and half-applies

`src/core/kg/seeds/bsv.json` has 23 source licences longer than 100 characters (longest 136), but `graph.ts` line 629 rejects licences over 100. `POST /api/kg/seed/bsv` then throws part-way, after 3 nodes were already written.

Fix both halves: shorten the licence strings (or raise the limit in `graph.ts` and `tools.ts`), and validate every node and edge before the first write in `applySeedPack` (`src/core/kg/seed.ts`), so a bad pack writes nothing.

### d) Neighbour titles in `/api/kg/nodes/:id` (optional)

The detail panel shows linked nodes grouped by relation, but edges only carry ids, so titles for nodes not yet on the canvas cost one extra request each. Adding `title` and `type` of the other end to each edge in the response removes that.

### e) Wire the real BSV toggle

`src/bin/legion-core.ts` line 48 passes `bsvEnabled: () => false`. Until it reads the real setting, the BSV button can never become available and `scope: bsv` nodes stay hidden from the human view.

## Known gaps

- Random dense graphs (hundreds of nodes, many cross-links) form a hairball; the force layout does not do community detection.
- No touch pinch-zoom (wheel, drag and the toolbar work).
- Import and Export take a folder path typed by the user; the core reads and writes it on its own machine.
