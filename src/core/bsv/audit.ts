/**
 * The BSV audit log: append-only JSON lines under <dataDir>/bsv/audit.jsonl, hash-chained so that an edit, a deletion in the
 * middle, an insertion or a reordering is DETECTABLE (it is not preventable: the file belongs to the same user as any bot with a shell).
 *
 * Each line carries its sequence number, the hash of the previous line and its own hash: sha256(prev + "\n" + canonical(entry)).
 * `verify()` recomputes the chain. The process also remembers the head (last seq and hash) it wrote, so cutting lines off the END of
 * the file during a run is caught too. Across restarts the head is kept in a small anchor file next to the log (`audit.jsonl.head`,
 * written after every append): a log that ends earlier than the anchor says, was emptied, or ends in a different entry is reported on the
 * next open (the chain carries on and says so in its own first line). The anchor is a second copy of one hash, not a vault: a program that
 * can write both files can still rewrite both, and that is a documented residual.
 *
 * What goes in: who (agent, task), what (tool), the decision, a short reason and a few primitive, redacted fields. What never goes in:
 * a key, a seed phrase, a WIF, or free text that could forge a log line. Every string is stripped of control characters and line
 * breaks, scrubbed with the comms secret scrubber, and capped; a value that looks like a seed phrase or private key becomes
 * "[redacted-secret]"; keys that sound like secrets lose their value. Nested objects are dropped, not serialised.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { findForbiddenSecret, scrubSecrets } from '../comms/scrub.js';

export const GENESIS = '0'.repeat(64);
export const AUDIT_LIMITS = { text: 200, name: 80, fields: 16, entryBytes: 4096, rotateBytes: 4 * 1024 * 1024, scanFiles: 64, scanFileBytes: 8 * 1024 * 1024, scanBytes: 48 * 1024 * 1024 } as const;

export type AuditValue = string | number | boolean | null;

export interface AuditInput {
  /** Who acted: an agent id, or 'owner' for something done through the app window. */
  agent: string;
  task?: string;
  tool: string;
  decision: string;
  reason?: string;
  fields?: Record<string, unknown>;
}

export interface AuditEntry {
  v: 1;
  seq: number;
  ts: string;
  prev: string;
  agent: string;
  task: string | null;
  tool: string;
  decision: string;
  reason: string | null;
  fields: Record<string, AuditValue>;
  hash: string;
}

export interface VerifyReport {
  ok: boolean;
  entries: number;
  firstSeq?: number | null;
  lastSeq: number | null;
  lastHash: string | null;
  /** Sequence number (or line number when unreadable) of the first bad entry. */
  brokenAt?: number;
  reason?: string;
  /** The last line is cut off mid-write (a crash). Reported, not treated as tampering. */
  torn?: boolean;
}

// ------------------------------------------------------------------ redaction

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g;
const SECRETISH_KEY = new RegExp('seed|mnemonic|wif|priv|secret|passw|passphrase|xprv|token|credential|api[_-]?key|signing', 'i');

/** One line of safe text: no control or bidi characters, no line breaks, secrets scrubbed, capped. */
export function safeText(v: unknown, max: number = AUDIT_LIMITS.text): string {
  let s = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
  if (findForbiddenSecret(s)) return '[redacted-secret]';
  s = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  s = scrubSecrets(s, { keepHex: true }); // txids are 64 hex and stay readable; labelled keys and tokens are redacted
  if (findForbiddenSecret(s)) return '[redacted-secret]';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** An identifier (agent, task, tool, decision): a conservative character set, so it cannot carry a forged field or a second line. */
export function safeId(v: unknown, max: number = AUDIT_LIMITS.name): string {
  const s = typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
  const cleaned = s.replace(/[^A-Za-z0-9._:/@#-]/g, '?').slice(0, max);
  return findForbiddenSecret(s) ? '[redacted-secret]' : cleaned;
}

/** Primitive fields only, redacted. Anything nested or oddly named is dropped (and counted). */
export function redactFields(fields: Record<string, unknown> | undefined): Record<string, AuditValue> {
  const out: Record<string, AuditValue> = {};
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out;
  let dropped = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (Object.keys(out).length >= AUDIT_LIMITS.fields) { dropped++; continue; }
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) || k === 'dropped') { dropped++; continue; }
    if (SECRETISH_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    if (typeof v === 'string') out[k] = safeText(v);
    else if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === 'boolean' || v === null) out[k] = v;
    else dropped++;
  }
  if (dropped) out.dropped = dropped;
  return out;
}

