/**
 * The BSV spend policy engine. PURE and SYNCHRONOUS (no I/O, no timers, no network; the clock is injected). It holds no keys and
 * calls no wallet: the spend path asks it, and it answers with a verdict a person then reads. Reading it should answer "what would stop
 * a bad spend?".
 *
 * Two networks, one engine. Testnet and mainnet each have their own caps, allowlist, reservations and ledger (networks.ts holds the
 * table), so testnet traffic never uses up or hides mainnet headroom. What they share is the freeze and the unknown-outcome block.
 * Mainnet is a hard-off switch: `mainnetEnabled` is false by default, lives in the fingerprinted policy file, and only
 * `setMainnetEnabled(true)` (called by the owner-only route) turns it on. `mainnetOff` can only turn it off, so it is the one setter
 * the agent-facing path may call.
 *
 * Shape of the rules:
 *  - There is no "allow". The best answer to a request is `needs_approval`: a human reads a card and confirms. Every spend is manual.
 *  - The engine is synchronous on purpose: check-and-reserve is one step, so two requests in the same tick cannot both fit under a cap
 *    that only one of them fits under. Anything slow (a wallet call) happens AFTER the reservation, and a reservation counts against the
 *    caps until it is settled, denied, expired or resolved by a human.
 *  - Caps (per transaction, per session, rolling 24 h), a recipient allowlist, a maximum number of outputs and a fee ceiling. Defaults are
 *    tiny and every value is clamped to its network's hard caps (`NET[net].hardCaps`), which only a code change can raise (a hand-edited policy file cannot).
 *  - Live funds need arming: `armedUntil` lives in memory only, expires (both a monotonic and a wall clock must agree it is still
 *    valid), and is gone after a restart. One arm covers exactly one mainnet spend: the approval that uses it also consumes it.
 *  - Freeze denies everything pending, disarms, and stays until a person unfreezes it. An approved-but-unsettled spend becomes
 *    "unknown", which blocks every new spend until a human says whether it went out.
 *  - A run that read untrusted content needs one more explicit confirmation than a clean run. An untrusted-content run is never silently allowed.
 *  - Request ids are idempotent: the same id returns the same answer and never reserves twice; the same id with different content is
 *    refused; a used id is never accepted again, so there is no blind retry.
 *  - The decoded transaction that the card is built from must come from Legion's own decoder, never from agent-supplied fields. The
 *    engine checks that the amounts add up (inputs = outputs + fee) so a mislabelled change output cannot hide a payment.
 *
 * Policy state is changed only by calls the module exposes behind the admin secret AND the Electron main process' native
 * confirmation (see index.ts); nothing here reads a file or an HTTP header.
 */
import { createHash } from 'node:crypto';
import { safeId, safeText } from './audit.js';
import { addressNet, NET } from './networks.js';
import type { Caps, Net } from './networks.js';

export type { Caps, Net } from './networks.js';
export type WalletNet = Net | 'unknown';

/** Tiny on purpose: 1,000 sats is a fraction of a cent. TESTNET values only (named so, so nobody reaches for them on a mainnet path); use `NET[net].defaultCaps` for a network chosen at run time. */
export const TESTNET_DEFAULT_CAPS: Readonly<Caps> = NET.test.defaultCaps;
/** The ceiling of every TESTNET cap. Only a code change raises it: a policy file or an API call is clamped (and refused) above it. Mainnet's are `NET.main.hardCaps`. */
export const TESTNET_HARD_CAPS: Readonly<Caps> = NET.test.hardCaps;
export const MAX_MONEY_SATS = 2_100_000_000_000_000;
/** The TESTNET allowlist size; mainnet's is `NET.main.maxAllowlist`. */
export const TESTNET_MAX_ALLOWLIST = NET.test.maxAllowlist;
export const MAX_ARM_MINUTES = 60;
export const ARM_CHOICES_MINUTES = [5, 15, 30, 60] as const;
/** A card nobody answered in this time is denied. */
export const CARD_TTL_MS = 120_000;
/** An approved spend that nobody settled in this time becomes "unknown outcome" (it may have gone out). */
export const EXEC_TTL_MS = 300_000;
export const DAY_MS = 86_400_000;

export interface Clock { wall(): number; mono(): number }
export const systemClock: Clock = { wall: () => Date.now(), mono: () => performance.now() };

export interface FrozenInfo { at: string; reason: string }
export interface NetConfig { caps: Caps; allowlist: string[] }
/**
 * What is persisted (arming and the ledger are not part of it). `nets` is the truth. `caps` and `allowlist` are a read-only mirror of
 * `nets.test` kept for callers written before there were two networks: they are accessors on the prototype, so they are NOT own
 * properties, are dropped by a spread and never reach the file. A caller that deliberately writes `{...config(), caps}` is changing the
 * TESTNET caps (savePolicyConfig reads an own `caps` or `allowlist` that way); anything new should use `nets`.
 */
export interface PolicyConfig {
  nets: Record<Net, NetConfig>;
  frozen: FrozenInfo | null;
  /** The mainnet hard-off switch. False unless the file says exactly `true` and the file passed its fingerprint check (index.ts). */
  mainnetEnabled: boolean;
  readonly caps: Caps;
  readonly allowlist: string[];
}
class PolicyConfigImpl implements PolicyConfig {
  constructor(readonly nets: Record<Net, NetConfig>, readonly frozen: FrozenInfo | null, readonly mainnetEnabled: boolean) {}
  get caps(): Caps { return this.nets.test.caps; }
  get allowlist(): string[] { return this.nets.test.allowlist; }
}
const cloneNets = (n: Record<Net, NetConfig>): Record<Net, NetConfig> => ({
  test: { caps: { ...n.test.caps }, allowlist: [...n.test.allowlist] },
  main: { caps: { ...n.main.caps }, allowlist: [...n.main.allowlist] },
});
/** The one way to make a PolicyConfig: the pieces are copied, so what the caller keeps cannot change what was built. */
export function buildPolicyConfig(nets: Record<Net, NetConfig>, frozen: FrozenInfo | null, mainnetEnabled: boolean): PolicyConfig {
  return new PolicyConfigImpl(cloneNets(nets), frozen ? { ...frozen } : null, mainnetEnabled === true);
}

export interface DecodedOutput {
  recipient: string;
  sats: number;
  /** The decoder says this output returns to the wallet. It does not count as spent, but must balance. */
  change?: boolean;
}
export interface DecodedTx {
  /** Total value of the inputs, from the decoder. Must equal outputs + fee. */
  inputSats: number;
  outputs: DecodedOutput[];
  feeSats: number;
}

export interface SpendRequest {
  requestId: string;
  /** The network the transaction is built for. */
  network: Net;
  /** What the wallet reports, from a fresh status probe. */
  walletNetwork: WalletNet;
  agentId: string;
  taskId: string;
  /** Written by the agent. Shown to the human, labelled as such, never trusted. */
  reason: string;
  /** The run read untrusted content (web, files, chain data, another program's output). */
  tainted: boolean;
  decoded: DecodedTx;
}

export type Confirmation = 'approve' | 'untrusted-content' | 'live-funds';

