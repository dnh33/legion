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
 *  - `hermes acp` serves through the gateway agent (GatewayACPAgent, acp_adapter/server.py:245-248, gateway_server.py). Checked 2026-10-22 in the
 *    local clone: v0.22.1 has it (`git show v0.22.1:acp_adapter/server.py`, lines 254-257), v0.22.2 does not (no gateway_server.py), so the
 *    version line is NOT monotone, and the clone's history starts at f974134f36, so it cannot date the change by commit. The clone has no
 *    v0.22.3 tag. v0.22.3 contains it according to one GitHub compare call (f974134f36...v0.22.3, "ahead", behind_by 0) that was NOT
 *    re-checked locally. 0.22.3 is therefore a safe floor (0.22.2 is known to lack the server), not a proven first release.
 *    A run against a real Hermes confirms it.
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
import { BUILTIN_HERMES, type AcpDetection, type AcpEntry } from '../../shared/acp-view.js';
import { VERSION } from '../../shared/config.js';
import { redact } from '../log/redact.js';
import { asJson, CONTAINED_PROFILE, why, type Out } from './contained.js';
import { AgentLaunchError, resolveCommand, runAgentCli, startAgentProcess } from './process.js';
import { RpcPeer } from './rpc.js';
import { PROTOCOL_VERSION } from './session.js';

/**
 * `min`: a safe floor for the Hermes with the gateway ACP server this runtime talks to (see above; unconfirmed until the live walk). `testedWith`: the version the runtime was built and
 * checked against. It is the release that holds the source that was studied; update it after the live walk.
 */
export const TESTED_HERMES = { min: '0.22.3', testedWith: '0.22.3' } as const;
/** Where Hermes itself says to get it (its README and installation page). Shown without the scheme. */
export const HERMES_INSTALL_HOST = 'hermes-agent.nousresearch.com';

export const DETECT_TTL_MS = 10 * 60 * 1000;
/** `acp --check` imports Python packages: a cold disk on Windows can take a while. */
export const CHECK_TIMEOUT_MS = 30_000;
const GET_TIMEOUT_MS = 20_000;
/** Hermes starts Python, so its handshake gets longer than another agent host's. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
const OTHER_HANDSHAKE_TIMEOUT_MS = 8_000;
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
  /** Set by `peekDetection`: the program is on PATH but nothing has been run for it (so `checked` is false). */
  pending?: true;
  /** Hermes: `acp --check` passed. Another agent host: it answered the `initialize` handshake. */
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
  /** Does an agent use this host, or has the owner chosen it? Until then its Doctor rows are plain information, never amber or red. Default: yes. */
  inUse?: (entryId: string) => boolean;
  /** Is the "ignore Hermes's skip-approval settings" switch on? The Doctor reads the environment Hermes would get with it. Default: off. */
  stripSkipFlags?: () => boolean;
  /** The environment Legion starts Hermes from. Default: its own. */
  env?: NodeJS.ProcessEnv;
  /** Test hooks. */
  now?: () => number;
  run?: typeof runAgentCli;
  /** Test hook: how long the `initialize` handshake may take (ms). */
  handshakeTimeoutMs?: number;
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
const lastWaits = new Map<string, { permissionWaitMs: number; toolWaitMs: number; at: number }>();
const waitsInflight = new Map<string, Promise<void>>();

/** The PATH lookup of an entry, found or not, for as long as a detection lasts: the model list and the settings view ask on every call and must not walk PATH each time. */
const lookups = new Map<string, { at: number; value: { path: string } | { detection: AgentDetection } }>();

export function forgetDetections(): void { lookups.clear(); cache.clear(); inflight.clear(); lastWaits.clear(); waitsInflight.clear(); notes.clear(); }

const keyOf = (e: AcpEntry): string => JSON.stringify([e.id, e.command, e.args, e.contained === true, Object.entries(e.env ?? {}).sort()]);

/** The values the engine reads when it raises a card: undefined until the agent has been checked once. */
export function agentWaits(entry: Pick<AcpEntry, 'id'>): { permissionWaitMs: number; toolWaitMs: number } | undefined {
  const w = lastWaits.get(entry.id);
  return w ? { permissionWaitMs: w.permissionWaitMs, toolWaitMs: w.toolWaitMs } : undefined;
}

