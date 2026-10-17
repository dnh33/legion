/**
 * The skill finder's optional rerank: a small Haiku model that picks the best skills when the top scores are close together.
 *
 * One warm session per armory module (`RerankSession`): a streaming-input query that stays open, so a request costs about a second
 * instead of the 2.6 s a fresh Claude Code start takes. The session has no tools, no settings from disk, no hooks and its own short
 * system prompt. It returns ids only, and an id that is not in the candidate set is dropped. Third-party descriptions may be in the
 * prompt, because nothing from the answer goes back except ids that were already listed.
 *
 * Any failure keeps the fused order: a bad answer, a deadline, a busy or cold session, a spent cap, an error. The cost goes into the
 * month's spend in `<dataDir>/skill-finder/spend.json` (`{ "YYYY-MM": usd }`): an estimate is reserved before each request and
 * replaced by the real cost when the result arrives. A request that is abandoned or killed keeps its reservation.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { oneLine } from '../../kg/text.js';
import {
  BM25_MIN_SPREAD, RERANK_BACKOFF_MS, RERANK_DEADLINE_MS, RERANK_DESC_CHARS, RERANK_FAILS_BEFORE_BACKOFF, RERANK_HARD_MS, RERANK_IDLE_MS,
  RERANK_MARGIN, RERANK_RECYCLE_AFTER, RERANK_RESERVE_USD, RERANK_TEXT_CHARS, RERANK_WARM_MS,
} from './defaults.js';
import type { Ranked } from './rank.js';

/** The slice of the SDK's query that the rerank uses. A test passes a fake. */
export type RerankQuery = (a: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => AsyncIterable<unknown> & { close?: () => void };

export interface RerankCandidate { id: string; description: string }

/** What the session needs to start a child: the same environment and settings as the handshake's, and the owner's executable. */
export interface RerankLaunch {
  env: Record<string, string | undefined>;
  settings?: Record<string, unknown>;
  executablePath?: string;
}

/** The session's own system prompt: it is told what it is, and that no message depends on an earlier one. */
export const RERANK_SYSTEM_PROMPT = 'You rank skills for a request. Each message is a new request, unrelated to earlier ones. Answer with a JSON array of skill ids only.';

/** The margin test on the scores, best first: the top one against the third (or the last one, with fewer than three). */
export function isCloseMatch(scores: readonly number[], margin = RERANK_MARGIN): boolean {
  if (scores.length < 2) return false;
  return scores[0]! - scores[Math.min(2, scores.length - 1)]! <= margin;
}

/**
 * The scores the margin test reads, in the same order as `results`. A fused score is already 0..1. A keyword score is normalised
 * the way the fused score normalises BM25 (divided by the best BM25 of the candidates, not stretched below BM25_MIN_SPREAD), with
 * the boost kept: the fused formula at weight 0.
 */
export function rerankScores(results: readonly Ranked[], fused: boolean, best: number): number[] {
  if (fused) return results.map((r) => r.score);
  const top = Math.max(best, BM25_MIN_SPREAD);
  return results.map((r) => (r.bm25 / top) * r.boost);
}

/** The text the model reads: the message, one line per candidate, then the instruction. */
export function buildRerankPrompt(text: string, candidates: readonly RerankCandidate[], k: number): string {
  const lines = candidates.map((c) => `${c.id}: ${oneLine(c.description).slice(0, RERANK_DESC_CHARS).trimEnd()}`);
  return [
    text.slice(0, RERANK_TEXT_CHARS),
    '',
    ...lines,
    '',
    `Return only the ids that clearly fit, best first, at most ${Math.max(1, Math.min(5, Math.floor(k)))}. Return [] if none fit. Ids only.`,
  ].join('\n');
}

/**
 * The answer's ids. The trimmed text must be a JSON array of strings, or one fenced code block holding such an array; anything else
 * is invalid (undefined: the fused order stands). Ids outside the candidate set are dropped, duplicates are dropped, and the rest
 * are cut to k. An empty array is a real answer (no skill fits). A non-empty array with no known id is a forged answer: invalid.
 */
export function parseRerankAnswer(text: string, candidateIds: readonly string[], k: number): string[] | undefined {
  let body = text.trim();
  const fence = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(body);
  if (fence) body = fence[1]!.trim();
  if (!body.startsWith('[') || !body.endsWith(']')) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { return undefined; }
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) return undefined;
  if (raw.length === 0) return [];
  const known = new Set(candidateIds);
  const out: string[] = [];
  for (const id of raw as string[]) if (known.has(id) && !out.includes(id)) out.push(id);
  if (out.length === 0) return undefined;
  return out.slice(0, Math.max(1, Math.min(5, Math.floor(k))));
}

