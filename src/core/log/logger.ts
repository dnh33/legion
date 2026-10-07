/**
 * Legion's logger (plan-logging.md, PR 1: the module only, nothing calls it yet).
 *
 * One `LogSink` owns one bounded queue and one writer. `Logger.info(...)` formats the line, runs it through the
 * redactor and enqueues it; it never touches the disk and never blocks. The writer drains the queue in small batches
 * on a later tick. Four files in the log folder:
 *   legion.log  INFO and above, every component
 *   errors.log  WARN and above, every component
 *   agents.log  INFO and above from the "agents" component
 *   app.log     INFO and above from the app components (app, updater, blender, connectors)
 * A DEBUG line (only when the level is set to debug) goes to legion.log alone.
 *
 * Every line is redacted AFTER formatting and BEFORE it is queued, so nothing unredacted sits in memory or on disk.
 * Rotation is by the single writer: rename and reopen, no lock files. `closeAll()` closes every handle so the folder
 * can be deleted on Windows; `reopen()` makes the sink usable again.
 *
 * Limits: a token split across two stream chunks (see stream-wrap.ts) is not matched; if a rotation rename fails
 * (another process holds the file) the writer keeps appending, so the cap is then soft for that file.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { redact } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean;
export type LogFields = Record<string, LogValue | unknown>;

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
export const LOG_FILES = ['legion.log', 'errors.log', 'agents.log', 'app.log'] as const;
export type LogFile = (typeof LOG_FILES)[number];

export const MAX_FIELD_CHARS = 2000;
export const QUEUE_MAX = 10_000;
export const ROTATE_BYTES = 5 * 1024 * 1024;
export const ROTATE_KEEP = 3;
const BATCH_LINES = 500;
/** After a failed rotation, wait this long before trying again for that file. */
export const ROTATE_RETRY_MS = 60_000;

/** Components whose INFO+ lines also go to app.log. Everything else goes to legion.log (and errors.log) only. */
const APP_COMPONENTS = new Set(['app', 'updater', 'blender', 'connectors']);

/** Which files a line goes to. */
export function routeFor(level: LogLevel, component: string): LogFile[] {
  const files: LogFile[] = ['legion.log'];
  if (level === 'debug') return files;
  if (RANK[level] >= RANK.warn) files.push('errors.log');
  if (component === 'agents') files.push('agents.log');
  else if (APP_COMPONENTS.has(component)) files.push('app.log');
  return files;
}

/**
 * A 12-hex prefix for a digest or a transaction id. The redactor masks a bare 64-hex string (it can be a private key),
 * so a log carries this prefix instead. A value that is not at least 12 hex characters is hashed first.
 */
export function shortHash(value: string): string {
  const v = String(value).trim().toLowerCase();
  if (/^[0-9a-f]{12,}$/.test(v)) return v.slice(0, 12);
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

const ident = (s: string): string => String(s).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || '_';

function renderValue(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '"[non-finite]"';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') {
    // Redact the whole value first, then cap: a token straddling the cap must not leave an unmasked prefix. The input to
    // the redactor is bounded so a huge string cannot stall the caller; a token that starts before the cap is far shorter.
    const masked = redact(v.length > 100_000 ? v.slice(0, 100_000) : v);
    const capped = masked.length > MAX_FIELD_CHARS ? `${masked.slice(0, MAX_FIELD_CHARS)}...[truncated]` : masked;
    return JSON.stringify(capped); // one line, newlines escaped: a field cannot forge a second log line
  }
  return '"[unserialised]"'; // objects, arrays, null, undefined, functions, bigint, symbols: never serialised
}