/** Getters for the engine's two wait settings, read at each request or run for the entry that asks. `undefined` means "the agent's default": the values were read from Hermes's own settings, so they apply to Hermes and to no other agent host. */
export function hostWaitSeams(): { permissionWaitMs: (entry: AcpEntry) => number | undefined; toolWaitMs: (entry: AcpEntry) => number | undefined } {
  const of = (pick: 'permissionWaitMs' | 'toolWaitMs') => (e: AcpEntry): number | undefined => (isHermes(e) ? agentWaits(e)?.[pick] : undefined);
  return { permissionWaitMs: of('permissionWaitMs'), toolWaitMs: of('toolWaitMs') };
}

// ---------------------------------------------------------------- detection

/** The built-in entry is the only Hermes: normalizeAcp never lets a custom entry take its id. Hermes's own subcommands go to it alone. */
export const isHermes = (e: AcpEntry): boolean => e.id === BUILTIN_HERMES.id;

/** Probed: an entry only once the owner switched it on (Hermes is off until "Offer Hermes" is turned on; a custom command is an arbitrary program). */
export const isProbed = (e: AcpEntry): boolean => e.enabled;

/** The answer of the last check of this entry while it is fresh (10 minutes), else nothing. */
const freshHit = (entry: AcpEntry, now: () => number): AgentDetection | undefined => {
  const hit = cache.get(keyOf(entry));
  return hit && now() - hit.at < DETECT_TTL_MS ? hit.value : undefined;
};

/**
 * What may be known without starting anything: the program is on PATH (a file lookup, no process), and the last check of it while it is
 * fresh. With no fresh check and the program there, `pending` is set (found, not run). Never awaits, never starts a program: the model list,
 * the Doctor at app start and after a settings save use it.
 */
export function peekDetection(entry: AcpEntry, now: () => number = Date.now): AgentDetection {
  if (!isProbed(entry)) return { found: false, checked: false, checkOk: false, detail: `${entry.label} is not checked: it is switched off.` };
  const known = freshHit(entry, now);
  if (known) return known;
  const key = keyOf(entry);
  let hit = lookups.get(key);
  if (!hit || now() - hit.at >= DETECT_TTL_MS) { hit = { at: now(), value: resolveOrExplain(entry) }; lookups.set(key, hit); }
  const looked = hit.value;
  return 'path' in looked ? { found: true, path: looked.path, checked: false, checkOk: false, pending: true, detail: `${entry.label} has not been checked yet.` } : looked.detection;
}

/**
 * What Settings may show for an entry that is switched off: is the program on PATH. A file lookup only, no process, and the answer is
 * kept for as long as a detection lasts. Nothing else is known or asked.
 */
export function lookupAgent(entry: AcpEntry, now: () => number = Date.now): AgentDetection {
  const key = keyOf(entry);
  let hit = lookups.get(key);
  if (!hit || now() - hit.at >= DETECT_TTL_MS) { hit = { at: now(), value: resolveOrExplain(entry) }; lookups.set(key, hit); }
  const looked = hit.value;
  return 'path' in looked ? { found: true, path: looked.path, checked: false, checkOk: false, pending: true, detail: `${entry.label} is on your computer.` } : looked.detection;
}

/** The catalog's view of an entry: on PATH, and whether a fresh check said it does not start. */
export function peekAgent(entry: AcpEntry, now: () => number = Date.now): { found: boolean; startsOk?: boolean } {
  const d = peekDetection(entry, now);
  return { found: d.found, ...(d.found && !d.pending ? { startsOk: d.checkOk } : {}) };
}

/** What the window may know about an entry: the same facts, as the settings view carries them. */
export function toAcpDetection(d: AgentDetection): AcpDetection {
  const state: AcpDetection['state'] = !d.found ? (d.checked ? 'missing' : 'unknown') : d.checked && !d.checkOk ? 'error' : 'found';
  return {
    state, checked: d.checked, ...(d.version ? { version: d.version } : {}),
    ...(d.approvalsMode && d.approvalsMode !== 'unknown' ? { approvalsMode: d.approvalsMode } : {}), detail: d.detail,
  };
}

