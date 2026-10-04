# ADR 0009 — The house context layer

**Status:** accepted · **Date:** 2026-10-04

## Context

Every agent Legion runs gets `~/.legion/workspaces/<agentId>` as its working directory — never the
repository. That is deliberate isolation: an agent cannot wander into the source tree.

But it has a cost. The knowledge that makes work *consistent* — the house rules, the decisions already
made and why, the glossary, the lessons from earlier work — lives in the repo. An agent inside Legion
could not reach any of it. So two agents handed the same task could reach different conclusions, and
neither could discover why.

The owner's direction: **Legion should be developable from inside Legion.** That requires the context
layer to reach the agents, not the repo to reach their working directories.

## Decision

A new module, `src/core/house/`, copies a curated set of files from the installation root into
`<dataDir>/context` on start, and serves them to every agent through an in-process MCP server
(`legion_house`) with three tools:

- `house_list` — every file in the layer, with sizes, and what is missing from it.
- `house_recall` — lexical (BM25) search returning file, heading and a short snippet.
- `house_read` — one file in full.

Progressive disclosure: metadata and search first, full body only when the agent asks. The layer is
indexed, not injected, so its cost per task stays small.

## Trust

The layer is **context, not permission**. It can never widen an agent's approvals or authorise a spend,
a signature or a download: `permissionMode`, `disallowedTools` and `canUseTool` are decided in
`buildOptions` before the model sees any text. A rule in the house cannot grant more.

Reads mark the run tainted, because the layer can contain something the owner dropped in — still content
that arrived from outside the prompt.

**A file is trusted only while its bytes still match what Legion shipped.** The sync writes a hash
manifest; reads compare against it and wrap anything that has drifted as untrusted. Without this, an
agent editing the repo could write `AGENTS.md` and have its own edit return as *trusted*, which inverts
the rule the knowledge graph applies to everything else. This matters precisely when Legion-on-Legion
starts, which is the point of the module.

## Consequences

- Every agent shares one rulebook, and it is updatable without touching agent prompts.
- A project that needs different rules gets them through the project's own block, which stays separate.
- The layer is global, not per-project. Per-project scoping is deliberately **not** here.
- Skills are a different feature and are not part of this (parked; see the tracker). `claude/skills` is
  copied as content, but nothing here depends on it existing.