// ------------------------------------------------------------------ the chain

/** The exact text that is hashed: fixed key order, sorted field keys, so a re-serialisation by any tool gives the same bytes. */
export function canonical(e: Omit<AuditEntry, 'hash'>): string {
  const fields: Record<string, AuditValue> = {};
  for (const k of Object.keys(e.fields).sort()) fields[k] = e.fields[k]!;
  return JSON.stringify({ v: e.v, seq: e.seq, ts: e.ts, agent: e.agent, task: e.task, tool: e.tool, decision: e.decision, reason: e.reason, fields });
}

export const entryHash = (e: Omit<AuditEntry, 'hash'>): string => createHash('sha256').update(e.prev + '\n' + canonical(e)).digest('hex');

const HEX64 = /^[0-9a-f]{64}$/;
const isEntry = (j: unknown): j is AuditEntry => {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
  const e = j as Record<string, unknown>;
  return e.v === 1 && Number.isSafeInteger(e.seq) && (e.seq as number) >= 0 && typeof e.ts === 'string' && typeof e.prev === 'string' && HEX64.test(e.prev)
    && typeof e.agent === 'string' && (e.task === null || typeof e.task === 'string') && typeof e.tool === 'string' && typeof e.decision === 'string'
    && (e.reason === null || typeof e.reason === 'string') && !!e.fields && typeof e.fields === 'object' && !Array.isArray(e.fields) && typeof e.hash === 'string' && HEX64.test(e.hash);
};

/** Parses a log's text and checks the chain. Pure: also used by tests on hand-made files. */
export function verifyText(text: string): VerifyReport & { parsed: AuditEntry[] } {
  const parsed: AuditEntry[] = [];
  const fail = (brokenAt: number, reason: string, extra: Partial<VerifyReport> = {}) => ({
    ok: false, entries: parsed.length, lastSeq: parsed.length ? parsed[parsed.length - 1]!.seq : null, lastHash: parsed.length ? parsed[parsed.length - 1]!.hash : null, brokenAt, reason, parsed, ...extra,
  });
  if (!text) return { ok: true, entries: 0, lastSeq: null, lastHash: null, parsed };
  const endsClean = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsClean) lines.pop();
  let torn = false;
  let prev: string | null = null;
  let prevSeq: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isLast = i === lines.length - 1;
    let j: unknown;
    try { j = JSON.parse(line); } catch { j = undefined; }
    if (!isEntry(j)) {
      if (isLast && !endsClean) { torn = true; break; } // a half-written last line: a crash, not an attack
      return fail(i + 1, 'unreadable or malformed line');
    }
    const { hash, ...rest } = j;
    if (prev === null) {
      if (j.seq === 0 && j.prev !== GENESIS) return fail(j.seq, 'first entry does not start at the genesis hash');
    } else {
      if (j.seq !== (prevSeq as number) + 1) return fail(j.seq, 'sequence gap, repeat or reorder');
      if (j.prev !== prev) return fail(j.seq, 'previous-hash link broken (a line was edited, removed, inserted or reordered)');
    }
    if (entryHash(rest) !== hash) return fail(j.seq, 'entry hash does not match its content (the line was edited)');
    parsed.push(j);
    prev = hash; prevSeq = j.seq;
  }
  return { ok: true, entries: parsed.length, firstSeq: parsed.length ? parsed[0]!.seq : null, lastSeq: prevSeq, lastHash: prev, parsed, ...(torn ? { torn: true } : {}) };
}