export function formatLine(now: Date, level: LogLevel, component: string, event: string, fields?: LogFields): string {
  let line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${ident(component)} ${ident(event)}`;
  if (fields) for (const k of Object.keys(fields)) line += ` ${ident(k)}=${renderValue(fields[k])}`;
  return line;
}

interface Entry { level: number; files: LogFile[]; text: string; prev: Entry | null; next: Entry | null; gone: boolean }

export interface LogSinkOptions {
  /** Folder for the four files (`<dataDir>/logs`). Created on demand. */
  dir: string;
  /** Lowest level recorded. Default info. */
  level?: LogLevel;
  queueMax?: number;
  rotateBytes?: number;
  rotateKeep?: number;
  now?: () => Date;
  /** Rename used by rotation (injectable so a test can fail it). Default fs.renameSync. */
  rename?: (from: string, to: string) => void;
  /** How a drain is scheduled. Default setImmediate. A test passes one that never runs, to stall the writer. */
  schedule?: (fn: () => void) => void;
}

export class LogSink {
  readonly dir: string;
  private readonly minRank: number;
  private readonly queueMax: number;
  private readonly rotateBytes: number;
  private readonly rotateKeep: number;
  private readonly now: () => Date;
  private readonly schedule: (fn: () => void) => void;

  private head: Entry | null = null;
  private tail: Entry | null = null;
  private size = 0;
  /** Oldest-first lists of queued DEBUG and INFO entries, for eviction when the queue is full. */
  private readonly low: Array<{ list: Entry[]; at: number; live: number }> = [{ list: [], at: 0, live: 0 }, { list: [], at: 0, live: 0 }];
  private readonly rename: (from: string, to: string) => void;
  private readonly rotateBackoffUntil = new Map<LogFile, number>();
  private dropped = 0;
  private scheduled = false;
  private open = true;
  private readonly fds = new Map<LogFile, { fd: number; size: number }>();
  private waiters: Array<() => void> = [];
  /** Write failures swallowed (disk full, folder gone and not recreatable). Logging must never throw into a run. */
  writeErrors = 0;

  constructor(opts: LogSinkOptions) {
    this.dir = opts.dir;
    this.minRank = RANK[opts.level ?? 'info'];
    this.queueMax = opts.queueMax ?? QUEUE_MAX;
    this.rotateBytes = opts.rotateBytes ?? ROTATE_BYTES;
    this.rotateKeep = opts.rotateKeep ?? ROTATE_KEEP;
    this.rename = opts.rename ?? renameSync;
    this.now = opts.now ?? (() => new Date());
    this.schedule = opts.schedule ?? ((fn) => { setImmediate(fn); });
  }

  logger(component: string): Logger {
    return new Logger(this, component);
  }

  /** Lines waiting for the writer. */
  get queued(): number { return this.size; }
  /** Diagnostic: entries held in the DEBUG/INFO eviction lists (stays near the queue size, never the history). */
  get lowListLength(): number { return this.low[0].list.length + this.low[1].list.length; }
  /** Open file handles (0 after closeAll). */
  get openHandles(): number { return this.fds.size; }

  /** Formats, redacts and enqueues one line. Never throws, never blocks. */
  log(level: LogLevel, component: string, event: string, fields?: LogFields): void {
    const rank = RANK[level];
    if (rank === undefined || rank < this.minRank) return;
    let text: string;
    try {
      text = redact(formatLine(this.now(), level, component, event, fields));
    } catch {
      text = `${this.now().toISOString()} ${level.toUpperCase().padEnd(5)} log redaction.failed`; // fail closed: drop the content
    }
    if (this.size >= this.queueMax && !this.makeRoom(rank)) { this.dropped++; this.kick(); return; }
    const e: Entry = { level: rank, files: routeFor(level, component), text, prev: this.tail, next: null, gone: false };
    if (this.tail) this.tail.next = e; else this.head = e;
    this.tail = e;
    this.size++;
    if (rank < RANK.warn) { this.low[rank].list.push(e); this.low[rank].live++; }
    this.kick();
  }

  /** Full queue: evict the oldest DEBUG, then the oldest INFO, for an incoming WARN+. Returns false when the incoming line must be dropped. */
  private makeRoom(incoming: number): boolean {
    if (incoming < RANK.warn) return false; // a low-priority line never pushes out anything
    for (const q of this.low) {
      while (q.at < q.list.length) {
        const old = q.list[q.at++];
        if (old.gone) continue;
        this.unlink(old);
        this.dropped++;
        return true;
      }
    }
    // Only WARN/ERROR queued: drop the oldest of those rather than block.
    if (this.head) { this.unlink(this.head); this.dropped++; return true; }
    return false;
  }

  private unlink(e: Entry): void {
    e.gone = true;
    if (e.prev) e.prev.next = e.next; else this.head = e.next;
    if (e.next) e.next.prev = e.prev; else this.tail = e.prev;
    this.size--;
    if (e.level < RANK.warn) {
      const q = this.low[e.level];
      q.live--;
      // Drained or evicted entries stay in the list until compacted: keep it within twice the live count.
      if (q.list.length > 1024 && q.list.length > 2 * q.live) { q.list = q.list.filter((x) => !x.gone); q.at = 0; }
    }
  }

  private kick(): void {
    if (this.scheduled || !this.open) return;
    this.scheduled = true;
    this.schedule(() => { this.scheduled = false; this.drain(BATCH_LINES); if (this.size > 0 && this.open) this.kick(); });
  }

  /** Resolves when the queue has been written (or immediately if empty). With a stalled writer it stays pending. */
  drained(): Promise<void> {
    if (this.size === 0 && this.dropped === 0) return Promise.resolve();
    return new Promise((res) => { this.waiters.push(res); });
  }

  /** Writes the queue now, synchronously: for exit and fatal paths. A closed sink writes nothing. */
  flushSync(): void {
    this.drain(Infinity);
  }

  private drain(max: number): void {
    if (!this.open) return;
    const batch = new Map<LogFile, string[]>();
    const add = (files: LogFile[], text: string): void => {
      for (const f of files) { const a = batch.get(f); if (a) a.push(text); else batch.set(f, [text]); }
    };
    if (this.dropped > 0) {
      const n = this.dropped;
      this.dropped = 0;
      add(['legion.log', 'errors.log'], redact(`${this.now().toISOString()} WARN  log log.dropped count=${n}`));
    }
    let n = 0;
    while (this.head && n < max) {
      const e = this.head;
      this.unlink(e);
      add(e.files, e.text);
      n++;
    }
    for (const [file, lines] of batch) this.writeLines(file, lines);
    if (this.size === 0 && this.dropped === 0) { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
  }

  private handle(file: LogFile): { fd: number; size: number } | null {
    const cur = this.fds.get(file);
    if (cur) return cur;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const fd = openSync(join(this.dir, file), 'a', 0o600);
      const h = { fd, size: fstatSync(fd).size };
      this.fds.set(file, h);
      return h;
    } catch { this.writeErrors++; return null; }
  }

  private closeHandle(file: LogFile): void {
    const h = this.fds.get(file);
    if (!h) return;
    this.fds.delete(file);
    try { closeSync(h.fd); } catch { /* already closed */ }
  }

  private rotate(file: LogFile): void {
    this.closeHandle(file);
    const base = join(this.dir, file);
    try {
      // Rename only, oldest first: a rename onto an existing file replaces it, so the oldest backup is dropped only once
      // its replacement is in place. A failure part-way loses nothing that was not already due to go.
      for (let i = this.rotateKeep - 1; i >= 1; i--) if (existsSync(`${base}.${i}`)) this.rename(`${base}.${i}`, `${base}.${i + 1}`);
      this.rename(base, `${base}.1`);
    } catch {
      this.writeErrors++; // soft cap for this file: keep appending, and do not retry on every line
      this.rotateBackoffUntil.set(file, this.now().getTime() + ROTATE_RETRY_MS);
    }
  }

  private writeLines(file: LogFile, lines: string[]): void {
    let pending = '';
    const flush = (): void => {
      if (!pending) return;
      let h = this.handle(file);
      try {
        if (!h) return;
        try { writeSync(h.fd, pending); } catch {
          // the folder or file may have been deleted under us: reopen once
          this.closeHandle(file);
          h = this.handle(file);
          if (!h) return;
          writeSync(h.fd, pending);
        }
        h.size += Buffer.byteLength(pending);
      } catch { this.writeErrors++; }
      finally { pending = ''; }
    };
    for (const l of lines) {
      const text = `${l}\n`;
      const len = Buffer.byteLength(text);
      const h = this.handle(file);
      const have = (h?.size ?? 0) + Buffer.byteLength(pending);
      if (have > 0 && have + len > this.rotateBytes && this.now().getTime() >= (this.rotateBackoffUntil.get(file) ?? 0)) { flush(); this.rotate(file); }
      pending += text;
    }
    flush();
  }

  /**
   * Closes every file handle and stops writing (lines stay queued). Call before deleting the log folder: on Windows an
   * open handle makes the delete fail. Then call `reopen()`.
   */
  closeAll(): void {
    this.open = false;
    for (const f of [...this.fds.keys()]) this.closeHandle(f);
  }

  /** Drops every queued line without writing it (Clear logs: lines from before the clear must not come back). */
  clearQueue(): void {
    this.head = null; this.tail = null; this.size = 0; this.dropped = 0;
    for (const q of this.low) { q.list = []; q.at = 0; q.live = 0; }
    const w = this.waiters; this.waiters = [];
    for (const r of w) r();
  }

  /** Makes the sink usable again after `closeAll()`. Recreates the folder; queued lines are written. */
  reopen(): void {
    this.open = true;
    try { mkdirSync(this.dir, { recursive: true, mode: 0o700 }); } catch { this.writeErrors++; }
    if (this.size > 0) this.kick();
  }
}

export class Logger {
  constructor(private readonly sink: LogSink, readonly component: string) {}
  debug(event: string, fields?: LogFields): void { this.sink.log('debug', this.component, event, fields); }
  info(event: string, fields?: LogFields): void { this.sink.log('info', this.component, event, fields); }
  warn(event: string, fields?: LogFields): void { this.sink.log('warn', this.component, event, fields); }
  error(event: string, fields?: LogFields): void { this.sink.log('error', this.component, event, fields); }
}