/** The spend file's path. */
export function spendFilePath(dataDir: string): string {
  return join(dataDir, 'skill-finder', 'spend.json');
}

/** Spend by month, as stored. A missing or damaged file is no spend. */
export function readSpend(dataDir: string): Record<string, number> {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(spendFilePath(dataDir), 'utf8')); } catch { return {}; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [month, usd] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof usd === 'number' && Number.isFinite(usd) && usd >= 0) out[month] = usd;
  }
  return out;
}

/** The local month as YYYY-MM. */
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Adds `usd` (may be negative, to replace a reservation by the real cost) to a month, never below zero. Atomic: a crash mid-write
 * leaves the old file. A failed write is ignored, so a disk error means the change is not counted toward the cap.
 */
function addSpend(dataDir: string, month: string, usd: number): void {
  const spent = readSpend(dataDir);
  spent[month] = Math.max(0, (spent[month] ?? 0) + usd);
  const path = spendFilePath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, JSON.stringify(spent, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* leave it */ }
  }
}



export interface RerankSessionOpts {
  dataDir: string;
  /** The child's environment and settings. Undefined (no config) means no rerank: the full process environment is never used. */
  launch: () => RerankLaunch | undefined;
  queryFn?: RerankQuery;
  /** One line per failure, never with prompt text. */
  log?: (m: string) => void;
  now?: () => Date;
  /** Timings and limits. The defaults are in defaults.ts; tests shorten them. */
  deadlineMs?: number;
  hardMs?: number;
  warmMs?: number;
  idleMs?: number;
  recycleAfter?: number;
  backoffMs?: number;
  failsBeforeBackoff?: number;
  reserveUsd?: number;
}

export interface RerankAsk {
  /** The message to rank. Cut to RERANK_TEXT_CHARS. */
  text: string;
  /** The top candidates, best first (the caller passes at most RERANK_CANDIDATES). */
  candidates: RerankCandidate[];
  /** How many ids to keep, 1 to 5. */
  k: number;
  /** The owner's monthly cap for reranking, in US dollars. */
  monthlyUsd: number;
}

interface Pending {
  kind: 'warm' | 'rank';
  month: string;
  abandoned: boolean;
  settle: (text: string | undefined) => void;
  deadline?: NodeJS.Timeout;
  ceiling?: NodeJS.Timeout;
}

interface Live {
  q: ReturnType<RerankQuery>;
  ac: AbortController;
  closed: boolean;
  ready: boolean;
  /** The cumulative cost the last result carried (0 for a new session). */
  lastTotal: number;
  pending?: Pending;
  served: number;
  said: string;
  inbox: SDKUserMessage[];
  wake?: () => void;
  ended: boolean;
  idle?: NodeJS.Timeout;
}

/**
 * The warm rerank session. It starts in the background on the first turn that wants a rerank (that turn keeps the fused order) and
 * answers a warm-up message before it takes requests. It serves one request at a time: a turn that finds it busy or still warming
 * keeps the fused order, and nothing is queued. A request that misses the deadline is abandoned and its answer, if it comes, is
 * dropped; the session stays busy until that result arrives or the hard ceiling closes it. It is closed after `recycleAfter`
 * reranks, after `idleMs` without one, on `close()`, and on any error. After `failsBeforeBackoff` failures in a row (an error or an invalid answer; a timeout does not count) no session starts
 * for `backoffMs`.
 */
export class RerankSession {
  private live: Live | undefined;
  private failures = 0;
  private backoffUntil = 0;
  private lastReason: string | undefined;
  private disposed = false;

  constructor(private readonly o: RerankSessionOpts) {}