export interface CardOutput {
  index: number; recipient: string; sats: number; bsv: string; kind: 'payment' | 'change'; allowlisted: boolean;
  /** The network the address's version byte belongs to, or null when the recipient is not a valid address. The dialog shows it next to the card's network. */
  addressNetwork: Net | null;
}
export interface ApprovalCard {
  requestId: string;
  network: Net;
  networkLabel: string;
  agentId: string;
  taskId: string;
  /** The agent's words, sanitised. */
  purpose: string;
  purposeNote: string;
  outputs: CardOutput[];
  fee: { sats: number; bsv: string };
  /** Payments plus fee: what leaves the wallet for good. */
  totalSpendSats: number;
  totalSpendBsv: string;
  remaining: { perTxSats: number; perSessionSats: number; per24hSats: number };
  warnings: string[];
  requiredConfirmations: Confirmation[];
  createdAt: number;
  expiresAt: number;
  /** Binds an approval to exactly this content. */
  hash: string;
}

export type Verdict = 'deny' | 'needs_approval';
/** A fixed vocabulary for every way a request can be refused: the spend path maps these to what an agent may see (the free-text `reasons` never go to an agent). */
export type PolicyCode =
  | 'bad-request' | 'frozen' | 'unknown-outcome-pending' | 'wallet-network-unknown' | 'wallet-network-mismatch'
  | 'mainnet-disabled' | 'not-armed' | 'address-network-mismatch' | 'not-allowlisted' | 'too-many-outputs' | 'fee-too-high' | 'over-cap';
export interface Decision {
  verdict: Verdict;
  requestId: string;
  /** Every failing check, in a fixed order. */
  reasons: string[];
  /** One code per failing check, in the same order (no code is repeated). */
  codes: PolicyCode[];
  /** This id was seen before: the stored answer is returned and nothing was reserved again. */
  duplicate?: boolean;
  requiredConfirmations: Confirmation[];
  card?: ApprovalCard;
}

export type RequestStatus = 'pending' | 'approved' | 'executed' | 'failed' | 'denied' | 'expired' | 'unknown';
const RESERVING: ReadonlySet<RequestStatus> = new Set(['pending', 'approved', 'unknown']);

interface Record_ {
  requestId: string; hash: string; status: RequestStatus; agentId: string; taskId: string; network: Net;
  /** Set only on a seeded unknown record whose net was present but unrecognised (`network` is then `main`, the stricter side). */
  netInvalid?: boolean;
  /** Payments plus fee. */
  totalSats: number; createdAt: number; expiresAt: number; approvedAt?: number; settledAt?: number; actualSats?: number;
  /** The stored answer. Never handed out: callers get a deep copy (see `copyDecision`). */
  decision: Decision;
  /** The confirmations the card needs, frozen at creation and kept apart from `decision`, so nothing a caller holds can lower the bar. */
  required: readonly Confirmation[];
}

/** A deep copy that shares nothing with the original: a caller may do what it likes with it. */
function copyDecision(d: Decision): Decision { return structuredClone(d); }

/** `net` is the network the spend was on; a record without it is a testnet record (older logs never wrote it). */
export interface LedgerRecord { requestId: string; sats: number; at: number; session?: string; net?: LedgerNet }
/** `invalid` marks a net value that is present but not `test` or `main`: it is counted (never dropped) and shown, never treated as testnet. */
export type LedgerNet = Net | 'invalid';
/** A MISSING net is a legacy testnet line; a present but unrecognised one is `invalid`. */
function parseNet(v: unknown): LedgerNet { return v === undefined ? 'test' : v === 'test' || v === 'main' ? v : 'invalid'; }

export type PolicyEvent =
  | { type: 'armed'; until: number; minutes: number }
  | { type: 'disarmed'; reason: string }
  | { type: 'frozen'; reason: string; denied: string[]; unknown: string[] }
  | { type: 'unfrozen' }
  | { type: 'caps'; caps: Caps; net: Net }
  | { type: 'allowlist'; size: number; net: Net }
  | { type: 'mainnet'; enabled: boolean; reason: string }
  | { type: 'voided'; reason: string; ids: string[]; net: Net | 'all' }
  | { type: 'decision'; requestId: string; verdict: Verdict; reasons: string[]; duplicate: boolean; agentId: string; taskId: string; totalSats: number; network: Net }
  | { type: 'approved'; requestId: string; totalSats: number; net: LedgerNet }
  | { type: 'settled'; requestId: string; outcome: string; sats: number | null; net: LedgerNet }
  | { type: 'expired'; requestId: string; net: LedgerNet }
  | { type: 'resolved'; requestId: string; outcome: string; net: LedgerNet };

export interface NetUsage { sessionSats: number; last24hSats: number; reservedSats: number }
export interface NetSnapshot { caps: Caps; hardCaps: Caps; allowlist: string[]; usage: NetUsage; label: string }
export interface PolicySnapshot {
  frozen: FrozenInfo | null;
  /** Live funds armed (mainnet only; one spend, then it is gone). */
  armed: boolean;
  /** Wall-clock ms when arming ends (for display only), or null. */
  armedUntil: number | null;
  remainingMs: number;
  /** The mainnet hard-off switch. */
  mainnetEnabled: boolean;
  /** Per network: caps, hard ceilings, allowlist and usage. Use this. */
  nets: Record<Net, NetSnapshot>;
  /** The testnet values of `nets.test`, kept so callers written before there were two networks still read something true. */
  caps: Caps;
  hardCaps: Caps;
  allowlist: string[];
  usage: NetUsage & { invalidNetRecords: number };
  pending: Array<{ requestId: string; status: RequestStatus; agentId: string; totalSats: number; expiresAt: number; network: Net }>;
  unknown: Array<{ requestId: string; agentId: string; totalSats: number; net: LedgerNet }>;
}

export class PolicyError extends Error { constructor(message: string) { super(message); this.name = 'PolicyError'; } }

const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RECIPIENT = /^[A-Za-z0-9._@:+-]{3,120}$/;

export const isSats = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_MONEY_SATS;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** 123456789 -> "1.23456789". Integer maths only. */
export function fmtBsv(sats: number): string {
  const s = Math.max(0, Math.floor(sats));
  return `${Math.floor(s / 1e8)}.${String(s % 1e8).padStart(8, '0')}`;
}

/** A recipient is an address, a paymail or a public key: a short token of safe characters, no spaces. Comparison is exact (paymails ignore case). No trimming: " abc" is not "abc". */
export function normalizeRecipient(s: unknown): string | undefined {
  if (typeof s !== 'string' || !RECIPIENT.test(s)) return undefined;
  return s.includes('@') ? s.toLowerCase() : s;
}

