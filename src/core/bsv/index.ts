/**
 * BSV mode: the optional BSV Dev Kit toggle. Knowledge, a read-only wallet STATUS probe, and the safety infrastructure for later.
 * There are NO keys here, and nothing that signs, spends, inscribes or broadcasts: the only wallet contact is wallet-probe.ts
 * (four harmless questions, loopback only), and the only agent tool is the read-only `bsv_status`.
 * What the toggle does: shows the Assayer (the state filter in server.ts reads the flag), loads the bundled BSV
 * knowledge pack into the knowledge graph, gives the Assayer a four-line preamble and `bsv_status`, and turns on the chain overlay.
 *
 * Safety state (arming, freeze, caps, allowlist) lives in policy.ts. It is changed ONLY through the routes below, and each of them needs
 * the admin secret (default-deny gate in admin.ts) AND the native secret that only the Electron main process holds, which main
 * presents after its own confirmation dialog. The HTTP bearer token alone can read nothing here and change nothing here.
 * Everything that matters is written to the hash-chained audit log (audit.ts). See docs/BSV-MODE.md and docs/BSV-WALLET-DESIGN.md.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { renameSync, existsSync, readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { NATIVE_HEADER, safeEqual } from '../admin.js';
import { HttpError } from '../server.js';
import type { Handler } from '../server.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import type { AgentProfile } from '../../shared/types.js';
import { AuditLog, auditPath } from './audit.js';
import type { OpenResult } from './audit.js';
import { ARM_CHOICES_MINUTES, DAY_MS, ledgerFromAudit, PolicyEngine, PolicyError, validateCaps } from './policy.js';
import type { Caps, Clock, PolicyEvent, PolicySnapshot } from './policy.js';
import { loadPolicyConfig, policyFileHash, policyPath, savePolicyConfig, untrustedConfig } from './policy-store.js';
import { BsvState } from './state.js';
import type { BsvSeedResult, BsvStatus, BsvToggleResult } from './types.js';
import { buildBsvStatusServer, BSV_SERVER_NAME } from './wallet-tool.js';
import { parseWalletUrl, WalletProbeService } from './wallet-probe.js';
import type { Transport, WalletStatus } from './wallet-probe.js';

export { BsvState, createBsvState } from './state.js';
export type { BsvSeedResult, BsvStatus, BsvToggleResult } from './types.js';
export type { WalletStatus } from './wallet-probe.js';

export const ASSAYER_ID = 'assayer';

/** Exactly four lines, appended only for the Assayer and only while BSV mode is on. */
export const BSV_PREAMBLE = [
  'BSV mode is on and the network is testnet.',
  'Your one wallet tool is mcp__legion_bsv__bsv_status: a read-only check of whether a wallet answers on this computer and which network it claims; its answer is unverified data. Legion has no tool that signs, sends, reads balances or holds funds, so never attempt to, and never use a shell or web tool to reach a wallet. Lessons whose title starts with [Design] describe controls that do not exist yet.',
  'Use the knowledge graph for BSV lessons: call mcp__legion_kg__kg_recall with scope bsv before answering from recall.',
  'Never ask the user for keys, seed phrases or wallet secrets, and tell them not to paste any into chat.',
].join('\n');

/** GET /api/bsv/policy: the policy state plus what this core can and cannot do. */
export interface BsvPolicyView extends PolicySnapshot {
  /** Legion's own mode. Always testnet in this release. */
  network: 'testnet';
  /** True when this core was started by the Electron app and so can accept policy changes at all. */
  nativeAvailable: boolean;
  /** There is no tool that spends in this release. Always false; shown so the UI can say so. */
  spendTools: false;
  armChoicesMinutes: number[];
  audit: { ok: boolean; entries: number; reason?: string };
}