  private now(): Date { return (this.o.now ?? (() => new Date()))(); }
  private note(reason: string): void {
    if (reason === this.lastReason) return;
    this.lastReason = reason;
    try { this.o.log?.(`finder: rerank skipped (${reason})`); } catch { /* a log failure is not a rerank failure */ }
  }

  /** 'none' (no session), 'warming' (started, not yet answered) or 'ready'. For tests. */
  state(): 'none' | 'warming' | 'ready' {
    return !this.live ? 'none' : this.live.ready ? 'ready' : 'warming';
  }

  /** The ids to use, best first, or undefined to keep the fused order. Never rejects. */
  async pick(a: RerankAsk): Promise<string[] | undefined> {
    try {
      if (this.disposed || a.candidates.length === 0) return undefined;
      if (this.now().getTime() < this.backoffUntil) return undefined;
      const live = this.live;
      if (!live) { this.start(a.monthlyUsd); return undefined; }
      if (!live.ready || live.pending) return undefined;
      const month = this.reserve(a.monthlyUsd);
      if (!month) return undefined;
      const text = await this.send(live, 'rank', buildRerankPrompt(a.text, a.candidates, a.k), month, this.o.deadlineMs ?? RERANK_DEADLINE_MS);
      if (text === undefined) return undefined;
      const ids = parseRerankAnswer(text, a.candidates.map((c) => c.id), a.k);
      if (ids === undefined) { this.note('unusable answer'); this.failed(); } else { this.failures = 0; this.lastReason = undefined; }
      return ids;
    } catch {
      this.note('error');
      return undefined;
    }
  }

  /** Closes the session and its child. A request in flight keeps its reservation. The next turn may start a new session. */
  close(): void {
    if (this.live) this.closeLive(this.live);
  }

  /** Closes the session for good: no later turn starts a CLI. For module dispose. */
  dispose(): void {
    this.disposed = true;
    this.close();
  }

  /** Reserves the estimate in the month's spend. Undefined when the month would pass the cap. */
  private reserve(monthlyUsd: number): string | undefined {
    const month = monthKey(this.now());
    const spent = readSpend(this.o.dataDir)[month] ?? 0;
    const est = this.o.reserveUsd ?? RERANK_RESERVE_USD;
    if (spent + est > monthlyUsd) { this.note('monthly cap'); return undefined; }
    addSpend(this.o.dataDir, month, est);
    return month;
  }

