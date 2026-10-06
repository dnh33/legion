/**
 * Asks the Claude Code SDK what it really loads (skills, commands, plugins with their folders), without a model turn.
 *
 * Why not the system `init` message: measured on SDK 0.3.285 (2026-10-06), a query whose prompt stream yields nothing never emits
 * `init` (that message goes out with the first user turn). The same data is answered by three control requests that need no turn:
 * `initializationResult()` (every slash command, skills included), `reloadSkills()` (the skills) and `reloadPlugins()` (name, path, source).
 * Nothing is sent to the model: the prompt stream yields no message, so the CLI has no turn to run, and a background reader counts any
 * assistant/result message and its cost so the caller can prove that (modelMessages and costUsd stay 0). `disableAllHooks` keeps the
 * owner's SessionStart hooks from running for what is only a listing. Closed in a finally block.
 * The SDK is already used by the engine; no child process or network call is written here (the SDK starts its own CLI).
 */
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import { tmpdir } from 'node:os';

export interface SdkCommand { name: string; description: string }
export interface SdkPlugin { name: string; path: string; source?: string }
export interface SdkSnapshot {
  /** The skills the SDK lists (reloadSkills). */
  skills: SdkCommand[];
  /** Every slash command (initializationResult), skills and plugin commands included. */
  commands: SdkCommand[];
  plugins: SdkPlugin[];
  /** Messages of a model turn seen while the probe ran (assistant, result, stream events). Must be 0. */
  modelMessages: number;
  /** Largest total_cost_usd seen on any message. Must be 0. */
  costUsd: number;
}

/** The slice of the SDK's Query that the probe uses (a test passes a fake). */
export interface ProbeQuery {
  initializationResult(): Promise<{ commands?: unknown }>;
  reloadSkills(): Promise<{ skills?: unknown }>;
  reloadPlugins(): Promise<{ plugins?: unknown }>;
  interrupt(): Promise<unknown>;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}
export type ProbeQueryFn = (a: { prompt: AsyncIterable<never>; options: Record<string, unknown> }) => ProbeQuery;

export interface HandshakeOptions {
  /** Same switch as the engine's: true reads the owner's Claude Code settings (settingSources ['user']). */
  inheritClaudeCode: boolean;
  queryFn?: ProbeQueryFn;
  timeoutMs?: number;
  cwd?: string;
  /** The child environment, built like the catalog probe's (buildChildEnv with probe: true): no bearer token, connectors off. */
  env?: Record<string, string | undefined>;
  /** Extra SDK settings (the connector switch). disableAllHooks is always added. */
  settings?: Record<string, unknown>;
  /** claude.executablePath, when the owner set one. */
  executablePath?: string;
}

/** A listing runner: the real handshake, or a fake in tests. */
export type SdkProbe = (o: HandshakeOptions) => Promise<SdkSnapshot>;

const cmdList = (v: unknown): SdkCommand[] => {
  if (!Array.isArray(v)) return [];
  const out: SdkCommand[] = [];
  for (const c of v) {
    const r = c as { name?: unknown; description?: unknown } | null;
    if (r && typeof r.name === 'string' && r.name.trim()) out.push({ name: r.name.trim(), description: typeof r.description === 'string' ? r.description : '' });
  }
  return out;
};
const pluginList = (v: unknown): SdkPlugin[] => {
  if (!Array.isArray(v)) return [];
  const out: SdkPlugin[] = [];
  for (const p of v) {
    const r = p as { name?: unknown; path?: unknown; source?: unknown } | null;
    if (r && typeof r.name === 'string' && r.name && typeof r.path === 'string') out.push({ name: r.name, path: r.path, ...(typeof r.source === 'string' ? { source: r.source } : {}) });
  }
  return out;
};

export const sdkHandshake: SdkProbe = async (o) => {
  const queryFn = o.queryFn ?? (realQuery as unknown as ProbeQueryFn);
  const timeoutMs = o.timeoutMs ?? 45_000;
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  // A prompt stream that yields nothing: it only waits until the probe is over. No user message means no model turn.
  const prompt: AsyncIterable<never> = (async function* () { await gate; })();
  const ac = new AbortController();
  const q = queryFn({
    prompt,
    options: {
      cwd: o.cwd ?? tmpdir(),
      settingSources: o.inheritClaudeCode ? ['user'] : [],
      strictMcpConfig: true,
      settings: { ...(o.settings ?? {}), disableAllHooks: true },
      ...(o.env ? { env: o.env } : {}),
      ...(o.executablePath ? { pathToClaudeCodeExecutable: o.executablePath } : {}),
      abortController: ac,
    },
  });
  let modelMessages = 0;
  let costUsd = 0;
  // Watch only; never waits for a message. Anything that is not a system notice would mean a turn started.
  const it = q[Symbol.asyncIterator]();
  void (async () => {
    try {
      for (;;) {
        const n = await it.next();
        if (n.done) return;
        const m = n.value as { type?: unknown; total_cost_usd?: unknown } | null;
        if (m && m.type !== 'system') modelMessages++;
        if (m && typeof m.total_cost_usd === 'number') costUsd = Math.max(costUsd, m.total_cost_usd);
      }
    } catch { /* the listing already failed or the query was closed */ }
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`The Claude Code listing did not answer within ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs); });
  try {
    const run = (async () => {
      const init = await q.initializationResult();
      const sk = await q.reloadSkills();
      const pl = await q.reloadPlugins();
      return { commands: cmdList(init.commands), skills: cmdList(sk.skills), plugins: pluginList(pl.plugins) };
    })();
    run.catch(() => undefined); // a late failure after the timeout is not an unhandled rejection
    const got = await Promise.race([run, timeout]);
    return { ...got, modelMessages, costUsd };
  } finally {
    if (timer) clearTimeout(timer);
    // Nothing runs, so interrupt only has to be harmless; close() ends the CLI process and frees the stream.
    try { void q.interrupt().catch(() => undefined); } catch { /* not running */ }
    try { ac.abort(); } catch { /* already aborted */ }
    try { q.close(); } catch { /* already closed */ }
    release();
  }
};
