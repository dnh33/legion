/**
 * Append-only audit log of every Blender script decision: <dataDir>/blender/audit.jsonl, one JSON object per line.
 * Each line holds the script's sha256, never its text, and a hash chain (`chain` = sha256(previous chain + this entry)), so an edited or removed
 * line is detectable (verifyAudit). Legion never rewrites or shortens the file and offers no route, tool or setting that does.
 * Values are scrubbed of configured secrets before they are written.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scrubSecrets } from '../comms/scrub.js';

export type AuditDecision = 'blocked' | 'denied' | 'timeout' | 'approved' | 'backup_failed' | 'unavailable';

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
}

const GENESIS = '0'.repeat(64);
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export class AuditLog {
  readonly file: string;
  private last = GENESIS;

  constructor(dataDir: string, private readonly secrets: () => string[] = () => [], private readonly now: () => Date = () => new Date()) {
    this.file = join(dataDir, 'blender', 'audit.jsonl');
    this.last = this.tailChain();
  }

  private tailChain(): string {
    try {
      if (!existsSync(this.file)) return GENESIS;
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
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
      return { ok: true };
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) }; }
  }

  entries(limit = 200): Array<Record<string, unknown>> {
    try {
      const rows = readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-limit);
      return rows.map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch { return []; }
  }
}

/** Checks the hash chain of an audit file. */
export function verifyAudit(file: string): { ok: boolean; lines: number; badLine?: number } {
  let prev = GENESIS;
  let n = 0;
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const row of rows) {
    n++;
    let o: Record<string, unknown>;
    try { o = JSON.parse(row) as Record<string, unknown>; } catch { return { ok: false, lines: rows.length, badLine: n }; }
    const { prev: p, chain, ...body } = o;
    if (p !== prev || typeof chain !== 'string' || sha(prev + JSON.stringify(body)) !== chain) return { ok: false, lines: rows.length, badLine: n };
    prev = chain;
  }
  return { ok: true, lines: rows.length };
}
