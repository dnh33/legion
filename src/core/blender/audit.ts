/**
 * Append-only audit log of every Blender script decision and every read-only tool call: <dataDir>/blender/audit.jsonl, one JSON object per line.
 * Each line holds the script's sha256, never its text, and a hash chain (`chain` = sha256(previous chain + this entry)). Legion never rewrites
 * or shortens the file and offers no route, tool or setting that does. Values are scrubbed of configured secrets before they are written.
 *
 * What the chain can and cannot show, plainly: it is UNKEYED. It catches an edited or removed line in the MIDDLE of the file (every later
 * link breaks) and accidental damage. It cannot, alone, catch the tail being cut off, or the whole file being recomputed from the start by
 * anyone who can write it. To narrow that, the newest chain value and the line count are also kept in a second file, audit.jsonl.head, which
 * verifyAudit compares with the log: a cut-off tail or a log replaced by a shorter one no longer matches. A same-user process that rewrites BOTH
 * files consistently is not detected; nothing keyless on the same disk can detect it.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scrubSecrets } from '../comms/scrub.js';

/**
 * approved   = the user said yes; written BEFORE the script is started (a run whose approved line cannot be written does not start)
 * completed  = the outcome of an approved run (ok, summary, duration, timedOut)
 * read       = a read-only tool (inspect, screenshot, docs, status)
 */
export type AuditDecision = 'blocked' | 'denied' | 'timeout' | 'approved' | 'completed' | 'backup_failed' | 'unavailable' | 'read' | 'refused';

export interface AuditEntry {
  taskId: string;
  agentId: string;
  mode: 'live' | 'sandbox';
  hash: string;
  bytes: number;
  lines: number;
  decision: AuditDecision;
  /** Rule names that blocked the script. */
  rules?: string[];
  /** Result of an approved run. */
  ok?: boolean;
  /** First 300 characters of the result (or the reason), scrubbed. */
  summary?: string;
  durationMs?: number;
  backup?: string;
  /** Files that came back from a sandbox run. */
  files?: string[];
  /** The purpose line the agent gave, scrubbed and cut. */
  purpose?: string;
  /** Which read-only tool ('inspect' | 'screenshot' | 'docs' | 'status'). */
  tool?: string;
  /** The run hit the time limit and may still be running in Blender. */
  timedOut?: boolean;
  /** Sandbox exports that were set aside because they can carry code (.blend). */
  quarantined?: string[];
}

export interface HeadAnchor { chain: string; lines: number; at: string }
export interface AuditVerdict {
  ok: boolean;
  lines: number;
  badLine?: number;
  /** ok: matches; behind: the log is ahead by lines written after the last anchor (a crash between the two writes; fine); missing: no anchor file; mismatch: the log is shorter or different from the anchor. */
  anchor: 'ok' | 'behind' | 'missing' | 'mismatch';
  note: string;
}

