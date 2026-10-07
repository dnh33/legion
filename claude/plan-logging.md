# Plan: logging (ladder items 3 and 7)

Status: **design, for agreement with the connectors session** (it owns the redactor, connectors design rev 6
section 4.4). No code in `src/bin/legion-core.ts`, the log sink or the stream wrappers until both sessions agree.
Brief: the maintainer's logging handoff (private notes, 2026-10-04/05), restated below where it decides something.

## What the owner gets
- Logs a user can paste into a chat when something breaks. **Not encrypted, on purpose**: encryption and redaction
  solve different problems. Keys stay in the keyring; a secret that leaks into a log is redacted at the writer.
- **Settings → Legion → Logs**: the folder path, one line saying what is recorded, *Open folder*, *Copy errors.log*,
  and **Clear logs**. A log a user cannot delete is a liability.
- Four files in `<dataDir>/logs/`, split by severity and component (as Hermes Agent does):

| File | Holds |
|---|---|
| `legion.log` | INFO and above, everything |
| `errors.log` | WARN and above only; what a user sends when "it broke" |
| `agents.log` | INFO and above from runs: start/finish, duration, turns, provider errors, approvals |
| `app.log` | INFO and above from the window, updater, Blender lifecycle, connectors lifecycle |

`core.log` stays as the name the splash screen, Settings and docs already point to, until a later release: it becomes
the raw stream file (see "Streams") and the UI points at the new folder.

## What is recorded, and what never is
Recorded: run start and finish (agent, provider, model, duration, turn count, outcome), provider errors with the
provider's own message, approvals (asked, answered, timed out; tool name only), updater steps, Blender lifecycle,
connector connect/disconnect/refresh outcomes (kind only), core start/stop, crashes.

**Never**: prompts, completions, tool arguments, file contents, note text, key-shaped strings, URLs with query strings,
device codes, signed log URLs. Events carry **event ids and fixed fields, not prose**, so nothing sensitive needs a field:

```ts
log.info('run.finished', { agent: 'scout', provider: 'claude', ms: 41200, turns: 7, outcome: 'ok' });
log.warn('provider.error', { agent: 'scout', provider: 'openrouter', status: 429, message: '<provider text>' });
```
Field values are typed (string | number | boolean); strings are capped at 2,000 characters; unknown objects are not
serialised.

## One sink (agreed constraint)
- `src/core/log/` exports one `Logger` (levels `debug|info|warn|error`, component, event id, fields).
- The **single `log()` in `src/bin/legion-core.ts`** becomes a thin call into that logger. There is no second writer.
- **The redactor runs inside the sink before any write**: the connectors session's redactor, built on
  `scrubSecrets` from `src/core/comms/scrub.ts` (one redactor, extended in one place: add `github_pat_`, the data key
  shape, device codes, signed-URL shapes there). Applied to the formatted line, after the fields are rendered, so a
  secret in any field or message is caught.
- **One async queue**: `log()` enqueues and returns; one writer drains the queue to the files. Logging never blocks a
  run. The queue is bounded (10,000 lines); on overflow it drops DEBUG and INFO first and writes one
  `log.dropped {count}` line, never blocks.
- On exit (`SIGINT`, `SIGTERM`, `beforeExit`, fatal) the queue is flushed synchronously, then the files are closed.

## Streams (agreed constraint)
- Core wraps **both `process.stdout.write` and `process.stderr.write`**: every chunk goes through the same redactor
  before it reaches the stream, so stray `console.log`, Node warnings and crash traces are masked too. Electron main
  sends both streams into the raw file (`stdio: ['pipe', out, out]`, `src/electron/main.ts:161`).
- `uncaughtException` and `unhandledRejection` go through `log.error` (redacted) and then the synchronous flush.
- Electron main's own direct write (`startFailureLine`, `src/electron/main.ts:448`) goes through the same redactor
  (imported, not copied) before `appendFileSync`.
- Stated limit, in `SECURITY.md` wording: a native crash (V8 fatal error or OOM) writes to the stream below Node's
  wrappers and is not masked. Legion's own code never puts secrets in URLs or error messages, so such a trace should
  not contain one.

## Rotation (disk safety)
- Each file is size-capped: rotate at 5 MB, keep 3 old files (`legion.log.1` ... `.3`), so the folder stays under
  about 80 MB. The raw stream file is capped the same way at core start.
- Rotation is done by the single writer (rename and reopen); no lock files.
- **Windows trap** (Hermes Agent: rotating handlers hold lock files until closed, so deleting the folder fails with
  WinError 32): *Clear logs* and any folder delete first ask the writer to close every handle, then delete, then
  reopen. A test reproduces the failure without the close.

## Tests (each with a demonstrated negative)
- **A token-shaped value written through every path comes out masked** (agreed constraint): `log.*` fields and
  messages, `console.log`, `process.stdout.write`, `process.stderr.write`, `uncaughtException`, `unhandledRejection`,
  and Electron main's start-failure line. Negative: bypass the redactor in one path and the test fails.
- Values covered: `sk-`, `gh[pousr]_`, `github_pat_`, `Bearer`, AWS, a private-key block, a URL with `?token=`, a WIF key.
- Rotation: writing 30 MB leaves at most 4 files per log and under the cap (proves an unbounded log cannot fill a disk).
- The queue never blocks: 50,000 lines with a stalled writer return immediately; overflow drops DEBUG/INFO first.
- Clear logs works on Windows while the writer is open (close, delete, reopen).
- Never-list: a run with a prompt containing a marker string leaves the marker in no log file.
- Product copy: no development-state words (`test/product-copy.test.ts`).

## Order
1. Agree this design with the connectors session (redactor API: `redact(line: string): string`, exported from one
   place; who adds the new shapes).
2. Logger, queue, files, rotation, tests (no change to `legion-core.ts` yet).
3. Swap `log()` and the stream wrappers onto the logger, with the connectors session, in one PR.
4. Event calls at the recorded points (runs, approvals, updater, Blender, connectors).
5. Settings → Logs UI, clear button, docs (`docs/ARCHITECTURE.md`, `SECURITY.md` limit line), real-PC check
   (Windows clear while open, paste-ability).

## Open questions for the connectors session
1. Does the redactor live in `scrub.ts` (extended) or a new `src/core/log/redact.ts` that calls `scrubSecrets`? I
   propose the latter, so the log path can add log-only shapes (device codes, signed URLs) without changing what
   transcripts scrub.
2. The stream wrappers: installed by the logger module at core start, before any other module loads; agreed?
3. Your `KEY <base64>` stdin line: the data key value is passed to the redactor's exact-value list so it can never be
   logged even if a caller mistakes it for text. Agreed?
