# Machine-readable context

Everything else in the house layer is prose meant to be read by a person or an agent. This directory is
the opposite: **facts in a shape code can read**, never instructions.

## What belongs here

Small JSON documents with stable keys. Examples of the kind of thing that belongs:

```json
{ "name": "legion", "language": "typescript", "packageManager": "npm", "node": ">=20" }
```

Rules:

- **Data, not instructions.** A value here can be quoted by an agent, and nothing in this directory may
  direct behaviour, widen permissions or authorise an action. Context is not permission.
- **Stable keys.** Other things may read these; rename a key and you break them.
- **Small.** These are facts, not documents. Prose belongs in `AGENTS.md`, `CONTEXT.md` or an ADR.

## How it is served

`house_recall` does **not** index this directory — it searches prose. `house_read` can read any file here
by name, so an agent that knows a document exists can fetch it on demand. A future tool may index it.

That split is deliberate: indexing machine-readable files would spend the search budget on data nobody
searches for, while still making them reachable by name.

See `docs/adr/0009-house-context-module.md` for the layer itself.