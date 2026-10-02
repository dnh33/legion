/**
 * The BSV audit log: append-only JSON lines under <dataDir>/bsv/audit.jsonl, hash-chained so that an edit, a deletion in the
 * middle, an insertion or a reordering is DETECTABLE (it is not preventable: the file belongs to the same user as any bot with a shell).
 *
 * Each line carries its sequence number, the hash of the previous line and its own hash: sha256(prev + "\n" + canonical(entry)).
 * `verify()` recomputes the chain. The process also remembers the head (last seq and hash) it wrote, so cutting lines off the END of
 * the file during a run is caught too (a restart forgets the head: a truncated tail across restarts is a documented residual).
 *
 * What goes in: who (agent, task), what (tool), the decision, a short reason and a few primitive, redacted fields. What never goes in:
 * a key, a seed phrase, a WIF, or free text that could forge a log line. Every string is stripped of control characters and line
 * breaks, scrubbed with the comms secret scrubber, and capped; a value that looks like a seed phrase or private key becomes
 * "[redacted-secret]"; keys that sound like secrets lose their value. Nested objects are dropped, not serialised.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findForbiddenSecret, scrubSecrets } from '../comms/scrub.js';

export const GENESIS = '0'.repeat(64);
export const AUDIT_LIMITS = { text: 200, name: 80, fields: 16, entryBytes: 4096, rotateBytes: 4 * 1024 * 1024 } as const;

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
const SECRETISH_KEY = /seed|mnemonic|wif|priv|secret|passw|passphrase|xprv|token|credential|api[_-]?key|signing/i;

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
  tamper?: { reason: string; brokenAt?: number; movedTo: string };
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
    if (!existsSync(this.file)) { this.known = true; return { ok: true }; }
    const rep = verifyText(readFileSync(this.file, 'utf8'));
    if (rep.ok) {
      if (rep.lastSeq !== null) { this.headSeq = rep.lastSeq; this.headHash = rep.lastHash!; this.firstSeq = rep.firstSeq ?? null; }
      this.known = true;
      if (rep.torn) this.sealTornTail();
      return { ok: true };
    }
    const movedTo = `${this.file}.broken-${this.now()}`;
    renameSync(this.file, movedTo);
    this.headSeq = -1; this.headHash = GENESIS; this.known = true;
    this.append({ agent: 'legion', tool: 'audit', decision: 'chain-restart', reason: `previous log failed verification: ${rep.reason ?? 'unknown'}`, fields: { brokenAt: rep.brokenAt ?? null, kept: movedTo.split(/[\\/]/).pop() } });
    return { ok: false, tamper: { reason: rep.reason ?? 'unknown', brokenAt: rep.brokenAt, movedTo } };
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