/** Clamps nothing: returns the caps if every value is an integer in range for `net` (default testnet), else throws naming the field. */
export function validateCaps(c: Partial<Caps>, base?: Caps, net: Net = 'test'): Caps {
  const hard = NET[net].hardCaps;
  const out: Caps = { ...(base ?? NET[net].defaultCaps) };
  for (const [k, v] of Object.entries(c)) {
    if (!(k in hard)) throw new PolicyError(`unknown cap "${safeId(k, 32)}"`);
    const key = k as keyof Caps;
    const min = key === 'maxOutputs' ? 1 : 0;
    if (!isCount(v) || v < min || v > hard[key]) throw new PolicyError(`${key} must be a whole number from ${min} to ${hard[key]}`);
    out[key] = v;
  }
  // the order of the caps is part of the rule: a transaction cap above the session cap would be meaningless
  if (out.perTxSats > out.perSessionSats || out.perSessionSats > out.per24hSats) throw new PolicyError('caps must satisfy per transaction <= per session <= per 24 hours');
  return out;
}

/**
 * Whether a recipient may be on `net`'s allowlist. A recipient that is a valid address of the OTHER network never may (a testnet list
 * holding a mainnet address would pay real money the first time the wallet claims testnet). Mainnet is stricter: only a valid mainnet
 * address (a typo with a bad checksum would otherwise sit in the list unnoticed). Testnet is the same: only a valid testnet address (a paymail or a token is not a base58check address, so it never matches either list).
 */
