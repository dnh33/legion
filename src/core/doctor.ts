/** Health checks. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { configPath } from '../shared/config.js';
import type { DoctorCheck, LegionConfig } from '../shared/types.js';
import type { BoatClient } from './boat.js';
import { CLAUDE_NOT_CONFIGURED, type BoatHealth } from './boat-health.js';
import { buildChildEnv, connectorSettings, isPlanOnly, planOnlySettings } from './engine.js';
import type { QueryFn } from './engine.js';
import { claudeHomeDir } from './armory/discover.js';

const SIGN_IN_FIX = 'Run `claude` in a terminal and sign in with /login';

const MANAGED_KEY_NOTE = "Your organization's managed settings give Claude this key, and Legion cannot turn it off. Ask your admin to add credits or give you a Claude seat, or turn on Allow API credit billing.";

const PLAN_ONLY_FIX = 'To use your Claude plan: run claude in a terminal, type /logout, then /login and choose your Claude account. Or turn on Settings -> Claude -> Allow API credit billing.';

/** The name (never the value) of the first billing key the user's Claude Code settings.json sets, if any. Missing or corrupt files give undefined. */
function billingKeyInSettings(): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(claudeHomeDir(), 'settings.json'), 'utf8')) as { env?: Record<string, unknown>; apiKeyHelper?: unknown } | null;
    const set = (v: unknown) => typeof v === 'string' && v.trim() !== '';
    const env = s?.env && typeof s.env === 'object' ? s.env : {};
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) if (set(env[k])) return k;
    if (set(s?.apiKeyHelper)) return 'apiKeyHelper';
  } catch { /* no settings file, or not JSON: nothing to flag */ }
  return undefined;
}

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
      cwd: tmpdir(), settingSources: [], strictMcpConfig: true, env: buildChildEnv(config, { probe: true }), settings: planOnlySettings(config, connectorSettings(config, { probe: true }).settings), abortController: ac,
      // Pinned: an omitted mode starts auto mode on third-party providers (SDK 0.3.286). A probe leaves no session file.
      permissionMode: 'default', persistSession: false,
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
    let billNote = '';
    if (config.claude.auth === 'claude-login') {
      // A key source other than "none" means runs bill API credits, even when a Claude plan is also signed in.
      const source = info?.apiKeySource;
      const billed = !!source && source !== 'none';
      if (isPlanOnly(config)) {
        // Plan only: the keys in Claude Code settings are blanked for runs, so only a source the blanks cannot reach (a stored Console key) fails here.
        if (billed) {
          // Legion blanks ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN and apiKeyHelper in the flag settings, which outrank every user, project and local file. A key still
          // reported from one of those two sources therefore comes from the managed settings layer, the only one above them. A stored Console key ('/login managed key') is a different case.
          const managed = source === 'ANTHROPIC_API_KEY' || source === 'apiKeyHelper';
          return { ok: false, detail: `Runs would bill API credits (key source: ${source}), so Legion will not start them${managed ? `. ${MANAGED_KEY_NOTE}` : ''}`, fix: PLAN_ONLY_FIX };
        }
      } else {
        // API billing allowed: say so, and keep the key names in the settings files as information.
        // Settings the runs load but this probe does not (it runs with settingSources: []).
        const name = config.claude.inheritClaudeCodeSettings ? billingKeyInSettings() : undefined;
        const parts = [billed ? `Signed in; runs bill API credits (key source: ${source}), as you allowed in Settings` : '', name ? `Your Claude Code settings set ${name}; runs bill it, as you allowed in Settings` : ''].filter(Boolean);
        billNote = parts.join('. ');
      }
    }
    // Which Claude Code is bundled (SDK 0.3.296 reports it in the initialize response). Best effort: never fails the check.
    let version = '';
    let vt: ReturnType<typeof setTimeout> | undefined;
    try {
      const init = await Promise.race([q.initializationResult?.(), new Promise<undefined>((res) => { vt = setTimeout(() => res(undefined), 2000); })]);
      if (typeof init?.claude_code_version === 'string' && init.claude_code_version) version = `Claude Code ${init.claude_code_version}`;
    } catch { /* an older CLI or a closed query: the version is simply not shown */ }
    clearTimeout(vt);
    return { ok: true, detail: [[who || `provider: ${info?.apiProvider ?? 'unknown'}`, version].filter(Boolean).join(', '), billNote].filter(Boolean).join('. ') };
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

export async function runDoctor(deps: { config: LegionConfig; getBoat: () => BoatClient | null; health?: BoatHealth; queryFn?: QueryFn; probeTimeoutMs?: number }): Promise<DoctorCheck[]> {
  const { config } = deps;
  const queryFn = deps.queryFn ?? realQuery;
  const checks: DoctorCheck[] = [];

  checks.push(await safe('node', 'Node.js version', () => {
    // the floor of package.json engines.node (Electron and the build tools need 22.12)
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    return major > 22 || (major === 22 && minor >= 12)
      ? { ok: true, detail: `v${process.versions.node}` }
      : { ok: false, detail: `v${process.versions.node}`, fix: 'Install Node.js 22.12 or newer' };
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

  // Plan only blanks these two for the Claude run. Say so when the environment Legion started in sets one (the name only, never the value).
  if (isPlanOnly(config)) {
    const set = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter((k) => (process.env[k] ?? '').trim() !== '');
    if (set.length) {
      const names = set.join(' and ');
      checks.push({ id: 'claude-env', label: 'Claude environment keys', ok: true, detail: `Your environment sets ${names}. Legion does not use ${set.length > 1 ? 'them' : 'it'}, so your runs use your Claude plan. To bill ${set.length > 1 ? 'those keys' : 'that key'}, turn on Allow API credit billing in Settings, Claude.` });
    }
  }

  checks.push(await safe('boat', 'boat.dev', async () => {
    const boat = deps.getBoat();
    if (!boat) return { ok: true, detail: 'Not configured (agent VMs disabled)', fix: 'Open Settings → boat.dev to add a key and enable VMs' };
    await boat.me();
    const health = deps.health;
    if (!health) return { ok: true, detail: 'Connected' };
    if (!health.view().checkedAt) await health.probe(); // first look at what this key may do
    const v = health.view();
    if (v.forbidden.length) {
      const what = v.forbidden.map((f) => f.action).join(', ');
      return { ok: false, detail: `Connected, but this boat.dev API key cannot do: ${what}`, fix: 'Create a full-access key in boat.dev and paste it in Settings → boat.dev' };
    }
    return { ok: true, detail: v.trial.limited ? 'Connected (free trial: larger VM sizes are not available, Legion uses Default)' : 'Connected' };
  }).then((c) => (c.ok ? c : { ...c, fix: c.fix ?? 'Open Settings → boat.dev to check the key' })));

  if (deps.getBoat() && deps.health?.claudeMissing()) {
    checks.push({ id: 'boat-claude', label: 'Claude on boat.dev', ok: true, detail: CLAUDE_NOT_CONFIGURED, fix: 'Open the Agents page in your boat.dev dashboard and connect Claude' });
  }

  checks.push(await safe('workspace', 'Workspace directory', () => {
    mkdirSync(config.workspaceDir, { recursive: true });
    const f = join(config.workspaceDir, `.legion-doctor-${process.pid}.tmp`);
    writeFileSync(f, 'ok');
    rmSync(f, { force: true });
    return { ok: true, detail: config.workspaceDir };
  }));

  return checks;
}