  private start(monthlyUsd: number): void {
    if (this.disposed) return;
    const launch = this.o.launch();
    if (!launch) return;
    const month = this.reserve(monthlyUsd);
    if (!month) return;
    const ac = new AbortController();
    const options: Record<string, unknown> = {
      model: 'haiku',
      tools: [],
      systemPrompt: RERANK_SYSTEM_PROMPT,
      cwd: tmpdir(),
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      settings: { ...(launch.settings ?? {}), disableAllHooks: true },
      env: launch.env,
      ...(launch.executablePath ? { pathToClaudeCodeExecutable: launch.executablePath } : {}),
      abortController: ac,
    };
    const live = { closed: false, ready: false, lastTotal: 0, served: 0, said: '', inbox: [], ended: false, ac } as unknown as Live;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        if (live.inbox.length) { yield live.inbox.shift()!; continue; }
        if (live.ended) return;
        await new Promise<void>((res) => { live.wake = res; });
      }
    }
    try {
      live.q = (this.o.queryFn ?? (realQuery as unknown as RerankQuery))({ prompt: input(), options });
    } catch {
      addSpend(this.o.dataDir, month, -(this.o.reserveUsd ?? RERANK_RESERVE_USD));
      this.note('error');
      this.failed();
      return;
    }
    this.live = live;
    void this.read(live);
    void this.send(live, 'warm', 'Warm-up. Answer with [].', month, this.o.warmMs ?? RERANK_WARM_MS);
  }

  private send(live: Live, kind: Pending['kind'], text: string, month: string, deadlineMs: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const p: Pending = { kind, month, abandoned: false, settle: resolve };
      live.pending = p;
      if (live.idle) clearTimeout(live.idle);
      p.deadline = setTimeout(() => this.onDeadline(live, p), deadlineMs);
      p.deadline.unref?.();
      live.said = '';
      live.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage);
      live.wake?.();
    });
  }

  private onDeadline(live: Live, p: Pending): void {
    if (live.closed || live.pending !== p) return;
    p.abandoned = true;
    p.settle(undefined);
    // A timeout is slowness, not a fault: it does not count toward the backoff.
    this.note('timeout');
    if (p.kind === 'warm') { this.closeLive(live); return; }
    p.ceiling = setTimeout(() => { if (live.pending === p) this.closeLive(live); }, Math.max(0, (this.o.hardMs ?? RERANK_HARD_MS) - (this.o.deadlineMs ?? RERANK_DEADLINE_MS)));
    p.ceiling.unref?.();
  }

  private async read(live: Live): Promise<void> {
    try {
      for await (const m of live.q) {
        if (live.closed) break;
        const msg = m as { type?: unknown; message?: { content?: unknown } };
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const b of msg.message!.content as Array<{ type?: unknown; text?: unknown }>) {
            if (b && b.type === 'text' && typeof b.text === 'string') live.said += b.text;
          }
        } else if (msg.type === 'result') this.onResult(live, m as Record<string, unknown>);
        if (live.closed) break;
      }
    } catch { /* the stream broke: handled below */ }
    if (!live.closed) { this.note('error'); this.failed(); this.closeLive(live); }
  }

  private onResult(live: Live, m: Record<string, unknown>): void {
    const est = this.o.reserveUsd ?? RERANK_RESERVE_USD;
    const total = typeof m.total_cost_usd === 'number' && Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : undefined;
    // On a streaming session total_cost_usd is CUMULATIVE for the session (the controller's probe: modelUsage cache-read tokens grew by
    // exactly each result's usage, and costUSD rose 0.000034, 0.00044, 0.00050, 0.00056). A request books the difference since the
    // previous result. The difference can include a hidden background model call; that is real spend, so it is booked too.
    const delta = total === undefined ? undefined : Math.max(0, total - live.lastTotal);
    if (total !== undefined) live.lastTotal = Math.max(live.lastTotal, total);
    const p = live.pending;
    if (!p) return;
    live.pending = undefined;
    if (p.deadline) clearTimeout(p.deadline);
    if (p.ceiling) clearTimeout(p.ceiling);
    // A live request swaps its reservation for the real cost. An abandoned one keeps the reservation (worst case), plus any excess.
    if (delta !== undefined) addSpend(this.o.dataDir, p.month, p.abandoned ? Math.max(0, delta - est) : delta - est);
    const bad = m.is_error === true || (typeof m.subtype === 'string' && m.subtype !== 'success');
    if (bad) {
      p.settle(undefined);
      this.note('error');
      this.failed();
      this.closeLive(live);
      return;
    }
    p.settle(p.abandoned ? undefined : typeof m.result === 'string' ? m.result : live.said);
    if (p.abandoned) { this.armIdle(live); return; }
    if (p.kind === 'warm') { live.ready = true; this.failures = 0; this.lastReason = undefined; }
    else live.served++;
    if (live.served >= (this.o.recycleAfter ?? RERANK_RECYCLE_AFTER)) { this.closeLive(live); return; }
    this.armIdle(live);
  }

  private armIdle(live: Live): void {
    if (live.idle) clearTimeout(live.idle);
    live.idle = setTimeout(() => this.closeLive(live), this.o.idleMs ?? RERANK_IDLE_MS);
    live.idle.unref?.();
  }

  private failed(): void {
    this.failures++;
    if (this.failures >= (this.o.failsBeforeBackoff ?? RERANK_FAILS_BEFORE_BACKOFF)) {
      this.failures = 0;
      this.backoffUntil = this.now().getTime() + (this.o.backoffMs ?? RERANK_BACKOFF_MS);
      this.note('paused after repeated failures');
      this.close();
    }
  }

  private closeLive(live: Live): void {
    if (live.closed) return;
    live.closed = true;
    if (this.live === live) this.live = undefined;
    for (const t of [live.idle, live.pending?.deadline, live.pending?.ceiling]) if (t) clearTimeout(t);
    live.pending?.settle(undefined);
    live.pending = undefined;
    live.ended = true;
    live.wake?.();
    try { live.ac.abort(); } catch { /* already aborted */ }
    try { live.q?.close?.(); } catch { /* already closed */ }
  }
}