export interface AuditLogOptions {
  /** Wall clock in ms (injectable for tests). */
  now?: () => number;
  rotateBytes?: number;
}

export interface OpenResult {
  /** The chain on disk was intact (or there was none). */
  ok: boolean;
  /** When it was not: what was wrong and where the evidence was moved to (the log carries on in a fresh file). */
  tamper?: { reason: string; brokenAt?: number; /** The evidence file, when the log itself was moved aside (a broken chain). Not set when only the head anchor disagreed. */ movedTo?: string };
}

export class AuditLog {
  private headSeq = -1;
  private headHash = GENESIS;
  /** True once this process has read or written the head: only then is a missing tail a tamper signal. */
  private known = false;
  /** Sequence number of the first entry in the current file, as this process last saw it (the start of a log cannot be cut off unnoticed). */
  private firstSeq: number | null = null;

  constructor(readonly file: string, private readonly o: AuditLogOptions = {}) {}

  private now(): number { return (this.o.now ?? Date.now)(); }

  /**
   * Reads the existing log. An intact chain is continued; a broken one is moved aside (kept as evidence, never deleted) and a fresh
   * file starts with a `chain-restart` entry that says so. The caller (the module) freezes the policy engine on `tamper`.
   */
  open(): OpenResult {
    mkdirSync(dirname(this.file), { recursive: true });
    const text = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
    const rep = verifyText(text);
    if (!rep.ok) {
      const movedTo = `${this.file}.broken-${this.now()}`;
      renameSync(this.file, movedTo);
      this.headSeq = -1; this.headHash = GENESIS; this.known = true; this.firstSeq = null;
      this.append({ agent: 'legion', tool: 'audit', decision: 'chain-restart', reason: `previous log failed verification: ${rep.reason ?? 'unknown'}`, fields: { brokenAt: rep.brokenAt ?? null, kept: movedTo.split(/[\\/]/).pop() } });
      return { ok: false, tamper: { reason: rep.reason ?? 'unknown', brokenAt: rep.brokenAt, movedTo } };
    }
    // The chain in the file is intact (or there is none). Where does it end, and is that where the anchor says it should?
    let tail: { seq: number; hash: string } | null = rep.lastSeq !== null ? { seq: rep.lastSeq, hash: rep.lastHash! } : null;
    // an empty file is what rotation leaves behind: the head is then the last entry of the newest archive
    if (!tail) tail = this.newestArchiveHead();
    const anchor = this.readAnchor();
    let problem: string | undefined;
    if (anchor.state === 'bad') problem = 'the head anchor file could not be read';
    else if (anchor.state === 'missing') { if (tail) problem = 'the head anchor file is missing although the log has entries'; }
    else if (!tail) problem = `the log is missing or empty, but the head anchor records entries up to ${anchor.seq}`;
    else if (tail.seq < anchor.seq) problem = `the log ends at entry ${tail.seq}, but the head anchor records ${anchor.seq}: the end of the log was cut off`;
    else if (tail.seq === anchor.seq && tail.hash !== anchor.hash) problem = `the last entry of the log is not the one the head anchor records (entry ${anchor.seq} was replaced)`;
    else if (tail.seq > anchor.seq && !this.holds(rep.parsed, anchor.seq, anchor.hash)) problem = `the entry the head anchor records (${anchor.seq}) is not in the log`;

    if (tail) { this.headSeq = tail.seq; this.headHash = tail.hash; this.firstSeq = rep.lastSeq !== null ? (rep.firstSeq ?? null) : null; }
    this.known = true;
    if (rep.torn) this.sealTornTail();
    if (!problem) { if (anchor.state !== 'ok' || !tail || tail.seq !== anchor.seq) this.writeAnchor(); return { ok: true }; }
    // the log carries on from what is on disk, and its own next line says what was found (the evidence is the line plus the anchor values)
    this.append({ agent: 'legion', tool: 'audit', decision: 'head-mismatch', reason: problem, fields: { anchorSeq: anchor.state === 'ok' ? anchor.seq : null, fileSeq: tail?.seq ?? null } });
    return { ok: false, tamper: { reason: problem, brokenAt: tail ? tail.seq + 1 : 0 } };
  }