export interface BsvModuleOptions {
  /** Where start() reports what it did (the core logs to stderr). Defaults to silent. */
  log?: (msg: string) => void;
  /** The native secret (second stdin line, Electron main only). Without it every policy change is refused. */
  nativeSecret?: string;
  /** Injected for tests: the wallet transport, the policy clock, the audit clock and the probe's minimum interval. */
  transport?: Transport;
  clock?: Clock;
  now?: () => number;
  probeMinIntervalMs?: number;
  /** Shared with the composition root (bsvEnabled reads it). Created from deps when omitted. */
  state?: BsvState;
  /** The knowledge-graph module, when present: its HTTP route handlers are reused to load the seed and count nodes. */
  kg?: CoreModule;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createBsvModule(deps: ModuleDeps, opts: BsvModuleOptions = {}): CoreModule & { state: BsvState; policy: PolicyEngine; audit: AuditLog; probe: WalletProbeService; ensureSeed: () => Promise<BsvSeedResult>; start: () => Promise<void> } {
  const state = opts.state ?? new BsvState({ dataDir: deps.dataDir, config: deps.config });
  const log = opts.log ?? (() => undefined);

  // ---- audit log, policy engine and wallet probe (nothing here can sign or spend; there is no spend tool)
  const audit = new AuditLog(auditPath(deps.dataDir), { now: opts.now });
  const policyFile = policyPath(deps.dataDir);
  const loaded = loadPolicyConfig(policyFile);
  let opened: OpenResult | undefined;
  let auditProblem: string | undefined;
  try { opened = audit.open(); } catch (e) { auditProblem = `the audit log could not be opened: ${e instanceof Error ? e.message : String(e)}`; }
  const note = (agent: string, tool: string, decision: string, reason?: string, fields?: Record<string, unknown>, task?: string) => {
    try { audit.append({ agent, task, tool, decision, reason, fields }); } catch (e) { log(`BSV audit write failed: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // The wallet probe never contacts anything until the owner presses Connect (in memory only), so it can be built first: a freeze at start
  // disconnects it, and there is nothing yet to disconnect.
  const probe = new WalletProbeService({ getUrl: () => state.walletUrl, enabled: () => state.enabled, transport: opts.transport, now: opts.now, minIntervalMs: opts.probeMinIntervalMs });

  // ---- the policy file is checked against what Legion itself last wrote (sha256, recorded in the audit log). Anything else is tampering.
  /** The hash Legion last wrote, from the audit log (current file, archives and kept evidence). null = Legion never wrote one that the log remembers. */
  const recordedPolicyHash = (): string | null => {
    try {
      const e = audit.entries((x) => x.tool === 'policy' && x.decision === 'saved').pop();
      const h = e?.fields.policyHash;
      return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h) ? h : null;
    } catch { return null; }
  };
  let lastPolicyHash: string | null = recordedPolicyHash();
  /** Moves a policy file we no longer trust aside as evidence. At most 10 are kept: past that the foreign file is simply replaced, so a loop cannot fill the disk. */
  const keepEvidence = (): string | undefined => {
    try {
      if (!existsSync(policyFile)) return undefined;
      const base = `${basename(policyFile)}.tampered-`;
      const have = readdirSync(dirname(policyFile)).filter((n) => n.startsWith(base)).length;
      if (have >= 10) return undefined;
      const to = `${policyFile}.tampered-${(opts.now ?? Date.now)()}`;
      renameSync(policyFile, to);
      return basename(to);
    } catch { return undefined; }
  };
  const persistPolicy = (cfg = policy.config()): boolean => {
    try {
      const h = savePolicyConfig(policyFile, cfg);
      lastPolicyHash = h;
      note('legion', 'policy', 'saved', undefined, { policyHash: h });
      return true;
    } catch (e) { log(`BSV policy not saved: ${e instanceof Error ? e.message : String(e)}`); return false; }
  };
  const onPolicyEvent = (e: PolicyEvent) => {
    switch (e.type) {
      case 'armed': return note('owner', 'policy', 'armed', 'live funds armed (nothing in this version can spend)', { minutes: e.minutes, until: new Date(e.until).toISOString() });
      case 'disarmed': return note('owner', 'policy', 'disarmed', e.reason);
      case 'frozen': probe.disconnect(); return note('owner', 'policy', 'frozen', e.reason, { denied: e.denied.length, unknown: e.unknown.length });
      case 'unfrozen': return note('owner', 'policy', 'unfrozen');
      case 'caps': return note('owner', 'policy', 'caps-changed', undefined, { ...e.caps });
      case 'allowlist': return note('owner', 'policy', 'allowlist-changed', undefined, { size: e.size });
      case 'decision': return note(e.agentId, 'spend-policy', e.verdict === 'deny' ? 'denied' : 'needs-approval', e.reasons.join('; ') || undefined, { requestId: e.requestId, totalSats: e.totalSats, network: e.network, duplicate: e.duplicate }, e.taskId);
      case 'approved': return note('owner', 'spend-policy', 'approved', undefined, { requestId: e.requestId, totalSats: e.totalSats });
      case 'settled': return note('legion', 'spend-policy', e.outcome === 'executed' ? 'executed' : e.outcome, undefined, { requestId: e.requestId, sats: e.sats });
      case 'expired': return note('legion', 'spend-policy', 'expired', undefined, { requestId: e.requestId });
      case 'resolved': return note('owner', 'spend-policy', 'resolved', undefined, { requestId: e.requestId, outcome: e.outcome });
    }
  };
  // The rolling 24 h window is rebuilt from the audit log by TIME (every file of the log, newest to oldest, bounded), not from the last N lines:
  // a flood of status notes, a rotation or a restored file cannot push a spend out of it.
  const clockNow = () => (opts.now ?? Date.now)();
  const history = (() => { try { return opened || !auditProblem ? ledgerFromAudit(audit.entries((e) => e.decision === 'executed', clockNow() - DAY_MS - 3_600_000)) : []; } catch { return []; } })();

  // fail closed at start: a policy file that is unreadable, was not written by Legion, or changed since Legion wrote it loads as DEFAULT limits, an empty
  // allowlist and FROZEN, and the file is kept aside as evidence
  const fileProblem = loaded.unreadable ? 'the policy file could not be read'
    : loaded.hash !== null && lastPolicyHash === null ? 'the policy file has no record of being written by Legion (it was created or replaced outside it)'
    : loaded.hash !== null && lastPolicyHash !== loaded.hash ? 'the policy file changed outside Legion since it was last saved'
    : loaded.hash === null && lastPolicyHash !== null ? 'the policy file is missing although Legion saved one'
    : undefined;
  const evidence = fileProblem && loaded.hash !== null ? keepEvidence() : undefined;
  const policy = new PolicyEngine({ config: fileProblem ? untrustedConfig(fileProblem) : loaded.config, clock: opts.clock, ledger: history, onEvent: onPolicyEvent });
  const startupFreeze = auditProblem ?? (opened && !opened.ok ? `the audit log failed verification (${opened.tamper?.reason ?? 'unknown'}); the evidence was kept` : undefined) ?? fileProblem;
  if (fileProblem) note('legion', 'policy', 'file-tampered', fileProblem, { keptAs: evidence ?? null });
  if (startupFreeze && !policy.isFrozen) { policy.freeze(startupFreeze); log(`BSV frozen at start: ${startupFreeze}`); }
  if (startupFreeze) persistPolicy();

  /**
   * Runs before anything reads or changes the policy at run time: if the file on disk is not the one Legion last wrote, the chain freezes now,
   * the foreign file is kept aside, and Legion's own copy (in memory) is written back. Cheap (one small read), so it is not rate limited.
   */
  let checking = false;
  const checkPolicyFile = (): void => {
    if (checking) return;
    checking = true;
    try {
      const now = policyFileHash(policyFile);
      if (now === lastPolicyHash) return;
      const why = now === null ? 'the policy file was removed while Legion was running' : now === undefined ? 'the policy file can no longer be read' : 'the policy file changed outside Legion while it was running';
      const kept = keepEvidence();
      policy.freeze(why);
      note('legion', 'policy', 'file-tampered', why, { keptAs: kept ?? null });
      persistPolicy();
    } finally { checking = false; }
  };

  probe.onChange = (prev, next) => {
    note('legion', 'bsv_wallet', 'probe', next.message, { network: next.network, reachable: next.reachable, authenticated: next.authenticated, previous: prev.probed ? prev.network : 'none' });
    // A "changed" report from a wallet is an unverified claim. It may only make Legion MORE careful (disarm); it never raises a limit, lifts a freeze or resets anything.
    if (prev.probed && prev.network !== next.network) policy.disarm('the wallet reported a different network than before');
  };
  const statusCalls = new Map<string, number>();

  /** Every policy change needs the native secret, in addition to the admin secret the gate already checked. */
  const requireNative = (req: { headers?: Record<string, string | string[] | undefined> } | undefined) => {
    if (!opts.nativeSecret) throw new HttpError(403, 'native_unavailable: policy changes need the Legion app window (this core was not started by it)');
    const given = req?.headers?.[NATIVE_HEADER];
    if (typeof given !== 'string' || !safeEqual(given, opts.nativeSecret)) throw new HttpError(403, 'native_confirmation_required: policy changes come only from the app after its confirmation dialog');
  };
  const policyView = (): BsvPolicyView => {
    checkPolicyFile();
    let rep: { ok: boolean; entries: number; reason?: string };
    try { const v = audit.verify(); rep = { ok: v.ok, entries: v.entries, ...(v.reason ? { reason: v.reason } : {}) }; } catch { rep = { ok: false, entries: 0, reason: 'unreadable' }; }
    return { ...policy.snapshot(), network: 'testnet', nativeAvailable: !!opts.nativeSecret, spendTools: false, armChoicesMinutes: [...ARM_CHOICES_MINUTES], audit: rep };
  };
  const policyErr = (e: unknown): never => {
    if (e instanceof HttpError) throw e;
    if (e instanceof PolicyError) throw new HttpError(409, e.message);
    throw e;
  };

  // The Assayer is hidden while BSV mode is off. The engine asks this before it starts a task and again when a queued job is about to run.
  const bridge = (deps.engine as { bridge?: { isVisible: (a: AgentProfile) => boolean } } | undefined)?.bridge;
  if (bridge) bridge.isVisible = (a) => a.requires !== 'bsv' || state.enabled;

  // The kg module is reached through its own route semantics (no edits to src/core/kg): record its handlers.
  const kgHandlers = new Map<string, Handler>();
  opts.kg?.routes?.((method, pattern, handler) => { kgHandlers.set(`${method} ${pattern}`, handler); });
  const kgCall = async (method: string, pattern: string): Promise<any> => {
    const h = kgHandlers.get(`${method} ${pattern}`);
    if (!h) throw new Error(`knowledge graph route ${method} ${pattern} is not available`);
    return h({ req: undefined as never, res: undefined as never, url: new URL('http://127.0.0.1' + pattern), params: [], body: undefined });
  };

  /** The agents behind the BSV gate (the seeded Assayer). Found by `requires`, not by id. */
  const gated = (): AgentProfile[] => deps.store.listAgents().filter((a) => a.requires === 'bsv');

  async function bsvNodes(): Promise<number> {
    if (!kgHandlers.size || !state.enabled) return 0;
    try { return Number((await kgCall('GET', '/api/kg/stats')).byScope?.bsv ?? 0) || 0; } catch { return 0; }
  }

  async function status(): Promise<BsvStatus> {
    const nodes = await bsvNodes();
    return {
      enabled: state.enabled, network: state.network,
      assayerAvailable: gated().length > 0,
      knowledgeLoaded: nodes > 0, knowledgeNodes: nodes,
    };
  }

  /**
   * Loads or upgrades the bundled pack through the kg seed route, which decides by the index node's recorded pack version (not by
   * "any bsv node exists", so a human note in scope bsv cannot block seeding). Human edits are never overwritten.
   * Never throws: a missing pack must not block the toggle.
   */
  async function ensureSeed(): Promise<BsvSeedResult> {
    if (!kgHandlers.size) return { status: 'no-kg' };
    try {
      const { ok: _ok, ...result } = await kgCall('POST', '/api/kg/seed/bsv');
      return result as BsvSeedResult;
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
  }

  // Toggles are serialised so two quick clicks cannot interleave a seed load with a flip.
  let lock: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => undefined);
    return run;
  };

  /**
   * Core startup: when BSV mode is already on, bring the pack up to the bundled version (idempotent: it does nothing at the same
   * version). Never blocks boot and never throws: a failure is logged and the next toggle or Load button tries again.
   */
  async function start(): Promise<void> {
    try {
      if (!state.enabled) return;
      const r = await exclusive(ensureSeed); // serialised with the toggle, so a click during start cannot interleave
      if (r.status === 'error') log(`BSV knowledge pack not loaded: ${r.error ?? 'unknown error'}`);
      else if (r.status === 'no-kg') log('BSV knowledge pack not loaded: the knowledge graph module is not present');
      else if (r.status === 'already-loaded') log(`BSV knowledge pack already at version ${r.to ?? '?'}`);
      else log(`BSV knowledge pack ${r.status} (v${r.from ?? 0} -> v${r.to ?? '?'}): ${r.created ?? 0} added, ${r.updated ?? 0} updated, ${r.edges ?? 0} links${r.skippedEdited?.length ? `, ${r.skippedEdited.length} edited by you left alone` : ''}${r.skippedRemoved?.length ? `, ${r.skippedRemoved.length} you deleted stay deleted` : ''}`);
    } catch (e) {
      try { log(`BSV knowledge pack not loaded: ${e instanceof Error ? e.message : String(e)}`); } catch { /* logging must not throw either */ }
    }
  }

  return {
    id: 'bsv',
    state,
    ensureSeed,
    start,
    // keyed on the gate, not on an id string: a bot a user happens to name "Assayer" is an ordinary bot
    preamble: (agent: AgentProfile) => (agent.requires === 'bsv' && state.enabled ? BSV_PREAMBLE : ''),
    mcpServers: (agent: AgentProfile, job): Record<string, McpServerConfig> => (agent.requires === 'bsv' && state.enabled
      ? { [BSV_SERVER_NAME]: buildBsvStatusServer({ agent, job, state, policy, probe, audit, calls: statusCalls, checkPolicyFile }) }
      : {}),
    policy, audit, probe,
    routes: (add) => {
      // ---- read-only views (admin only by the default-deny gate)
      // Contacts nothing unless the owner pressed Connect in this launch (the probe answers "not connected" from memory).
      add('GET', '/api/bsv/wallet', ({ url }): Promise<WalletStatus> | WalletStatus => (url.searchParams.get('cached') === '1' ? probe.cached() : probe.check()));
      // First contact with a wallet: the address is typed by the owner and confirmed in a native dialog by main (native secret). No default address exists.
      add('POST', '/api/bsv/wallet/connect', async ({ req, body }): Promise<WalletStatus> => {
        requireNative(req);
        checkPolicyFile();
        if (!state.enabled) throw new HttpError(409, 'Turn BSV mode on first.');
        if (policy.isFrozen) throw new HttpError(409, 'The chain is frozen, so Legion does not contact a wallet. Unfreeze it first.');
        const raw = isObj(body) ? body.url : undefined;
        const target = parseWalletUrl(raw);
        if (!target.ok) throw new HttpError(400, `wallet address refused: ${target.reason}`);
        try { state.setWalletUrl(raw as string); } catch (e) { log(`BSV wallet address not saved: ${e instanceof Error ? e.message : String(e)}`); }
        const c = probe.connect();
        if (!c.ok) throw new HttpError(400, c.reason);
        note('owner', 'bsv_wallet', 'connected', 'the owner pressed Connect; the wallet is asked four read-only questions', { address: target.display });
        return probe.check({ fresh: true });
      });
      // Disconnect only makes Legion quieter, so it needs the admin secret (the gate) but not the native dialog.
      add('POST', '/api/bsv/wallet/disconnect', (): WalletStatus => {
        if (probe.connected) note('owner', 'bsv_wallet', 'disconnected');
        probe.disconnect();
        return probe.cached();
      });
      add('GET', '/api/bsv/policy', () => policyView());
      add('GET', '/api/bsv/audit', ({ url }) => {
        const num = (k: string): number | undefined => { const v = url.searchParams.get(k); return v !== null && /^\d{1,9}$/.test(v) ? Number(v) : undefined; };
        return audit.read({ limit: num('limit'), before: num('before') });
      });
      // ---- policy changes: admin secret (gate) + native secret (here). Each is one synchronous step, then saved, then logged by the engine's event.
      add('POST', '/api/bsv/policy/arm', ({ req, body }) => {
        requireNative(req);
        checkPolicyFile();
        try {
          if (!state.enabled) throw new HttpError(409, 'Turn BSV mode on first.');
          const minutes = (body as { minutes?: unknown } | undefined)?.minutes;
          if (typeof minutes !== 'number' || !(ARM_CHOICES_MINUTES as readonly number[]).includes(minutes)) throw new HttpError(400, `minutes must be one of ${ARM_CHOICES_MINUTES.join(', ')}`);
          policy.arm(minutes);
          return policyView();
        } catch (e) { return policyErr(e); }
      });
      add('POST', '/api/bsv/policy/disarm', ({ req }) => { requireNative(req); policy.disarm(); return policyView(); });
      // Freeze only makes Legion safer, so it needs NO native confirmation and is open to the bearer token too (admin.ts CLIENT_ROUTES): a core with no
      // Electron app (headless) can still be frozen. Everything that loosens something (arm, unfreeze, caps, allowlist, connect) still needs the app.
      add('POST', '/api/bsv/policy/freeze', ({ body }) => {
        const reason = typeof (body as { reason?: unknown } | undefined)?.reason === 'string' ? (body as { reason: string }).reason : 'frozen by the owner';
        policy.freeze(reason); // in memory first: a freeze must never wait on the disk
        const saved = persistPolicy();
        return { ...policyView(), persisted: saved };
      });
      add('POST', '/api/bsv/policy/unfreeze', ({ req }) => {
        requireNative(req);
        checkPolicyFile();
        if (!policy.isFrozen) return policyView();
        // saved first: if the disk refuses, the chain stays frozen in memory and on disk
        if (!persistPolicy({ ...policy.config(), frozen: null })) throw new HttpError(500, 'Could not save the change, so the chain stays frozen.');
        policy.unfreeze();
        return policyView();
      });
      add('POST', '/api/bsv/policy/caps', ({ req, body }) => {
        requireNative(req);
        checkPolicyFile();
        try {
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'body {perTxSats?, perSessionSats?, per24hSats?, maxOutputs?, maxFeeSats?} required');
          const next = validateCaps(body as Partial<Caps>, policy.config().caps); // refuses anything above the hard ceiling
          if (!persistPolicy({ ...policy.config(), caps: next })) throw new HttpError(500, 'Could not save the change.');
          policy.setCaps(body as Partial<Caps>);
          return policyView();
        } catch (e) { return policyErr(e); }
      });
      add('POST', '/api/bsv/policy/allowlist', ({ req, body }) => {
        requireNative(req);
        checkPolicyFile();
        try {
          const list = (body as { list?: unknown } | undefined)?.list;
          const before = policy.config();
          policy.setAllowlist(list); // validates; emits the event
          if (!persistPolicy()) { policy.setAllowlist(before.allowlist); throw new HttpError(500, 'Could not save the change.'); }
          return policyView();
        } catch (e) { return policyErr(e); }
      });
      add('GET', '/api/bsv', () => status());
      add('POST', '/api/bsv', ({ body }) => exclusive(async (): Promise<BsvToggleResult> => {
        if (!isObj(body) || typeof body.enabled !== 'boolean') throw new HttpError(400, 'body {enabled:boolean} required');
        let changed: boolean;
        try { changed = state.set(body.enabled); } catch (e) {
          throw new HttpError(500, `Could not save the BSV setting: ${e instanceof Error ? e.message : String(e)}`);
        }
        let seed: BsvSeedResult | undefined;
        // Turning OFF: jobs of the Assayer that are still waiting in the queue are cancelled now (the engine also re-checks when a job starts).
        if (!body.enabled) {
          try { (deps.engine as { cancelHiddenQueued?: () => string[] }).cancelHiddenQueued?.(); } catch { /* the start-time check still holds */ }
          // BSV mode off: nothing stays armed, and the wallet is disconnected: turning the mode back on starts disconnected (Connect again)
          policy.disarm('BSV mode turned off');
          probe.disconnect();
        }
        if (changed) note('owner', 'bsv-mode', body.enabled ? 'enabled' : 'disabled');
        if (body.enabled) {
          seed = await ensureSeed();
          // Turning ON: tell open clients the gated agent(s) exist now. Turning OFF has no event (the frozen event union
          // has no "hidden"), so clients simply refetch /api/state; agent.deleted would be wrong here.
          if (changed) for (const a of gated()) deps.bus.emit({ type: 'agent.updated', agent: a });
        }
        return { ...(await status()), ...(seed ? { seed } : {}) };
      }));
    },
  };
}
