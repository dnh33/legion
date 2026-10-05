# Card design language

How Legion draws a card that a person answers (Allow / Deny, Review, Accept / Reject). Source of truth for the desktop card: `ui/src/components/ApprovalCard.tsx`, `ui/src/styles/app.css` (`.approval*`), `ui/src/blender/blender.css` (`.bl-*`). Written from the 2026-10-05 art review (`claude/art-review/cards/`, local only). The terminal mod follows the same rules (last section).

## Anatomy, top to bottom

1. **Head: who asks, what kind.** Shield icon, `Needs your OK`, `·`, the asking bot's name (`a.agentId`, never the bot that woke it; `You, from Settings` for the Blender download you started), then the tool in a mono chip. Legion's own card kinds get plain names (Room request, Blender script, Download Blender, Download asset, Delete board item, Open web page, Script in web page). Any other tool keeps its short id (`github·create_pull_request`). The full tool id is the chip's tooltip. A Blender card adds one mode badge (LIVE, On this PC, Cloud VM). Nothing else goes in the head.
2. **Origin, only when the run was not started by you.** One muted line: `Via Zealot in Launch crew, hop 2`, `Via Zealot through the agent bridge, hop 1`, `Via an MCP client (...)`. "Via" names who started the run. The asker is already in the head.
3. **What exactly.** The exact command, path, JSON or script, in the code face (`--font-mono`, `--code-bg`), character for character. Text that Legion writes out in sentences (room requests, board delete) is prose (`--font`, `--surface-2`). Never cap the height of this box: the core caps every summary (400 chars, a room request 700), and nothing a person must read sits below a fold. A Blender script is shown in full with line numbers, wrapped and never scrolled sideways. Hidden characters are shown as `‹U+XXXX›`.
4. **Consequence.** For a risky mode, one boxed sentence in the danger tint says what saying yes does ("Runs headless Blender on this computer as you..."). Safety-check notes come after the script, in the warn tint.
5. **Answer row.** `Allow` (primary) and `Deny`, with their key caps, then at the right the faint note `Auto-denies after 10 min`. A click-only card shows no `A` cap and says why: `No shortcut allows this: read it, then press Allow.`

## Tokens (`ui/src/styles/tokens.css` only)

| Use | Token |
|---|---|
| Card surface | `--surface`, flat. No gradient wash, glow or shadow. |
| Card edge, ordinary | `--warn-line` (1 px). The head label and icon use `--warn`. |
| Card edge, risky (Blender LIVE or On this PC) | `--danger-line`. The head label and icon turn `--danger`. |
| Code box | `--code-bg` + `--line`. Prose box: `--surface-2` + `--line`. |
| Allow | `.btn.primary` (`--accent`). The accent means alive/yours. It never means "safe" or "danger". |
| Mode badge | Danger tint for LIVE and On this PC. Neutral `--line-strong` for Cloud VM (not the accent). |
| Radii | Card `--r-lg` (12), inner boxes `--r` (8), chips `--r-sm` (6). Pills (badges) are 10. |
| Type | IBM Plex Sans 12.5 (head) and 13 (prose), JetBrains Mono 12 (code) and 11.5 (tool chip). Sentence case; capitals only where the copy writes them (LIVE). |

Every border and tint has a light-theme value. A raw `rgba(...)` or hex in a card rule is a bug: it renders the dark theme's colour in the light theme (`test/approval-cards.test.ts`).

## Copy

- Second person, plain, short: "Needs your OK", "Asks first", "No shortcut allows this: read it, then press Allow."
- Say who, what and the consequence. Never "Are you sure?".
- Text written by a bot is labelled as such ("The bot's text, not checked:" / "The name below is the bot's text, not Legion's").
- Scoped claims only ("Legion's check is a filter, not a sandbox"). No absolutes. No emoji. No exclamation marks.
- The same thing has one name everywhere (On this PC / Cloud VM / LIVE; Testnet / Mainnet).

## Motion

The card enters with the thread's own `msg-in` (180 ms, `--ease`). A Blender card does not animate. No pulse, shimmer or attention loop: the agent rail badge and the mascot already say a card is waiting.

## Keyboard

- A focused card: `A` allows, `D` denies.
- Focus on the page (nothing in a field): `A` and `D` answer the first card of the open task. Only the card the keys will answer shows its key caps: the first one, or the one that holds focus. They are hidden, not removed, so the buttons never move.
- **Click-only cards** (`src/shared/approval-keys.ts`, `clickOnly`): any `blender_exec` card, `legion_get_blender` and `blender_asset_get`. No key allows them, on either path. `D` still denies.

## States

- **Pending:** the card.
- **Allowed or denied:** the card leaves at once, optimistically. If the core refuses, a toast explains why and the list reloads.
- **Unanswered:** denied after 10 minutes. The card says this up front.
- **No admin (a browser tab, or a foreign core):** the click fails with "Open the Legion app to approve or change settings". The card does not pretend.
- **BSV spends** are not answered in a card. Each request row carries a network mark (`Testnet`, `Mainnet` in live amber, or `Network unknown`, never assumed testnet). Review… opens the native dialog, which is the only place that shows the amount, address and fee.

## Never weaken

The exact command, path or script. The Blender mode and its warning. Hidden-character markers. "Auto-denies after 10 min". The click-only rule. The BSV network and the native dialog. Colour can move to a token. It cannot drop a level of risk: risky stays danger.

## In a terminal

| Desktop rule | In cells |
|---|---|
| Card | A block with a 1-cell left gutter. No box-drawing frame around the whole block, so it stays copyable. |
| Head | One line: `! Needs your OK · Builder  Bash`. `!` and the label use the warn colour (ANSI yellow / 256-colour 221). The bot name is bold. The tool is dim. |
| Risky (LIVE, On this PC) | The `!` and the label turn red (ANSI red / 203). The badge is written out in brackets: `[LIVE]`, `[On this PC]`. `[Cloud VM]` is plain. Colour is never the only signal: the word is always there. |
| Origin | A dim line: `via Zealot in Launch crew, hop 2`. |
| What exactly | Verbatim, wrapped at the terminal width, never truncated with `…`. Long commands keep every character. Hidden characters are printed as `‹U+200B›` in reverse video. A script gets a dim line-number gutter. |
| Consequence | One plain sentence after the "what" (`It runs on your computer, with your access.`), red for risky modes. |
| Answer row | `[a] Allow  [d] Deny` then dim `auto-denies in 10 min`. For a click-only card, drop `[a]` and print `Allow in the Legion app, after reading.` Where the terminal cannot answer (it points to Claude Code's dialog), say where to answer instead of showing keys. |
| Accent | Green (ANSI 120) only for "yours/alive" (Allow, your own status). Never for a safe or a dangerous state. |
| Light terminals | Use the 16 ANSI colours or test both backgrounds. Dim must stay readable (no 240-grey on white). |
| Motion | None. No spinners on a waiting card. |