  // ---- the head anchor: one small file, written after every append (never before, so a crash mid-append cannot look like a cut)
  private get anchorFile(): string { return `${this.file}.head`; }

  private readAnchor(): { state: 'ok'; seq: number; hash: string } | { state: 'missing' } | { state: 'bad' } {
    if (!existsSync(this.anchorFile)) return { state: 'missing' };
    try {
      const j = JSON.parse(readFileSync(this.anchorFile, 'utf8')) as { v?: unknown; seq?: unknown; hash?: unknown };
      if (j && j.v === 1 && Number.isSafeInteger(j.seq) && (j.seq as number) >= 0 && typeof j.hash === 'string' && HEX64.test(j.hash)) return { state: 'ok', seq: j.seq as number, hash: j.hash };
    } catch { /* falls through */ }
    return { state: 'bad' };
  }

  private writeAnchor(): void {
    if (this.headSeq < 0) return;
    try {
      const tmp = `${this.anchorFile}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify({ v: 1, seq: this.headSeq, hash: this.headHash }), { mode: 0o600 });
      renameSync(tmp, this.anchorFile);
      try { chmodSync(this.anchorFile, 0o600); } catch { /* not supported everywhere */ }
    } catch { /* the next append writes it again; a missing anchor is reported at the next open */ }
  }

  /** Does the log hold entry `seq` with this hash? The entry may be in the file, or be the last line of the newest archive (a rotation just happened). */
  private holds(entries: readonly AuditEntry[], seq: number, hash: string): boolean {
    if (entries.some((e) => e.seq === seq && e.hash === hash)) return true;
    const a = this.newestArchiveHead();
    return !!a && a.seq === seq && a.hash === hash;
  }

  /** The files rotated out of the log, newest (highest sequence number) first. */
  private archives(): string[] {
    try {
      const base = basename(this.file);
      const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(\\d{1,12})$');
      return readdirSync(dirname(this.file)).map((n) => ({ n, m: re.exec(n) })).filter((x): x is { n: string; m: RegExpExecArray } => !!x.m)
        .sort((a, b) => Number(b.m[1]) - Number(a.m[1])).map((x) => join(dirname(this.file), x.n));
    } catch { return []; }
  }

  private newestArchiveHead(): { seq: number; hash: string } | null {
    for (const f of this.archives().slice(0, 3)) {
      try {
        const r = verifyText(readFileSync(f, 'utf8'));
        if (r.ok && r.lastSeq !== null) return { seq: r.lastSeq, hash: r.lastHash! };
      } catch { /* try the next one */ }
    }
    return null;
  }

  /** Every file that can hold audit lines: the log, its archives, and the evidence of broken chains, newest first. */
  private allFiles(): string[] {
    const dir = dirname(this.file);
    let broken: Array<{ f: string; t: number }> = [];
    try {
      const re = new RegExp('^' + basename(this.file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.broken-(\\d{1,16})$');
      broken = readdirSync(dir).map((n) => ({ n, m: re.exec(n) })).filter((x): x is { n: string; m: RegExpExecArray } => !!x.m).map((x) => ({ f: join(dir, x.n), t: Number(x.m[1]) }));
    } catch { /* no directory yet */ }
    broken.sort((a, b) => b.t - a.t);
    return [this.file, ...this.archives(), ...broken.map((b) => b.f)].slice(0, AUDIT_LIMITS.scanFiles);
  }

  /**
   * Entries of ALL the log's files (current, rotated, and kept evidence of a broken chain), read leniently: a line that parses as an
   * entry counts, whether or not the chain around it verifies (a forged extra line can only make a limit stricter). Bounded in bytes and
   * files. Sorted by the time written in the entry, oldest first, not by where the line sits in a file. `sinceMs` drops older entries.
   */
  entries(filter: (e: AuditEntry) => boolean = () => true, sinceMs = 0): AuditEntry[] {
    const seen = new Set<string>();
    const out: AuditEntry[] = [];
    let budget = AUDIT_LIMITS.scanBytes;
    for (const f of this.allFiles()) {
      if (budget <= 0) break;
      let text = '';
      try {
        const size = statSync(f).size;
        const take = Math.min(size, AUDIT_LIMITS.scanFileBytes, budget);
        const fd = openSync(f, 'r');
        try { const b = Buffer.alloc(take); readSync(fd, b, 0, take, size - take); text = b.toString('utf8'); } finally { closeSync(fd); }
        budget -= take;
        if (take < size) text = text.slice(text.indexOf('\n') + 1); // the first line of a window is cut: drop it
      } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let j: unknown;
        try { j = JSON.parse(line); } catch { continue; }
        if (!isEntry(j) || seen.has(j.hash)) continue;
        seen.add(j.hash);
        const at = Date.parse(j.ts);
        if (sinceMs && !(at >= sinceMs)) continue;
        if (filter(j)) out.push(j);
      }
    }
    return out.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || a.seq - b.seq);
  }

  /**
   * Like `entries`, but only from files whose hash chain verifies in full (a file that is too large to read whole, unreadable, or broken
   * contributes nothing; the current file must also end where this process left it). Use this, never `entries`, for anything that CLEARS or
   * RELAXES a state (such as an unknown outcome): the lenient reader may only ever add blocks, because a forged line in a broken file
   * must not be able to say "this was resolved".
   */
  verifiedEntries(filter: (e: AuditEntry) => boolean = () => true, sinceMs = 0): AuditEntry[] {
    const seen = new Set<string>();
    const out: AuditEntry[] = [];
    let budget = AUDIT_LIMITS.scanBytes;
    for (const f of this.allFiles()) {
      if (budget <= 0) break;
      let text = '';
      try {
        const size = statSync(f).size;
        if (size > AUDIT_LIMITS.scanFileBytes || size > budget) continue; // cannot verify what is not read whole
        text = readFileSync(f, 'utf8');
        budget -= size;
      } catch { continue; }
      const rep = verifyText(text);
      if (!rep.ok) continue;
      if (f === this.file && this.known && this.headSeq >= 0 && rep.entries > 0 && (rep.lastSeq !== this.headSeq || rep.lastHash !== this.headHash)) continue;
      for (const j of rep.parsed) {
        if (seen.has(j.hash)) continue;
        seen.add(j.hash);
        if (sinceMs && !(Date.parse(j.ts) >= sinceMs)) continue;
        if (filter(j)) out.push(j);
      }
    }
    return out.sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0) || a.seq - b.seq);
  }

  /** A torn last line stays in the file (it is evidence of a crash) but the next entry must start on a new line. */
  private sealTornTail(): void {
    try { appendFileSync(this.file, '\n', { mode: 0o600 }); } catch { /* the next append retries the newline check */ }
  }

  /** Appends one entry. Synchronous (one write call), so two callers in one process can never interleave. Never throws for a bad value: it redacts. */
  append(input: AuditInput): AuditEntry {
    if (!this.known) this.open();
    const decision = safeId(input.decision, 32).toLowerCase() || 'unknown';
    const partial: Omit<AuditEntry, 'hash'> = {
      v: 1, seq: this.headSeq + 1, ts: new Date(this.now()).toISOString(), prev: this.headHash,
      agent: safeId(input.agent) || 'unknown', task: input.task ? safeId(input.task) : null, tool: safeId(input.tool) || 'unknown', decision,
      reason: input.reason ? safeText(input.reason) : null, fields: redactFields(input.fields),
    };
    let entry: AuditEntry = { ...partial, hash: entryHash(partial) };
    // a line must stay small; trim the fields before giving up the reason
    if (JSON.stringify(entry).length > AUDIT_LIMITS.entryBytes) {
      const slim: Omit<AuditEntry, 'hash'> = { ...partial, fields: { trimmed: true }, reason: partial.reason ? partial.reason.slice(0, 120) : null };
      entry = { ...slim, hash: entryHash(slim) };
    }
    this.rotateIfLarge();
    let line = JSON.stringify(entry) + '\n';
    try {
      // if the file does not end with a newline (a torn write, or a foreign append), start on a fresh line
      if (lastByte(this.file) !== undefined && lastByte(this.file) !== 0x0a) line = '\n' + line;
    } catch { /* the append below reports the real problem */ }
    appendFileSync(this.file, line, { mode: 0o600 });
    this.headSeq = entry.seq; this.headHash = entry.hash;
    if (this.firstSeq === null) this.firstSeq = entry.seq;
    this.writeAnchor();
    return entry;
  }

  private rotateIfLarge(): void {
    const limit = this.o.rotateBytes ?? AUDIT_LIMITS.rotateBytes;
    try {
      if (!existsSync(this.file) || statSync(this.file).size < limit) return;
      renameSync(this.file, `${this.file}.${this.headSeq}`);
      this.firstSeq = null;
      writeFileSync(this.file, '', { mode: 0o600 }); // the chain continues: the next entry's prev is the last hash of the archived file
    } catch { /* keep appending to the same file rather than lose the entry */ }
  }

  /** Re-reads the file and checks the chain, and (after this process has written) that the tail is still where it left it. */
  verify(): VerifyReport {
    const text = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
    const { parsed: _p, ...rep } = verifyText(text);
    if (!rep.ok) return rep;
    if (this.known && this.headSeq >= 0 && (rep.lastSeq !== this.headSeq || rep.lastHash !== this.headHash)) {
      return { ...rep, ok: false, brokenAt: (rep.lastSeq ?? -1) + 1, reason: 'the end of the log is not where this process left it (lines were cut off or added from outside)' };
    }
    if (this.known && this.firstSeq !== null && rep.firstSeq !== this.firstSeq) {
      return { ...rep, ok: false, brokenAt: rep.firstSeq ?? this.firstSeq, reason: 'the start of the log is not where this process saw it (early lines were removed or the file was replaced)' };
    }
    return rep;
  }

  /** Newest first. `before` is a sequence number (exclusive) for paging. Also returns the chain check. */
  read(opts: { limit?: number; before?: number } = {}): { entries: AuditEntry[]; verify: VerifyReport; total: number } {
    const text = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
    const rep = verifyText(text);
    const verify = this.verify();
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500);
    let list = rep.parsed;
    if (opts.before !== undefined && Number.isFinite(opts.before)) list = list.filter((e) => e.seq < opts.before!);
    return { entries: list.slice(-limit).reverse(), verify, total: rep.entries };
  }

  get head(): { seq: number; hash: string } { return { seq: this.headSeq, hash: this.headHash }; }
}

/** The last byte of a file (undefined when it is missing or empty), read without loading the file. */
function lastByte(file: string): number | undefined {
  try {
    const size = statSync(file).size;
    if (size === 0) return undefined;
    const fd = openSync(file, 'r');
    try { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, size - 1); return b[0]; } finally { closeSync(fd); }
  } catch { return undefined; }
}

export function auditPath(dataDir: string): string { return join(dataDir, 'bsv', 'audit.jsonl'); }