export function detectAgent(entry: AcpEntry, deps: Partial<AgentHostDeps> & DetectOptions = {}): Promise<AgentDetection> {
  const now = deps.now ?? Date.now;
  if (!isProbed(entry)) return Promise.resolve({ found: false, checked: false, checkOk: false, detail: `${entry.label} is not checked: it is switched off.` });
  const key = keyOf(entry);
  lookups.delete(key); // a check looks at PATH itself: what it finds replaces what the quick view remembered
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
/** A number, or a quoted number (Hermes reads both with int() or float()); anything else is "not set". */
const secondsOf = (v: unknown): number => {
  const n = typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : HERMES_DEFAULT_WAIT_S;
};

/** The program's path, or the detection that says why there is none. A file lookup only. */
function resolveOrExplain(entry: AcpEntry): { path: string } | { detection: AgentDetection } {
  try {
    return { path: resolveCommand(entry.command, { ...process.env, ...(entry.env ?? {}) }) };
  } catch (e) {
    const notFound = e instanceof AgentLaunchError && e.code === 'not-found';
    const detail = notFound
      ? (isHermes(entry) ? `Hermes is not installed. Install it from ${HERMES_INSTALL_HOST}, then check again.` : `${entry.label} was not found on your computer. Check its command in Settings, Agent hosts.`)
      : redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
    return { detection: { found: false, checked: true, checkOk: false, detail } };
  }
}

/** How a Hermes command is run (same lookup and environment as a run) and how one setting is read, through the Contained profile when the entry is contained. */
function hermesTools(entry: AcpEntry, deps: Partial<AgentHostDeps>) {
  const run = deps.run ?? runAgentCli;
  const envKeep = deps.envKeep?.() ?? [];
  const go = (args: string[], timeoutMs: number) => run(entry.command, args, { timeoutMs, cwd: tmpdir(), envKeep, ...(entry.env ? { entryEnv: entry.env } : {}) });
  const prefix = entry.contained ? ['-p', CONTAINED_PROFILE] : [];
  const get = async (key: string): Promise<{ out: Out; value?: unknown }> => {
    const out = await go([...prefix, 'config', 'get', key, '--json'], GET_TIMEOUT_MS);
    const j = out.code === 0 ? asJson(out.stdout) : { ok: false as const };
    return j.ok ? { out, value: j.value } : { out };
  };
  return { go, get };
}

/** Hermes's own waits from the two settings (seconds, default 300), as the two card waits in ms. */
function waitsFrom(perm: unknown, tool: unknown): { permissionWaitMs: number; toolWaitMs: number } {
  const toolSeconds = secondsOf(tool);
  return { permissionWaitMs: secondsOf(perm) * 1000, toolWaitMs: Math.max(Math.floor(toolSeconds * 500), toolSeconds * 1000 - TOOL_MARGIN_MS) };
}

async function probe(entry: AcpEntry, deps: Partial<AgentHostDeps>): Promise<AgentDetection> {
  const label = entry.label;
  const builtin = entry.id === BUILTIN_HERMES.id;
  const looked = resolveOrExplain(entry);
  if (!('path' in looked)) return looked.detection;
  const path = looked.path;
  // Another agent host is only asked to start and answer `initialize`: the check and the settings reads are Hermes's own subcommands
  if (!builtin) {
    const hello = await handshake(entry, deps, deps.handshakeTimeoutMs ?? OTHER_HANDSHAKE_TIMEOUT_MS);
    if (!hello.ok) return { found: true, path, checked: true, checkOk: false, detail: `${label} did not answer when Legion started it.` };
    const seen = hello.version ?? notes.get(entry.id)?.version;
    return { found: true, path, checked: true, checkOk: true, ...(seen ? { version: seen } : {}), detail: `${label} starts.` };
  }
  const { go, get } = hermesTools(entry, deps);

  // The check is about the program, so it goes without the Contained profile: `hermes -p <name> ...` ends in an error when the profile is not
  // there yet (hermes_cli/main.py:630-653, read 2026-10-22), and that is the Contained row's story, not "Hermes does not start".
  const check = await go([...entry.args, '--check'], CHECK_TIMEOUT_MS);
  if (check.code !== 0 || check.timedOut) {
    return { found: true, path, checked: true, checkOk: false, detail: `${label} did not start: ${why(check)}`.slice(0, 400) };
  }

  const [mode, adopt, perm, tool, version] = await Promise.all([
    get('approvals.mode'), get('auth.adopt_external_logins'), get('approvals.timeout'), get('timeouts.mcp.tool_call'),
    handshake(entry, deps, deps.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS),
  ]);

  const approvalsMode = mode.value === undefined ? 'unknown' : modeOf(mode.value);
  const adoptExternalLogins = typeof adopt.value === 'boolean' ? adopt.value : isNotSet(adopt.out) ? true : undefined;
  const { permissionWaitMs, toolWaitMs } = waitsFrom(perm.value, tool.value);
  lastWaits.set(entry.id, { permissionWaitMs, toolWaitMs, at: (deps.now ?? Date.now)() });
  const seenVersion = version.version ?? notes.get(entry.id)?.version;
  return {
    found: true, path, checked: true, checkOk: true, ...(seenVersion ? { version: seenVersion } : {}), approvalsMode,
    ...(adoptExternalLogins !== undefined ? { adoptExternalLogins } : {}), permissionWaitMs, toolWaitMs, detail: `${label} starts.`,
  };
}

/**
 * `initialize` only: no session, no model call, no background service. The agent is stopped at once. Best effort: any failure means "not answered".
 * A contained entry is started without its profile here: the program is the same, and the profile may not exist yet.
 */
async function handshake(entry: AcpEntry, deps: Partial<AgentHostDeps>, timeoutMs: number): Promise<{ ok: boolean; version?: string }> {
  if (!deps.dataDir) return { ok: false };
  let proc: ReturnType<typeof startAgentProcess> | undefined;
  let peer: RpcPeer | undefined;
  try {
    proc = startAgentProcess({ ...entry, contained: false }, { cwd: tmpdir(), stripSkipFlags: false, dataDir: deps.dataDir, envKeep: deps.envKeep?.() ?? [] });
    peer = new RpcPeer(proc.io, { requestTimeoutMs: timeoutMs });
    const hello = await peer.request<unknown>('initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'legion', title: 'Legion', version: VERSION } }, timeoutMs);
    const info = (hello as { agentInfo?: { version?: unknown } } | null)?.agentInfo;
    const version = typeof info?.version === 'string' ? parseVersion(info.version) : undefined;
    return { ok: hello !== undefined && hello !== null, ...(version ? { version } : {}) };
  } catch {
    return { ok: false };
  } finally {
    try { peer?.close('done'); } catch { /* already closed */ }
    await proc?.stop().catch(() => undefined);
  }
}

/**
 * Only Hermes's own two waits (approvals.timeout and the tool-call timeout): two settings reads, no start check and no handshake. Kept 10 minutes.
 * A Hermes run that starts is a good moment for it: the owner chose Hermes, and the first card should already close when Hermes denies it.
 */
export function readAgentWaits(entry: AcpEntry, deps: Partial<AgentHostDeps> = {}): Promise<void> {
  if (!isHermes(entry) || !isProbed(entry)) return Promise.resolve();
  const now = deps.now ?? Date.now;
  const known = lastWaits.get(entry.id);
  if (known && now() - known.at < DETECT_TTL_MS) return Promise.resolve();
  const running = waitsInflight.get(entry.id);
  if (running) return running;
  const p = (async () => {
    if (!('path' in resolveOrExplain(entry))) return; // not on PATH: nothing to ask
    const { get } = hermesTools(entry, deps);
    const [perm, tool] = await Promise.all([get('approvals.timeout'), get('timeouts.mcp.tool_call')]);
    lastWaits.set(entry.id, { ...waitsFrom(perm.value, tool.value), at: now() });
  })().catch(() => undefined).finally(() => { if (waitsInflight.get(entry.id) === p) waitsInflight.delete(entry.id); });
  waitsInflight.set(entry.id, p);
  return p;
}

/**
 * Background warm-up of Hermes's own settings (a user who only uses Claude pays nothing, whatever they clicked on the first-use card). At core
 * start only a roster with an agent that uses Hermes (`inUse`) gets the full check; at a Hermes run start everyone gets at least the two waits, and the full check when an agent uses it. Never a switched-off
 * Hermes, never another agent host.
 */
export function warmHermes(entry: AcpEntry, deps: Partial<AgentHostDeps>, o: { inUse: boolean; runStart: boolean }): Promise<void> {
  if (!isHermes(entry) || !entry.enabled) return Promise.resolve();
  if (o.inUse) return detectAgent(entry, deps).then(() => undefined);
  return o.runStart ? readAgentWaits(entry, deps) : Promise.resolve();
}
