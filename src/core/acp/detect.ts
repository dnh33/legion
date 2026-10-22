/**
 * Is the agent (Hermes) on this computer, does it start, which version is it and what does it do about approvals. Read only: it runs the
 * agent's own one-shot commands through `runAgentCli` and one `initialize` handshake through `startAgentProcess` (src/core/acp/process.ts),
 * so it starts nothing itself and every probe has the same program lookup and environment as a run.
 *
 * What the Hermes source says (the Hermes source at commit bd3cbe91, read 2026-10-22; the release facts from GitHub the same day):
 *  - `hermes acp --check` imports the ACP packages and prints "Hermes ACP check OK" (acp_adapter/entry.py:113-117). It prints no version.
 *    `--version` is never sent: Hermes checks for updates on it, and Legion never updates Hermes.
 *  - The version is `agentInfo.version` of the `initialize` answer (acp_adapter/gateway_server.py:138-143). That answer needs no model
 *    and no background service: the service is only reached when a session opens (gateway_server.py:161).
 *  - `hermes acp` serves through the gateway agent from commit f974134f36 (2026-10-16, acp_adapter/server.py:245-248). It is in no tag
 *    before v0.22.3 (published 2026-10-21; `git tag --contains` lists only canary builds after v0.22.2, and the GitHub compare of
 *    f974134f36 with v0.22.3 says "ahead", behind_by 0). So v0.22.3 is the oldest version this runtime is built for.
 *  - `config get <key> --json` reads the merged config, so a default shows as its value (hermes_cli/config.py:3543-3590). A key that has no
 *    default and was never set exits 1 with "Config key not set".
 *  - approvals.mode is manual, smart or off; a bare `off` is read as the boolean false by YAML and Hermes maps false to off, true to manual and
 *    anything else to manual (tools/approval_context.py:262-280). The shipped default is smart (hermes_cli/config_defaults.py:1694).
 *  - approvals.timeout (default 300 s) is how long Hermes waits for an answer before it denies the request itself (tools/approval_context.py:
 *    _get_approval_timeout, acp_adapter/permissions.py:118-125). A tool call to an MCP server is cut at `timeouts.mcp.tool_call`, default 300 s
 *    (tools/mcp_tool_common.py:41-58). gateway/session_local_mcp.py:140 hands a session's own tool servers `tool_timeout=30`, but I found no
 *    reader of that key (the resolver reads `timeout`), so the config value is taken to govern. Not confirmed against a live run.
 *  - auth.adopt_external_logins defaults to true (config_defaults.py:1775): Hermes borrows the Claude Code login.
 */
import { tmpdir } from 'node:os';
import { BUILTIN_HERMES, containedArgs, type AcpEntry } from '../../shared/acp-view.js';
import { VERSION } from '../../shared/config.js';
import { redact } from '../log/redact.js';
import { asJson, CONTAINED_PROFILE, why, type Out } from './contained.js';
import { AgentLaunchError, resolveCommand, runAgentCli, startAgentProcess } from './process.js';
import { RpcPeer } from './rpc.js';
import { PROTOCOL_VERSION } from './session.js';

/**
 * `min`: the oldest Hermes with the gateway ACP server this runtime talks to (see above). `testedWith`: the version the runtime was built and
 * checked against. It is the release that holds the source that was studied; update it after the live walk.
 */
export const TESTED_HERMES = { min: '0.22.3', testedWith: '0.22.3' } as const;
/** Where Hermes itself says to get it (its README and installation page). Shown without the scheme. */
export const HERMES_INSTALL_HOST = 'hermes-agent.nousresearch.com';

export const DETECT_TTL_MS = 10 * 60 * 1000;
/** `acp --check` imports Python packages: a cold disk on Windows can take a while. */
export const CHECK_TIMEOUT_MS = 30_000;
const GET_TIMEOUT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** What Hermes does when nothing is configured, in seconds. */
const HERMES_DEFAULT_WAIT_S = 300;
/** A tool call is given up this much before Hermes cuts it (270 s of its 300 s), but never less than half of its time. */
const TOOL_MARGIN_MS = 30_000;

export type ApprovalsMode = 'manual' | 'smart' | 'off' | 'unknown';

export interface AgentDetection {
  /** The program is on PATH. */
  found: boolean;
  path?: string;
  /** False: nothing was run (a custom entry the owner has not switched on). */
  checked: boolean;
  /** `acp --check` passed. */
  checkOk: boolean;
  /** `x.y.z`, from the `initialize` answer (or the last run). Undefined when it could not be read or is Hermes's "no stamp" placeholder. */
  version?: string;
  approvalsMode?: ApprovalsMode;
  /** Hermes borrows the Claude Code login: true (also when the key is not set, the default), false, undefined when unreadable. */
  adoptExternalLogins?: boolean;
  /** How long Hermes waits for an answer to a request, in ms (its own setting, else 300 s). Set when Hermes starts. */
  permissionWaitMs?: number;
  /** How long a card raised inside a tool call may stay open, in ms: Hermes's tool-call timeout less a margin. Set when Hermes starts. */
  toolWaitMs?: number;
  detail: string;
}