const GENESIS = '0'.repeat(64);
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export class AuditLog {
  readonly file: string;
  readonly headFile: string;
  private last = GENESIS;
  private count = 0;
  /** Failed writes since start (the status view shows it). */
  failures = 0;

  constructor(dataDir: string, private readonly secrets: () => string[] = () => [], private readonly now: () => Date = () => new Date()) {
    this.file = join(dataDir, 'blender', 'audit.jsonl');
    this.headFile = headFileOf(this.file);
    this.last = this.tailChain();
  }

  private tailChain(): string {
    try {
      if (!existsSync(this.file)) return GENESIS;
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      this.count = lines.length;
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return GENESIS;
      const o = JSON.parse(lastLine) as { chain?: unknown };
      return typeof o.chain === 'string' && /^[0-9a-f]{64}$/.test(o.chain) ? o.chain : GENESIS;
    } catch { return GENESIS; }
  }

  private clean(s: string | undefined, max: number): string | undefined {
    if (s === undefined) return undefined;
    const t = scrubSecrets(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' '), { exact: this.secrets() });
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  /** Never throws: a log that cannot be written must not stop the user from working, but the failure is returned so callers can warn. */
  append(e: AuditEntry): { ok: boolean; error?: string } {
    try {
      const body: Record<string, unknown> = {
        ts: this.now().toISOString(), v: 1, ...e,
        ...(e.summary !== undefined ? { summary: this.clean(e.summary, 300) } : {}),
        ...(e.purpose !== undefined ? { purpose: this.clean(e.purpose, 200) } : {}),
      };
      const prev = this.last;
      const chain = sha(prev + JSON.stringify(body));
      const line = JSON.stringify({ ...body, prev, chain });
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, line + '\n', { encoding: 'utf8', flag: 'a', mode: 0o600 });
      if (process.platform !== 'win32') { try { chmodSync(this.file, 0o600); } catch { /* best effort */ } }
      this.last = chain;
      this.count++;
      this.writeHead();
      return { ok: true };
    } catch (err) { this.failures++; return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }

  /** Atomic (temp + rename) so a crash never leaves half an anchor. Throws; append reports it. */
  private writeHead(): void {
    const head: HeadAnchor = { chain: this.last, lines: this.count, at: this.now().toISOString() };
    const tmp = `${this.headFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(head), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.headFile);
  }

  /** Checks the chain and the head anchor. Never throws. */
  verify(): AuditVerdict { return verifyAudit(this.file); }

  entries(limit = 200): Array<Record<string, unknown>> {
    try {
      const rows = readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-limit);
      return rows.map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch { return []; }
  }
}

export const headFileOf = (file: string): string => `${file}.head`;

/** Checks the hash chain of an audit file and compares its end with the head anchor. */
export function verifyAudit(file: string): AuditVerdict {
  let prev = GENESIS;
  let n = 0;
  let rows: string[];
  try { rows = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []; } catch (e) {
    return { ok: false, lines: 0, anchor: 'mismatch', note: `The audit log cannot be read: ${e instanceof Error ? e.message : String(e)}` };
  }
  const chains: string[] = [];
  for (const row of rows) {
    n++;
    let o: Record<string, unknown>;
    try { o = JSON.parse(row) as Record<string, unknown>; } catch { return { ok: false, lines: rows.length, badLine: n, anchor: 'mismatch', note: `Line ${n} of the audit log is not valid JSON.` }; }
    const { prev: p, chain, ...body } = o;
    if (p !== prev || typeof chain !== 'string' || sha(prev + JSON.stringify(body)) !== chain) return { ok: false, lines: rows.length, badLine: n, anchor: 'mismatch', note: `The hash chain breaks at line ${n}: that line or one before it was changed or removed.` };
    prev = chain;
    chains.push(chain);
  }
  let head: HeadAnchor | null = null;
  try { if (existsSync(headFileOf(file))) head = JSON.parse(readFileSync(headFileOf(file), 'utf8')) as HeadAnchor; } catch { head = null; }
  if (!head || typeof head.chain !== 'string' || typeof head.lines !== 'number') {
    return rows.length === 0
      ? { ok: true, lines: 0, anchor: 'ok', note: 'The audit log is empty.' }
      : { ok: false, lines: rows.length, anchor: 'missing', note: 'The chain is intact, but the head anchor file is missing or unreadable, so a cut-off tail cannot be ruled out.' };
  }
  if (head.lines === 0) return { ok: rows.length === 0, lines: rows.length, anchor: rows.length === 0 ? 'ok' : 'behind', note: 'The audit log is empty.' };
  if (rows.length < head.lines || chains[head.lines - 1] !== head.chain) {
    return { ok: false, lines: rows.length, anchor: 'mismatch', note: `The head anchor says ${head.lines} lines ending in ${head.chain.slice(0, 12)}..., but the log has ${rows.length} and does not match: the end of the log was cut off or replaced.` };
  }
  if (rows.length > head.lines) return { ok: true, lines: rows.length, anchor: 'behind', note: `The log has ${rows.length - head.lines} line(s) after the last anchor (a write was interrupted); the chain is intact.` };
  return { ok: true, lines: rows.length, anchor: 'ok', note: 'The hash chain and the head anchor match. (Keyless: this does not stop a same-user process that rewrites both files.)' };
}
