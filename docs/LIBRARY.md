# The Library

The Library is the Lattice (the shared knowledge graph, see [KNOWLEDGE-GRAPH.md](KNOWLEDGE-GRAPH.md)) used as long-term memory for your bots, plus the screens that keep you in charge of it. Bots capture decisions, mistakes and patterns as they work, keep a private working memory, and start each run with a short briefing. Anything risky waits for you in the Inbox.

No model calls, no embeddings and no new dependencies are involved. Everything below is plain code over the same `graph.jsonl` log.

## What a bot can do

| Tool | What it does |
| --- | --- |
| `kg_capture` | Saves one note in a fixed shape: `decision`, `mistake`, `pattern`, `project` or `idea`, each with required fields that become fixed headings. Warns when a near-identical title exists (`similar: id X`) and then writes nothing, unless `supersedes` or `force` is given. One atomic write. |
| `kg_wm_set` | Sets the bot's own working memory: a private note, 2,500 characters of ACTIVE plus a small ARCHIVE. Shown to that bot at the start of its next run. Refused in a tainted run. |
| `kg_supersede`, `kg_merge` | Retire an outdated note in favour of a newer one, or fold duplicates into one. The old notes are kept, marked superseded or archived, and hidden from search and recall. A bot that may not change the old note directly (you wrote it) files a proposal instead. |
| `kg_upsert_node`, `kg_link`, `kg_unlink`, `kg_forget` | The original Lattice tools. `kg_forget` works only on the bot's own private notes and leaves a tombstone. |
| `kg_recall`, `kg_search`, `kg_get`, `kg_neighbors`, `kg_path`, `kg_subgraph`, `kg_lint`, `kg_stats` | Reads. Recall ranks by text match, recency (decisions, patterns and mistakes do not age), confidence and trust. Untrusted notes come back as `[untrusted lead]` with an id and no text. |

Accepting, rejecting, undoing and reading the Inbox or Activity are **not** tools. Only you can do them, through the app.

### The briefing

At the start of a run a bot gets a `<kg-briefing>` block of at most 1,200 characters, built with no model call:

- its own working memory (the ACTIVE part),
- up to five standing notes you wrote or accepted (tags `trigger:always` or `trigger:<bot>`),
- the titles of the top three recall hits that are active and not untrusted,
- how many of its notes wait in your Inbox.

Nothing from a tainted run, and nothing untrusted, ever reaches it. The block says it is data, not orders.

### Close-out

A task of 8 or more turns, or $0.10 or more, that made no `kg_capture` or `kg_wm_set` call gets one deterministic `episode` note (private to that bot, written by the system, kept 30 days). No extra model turn is forced.

### Vault mirror

`POST /api/kg/export` with `{"dir": "<vault>", "mode": "library"}` writes the bots' shared, active, non-untrusted notes into `<vault>/legion/<type>/` as Markdown with front matter. It never writes outside `<vault>/legion/`, never touches your own files, refuses to write through a symlink, and removes only its own stale files there. Import reads inline `#tags` (`#decision`, `#mistake`, `#pattern`, `#idea` map to those types) and skips `legion/`, so nothing loops back. The Export dialog in the app still exports everything into a folder you choose; the mirror mode is reachable through the API only for now.

## The screens

**Library** (title bar, third icon) has three tabs.

- **Lattice**: the graph view, as before. The detail panel now shows trust and status badges, edits a note in place (title, type, tags, body; "More fields" opens the full dialog), and edits a link's relation and note with the pencil on each link row. Pending notes show an amber PENDING block; superseded and archived notes are dimmed and say what replaced them.
- **Inbox**: everything waiting for you, newest first. Each row says who wrote it, in which task, the type, trust, whether the run was tainted, and any untrusted source. Edit proposals show a before/after diff against your note. Per row: Accept, Edit then accept, Reject. The title-bar icon carries an amber count while anything is waiting. Select rows to accept several at once; rows with an untrusted source are skipped unless you tick "Include N untrusted".
- **Activity**: the last 100 writes by bots and the system, with who, what, when, trust and an Undo button. Undo is open for 7 days. The button is disabled, with the reason beside it, when the write was already undone, is older than 7 days, is too large to keep undo data for, or a note it touched has changed since. Your own edits are not listed.