/** What detection needs from the core: where the data folder is (the handshake records its process there) and the owner's keep list. */
export interface AgentHostDeps {
  /** The entries to describe. Default: the built-in Hermes entry. */
  entries?: () => AcpEntry[];
  dataDir: string;
  envKeep?: () => readonly string[];
  /** Test hooks. */
  now?: () => number;
  run?: typeof runAgentCli;
}

export interface DetectOptions { force?: boolean }

// ---------------------------------------------------------------- versions

/** `v0.22.3`, `0.22.3+canary.2026...` and `0.22.3` all give `0.22.3`. `0.0.0` is Hermes's placeholder for "no install stamp": unknown. */
export function parseVersion(raw: string | undefined): string | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec((raw ?? '').trim());
  if (!m) return undefined;
  const v = `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
  return v === '0.0.0' ? undefined : v;
}
/** Negative when a is older than b. Both are `x.y.z`. */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d !== 0) return d; }
  return 0;
}

// ---------------------------------------------------------------- what the runs tell us

const notes = new Map<string, { version?: string; authFailed?: boolean }>();
/** A run opened a session: the version the agent reported, and the agent signed in after all. */
export function noteAgentVersion(entryId: string, version: string): void {
  const v = parseVersion(version);
  const n = notes.get(entryId) ?? {};
  notes.set(entryId, { ...n, ...(v ? { version: v } : {}), authFailed: false });
}
/** A run was refused because the agent could not sign in to a model provider. */
export function noteAuthFailure(entryId: string): void { notes.set(entryId, { ...(notes.get(entryId) ?? {}), authFailed: true }); }
export const authFailureNoted = (entryId: string): boolean => notes.get(entryId)?.authFailed === true;

// ---------------------------------------------------------------- the cache

const cache = new Map<string, { at: number; value: AgentDetection }>();
const inflight = new Map<string, Promise<AgentDetection>>();
/** The last waits read for an entry. Kept after the answer expires: a stale value beats none. */
const lastWaits = new Map<string, { permissionWaitMs: number; toolWaitMs: number }>();

export function forgetDetections(): void { cache.clear(); inflight.clear(); lastWaits.clear(); notes.clear(); }

const keyOf = (e: AcpEntry): string => JSON.stringify([e.id, e.command, e.args, e.contained === true, Object.entries(e.env ?? {}).sort()]);

/** The values the engine reads when it raises a card: undefined until the agent has been checked once. */
export function agentWaits(entry: Pick<AcpEntry, 'id'>): { permissionWaitMs: number; toolWaitMs: number } | undefined {
  const w = lastWaits.get(entry.id);
  return w ? { ...w } : undefined;
}

/** Getters for the engine's two wait settings, read at each request or run. `undefined` means "the agent's default". */
export function hostWaitSeams(entry: () => AcpEntry | undefined): { permissionWaitMs: () => number | undefined; toolWaitMs: () => number | undefined } {
  const of = (pick: 'permissionWaitMs' | 'toolWaitMs') => (): number | undefined => { const e = entry(); return e ? agentWaits(e)?.[pick] : undefined; };
  return { permissionWaitMs: of('permissionWaitMs'), toolWaitMs: of('toolWaitMs') };
}

// ---------------------------------------------------------------- detection

/** Probed: the built-in entry, and a custom entry only once the owner switched it on (a custom command is an arbitrary program). */
export const isProbed = (e: AcpEntry): boolean => e.id === BUILTIN_HERMES.id || e.enabled;

export function detectAgent(entry: AcpEntry, deps: Partial<AgentHostDeps> & DetectOptions = {}): Promise<AgentDetection> {
  const now = deps.now ?? Date.now;
  if (!isProbed(entry)) return Promise.resolve({ found: false, checked: false, checkOk: false, detail: `${entry.label} is not checked: it is switched off.` });
  const key = keyOf(entry);
  const hit = cache.get(key);
  if (!deps.force && hit && now() - hit.at < DETECT_TTL_MS) return Promise.resolve(hit.value);
  const running = inflight.get(key);
  if (running) return running;
  const p = probe(entry, deps).then((value) => {
    if (value.found) cache.set(key, { at: now(), value }); else cache.delete(key); // a program that is not there is looked up again at once: that costs no process
    return value;
  }).finally(() => { if (inflight.get(key) === p) inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

const isNotSet = (r: Out): boolean => r.code === 1 && /not set/i.test(`${r.stderr}\n${r.stdout}`);

/** Hermes reads YAML, where a bare `off` is false: false is off, true is manual, a string must be one of the three. */
function modeOf(v: unknown): ApprovalsMode {
  if (v === false) return 'off';
  if (v === true) return 'manual';
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'manual' || s === 'smart' || s === 'off' ? s : 'unknown';
}
const secondsOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : HERMES_DEFAULT_WAIT_S);

async function probe(entry: AcpEntry, deps: Partial<AgentHostDeps>): Promise<AgentDetection> {
  const label = entry.label;
  const builtin = entry.id === BUILTIN_HERMES.id;
  let path: string;
  try {
    path = resolveCommand(entry.command, { ...process.env, ...(entry.env ?? {}) });
  } catch (e) {
    const notFound = e instanceof AgentLaunchError && e.code === 'not-found';
    const detail = notFound
      ? (builtin ? `Hermes is not installed. Install it from ${HERMES_INSTALL_HOST}, then check again.` : `${label} was not found on your computer. Check its command in Settings, Agent hosts.`)
      : redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
    return { found: false, checked: true, checkOk: false, detail };
  }
  const run = deps.run ?? runAgentCli;
  const envKeep = deps.envKeep?.() ?? [];
  const go = (args: string[], timeoutMs: number) => run(entry.command, args, { timeoutMs, cwd: tmpdir(), envKeep, ...(entry.env ? { entryEnv: entry.env } : {}) });

  const check = await go([...containedArgs(entry), '--check'], CHECK_TIMEOUT_MS);
  if (check.code !== 0 || check.timedOut) {
    return { found: true, path, checked: true, checkOk: false, detail: `${label} did not start: ${why(check)}`.slice(0, 400) };
  }

  const prefix = entry.contained ? ['-p', CONTAINED_PROFILE] : [];
  const get = async (key: string): Promise<{ out: Out; value?: unknown }> => {
    const out = await go([...prefix, 'config', 'get', key, '--json'], GET_TIMEOUT_MS);
    const j = out.code === 0 ? asJson(out.stdout) : { ok: false as const };
    return j.ok ? { out, value: j.value } : { out };
  };
  const [mode, adopt, perm, tool, version] = await Promise.all([
    get('approvals.mode'), get('auth.adopt_external_logins'), get('approvals.timeout'), get('timeouts.mcp.tool_call'),
    askVersion(entry, deps),
  ]);

  const approvalsMode = mode.value === undefined ? 'unknown' : modeOf(mode.value);
  const adoptExternalLogins = typeof adopt.value === 'boolean' ? adopt.value : isNotSet(adopt.out) ? true : undefined;
  const permissionWaitMs = secondsOf(perm.value) * 1000;
  const toolSeconds = secondsOf(tool.value);
  const toolWaitMs = Math.max(Math.floor(toolSeconds * 500), toolSeconds * 1000 - TOOL_MARGIN_MS);
  lastWaits.set(entry.id, { permissionWaitMs, toolWaitMs });
  const seenVersion = version ?? notes.get(entry.id)?.version;
  return {
    found: true, path, checked: true, checkOk: true, ...(seenVersion ? { version: seenVersion } : {}), approvalsMode,
    ...(adoptExternalLogins !== undefined ? { adoptExternalLogins } : {}), permissionWaitMs, toolWaitMs, detail: `${label} starts.`,
  };
}

/**
 * `initialize` only: no session, no model call, no background service. The agent is stopped at once. Best effort: any failure means "version not read".
 * A contained entry is started without its profile here: the program is the same, and the profile may not exist yet.
 */
async function askVersion(entry: AcpEntry, deps: Partial<AgentHostDeps>): Promise<string | undefined> {
  if (!deps.dataDir) return undefined;
  let proc: ReturnType<typeof startAgentProcess> | undefined;
  let peer: RpcPeer | undefined;
  try {
    proc = startAgentProcess({ ...entry, contained: false }, { cwd: tmpdir(), stripSkipFlags: false, dataDir: deps.dataDir, envKeep: deps.envKeep?.() ?? [] });
    peer = new RpcPeer(proc.io, { requestTimeoutMs: HANDSHAKE_TIMEOUT_MS });
    const hello = await peer.request<unknown>('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'legion', title: 'Legion', version: VERSION } }, HANDSHAKE_TIMEOUT_MS);
    const info = (hello as { agentInfo?: { version?: unknown } } | null)?.agentInfo;
    return typeof info?.version === 'string' ? parseVersion(info.version) : undefined;
  } catch {
    return undefined;
  } finally {
    try { peer?.close('done'); } catch { /* already closed */ }
    await proc?.stop(1500).catch(() => undefined);
  }
}
