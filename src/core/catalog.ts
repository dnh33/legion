/** Claude Code slash-command + model catalog, probed without a model call. */
import { tmpdir } from 'node:os';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Catalog, CatalogCommand, CatalogModel, LegionConfig } from '../shared/types.js';
import { buildChildEnv } from './engine.js';
import type { QueryFn } from './engine.js';

export const CATALOG_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;

export interface CatalogDeps {
  config: LegionConfig;
  queryFn?: QueryFn;
  /** Test hooks. */
  timeoutMs?: number;
  now?: () => number;
}

interface State { cache?: { at: number; value: Catalog }; inflight?: Promise<Catalog> }
const states = new WeakMap<object, State>();

export async function getCatalog(deps: CatalogDeps, opts?: { force?: boolean }): Promise<Catalog> {
  const now = deps.now ?? Date.now;
  let st = states.get(deps.config);
  if (!st) { st = {}; states.set(deps.config, st); }
  const state = st;
  if (!opts?.force && state.cache && now() - state.cache.at < CATALOG_TTL_MS) return state.cache.value;
  if (state.inflight) return state.inflight;
  const p = probe(deps, now).then((value) => {
    if (!value.error) state.cache = { at: now(), value };
    return value;
  }).finally(() => { state.inflight = undefined; });
  state.inflight = p;
  return p;
}

async function probe(deps: CatalogDeps, now: () => number): Promise<Catalog> {
  const queryFn = deps.queryFn ?? realQuery;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // Streaming-input prompt that yields nothing until closed: no model call is made.
  async function* input(): AsyncGenerator<SDKUserMessage, void> { await gate; }
  const ac = new AbortController();
  let q: ReturnType<QueryFn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const options: Parameters<QueryFn>[0]['options'] = {
      cwd: tmpdir(), env: buildChildEnv(deps.config), abortController: ac,
      settingSources: deps.config.claude.inheritClaudeCodeSettings ? ['user', 'project', 'local'] : [],
    };
    if (deps.config.claude.executablePath) options.pathToClaudeCodeExecutable = deps.config.claude.executablePath;
    q = queryFn({ prompt: input(), options });
    const probeQ = q;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    });
    const [cmds, models] = await Promise.all([
      Promise.race([probeQ.supportedCommands(), timeout]),
      Promise.race([probeQ.supportedModels(), timeout]),
    ]);
    return { commands: dedupeCommands(cmds ?? []), models: dedupeModels(models ?? []), fetchedAt: new Date(now()).toISOString() };
  } catch (e) {
    return { commands: [], models: [], fetchedAt: new Date(now()).toISOString(), error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer) clearTimeout(timer);
    release();
    try { void q?.interrupt?.()?.catch?.(() => undefined); } catch { /* ignore */ }
    try { q?.close?.(); } catch { /* ignore */ }
    try { ac.abort(); } catch { /* ignore */ }
  }
}

/**
 * Commands that only make sense in Claude Code's interactive terminal UI (or are internal plumbing)
 * and do nothing useful in a headless Legion task. Hidden from the slash menu.
 */
const TUI_ONLY = new Set([
  'clear', 'color', 'config', 'focus', 'heapdump', 'import', 'output-style', 'rename', 'agents', 'exit', 'quit',
  'login', 'logout', 'vim', 'terminal-setup', 'theme', 'resume', 'ide', 'status', 'statusline', 'keybindings',
  'design-consent', 'design-revoke', 'diff', 'doctor', 'model', 'reload-plugins', 'reload-skills', 'bug', 'feedback',
]);
export function isUsefulCommand(name: string, description: string): boolean {
  if (name.startsWith('__') || TUI_ONLY.has(name)) return false;
  if (/\(removed\)|sessions only/i.test(description)) return false;
  return true;
}

function dedupeCommands(list: any[]): CatalogCommand[] {
  const seen = new Set<string>();
  const out: CatalogCommand[] = [];
  for (const c of list) {
    const name = typeof c?.name === 'string' ? c.name.replace(/^\//, '') : '';
    if (!name || seen.has(name) || !isUsefulCommand(name, String(c.description ?? ''))) continue;
    seen.add(name);
    out.push({
      name, description: String(c.description ?? ''), argumentHint: String(c.argumentHint ?? ''),
      ...(Array.isArray(c.aliases) && c.aliases.length ? { aliases: c.aliases.map(String) } : {}),
      ...(c.builtin ? { builtin: true } : {}),
    });
  }
  return out;
}

function dedupeModels(list: any[]): CatalogModel[] {
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const m of list) {
    const value = typeof m?.value === 'string' ? m.value : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({
      value, displayName: String(m.displayName ?? value), description: String(m.description ?? ''),
      ...(m.resolvedModel ? { resolvedModel: String(m.resolvedModel) } : {}),
    });
  }
  return out;
}
