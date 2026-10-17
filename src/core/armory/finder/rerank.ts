/**
 * The skill finder's optional rerank: one small Haiku call that picks the best skills when the top scores are close together.
 *
 * The call is isolated: no tools, no settings from disk, no hooks, one message in and one answer out. It returns ids only, and an
 * id that is not in the candidate set is dropped. Third-party descriptions may be in the prompt, because nothing from the answer
 * goes back except ids that were already listed.
 *
 * Any failure keeps the fused order: a bad answer, a deadline, an error. The cost of a call is added to the month's spend in
 * `<dataDir>/skill-finder/spend.json` (`{ "YYYY-MM": usd }`), and a month at or over the owner's cap makes no call at all.
 * A call that misses the deadline is not abandoned for billing: it runs on to a hard ceiling so its cost is still counted.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { oneLine } from '../../kg/text.js';
import { BM25_MIN_SPREAD, RERANK_DEADLINE_MS, RERANK_DESC_CHARS, RERANK_HARD_MS, RERANK_MARGIN, RERANK_TEXT_CHARS } from './defaults.js';
import type { Ranked } from './rank.js';

/** The slice of the SDK's query that the rerank uses. A test passes a fake. */
export type RerankQuery = (a: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => AsyncIterable<unknown> & { close?: () => void };

export interface RerankCandidate { id: string; description: string }

export interface RerankRequest {
  dataDir: string;
  /** The message to rank. Cut to RERANK_TEXT_CHARS. */
  text: string;
  /** The top candidates, best first (the caller passes at most RERANK_CANDIDATES). */
  candidates: RerankCandidate[];
  /** How many ids to keep, 1 to 5. */
  k: number;
  /** The owner's monthly cap for reranking, in US dollars. */
  monthlyUsd: number;
  /** The child environment and settings, built like the handshake's. */
  env?: Record<string, string | undefined>;
  settings?: Record<string, unknown>;
  executablePath?: string;
  queryFn?: RerankQuery;
  /** How long the turn waits for the answer. Default RERANK_DEADLINE_MS. */
  deadlineMs?: number;
  /** When the call is closed whatever happens. Default RERANK_HARD_MS. */
  hardMs?: number;
  now?: () => Date;
}

export interface RerankOutcome {
  /** The ids the answer named, best first, validated and cut to k. Undefined keeps the fused order. */
  ids: string[] | undefined;
  /** Resolves once the call has ended and its cost (if any) is in the spend file. For tests and shutdown. */
  done: Promise<void>;
}

/** Every built-in tool name. The call is given no tools, and these are also named as disallowed, in case a future SDK adds one to the default set. */
export const RERANK_DISALLOWED = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'NotebookRead', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'Skill', 'TodoWrite', 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  'SendMessage', 'ListAgents', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'Config', 'Monitor', 'CronCreate',
  'CronList', 'CronDelete', 'ScheduleWakeup', 'PushNotification', 'KillShell', 'BashOutput',
];

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
    `Return a JSON array of up to ${k} skill ids from the list that fit this request, best first. Return [] if none fit. Ids only.`,
  ].join('\n');
}

/**
 * The answer's ids. The first JSON array in the text whose items are all strings is the answer; no such array is invalid.
 * Ids outside the candidate set are dropped, duplicates are dropped, and the rest are cut to k. An empty array is a valid answer.
 */
export function parseRerankAnswer(text: string, candidateIds: readonly string[], k: number): string[] | undefined {
  const known = new Set(candidateIds);
  for (const m of text.matchAll(/\[[^[\]]*\]/g)) {
    let raw: unknown;
    try { raw = JSON.parse(m[0]); } catch { continue; }
    if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) continue;
    const out: string[] = [];
    for (const id of raw as string[]) if (known.has(id) && !out.includes(id)) out.push(id);
    return out.slice(0, Math.max(1, Math.min(5, Math.floor(k))));
  }
  return undefined;
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
 * Adds `usd` to a month. Atomic: a crash mid-write leaves the old file. A failed write is ignored, so a disk error means that
 * call's cost is not counted toward the cap. The call itself has already been paid for.
 */