The screens never guess. Every action waits for the core, then both lists are read again. A refusal from the core is shown on the row in the core's own words.

Colour: amber is pending, red is untrusted or tainted, dimmed dashed is superseded or archived. Green stays for selection and paths. Diffs use blue for added and red for removed lines.

## What goes to the Inbox

- Any shared write from a **tainted** run (see below). Forced untrusted and pending.
- A bot's edit to a note whose trust is `human`: stored as a pending copy that supersedes yours. Your note is untouched until you accept.
- A supersede or merge a bot may not do directly.
- A shared write from a run another bot woke while that bot was under "ask" approvals.
- Every shared write by the Archivist, which flags and proposes and never decides.

Everything else a bot writes is accepted at once and listed in Activity. A clean bot that marks a source untrusted is not held, but the note is stored as untrusted: other bots see only its title as a lead.

Accepting a note from a tainted run keeps it at `agent` trust; it never becomes `human` by being accepted as is. If you edit it before accepting, it becomes yours (`human`) and the taint is cleared. The Inbox says which of the two will happen. At most 50 notes per bot can wait; past that the write is refused with a message, not silently dropped.

## The safety model, in plain words

1. **Trust is decided by the engine, never by the bot.** Each note is `human` (you wrote or accepted it), `agent` (a bot in a clean run) or `untrusted` (it has an untrusted source, or a tainted run wrote it). A bot cannot pass a trust level in.
2. **Taint is sticky.** A run is tainted once it calls WebFetch, WebSearch, any Bash or VM shell tool, or any MCP tool that is not Legion's own, or when a tainted bot or message woke it. From then on, for that task: its writes are untrusted and held, it cannot write working memory or trigger tags, and it may link only notes it wrote itself.
3. **Untrusted text is data.** Other bots see an untrusted note as a title-less lead, and it is never in a briefing. Where it is shown, it is wrapped as data.
4. **Bots cannot rewrite what you wrote.** A change becomes a proposal you review.
5. **Bots cannot change scope or delete shared notes.** They may forget only their own private notes, as a tombstone you can restore and that is purged after 30 days. The Archivist flags and proposes; it never deletes.
6. **Limits per task:** 40 node writes, 100 link operations, 200 KB written, 60 graph calls. Past a limit the bot is told to finish up.
7. **Secrets do not get in.** Keys, tokens and your configured credentials are redacted before saving; a seed phrase or private key makes the whole write fail. A 64-character hex transaction id is kept.
8. **A safety copy first.** `graph.jsonl.bak-N` (newest five kept) is taken before compaction, vault import, seeding or a delete of more than five notes.
9. **Your own edits are not listed in Activity**, so they have no Undo. They are ordinary writes by you.

## Not built

- Embeddings or any semantic search. Recall is keyword ranking.
- Two-way vault sync, a file watcher, or merge of vault edits made while the app runs. The mirror is one-way.
- The Council dialog (convening a review as a room from a note), a Bots tab with per-bot memory cards, a cost chip, a recall-trail chip under task replies, drag-to-link on the canvas, and tidy runs driven by a model.
- A button for the vault mirror in the Export dialog.
- Keyboard shortcuts in the Inbox.

## HTTP routes added for the screens

`GET /api/kg/inbox`, `POST /api/kg/inbox/accept` (`ids`, `agent`, `overrideUntrusted`), `POST /api/kg/inbox/:id/accept` (optional `edit: {title, body, tags}`; send only fields you changed), `POST /api/kg/inbox/:id/reject`, `GET /api/kg/activity`, `POST /api/kg/activity/:id/undo`, `PATCH /api/kg/edges/:id` (`rel`, `note`, `weight`; human only; 409 when the new relation already links the two notes). Retyping or editing a note uses `POST /api/kg/nodes` with its `id` and only the fields to change.
