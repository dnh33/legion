/** Health checks. */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { configPath } from '../shared/config.js';
import type { DoctorCheck, LegionConfig } from '../shared/types.js';
import type { BoatClient } from './boat.js';
import { buildChildEnv } from './engine.js';
import type { QueryFn } from './engine.js';

const SIGN_IN_FIX = 'Run `claude` in a terminal and sign in with /login';

async function safe(id: string, label: string, fn: () => Promise<Omit<DoctorCheck, 'id' | 'label'>> | Omit<DoctorCheck, 'id' | 'label'>): Promise<DoctorCheck> {
  try {
    return { id, label, ...(await fn()) };
  } catch (e) {
    return { id, label, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function probeClaude(config: LegionConfig, queryFn: QueryFn, timeoutMs: number): Promise<Omit<DoctorCheck, 'id' | 'label'>> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  // Async iterable that yields nothing until closed: starts the session without sending any prompt (no model call).
  async function* input(): AsyncGenerator<SDKUserMessage, void> { await gate; }
  const ac = new AbortController();
  let q: ReturnType<QueryFn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const options: Parameters<QueryFn>[0]['options'] = {
      cwd: tmpdir(), settingSources: [], env: buildChildEnv(config), abortController: ac,
    };
    if (config.claude.executablePath) options.pathToClaudeCodeExecutable = config.claude.executablePath;
    q = queryFn({ prompt: input(), options });
    const info = await Promise.race([
      q.accountInfo(),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs); }),
    ]);
    const who = [info?.email, info?.subscriptionType && `plan: ${info.subscriptionType}`].filter(Boolean).join(', ');
    if (config.claude.auth === 'claude-login' && !info?.email && !info?.subscriptionType && (!info?.apiProvider || info.apiProvider === 'firstParty')) {
      return { ok: false, detail: 'No signed-in Claude account found', fix: SIGN_IN_FIX };
    }
    return { ok: true, detail: who || `provider: ${info?.apiProvider ?? 'unknown'}` };
  } catch (e) {
    return { ok: false, detail: `Claude probe failed: ${e instanceof Error ? e.message : String(e)}`, fix: SIGN_IN_FIX };
  } finally {
    if (timer) clearTimeout(timer);
    release();
    try { void q?.interrupt?.()?.catch?.(() => undefined); } catch { /* ignore */ }
    try { q?.close?.(); } catch { /* ignore */ }
    try { ac.abort(); } catch { /* ignore */ }
  }
}

export async function runDoctor(deps: { config: LegionConfig; getBoat: () => BoatClient | null; queryFn?: QueryFn; probeTimeoutMs?: number }): Promise<DoctorCheck[]> {
  const { config } = deps;
  const queryFn = deps.queryFn ?? realQuery;
  const checks: DoctorCheck[] = [];

  checks.push(await safe('node', 'Node.js version', () => {
    const major = Number(process.versions.node.split('.')[0]);
    return major >= 20
      ? { ok: true, detail: `v${process.versions.node}` }
      : { ok: false, detail: `v${process.versions.node}`, fix: 'Install Node.js 20 or newer' };
  }));

  checks.push(await safe('config', 'Config file', () => {
    const p = configPath();
    return existsSync(p)
      ? { ok: true, detail: p }
      : { ok: false, detail: `Not found: ${p}`, fix: 'Start Legion core once to create it' };
  }));

  checks.push(await safe('auth', 'Claude auth mode', () => {
    if (config.claude.auth === 'api-key') {
      return config.claude.apiKey
        ? { ok: true, detail: 'api-key (key present)' }
        : { ok: false, detail: 'api-key mode but no key set', fix: 'Open Settings → Claude to add an API key' };
    }
    return { ok: true, detail: 'claude-login (uses your signed-in Claude Code account)' };
  }));

  checks.push(await safe('claude', 'Claude sign-in', () => probeClaude(config, queryFn, deps.probeTimeoutMs ?? 20_000)));

  checks.push(await safe('boat', 'boat.dev', async () => {
    const boat = deps.getBoat();
    if (!boat) return { ok: true, detail: 'Not configured (agent VMs disabled)', fix: 'Open Settings → boat.dev to add a key and enable VMs' };
    await boat.me();
    return { ok: true, detail: 'Connected' };
  }).then((c) => (c.ok ? c : { ...c, fix: c.fix ?? 'Open Settings → boat.dev to check the key' })));

  checks.push(await safe('workspace', 'Workspace directory', () => {
    mkdirSync(config.workspaceDir, { recursive: true });
    const f = join(config.workspaceDir, `.legion-doctor-${process.pid}.tmp`);
    writeFileSync(f, 'ok');
    rmSync(f, { force: true });
    return { ok: true, detail: config.workspaceDir };
  }));

  return checks;
}