export function recipientFitsNet(net: Net, recipient: string): boolean {
  const an = addressNet(recipient);
  return an === net;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function sanitizeNet(net: Net, raw: unknown): NetConfig {
  const o = isObj(raw) ? raw : {};
  const info = NET[net];
  const caps: Caps = { ...info.defaultCaps };
  const rc = isObj(o.caps) ? o.caps : {};
  for (const k of Object.keys(info.hardCaps) as Array<keyof Caps>) {
    const v = rc[k];
    const min = k === 'maxOutputs' ? 1 : 0;
    if (isCount(v) && v >= min) caps[k] = Math.min(v, info.hardCaps[k]);
  }
  if (caps.perTxSats > caps.perSessionSats) caps.perTxSats = caps.perSessionSats;
  if (caps.perSessionSats > caps.per24hSats) caps.perSessionSats = caps.per24hSats;
  if (caps.perTxSats > caps.perSessionSats) caps.perTxSats = caps.perSessionSats;
  const allow = new Set<string>();
  if (Array.isArray(o.allowlist)) for (const a of o.allowlist) { const n = normalizeRecipient(a); if (n && recipientFitsNet(net, n) && allow.size < info.maxAllowlist) allow.add(n); }
  return { caps, allowlist: [...allow] };
}

/**
 * What a policy file says, reduced to something safe: unknown fields dropped, caps clamped to each network's hard ceiling, allowlists
 * re-validated per network, `mainnetEnabled` true only when it is exactly `true` in a file of the current shape (a legacy-shaped file never enables it).
 * Versioned one-way migration: a file with a `nets` object is the current shape. A file WITHOUT one (every file written before mainnet
 * existed) holds testnet limits at the top level: they load as `nets.test`, mainnet loads at its defaults and OFF. The old top-level fields are
 * read only when `nets` is absent, so they can never override a choice made later; the file is written in the new shape on the next owner change.
 */
export function sanitizePolicyConfig(raw: unknown): PolicyConfig {
  const o = isObj(raw) ? raw : {};
  const hasNets = isObj(o.nets);
  const n = hasNets ? o.nets as Record<string, unknown> : {};
  const nets: Record<Net, NetConfig> = {
    test: sanitizeNet('test', hasNets ? n.test : { caps: o.caps, allowlist: o.allowlist }),
    main: sanitizeNet('main', hasNets ? n.main : undefined),
  };
  let frozen: FrozenInfo | null = null;
  const f = o.frozen;
  if (f && typeof f === 'object' && !Array.isArray(f)) frozen = { at: safeText((f as { at?: unknown }).at, 40), reason: safeText((f as { reason?: unknown }).reason, 160) || 'frozen' };
  return buildPolicyConfig(nets, frozen, hasNets && o.mainnetEnabled === true); // a legacy-shaped file (no `nets`) never loads mainnet on
}

export const POLICY_FILE_VERSION = 2;

/**
 * What is written to the policy file: the current shape, run through sanitizePolicyConfig so the file never holds more than the engine
 * would load. An OWN `caps` or `allowlist` on `cfg` (not the prototype mirror that config() offers) is a caller written before there were
 * two networks, changing the testnet limits with `{...config(), caps}`; it is applied to the testnet entry and nothing else.
 */
export function policyFileShape(cfg: Partial<PolicyConfig>): Record<string, unknown> {
  const done = (c: PolicyConfig) => ({ version: POLICY_FILE_VERSION, nets: c.nets, mainnetEnabled: c.mainnetEnabled, frozen: c.frozen });
  if (!cfg.nets) return done(sanitizePolicyConfig(cfg)); // a legacy-shaped object
  const own = (k: string) => Object.prototype.hasOwnProperty.call(cfg, k);
  return done(sanitizePolicyConfig({
    nets: { test: { caps: own('caps') ? cfg.caps : cfg.nets.test.caps, allowlist: own('allowlist') ? cfg.allowlist : cfg.nets.test.allowlist }, main: cfg.nets.main },
    frozen: cfg.frozen ?? null, mainnetEnabled: cfg.mainnetEnabled === true,
  }));
}

/** The sha256 that binds a card (and so an approval) to the exact request. */
export function requestHash(r: SpendRequest): string {
  return createHash('sha256').update(JSON.stringify({
    id: r.requestId, net: r.network, agent: r.agentId, task: r.taskId, reason: r.reason, tainted: r.tainted,
    in: r.decoded.inputSats, fee: r.decoded.feeSats, out: r.decoded.outputs.map((o) => [o.recipient, o.sats, !!o.change]),
  })).digest('hex');
}

export interface PolicyOptions {
  /** A saved policy (or the legacy testnet-only shape). Always run through sanitizePolicyConfig. */
  config?: Partial<PolicyConfig>;
  clock?: Clock;
  onEvent?: (e: PolicyEvent) => void;
  /** Executed spends from earlier sessions (rebuilt from the audit log), so a restart does not reset the rolling 24 h cap. */
  ledger?: LedgerRecord[];
  sessionId?: string;
  /** Spends an earlier session left without an outcome (rebuilt from the audit log by the module). Each becomes an `unknown` record: it keeps
   *  its reservation, blocks every new spend on BOTH networks, and is cleared only by `resolveUnknown`. This is not an "allow": nothing here loosens a check. */
  unknown?: Array<{ requestId: string; agentId: string; totalSats: number; net?: unknown }>;
}

/** Does a record of network `rec` count against `net`'s limits? A record of an unrecognised network counts against both (never under-count). */
/** The network a record counts against, as an event or a ledger line says it. */
const recNet = (r: { network: Net; netInvalid?: boolean }): LedgerNet => (r.netInvalid ? 'invalid' : r.network);
const applies = (rec: LedgerNet | undefined, net: Net): boolean => rec === 'invalid' || (rec ?? 'test') === net;

export class PolicyEngine {
  private nets: Record<Net, NetConfig>;
  private mainnetOn: boolean;
  private frozen: FrozenInfo | null;
  private armedUntilWall: number | null = null;
  private armedUntilMono: number | null = null;
  private mainnetOffHook: ((reason: string) => void) | null = null;
  /** The restart seed turned the switch off in memory; the hook (registered later) must still save that. */
  private seedOffPending: string | null = null;
  private readonly requests = new Map<string, Record_>();
  private ledger: LedgerRecord[];
  private readonly clock: Clock;
  private readonly emit: (e: PolicyEvent) => void;
  readonly sessionId: string;

  constructor(o: PolicyOptions = {}) {
    const cfg = sanitizePolicyConfig(o.config);
    this.nets = cloneNets(cfg.nets); this.mainnetOn = cfg.mainnetEnabled; this.frozen = cfg.frozen;
    this.clock = o.clock ?? systemClock;
    this.emit = (e) => { try { o.onEvent?.(e); } catch { /* an observer must not break the policy */ } };
    this.ledger = (o.ledger ?? []).filter((r) => isSats(r.sats) && Number.isFinite(r.at)).map((r) => ({ ...r, ...(r.net === undefined ? {} : { net: parseNet(r.net) }) }));
    this.sessionId = o.sessionId ?? `s${Math.floor(this.clock.wall())}`;
    const now = this.clock.wall();
    let seeds: unknown[] = [];
    try { seeds = Array.isArray(o.unknown) ? [...o.unknown] : []; } catch { seeds = []; } // hostile input: a bad list is dropped, never thrown
    const putUnknown = (id: string, agent: unknown, totalSats: number, net: LedgerNet, why: string) => {
      const decision: Decision = { verdict: 'deny', requestId: id, reasons: [why], codes: ['unknown-outcome-pending'], requiredConfirmations: ['approve'] };
      this.requests.set(id, {
        requestId: id, hash: '', status: 'unknown', agentId: safeId(agent), taskId: '', network: net === 'test' ? 'test' : 'main', ...(net === 'invalid' ? { netInvalid: true } : {}), totalSats,
        createdAt: now, expiresAt: 0, settledAt: now, decision, required: Object.freeze(['approve'] as Confirmation[]),
      });
    };
    let bad = 0;
    // an entry that cannot be read is never dropped: it becomes a placeholder unknown (on the stricter side, mainnet switched off), so the block it stood for stays
    // until the owner resolves it (`invalid-seed-N`). Only an entry that is not even an object has nothing to keep, and it gets the same placeholder.
    const placeholder = (agent: unknown, sats: unknown) => { putUnknown(`invalid-seed-${bad++}`, agent, isSats(sats) ? sats : 0, 'invalid', 'an earlier session left a spend without a known outcome, and its record could not be read'); this.seedMainnetOff(); };
    for (const u0 of seeds) {
      try {
        if (!u0 || typeof u0 !== 'object') { placeholder(undefined, 0); continue; }
        const g = u0 as { requestId?: unknown; agentId?: unknown; totalSats?: unknown; net?: unknown };
        const u = { requestId: g.requestId, agentId: g.agentId, totalSats: g.totalSats, net: g.net }; // each field read once
        if (typeof u.requestId !== 'string' || !REQUEST_ID.test(u.requestId) || !isSats(u.totalSats)) { placeholder(u.agentId, u.totalSats); continue; }
        const dup = this.requests.get(u.requestId);
        if (dup) { if (dup.hash === '' && dup.status === 'unknown' && u.totalSats > dup.totalSats) dup.totalSats = u.totalSats; continue; } // a repeated id keeps the LARGER amount
        const net = parseNet(u.net);
        // an earlier mainnet spend with no known outcome: the switch starts OFF whatever the file said (the owner resolves it, then turns it on again)
        if (net !== 'test') this.seedMainnetOff();
        putUnknown(u.requestId, u.agentId, u.totalSats, net, 'an earlier session left this spend without a known outcome');
      } catch { try { placeholder(undefined, 0); } catch { /* nothing more can be kept */ } }
    }
  }

  private seedMainnetOff(): void {
    if (!this.mainnetOn) return;
    this.mainnetOn = false;
    this.seedOffPending = 'an earlier mainnet spend has no known outcome';
  }

  // ---------------------------------------------------------------- time, arming, freezing

  /** True while arming is valid. Both the monotonic and the wall clock must still be inside the window (a clock set back cannot extend it). */
  isArmed(): boolean {
    this.sweep();
    return this.armedUntilWall !== null;
  }

  /** Expires arming and old cards, and turns an overdue approved spend into "unknown". Called by every public method that reads state. */
  sweep(): void {
    const wall = this.clock.wall(); const mono = this.clock.mono();
    if (this.armedUntilWall !== null && (wall >= this.armedUntilWall || mono >= (this.armedUntilMono as number))) {
      this.armedUntilWall = null; this.armedUntilMono = null;
      this.emit({ type: 'disarmed', reason: 'expired' });
    }
    let mainUnknown = false;
    for (const r of this.requests.values()) {
      if (r.status === 'pending' && wall >= r.expiresAt) { r.status = 'expired'; r.settledAt = wall; this.emit({ type: 'expired', requestId: r.requestId, net: recNet(r) }); }
      else if (r.status === 'approved' && wall >= (r.approvedAt ?? 0) + EXEC_TTL_MS) { r.status = 'unknown'; r.settledAt = wall; mainUnknown ||= r.network === 'main'; this.emit({ type: 'settled', requestId: r.requestId, outcome: 'unknown', sats: null, net: recNet(r) }); }
    }
    if (mainUnknown) this.mainnetOff('a mainnet spend has an unknown outcome');
  }

  /** Arms live funds: ONE mainnet spend may then be approved, and the approval that uses the arm also ends it. Needs the switch on and the chain not frozen. */
  arm(minutes: number): { until: number } {
    this.sweep();
    if (this.frozen) throw new PolicyError('the chain is frozen: unfreeze it first');
    if (!this.mainnetOn) throw new PolicyError('mainnet is switched off: the owner turns it on first');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_ARM_MINUTES) throw new PolicyError(`arm for 1 to ${MAX_ARM_MINUTES} whole minutes`);
    const ms = minutes * 60_000;
    this.armedUntilWall = this.clock.wall() + ms;
    this.armedUntilMono = this.clock.mono() + ms;
    this.emit({ type: 'armed', until: this.armedUntilWall, minutes });
    return { until: this.armedUntilWall };
  }

  disarm(reason = 'disarmed by the owner'): void {
    if (this.armedUntilWall === null) return;
    this.armedUntilWall = null; this.armedUntilMono = null;
    this.emit({ type: 'disarmed', reason });
  }

  /** Denies every pending card, disarms, and stays frozen until `unfreeze`. Approved-but-unsettled spends become unknown (and a mainnet one switches mainnet off). Idempotent. */
  freeze(reason = 'frozen by the owner'): { denied: string[]; unknown: string[] } {
    this.sweep();
    const denied: string[] = []; const unknown: string[] = [];
    let mainUnknown = false;
    const wall = this.clock.wall();
    for (const r of this.requests.values()) {
      if (r.status === 'pending') { r.status = 'denied'; r.settledAt = wall; denied.push(r.requestId); }
      else if (r.status === 'approved') { r.status = 'unknown'; r.settledAt = wall; unknown.push(r.requestId); mainUnknown ||= r.network === 'main'; }
    }
    this.armedUntilWall = null; this.armedUntilMono = null;
    const was = this.frozen;
    this.frozen = was ?? { at: new Date(wall).toISOString(), reason: safeText(reason, 160) || 'frozen' };
    this.emit({ type: 'frozen', reason: this.frozen.reason, denied: [...denied], unknown: [...unknown] });
    if (mainUnknown) this.mainnetOff('a mainnet spend has an unknown outcome');
    return { denied, unknown };
  }

  unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = null;
    this.emit({ type: 'unfrozen' });
  }

  get isFrozen(): boolean { return this.frozen !== null; }

  // ---------------------------------------------------------------- the mainnet switch

  get mainnetEnabled(): boolean { return this.mainnetOn; }

  /**
   * Turns mainnet ON. Only the owner-only route calls this (behind the admin secret and the native secret, after a native dialog). Refused
   * while the chain is frozen. `false` is the same as `mainnetOff`.
   */
  setMainnetEnabled(enabled: boolean): void {
    if (enabled === false) { this.mainnetOff('switched off by the owner'); return; }
    if (enabled !== true) throw new PolicyError('mainnetEnabled must be true or false');
    this.sweep();
    if (this.frozen) throw new PolicyError('the chain is frozen: unfreeze it first');
    if (this.mainnetOn) return;
    this.mainnetOn = true;
    this.disarm('mainnet switched on: arming starts from zero'); // an arm from before the switch (it was refused, but never rely on that) cannot carry over
    this.emit({ type: 'mainnet', enabled: true, reason: 'switched on by the owner' });
  }

  /**
   * Turns mainnet OFF, disarms and voids every pending mainnet card. It can only make things safer, so it is the one switch the spend path
   * may touch. Returns true when it was on. The registered hook (see `setMainnetOffHook`) runs after the state change, to save the file.
   */
  mainnetOff(reason = 'mainnet switched off'): boolean {
    const was = this.mainnetOn;
    this.mainnetOn = false; // in memory first: this never waits on a disk
    const why = safeText(reason, 160) || 'mainnet switched off';
    this.disarm(why);
    this.voidPending(why, 'main');
    if (was) {
      this.emit({ type: 'mainnet', enabled: false, reason: why });
      try { this.mainnetOffHook?.(why); } catch { /* saving the file must not undo a safety step */ }
    }
    return was;
  }

  /** Registers what runs after the switch goes from on to off (the module saves the policy file and writes the audit line). One hook; a later call replaces it. */
  setMainnetOffHook(hook: (reason: string) => void): void {
    this.mainnetOffHook = hook;
    // a restart seed switched it off before any hook existed: run it now, so the file and the audit log say off too
    if (this.seedOffPending) { const why = this.seedOffPending; this.seedOffPending = null; try { hook(why); } catch { /* saving must not undo a safety step */ } }
  }

  /** Denies every PENDING card (of one network, or all) and frees its reservation. Approved spends are not touched: they are mid-flight and belong to the spend path. Returns the ids. */
  voidPending(reason = 'voided', net?: Net): string[] {
    const ids: string[] = [];
    const wall = this.clock.wall();
    for (const r of this.requests.values()) {
      if (r.status !== 'pending') continue;
      if (net !== undefined && r.network !== net && !r.netInvalid) continue;
      r.status = 'denied'; r.settledAt = wall; ids.push(r.requestId);
    }
    if (ids.length) this.emit({ type: 'voided', reason: safeText(reason, 160), ids: [...ids], net: net ?? 'all' });
    return ids;
  }

  // ---------------------------------------------------------------- the settings (the module calls these only behind admin + native)

  /** Changes the caps of ONE network (default testnet, for callers written before there were two). Refused above that network's hard ceiling. */
  setCaps(partial: Partial<Caps>, net: Net = 'test'): Caps {
    this.nets[net].caps = validateCaps({ ...partial }, this.nets[net].caps, net); // the caller's object is copied; nothing it keeps can change the stored caps
    this.emit({ type: 'caps', caps: { ...this.nets[net].caps }, net });
    return { ...this.nets[net].caps };
  }

  /** Replaces the allowlist of ONE network (default testnet). Each network's list takes valid addresses of that network only. */
  setAllowlist(list: unknown, net: Net = 'test'): string[] {
    const max = NET[net].maxAllowlist;
    const items: unknown[] | null = Array.isArray(list) ? [...list] : null; // copied once: what is checked is what is stored
    if (!items || items.length > max) throw new PolicyError(`the allowlist is a list of at most ${max} recipients`);
    const out = new Set<string>();
    for (const a of items) {
      const n = normalizeRecipient(typeof a === 'string' ? a.trim() : a); // the owner's input is trimmed once, here; a transaction's recipient never is
      if (!n) throw new PolicyError('a recipient must be 3 to 120 characters of letters, digits and . _ @ : + -');
      if (!recipientFitsNet(net, n)) throw new PolicyError(net === 'main' ? `${safeText(n, 48)} is not a valid mainnet address` : `${safeText(n, 48)} is not a valid testnet address (a mainnet address cannot go on the testnet list)`);
      out.add(n);
    }
    this.nets[net].allowlist = [...out];
    this.emit({ type: 'allowlist', size: this.nets[net].allowlist.length, net });
    return [...this.nets[net].allowlist];
  }

  /** The part of the state that is saved to disk. */
  config(): PolicyConfig { return buildPolicyConfig(this.nets, this.frozen, this.mainnetOn); }

  // ---------------------------------------------------------------- usage (per network: testnet traffic never uses mainnet headroom, and the reverse)

  private executedSince(net: Net, from: number): number {
    return this.ledger.filter((r) => r.at > from && applies(r.net, net)).reduce((a, r) => a + r.sats, 0);
  }
  private reserved(net: Net): number {
    let n = 0;
    for (const r of this.requests.values()) if (RESERVING.has(r.status) && applies(recNet(r), net)) n += r.totalSats;
    return n;
  }
  private sessionSats(net: Net): number {
    return this.ledger.filter((r) => r.session === this.sessionId && applies(r.net, net)).reduce((a, r) => a + r.sats, 0);
  }
  /** An unknown outcome on EITHER network blocks both: which wallet state is current is unclear until the owner has looked. */
  private hasUnknown(): boolean {
    for (const r of this.requests.values()) if (r.status === 'unknown') return true;
    return false;
  }

  // ---------------------------------------------------------------- evaluate: check, then reserve, in one synchronous step

  evaluate(req: SpendRequest): Decision {
    // whatever is wrong with the request object (a getter that throws, a proxy, a cyclic structure), the answer is a denial, never an exception
    // The request is copied ONCE, here, and only the copy is read from now on: a caller that keeps a reference (or a getter that answers
    // differently each time it is read) cannot change what was checked after the check, nor what the card and the hash were built from.
    try { return this.evaluateChecked(structuredClone(req)); } catch {
      let id = '';
      try { id = typeof req?.requestId === 'string' && REQUEST_ID.test(req.requestId) ? req.requestId : ''; } catch { /* unreadable */ }
      return { verdict: 'deny', requestId: id, reasons: ['the request could not be read safely'], codes: ['bad-request'], requiredConfirmations: ['approve'] };
    }
  }

  private evaluateChecked(req: SpendRequest): Decision {
    this.sweep();
    const requestId = typeof req?.requestId === 'string' ? req.requestId : '';
    const deny = (reasons: string[], codes: PolicyCode[], confirmations: Confirmation[] = ['approve']): Decision => ({ verdict: 'deny', requestId, reasons, codes, requiredConfirmations: confirmations });

    if (!REQUEST_ID.test(requestId)) return deny(['request id must be 8 to 64 characters of letters, digits, _ and -'], ['bad-request']);
    // a shape that cannot be decoded safely is refused before anything else looks at it
    const shape = this.shapeProblems(req);
    if (shape.length) return this.recordDeny(req, shape, shape.map(() => 'bad-request' as PolicyCode));

    const hash = requestHash(req);
    const seen = this.requests.get(requestId);
    if (seen) {
      if (seen.hash !== hash) return deny(['request id was already used with different content'], ['bad-request']);
      // the same request again: same answer, no second reservation. Once it has been acted on, it can never be accepted again.
      if (seen.status === 'pending' || seen.decision.verdict === 'deny') return { ...copyDecision(seen.decision), duplicate: true };
      return { verdict: 'deny', requestId, reasons: [`this request id was already used (status: ${seen.status}); a new request needs a new id`], codes: ['bad-request'], duplicate: true, requiredConfirmations: ['approve'] };
    }

    const net = req.network;
    const cfg = this.nets[net];
    const reasons: string[] = []; const codes: PolicyCode[] = [];
    const no = (code: PolicyCode, text: string) => { reasons.push(text); if (!codes.includes(code)) codes.push(code); };
    if (this.frozen) no('frozen', `the chain is frozen (${this.frozen.reason})`);
    if (this.hasUnknown()) no('unknown-outcome-pending', 'an earlier spend has an unknown outcome: check the wallet, then resolve it');
    if (req.walletNetwork === 'unknown') no('wallet-network-unknown', 'the wallet did not report which network it is on');
    else if (req.walletNetwork !== req.network) no('wallet-network-mismatch', `the wallet is on the ${req.walletNetwork === 'main' ? 'main' : 'test'} network but this transaction is for the ${req.network === 'main' ? 'main' : 'test'} network`);
    if (req.network === 'main') {
      if (!this.mainnetOn) no('mainnet-disabled', 'mainnet is switched off in Legion (only the owner turns it on, in the app window)');
      else if (!this.armedUntilWall) no('not-armed', 'live funds are not armed (arming is done by the owner in the app window, covers one spend and expires)');
    }

    const tx = req.decoded;
    const payments = tx.outputs.filter((o) => !o.change);
    const paid = payments.reduce((a, o) => a + o.sats, 0);
    const total = paid + tx.feeSats;
    if (!cfg.allowlist.length) no('not-allowlisted', `the ${NET[net].label} recipient allowlist is empty, so no recipient is allowed`);
    for (const o of payments) {
      if (cfg.allowlist.length && !cfg.allowlist.includes(normalizeRecipient(o.recipient) ?? '')) no('not-allowlisted', `recipient ${safeText(o.recipient, 48)} is not on the allowlist`);
      // the version byte of the recipient must be this network's (on mainnet the recipient must be a valid address at all)
      const an = addressNet(o.recipient);
      if (an !== net) no('address-network-mismatch', `recipient ${safeText(o.recipient, 48)} is not a ${net === 'main' ? 'mainnet' : 'testnet'} address`);
    }
    if (payments.length > cfg.caps.maxOutputs) no('too-many-outputs', `${payments.length} payment outputs, the limit is ${cfg.caps.maxOutputs}`);
    if (tx.feeSats > cfg.caps.maxFeeSats) no('fee-too-high', `fee ${tx.feeSats} sats is above the ceiling of ${cfg.caps.maxFeeSats}`);
    if (total > cfg.caps.perTxSats) no('over-cap', `${total} sats is above the per-transaction cap of ${cfg.caps.perTxSats}`);
    const wall = this.clock.wall();
    const reserved = this.reserved(net);
    if (this.sessionSats(net) + reserved + total > cfg.caps.perSessionSats) no('over-cap', `this would go over the session cap of ${cfg.caps.perSessionSats} sats`);
    if (this.executedSince(net, wall - DAY_MS) + reserved + total > cfg.caps.per24hSats) no('over-cap', `this would go over the 24-hour cap of ${cfg.caps.per24hSats} sats`);

    const required: Confirmation[] = ['approve'];
    if (req.tainted) required.push('untrusted-content');
    if (req.network === 'main') required.push('live-funds');

    if (reasons.length) return this.recordDeny(req, reasons, codes, required);

    const card = this.buildCard(req, hash, total, required);
    const decision: Decision = { verdict: 'needs_approval', requestId, reasons: [], codes: [], requiredConfirmations: required, card };
    this.requests.set(requestId, {
      requestId, hash, status: 'pending', agentId: req.agentId, taskId: req.taskId, network: req.network, totalSats: total,
      createdAt: card.createdAt, expiresAt: card.expiresAt, decision, required: Object.freeze([...required]),
    });
    this.emit({ type: 'decision', requestId, verdict: 'needs_approval', reasons: [], duplicate: false, agentId: safeId(req.agentId), taskId: safeId(req.taskId), totalSats: total, network: req.network });
    return copyDecision(decision);
  }

  private recordDeny(req: SpendRequest, reasons: string[], codes: PolicyCode[], required: Confirmation[] = ['approve']): Decision {
    const requestId = typeof req?.requestId === 'string' ? req.requestId : '';
    const decision: Decision = { verdict: 'deny', requestId, reasons, codes: [...new Set(codes)], requiredConfirmations: required };
    let total = 0;
    try { total = (req.decoded.outputs as DecodedOutput[]).filter((o) => !o.change).reduce((a, o) => a + (isSats(o.sats) ? o.sats : 0), 0) + (isSats(req.decoded.feeSats) ? req.decoded.feeSats : 0); } catch { /* the shape was bad */ }
    // a denied request id is remembered (without a reservation) so that a retry with the same id gets the same answer
    if (REQUEST_ID.test(requestId) && !this.requests.has(requestId)) {
      let hash = '';
      try { hash = requestHash(req); } catch { hash = ''; }
      if (hash) this.requests.set(requestId, { requestId, hash, status: 'denied', agentId: safeId(req.agentId), taskId: safeId(req.taskId), network: req.network === 'main' ? 'main' : 'test', totalSats: 0, createdAt: this.clock.wall(), expiresAt: 0, decision: copyDecision(decision), required: Object.freeze([...required]) });
    }
    this.emit({ type: 'decision', requestId: safeId(requestId), verdict: 'deny', reasons: reasons.slice(0, 8).map((r) => safeText(r, 160)), duplicate: false, agentId: safeId(req?.agentId), taskId: safeId(req?.taskId), totalSats: total, network: req?.network === 'main' ? 'main' : 'test' });
    return decision;
  }

  /** Everything that makes a request undecodable or inconsistent: wrong types, floats, negatives, huge numbers, an unbalanced transaction. */
  private shapeProblems(req: SpendRequest): string[] {
    const p: string[] = [];
    if (!req || typeof req !== 'object') return ['request is not an object'];
    if (req.network !== 'test' && req.network !== 'main') p.push('network must be test or main');
    if (req.walletNetwork !== 'test' && req.walletNetwork !== 'main' && req.walletNetwork !== 'unknown') p.push('wallet network is not valid');
    if (typeof req.agentId !== 'string' || !req.agentId || typeof req.taskId !== 'string' || !req.taskId) p.push('agent and task are required');
    if (typeof req.reason !== 'string') p.push('reason must be text');
    if (typeof req.tainted !== 'boolean') p.push('the untrusted-content flag must be a boolean');
    const d = req.decoded;
    if (!d || typeof d !== 'object' || !Array.isArray(d.outputs)) return [...p, 'the decoded transaction is missing'];
    if (!d.outputs.length || d.outputs.length > 100) p.push('a transaction needs 1 to 100 outputs');
    if (!isSats(d.feeSats)) p.push('fee must be a whole number of sats');
    if (!isSats(d.inputSats)) p.push('input total must be a whole number of sats');
    let sum = 0; let change = 0; let ok = true;
    for (const o of d.outputs) {
      if (!o || typeof o !== 'object' || !isSats(o.sats) || o.sats < 1 || typeof o.recipient !== 'string') { ok = false; continue; }
      if (o.change !== undefined && typeof o.change !== 'boolean') { ok = false; continue; }
      if (o.change) change++;
      sum += o.sats;
    }
    if (!ok) p.push('every output needs a recipient and a whole number of sats above zero');
    if (change > 1) p.push('more than one change output');
    // the engine does not trust the decoder's labels alone: a transaction with no payment output (everything flagged change) is refused (mainnet's "exactly one" is checked in evaluate)
    if (ok && d.outputs.length - change < 1) p.push('a transaction needs at least one payment output');
    if (ok && isSats(d.feeSats) && isSats(d.inputSats) && sum + d.feeSats !== d.inputSats) p.push('the amounts do not add up (inputs must equal outputs plus fee)');
    return p;
  }

  private buildCard(req: SpendRequest, hash: string, total: number, required: Confirmation[]): ApprovalCard {
    const now = this.clock.wall();
    const net = req.network;
    const cfg = this.nets[net];
    const reserved = this.reserved(net);
    const warnings: string[] = [];
    if (net === 'main') warnings.push('LIVE FUNDS: this is the main network. A mistake cannot be undone.');
    if (req.tainted) warnings.push('This run read untrusted content (web, files, chain data or another program\'s output), so it may have been steered. Check the recipient and the amount yourself.');
    const paid = total - req.decoded.feeSats;
    if (paid > 0 && req.decoded.feeSats * 10 > paid) warnings.push('The fee is more than a tenth of the payment.');
    const outputs: CardOutput[] = req.decoded.outputs.map((o, index) => ({
      index, recipient: safeText(o.recipient, 120), sats: o.sats, bsv: fmtBsv(o.sats), kind: o.change ? 'change' : 'payment',
      allowlisted: !!o.change || cfg.allowlist.includes(normalizeRecipient(o.recipient) ?? ''),
      addressNetwork: addressNet(o.recipient),
    }));
    return {
      requestId: req.requestId, network: net, networkLabel: NET[net].label,
      agentId: safeId(req.agentId), taskId: safeId(req.taskId),
      purpose: safeText(req.reason, 200), purposeNote: 'Written by the agent. Not checked by Legion.',
      outputs, fee: { sats: req.decoded.feeSats, bsv: fmtBsv(req.decoded.feeSats) },
      totalSpendSats: total, totalSpendBsv: fmtBsv(total),
      remaining: {
        perTxSats: Math.max(0, cfg.caps.perTxSats - total),
        perSessionSats: Math.max(0, cfg.caps.perSessionSats - this.sessionSats(net) - reserved - total),
        per24hSats: Math.max(0, cfg.caps.per24hSats - this.executedSince(net, now - DAY_MS) - reserved - total),
      },
      warnings, requiredConfirmations: required, createdAt: now, expiresAt: now + CARD_TTL_MS, hash,
    };
  }

  // ---------------------------------------------------------------- the human's answer

  /**
   * The human approves a pending card. They must present the card's hash (so they approve THIS content) and every confirmation the card
   * requires. Everything that could have changed since the card was made is checked again: freeze, the mainnet switch, arming, the
   * wallet's network, the clock. A wallet that now claims another network voids the card (it is not left waiting for the claim to flip back).
   * A mainnet approval consumes the arm in the same synchronous step: one arm, one spend.
   */
  approve(requestId: string, input: { cardHash: string; confirmations: readonly string[]; walletNetwork: WalletNet }): { ok: true; totalSats: number } | { ok: false; reason: string } {
    this.sweep();
    const r = this.requests.get(requestId);
    if (!r) return { ok: false, reason: 'unknown request' };
    if (r.status !== 'pending') return { ok: false, reason: `this request is ${r.status}, not waiting for approval` };
    // the answer is read ONCE into plain values (a getter or a proxy cannot say yes to the check and something else to the use)
    let cardHash: unknown; let have: Set<string>; let walletNetwork: unknown;
    try {
      cardHash = input.cardHash; walletNetwork = input.walletNetwork;
      const given: unknown = input.confirmations; // one read
      have = new Set(Array.isArray(given) ? [...given].filter((c): c is string => typeof c === 'string') : []);
    } catch { return { ok: false, reason: 'the answer could not be read safely' }; }
    if (this.frozen) { r.status = 'denied'; r.settledAt = this.clock.wall(); return { ok: false, reason: 'the chain is frozen' }; }
    if (r.network === 'main' && !this.mainnetOn) { r.status = 'denied'; r.settledAt = this.clock.wall(); return { ok: false, reason: 'mainnet is switched off' }; }
    if (r.network === 'main' && !this.armedUntilWall) { r.status = 'denied'; r.settledAt = this.clock.wall(); return { ok: false, reason: 'live funds are no longer armed' }; }
    if (cardHash !== r.hash) return { ok: false, reason: 'the card changed: approve what is on screen' };
    const missing = r.required.filter((c) => !have.has(c));
    if (missing.length) return { ok: false, reason: `missing confirmation: ${missing.join(', ')}` };
    if (this.hasUnknown()) return { ok: false, reason: 'an earlier spend has an unknown outcome' };
    if (walletNetwork !== r.network) { r.status = 'denied'; r.settledAt = this.clock.wall(); return { ok: false, reason: 'the wallet is no longer on the network this card was made for' }; }
    r.status = 'approved'; r.approvedAt = this.clock.wall();
    if (r.network === 'main') this.disarm('the one mainnet spend this arm covers was approved');
    this.emit({ type: 'approved', requestId, totalSats: r.totalSats, net: recNet(r) });
    return { ok: true, totalSats: r.totalSats };
  }

  /**
   * The spend path asks this immediately before it signs: the request is approved, the chain is not frozen, and for mainnet the switch is
   * still on (the owner may have pressed Disable between the approval and now). False = do not sign. Read-only apart from the sweep (an
   * overdue approval turns unknown there, which is also false).
   */
  canSign(requestId: string): boolean {
    this.sweep();
    const r = this.requests.get(requestId);
    if (!r || r.status !== 'approved') return false;
    if (this.frozen) return false;
    if (r.network === 'main' && (r.netInvalid || !this.mainnetOn)) return false;
    return true;
  }

  /** The human (or a timeout) says no. Releases the reservation. */
  deny(requestId: string): boolean {
    const r = this.requests.get(requestId);
    if (!r || r.status !== 'pending') return false;
    r.status = 'denied'; r.settledAt = this.clock.wall();
    return true;
  }

  /**
   * What happened to an approved spend. `executed` moves the actual amount into the ledger. If the actual amount is not the approved
   * amount, the chain freezes (something other than the card was signed). `unknown` blocks all new spends until `resolveUnknown`.
   * On mainnet either of those two also switches mainnet off.
   */
  settle(requestId: string, outcome: { kind: 'executed'; sats: number } | { kind: 'failed' } | { kind: 'unknown' }): { ok: boolean; reason?: string } {
    this.sweep();
    const r = this.requests.get(requestId);
    if (!r || r.status !== 'approved') return { ok: false, reason: 'not an approved request' };
    // read once: the amount that is checked is the amount that is recorded
    let kind: unknown; let sats: unknown;
    try { kind = outcome.kind; sats = (outcome as { sats?: unknown }).sats; } catch { kind = 'unknown'; sats = undefined; }
    const wall = this.clock.wall();
    r.settledAt = wall;
    const unknown = (reason: string) => { r.status = 'unknown'; this.emit({ type: 'settled', requestId, outcome: 'unknown', sats: null, net: recNet(r) }); if (r.network === 'main') this.mainnetOff('a mainnet spend has an unknown outcome'); return { ok: false, reason }; };
    if (kind === 'failed') { r.status = 'failed'; this.emit({ type: 'settled', requestId, outcome: 'failed', sats: null, net: recNet(r) }); return { ok: true }; }
    if (kind === 'unknown') { unknown(''); return { ok: true }; }
    if (kind !== 'executed' || !isSats(sats)) return unknown('the reported amount is not a number of sats');
    r.status = 'executed'; r.actualSats = sats;
    this.ledger.push({ requestId, sats, at: wall, session: this.sessionId, net: recNet(r) });
    this.emit({ type: 'settled', requestId, outcome: 'executed', sats, net: recNet(r) });
    if (sats !== r.totalSats) {
      this.freeze(`the amount sent (${sats} sats) is not the amount approved (${r.totalSats} sats)`);
      if (r.network === 'main') this.mainnetOff('the amount sent on mainnet is not the amount approved');
      return { ok: true, reason: 'mismatch: frozen' };
    }
    return { ok: true };
  }

  /** A person checked the wallet and says whether an unknown spend went out. */
  resolveUnknown(requestId: string, outcome: { kind: 'sent'; sats: number } | { kind: 'not-sent' }): boolean {
    const r = this.requests.get(requestId);
    if (!r || r.status !== 'unknown') return false;
    let kind: unknown; let sats: unknown;
    try { kind = outcome.kind; sats = (outcome as { sats?: unknown }).sats; } catch { return false; }
    const wall = this.clock.wall();
    if (kind === 'sent') {
      if (!isSats(sats)) return false;
      r.status = 'executed'; r.actualSats = sats; this.ledger.push({ requestId, sats, at: wall, session: this.sessionId, net: recNet(r) });
    } else if (kind === 'not-sent') r.status = 'failed';
    else return false;
    r.settledAt = wall;
    this.emit({ type: 'resolved', requestId, outcome: String(kind), net: recNet(r) });
    return true;
  }

  // ---------------------------------------------------------------- reading

  status(requestId: string): RequestStatus | undefined { this.sweep(); return this.requests.get(requestId)?.status; }

  executedRecords(): LedgerRecord[] { return this.ledger.map((r) => ({ ...r })); }

  private netSnapshot(net: Net, wall: number): NetSnapshot {
    const c = this.nets[net];
    return { caps: { ...c.caps }, hardCaps: { ...NET[net].hardCaps }, allowlist: [...c.allowlist], label: NET[net].label, usage: { sessionSats: this.sessionSats(net), last24hSats: this.executedSince(net, wall - DAY_MS), reservedSats: this.reserved(net) } };
  }

  snapshot(): PolicySnapshot {
    this.sweep();
    const wall = this.clock.wall();
    const live = [...this.requests.values()];
    const nets = { test: this.netSnapshot('test', wall), main: this.netSnapshot('main', wall) };
    return {
      frozen: this.frozen ? { ...this.frozen } : null,
      armed: this.armedUntilWall !== null,
      armedUntil: this.armedUntilWall,
      remainingMs: this.armedUntilWall === null ? 0 : Math.max(0, Math.min(this.armedUntilWall - wall, (this.armedUntilMono as number) - this.clock.mono())),
      mainnetEnabled: this.mainnetOn,
      nets,
      caps: { ...nets.test.caps }, hardCaps: { ...nets.test.hardCaps }, allowlist: [...nets.test.allowlist],
      usage: { ...nets.test.usage, invalidNetRecords: this.ledger.filter((r) => r.net === 'invalid').length + live.filter((r) => r.netInvalid).length },
      pending: live.filter((r) => r.status === 'pending' || r.status === 'approved').map((r) => ({ requestId: r.requestId, status: r.status, agentId: r.agentId, totalSats: r.totalSats, expiresAt: r.expiresAt, network: r.network })),
      unknown: live.filter((r) => r.status === 'unknown').map((r) => ({ requestId: r.requestId, agentId: r.agentId, totalSats: r.totalSats, net: recNet(r) })),
    };
  }
}

