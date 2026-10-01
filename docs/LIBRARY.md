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

A task of 8 or more turns, or $0.10 or more, that made no *successful* `kg_capture` or `kg_wm_set` call (a refused one does not count) gets one deterministic `episode` note (private to that bot, written by the system, kept 30 days). No extra model turn is forced.

### Vault mirror

`POST /api/kg/export` with `{"dir": "<vault>", "mode": "library"}` writes the bots' shared, active, non-untrusted notes into `<vault>/legion/<type>/` as Markdown with front matter. It never writes outside `<vault>/legion/`, never touches your own files, refuses to write through a symlink, and removes only its own stale files there. The folder carries a `.legion-mirror` marker and every file `mirror: "legion"` front matter; import skips the mirror at any depth (a folder named `legion`, a folder with the marker, or a file with that front matter), so nothing loops back even if the folder is moved or renamed. Files are written to a temp file and renamed, so a symlink planted at a file name is replaced, never written through. Every text field is scrubbed again on export. Import reads inline `#tags` (`#decision`, `#mistake`, `#pattern`, `#idea` map to those types). The Export dialog in the app still exports everything into a folder you choose; the mirror mode is reachable through the API only for now.

## The screens

**Library** (title bar, third icon) has three tabs.

- **Lattice**: the graph view, as before. The detail panel now shows trust and status badges, edits a note in place (title, type, tags, body; "More fields" opens the full dialog), and edits a link's relation and note with the pencil on each link row. Pending notes show an amber PENDING block; superseded and archived notes are dimmed and say what replaced them.
- **Inbox**: everything waiting for you, newest first. Each row says who wrote it, in which task, the type, trust, whether the run was tainted, and any untrusted source. Edit proposals show a before/after diff against your note. Per row: Accept, Edit then accept, Reject. The title-bar icon carries an amber count while anything is waiting. Select rows to accept several at once; rows with an untrusted source are skipped unless you tick "Include N untrusted". Bulk accept never takes trigger notes, edits of your own notes, or rows from a bot another bot woke under "ask"; those are reviewed one by one, and the summary says how many were skipped and why.
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

### Vault import

A vault is a folder on disk, and a bot with a shell may have written into it. The import started from the app (`POST /api/kg/import`) makes your files your own notes, with these exceptions that always wait in the Inbox: a file that carries a `trigger:*` tag, and a file that would change a note you did not import (a bot note, working memory, an episode, a BSV note). A file never overwrites such a note directly, and the front matter `id` is honoured only for notes the importer created. Any other caller of the importer (a script, a test) lands every file as a pending, untrusted note. Residual: a plain note a bot planted in a vault you then choose to import becomes your note, because you asked to import that folder. Read the vault before importing it if a bot could write there.

## The safety model, in plain words

1. **Trust is decided by the engine, never by the bot.** Each note is `human` (you wrote or accepted it), `agent` (a bot in a clean run) or `untrusted` (it has an untrusted source, or a tainted run wrote it). A bot cannot pass a trust level in.
2. **Taint is sticky and the rule is an allowlist.** A run is tainted by any tool not known to be clean: only file tools (Read, Glob, Grep, LS, Edit, Write, ...), planning tools and Legion's own tools (except the VM shell and file readers) are clean. WebFetch, WebSearch, Bash, MCP resource tools, every other MCP tool and any tool added later taint. It is also tainted when a tainted bot or message woke it, and a run that reads room messages written by a tainted bot becomes tainted itself. The rule looks at the tool name only, not at which path a file tool reads. The rule lives in one exported function, `taintsRun`, with a table-driven test. From then on, for that task: its writes are untrusted and held, it cannot write working memory or trigger tags, and it may link only notes it wrote itself.
3. **Untrusted text is data.** Other bots see an untrusted note as a title-less lead, and it is never in a briefing. Where it is shown, it is wrapped as data.
4. **Bots cannot rewrite what you wrote.** A change becomes a proposal you review.
5. **Bots cannot change scope or delete shared notes.** They may forget only their own private notes, as a tombstone you can restore and that is purged after 30 days. The Archivist flags and proposes; it never deletes.
6. **Limits per task:** 40 node writes, 100 link operations, 200 KB written, 60 graph calls. Past a limit the bot is told to finish up. **Limits per bot and store:** a bot may hold at most 10,000 notes and the store is capped at its node limit; your own writes may exceed the bot cap by a reserve of 500, so a bot that fills the graph cannot lock you out.
7. **Secrets do not get in.** Keys, tokens and your configured credentials are redacted before saving; a seed phrase or private key makes the whole write fail (a labelled phrase, or a field that is nothing but 12 to 24 plain words; Unicode look-alikes and zero-width characters are normalised first). Episodes are scrubbed before they are cut to length. A 64-character hex transaction id is kept.
8. **A safety copy first.** `graph.jsonl.bak-N` (newest five kept) is taken before compaction, vault import, seeding or a delete of more than five notes.
9. **Your own edits are not listed in Activity**, so they have no Undo. They are ordinary writes by you.
10. **The log is crash safe and shared-directory safe.** Multi-line writes (merge, capture with supersede) are stored between `begin` and `commit` markers; a half-written batch is discarded on load and the file is cut back to its start. Older logs without markers still load. Every node carries a revision counter, so two edits in one millisecond are told apart and an Undo refuses after a later edit; Undo of a create refuses once the note has gained links. A lock file (`graph.jsonl.lock`, stale after 30 s or a dead pid) lets two processes on one directory take turns instead of interleaving.
11. **Tainted-origin notes stay wrapped.** A note that a tainted run wrote is shown as data even after you accept it, until you edit it yourself. A held run that rewrites its own earlier shared note puts it back to pending.

### Known limit: the bearer token (R4.3)

`config.json` holds the bearer token and is written with mode 0600 (and tightened to 0600 when loaded on a POSIX system). The token is not placed in any agent's environment, and any env value that contains it is stripped. But a bot with a Bash tool runs as the same operating-system user and can read `config.json`, then call `/api/kg/inbox/:id/accept` and the other human routes as you. **This is not fixed.** The real mitigation is to run bots that may use Bash inside a VM sandbox that cannot see `~/.legion`, or to give bots a scoped token that cannot call the human routes. Both are listed as follow-ups. Until then, treat a Bash-capable bot as able to act as you on the local API, and keep bots that read the web away from Bash.

## Not built

- Embeddings or any semantic search. Recall is keyword ranking.
- Two-way vault sync, a file watcher, or merge of vault edits made while the app runs. The mirror is one-way.
- The Council dialog (convening a review as a room from a note), a Bots tab with per-bot memory cards, a cost chip, a recall-trail chip under task replies, drag-to-link on the canvas, and tidy runs driven by a model.
- A button for the vault mirror in the Export dialog.
- Keyboard shortcuts in the Inbox.

## HTTP routes added for the screens

`GET /api/kg/inbox`, `POST /api/kg/inbox/accept` (`ids`, `agent`, `overrideUntrusted`), `POST /api/kg/inbox/:id/accept` (optional `edit: {title, body, tags}`; send only fields you changed), `POST /api/kg/inbox/:id/reject`, `GET /api/kg/activity`, `POST /api/kg/activity/:id/undo`, `PATCH /api/kg/edges/:id` (`rel`, `note`, `weight`; human only; 409 when the new relation already links the two notes). Retyping or editing a note uses `POST /api/kg/nodes` with its `id` and only the fields to change.