function addSpend(dataDir: string, month: string, usd: number): void {
  const spent = readSpend(dataDir);
  spent[month] = (spent[month] ?? 0) + usd;
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

async function* onePrompt(text: string): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage;
}

/**
 * One rerank. Resolves at the deadline at the latest, with the ids or undefined. A month at or over the cap resolves at once with
 * no call and no record.
 */
export async function rerankPick(r: RerankRequest): Promise<RerankOutcome> {
  const now = r.now ?? (() => new Date());
  const month = monthKey(now());
  const nothing: RerankOutcome = { ids: undefined, done: Promise.resolve() };
  if ((readSpend(r.dataDir)[month] ?? 0) >= r.monthlyUsd) return nothing;
  if (r.candidates.length === 0) return nothing;

  const queryFn = (r.queryFn ?? (realQuery as unknown as RerankQuery));
  const ac = new AbortController();
  const options = {
    model: 'haiku',
    maxTurns: 1,
    tools: [],
    allowedTools: [],
    disallowedTools: RERANK_DISALLOWED,
    cwd: tmpdir(),
    settingSources: [],
    strictMcpConfig: true,
    settings: { ...(r.settings ?? {}), disableAllHooks: true },
    permissionMode: 'default',
    persistSession: false,
    ...(r.env ? { env: r.env } : {}),
    ...(r.executablePath ? { pathToClaudeCodeExecutable: r.executablePath } : {}),
    abortController: ac,
  };
  const prompt = buildRerankPrompt(r.text, r.candidates, r.k);

  let q: ReturnType<RerankQuery>;
  try {
    q = queryFn({ prompt: onePrompt(prompt), options });
  } catch {
    return nothing;
  }

  let finish!: () => void;
  const done = new Promise<void>((res) => { finish = res; });
  let cost: number | undefined;
  const stop = (): void => {
    try { ac.abort(); } catch { /* already aborted */ }
    try { q.close?.(); } catch { /* already closed */ }
  };
  // The hard ceiling: the call cannot run longer than this, whatever the deadline did.
  const ceiling = setTimeout(() => { stop(); finish(); }, r.hardMs ?? RERANK_HARD_MS);
  ceiling.unref?.();

  // Reads the answer. Errors are no answer; the cost is recorded in any case, and the spend is written before `done` resolves.
  const reading = (async (): Promise<string | undefined> => {
    let said = '';
    let answer: string | undefined;
    try {
      for await (const m of q) {
        const msg = m as { type?: unknown; total_cost_usd?: unknown; result?: unknown; message?: { content?: unknown } };
        if (typeof msg.total_cost_usd === 'number' && Number.isFinite(msg.total_cost_usd)) cost = msg.total_cost_usd;
        if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
          for (const b of msg.message!.content as Array<{ type?: unknown; text?: unknown }>) {
            if (b && b.type === 'text' && typeof b.text === 'string') said += b.text;
          }
        }
        if (msg.type === 'result') {
          if (typeof msg.result === 'string') answer = msg.result;
          break;
        }
      }
    } catch { /* an error is no answer */ }
    finally {
      stop();
      if (cost !== undefined && cost > 0) addSpend(r.dataDir, month, cost);
      clearTimeout(ceiling);
      finish();
    }
    return answer ?? (said || undefined);
  })();

  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((res) => { timer = setTimeout(() => res('late'), r.deadlineMs ?? RERANK_DEADLINE_MS); });
  const first = await Promise.race([reading, late]);
  if (timer) clearTimeout(timer);
  if (first === 'late') return { ids: undefined, done };
  const ids = first === undefined ? undefined : parseRerankAnswer(first, r.candidates.map((c) => c.id), r.k);
  return { ids, done };
}