/** The executed spends in an audit log (decision "executed" with a numeric `sats` field), for rebuilding the rolling window after a restart. */
export function ledgerFromAudit(entries: ReadonlyArray<{ decision: string; ts: string; fields: Record<string, unknown> }>): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  // one spend can be written more than once (the spend path and the engine's event each record it): a request id counts once, and when the
  // lines disagree the LARGER amount wins (a spend cap must never under-count)
  const seen = new Map<string, number>();
  for (const e of entries) {
    if (e.decision !== 'executed') continue;
    const sats = e.fields.sats; const at = Date.parse(e.ts);
    if (!isSats(sats) || !Number.isFinite(at)) continue;
    const id = e.fields.requestId;
    const net = parseNet(e.fields.net); // a line without `net` is a testnet line; a present but unrecognised value is `invalid`
    if (typeof id === 'string') {
      const k = `${net}:${id}`; const at0 = seen.get(k);
      if (at0 !== undefined) { if (sats > out[at0]!.sats) out[at0] = { requestId: id, sats, at, net }; continue; }
      seen.set(k, out.length);
    }
    out.push({ requestId: typeof id === 'string' ? id : 'audit', sats, at, net });
  }
  // ordered by the time of the spend, never by where the line sits in the file (a rotated or restored file is not in time order)
  return out.sort((a, b) => a.at - b.at);
}
