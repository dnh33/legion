/**
 * The BSV spend policy engine. PURE and SYNCHRONOUS (no I/O, no timers, no network; the clock is injected) and NOT connected to any
 * tool in this release: nothing in Legion can sign, spend, inscribe or broadcast. It exists so that the controls are built, tested and
 * reviewable before any spend tool is. Reading it should answer "what would stop a bad spend?".
 *
 * Shape of the rules:
 *  - There is no "allow". The best answer to a request is `needs_approval`: a human reads a card and confirms. Every spend is manual.
 *  - The engine is synchronous on purpose: check-and-reserve is one step, so two requests in the same tick cannot both fit under a cap
 *    that only one of them fits under. Anything slow (a wallet call) happens AFTER the reservation, and a reservation counts against the
 *    caps until it is settled, denied, expired or resolved by a human.
 *  - Caps (per transaction, per session, rolling 24 h), a recipient allowlist, a maximum number of outputs and a fee ceiling. Defaults are
 *    tiny and every value is clamped to HARD_CAPS, which only a code change can raise (a hand-edited policy file cannot).
 *  - Live funds need arming: `armedUntil` lives in memory only, expires (both a monotonic and a wall clock must agree it is still
 *    valid), and is gone after a restart.
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

export type Net = 'test' | 'main';
export type WalletNet = Net | 'unknown';

export interface Caps { perTxSats: number; perSessionSats: number; per24hSats: number; maxOutputs: number; maxFeeSats: number }
/** Tiny on purpose: 1,000 sats is a fraction of a cent. */
export const DEFAULT_CAPS: Readonly<Caps> = Object.freeze({ perTxSats: 1_000, perSessionSats: 5_000, per24hSats: 10_000, maxOutputs: 3, maxFeeSats: 200 });
/** The ceiling of every cap. Only a code change raises it: a policy file or an API call is clamped (and refused) above it. */
export const HARD_CAPS: Readonly<Caps> = Object.freeze({ perTxSats: 1_000_000, perSessionSats: 5_000_000, per24hSats: 10_000_000, maxOutputs: 10, maxFeeSats: 10_000 });
export const MAX_MONEY_SATS = 2_100_000_000_000_000;
export const MAX_ALLOWLIST = 50;
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
/** What is persisted (arming and the ledger are not part of it). */
export interface PolicyConfig { caps: Caps; allowlist: string[]; frozen: FrozenInfo | null }

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

export interface CardOutput { index: number; recipient: string; sats: number; bsv: string; kind: 'payment' | 'change'; allowlisted: boolean }
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
export interface Decision {
  verdict: Verdict;
  requestId: string;
  /** Every failing check, in a fixed order. */
  reasons: string[];
  /** This id was seen before: the stored answer is returned and nothing was reserved again. */
  duplicate?: boolean;
  requiredConfirmations: Confirmation[];
  card?: ApprovalCard;
}

export type RequestStatus = 'pending' | 'approved' | 'executed' | 'failed' | 'denied' | 'expired' | 'unknown';
const RESERVING: ReadonlySet<RequestStatus> = new Set(['pending', 'approved', 'unknown']);

interface Record_ {
  requestId: string; hash: string; status: RequestStatus; agentId: string; taskId: string; network: Net;
  /** Payments plus fee. */
  totalSats: number; createdAt: number; expiresAt: number; approvedAt?: number; settledAt?: number; actualSats?: number;
  decision: Decision;
}

export interface LedgerRecord { requestId: string; sats: number; at: number; session?: string }

export type PolicyEvent =
  | { type: 'armed'; until: number; minutes: number }
  | { type: 'disarmed'; reason: string }
  | { type: 'frozen'; reason: string; denied: string[]; unknown: string[] }
  | { type: 'unfrozen' }
  | { type: 'caps'; caps: Caps }
  | { type: 'allowlist'; size: number }
  | { type: 'decision'; requestId: string; verdict: Verdict; reasons: string[]; duplicate: boolean; agentId: string; taskId: string; totalSats: number; network: Net }
  | { type: 'approved'; requestId: string; totalSats: number }
  | { type: 'settled'; requestId: string; outcome: string; sats: number | null }
  | { type: 'expired'; requestId: string }
  | { type: 'resolved'; requestId: string; outcome: string };

export interface PolicySnapshot {
  frozen: FrozenInfo | null;
  armed: boolean;
  /** Wall-clock ms when arming ends (for display only), or null. */
  armedUntil: number | null;
  remainingMs: number;
  caps: Caps;
  hardCaps: Caps;
  allowlist: string[];
  usage: { sessionSats: number; last24hSats: number; reservedSats: number };
  pending: Array<{ requestId: string; status: RequestStatus; agentId: string; totalSats: number; expiresAt: number; network: Net }>;
  unknown: Array<{ requestId: string; agentId: string; totalSats: number }>;
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

/** Clamps nothing: returns the caps if every value is an integer in range, else throws naming the field. */
export function validateCaps(c: Partial<Caps>, base: Caps = DEFAULT_CAPS): Caps {
  const out: Caps = { ...base };
  for (const [k, v] of Object.entries(c)) {
    if (!(k in HARD_CAPS)) throw new PolicyError(`unknown cap "${safeId(k, 32)}"`);
    const key = k as keyof Caps;
    const min = key === 'maxOutputs' ? 1 : 0;
    if (!isCount(v) || v < min || v > HARD_CAPS[key]) throw new PolicyError(`${key} must be a whole number from ${min} to ${HARD_CAPS[key]}`);
    out[key] = v;
  }
  // the order of the caps is part of the rule: a transaction cap above the session cap would be meaningless
  if (out.perTxSats > out.perSessionSats || out.perSessionSats > out.per24hSats) throw new PolicyError('caps must satisfy per transaction <= per session <= per 24 hours');
  return out;
}

/** What a policy file says, reduced to something safe: unknown fields dropped, caps clamped to the hard ceiling, allowlist re-validated. */
export function sanitizePolicyConfig(raw: unknown): PolicyConfig {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const caps: Caps = { ...DEFAULT_CAPS };
  const rc = o.caps && typeof o.caps === 'object' && !Array.isArray(o.caps) ? o.caps as Record<string, unknown> : {};
  for (const k of Object.keys(HARD_CAPS) as Array<keyof Caps>) {
    const v = rc[k];
    const min = k === 'maxOutputs' ? 1 : 0;
    if (isCount(v) && v >= min) caps[k] = Math.min(v, HARD_CAPS[k]);
  }
  if (caps.perTxSats > caps.perSessionSats) caps.perTxSats = caps.perSessionSats;
  if (caps.perSessionSats > caps.per24hSats) caps.perSessionSats = caps.per24hSats;
  if (caps.perTxSats > caps.perSessionSats) caps.perTxSats = caps.perSessionSats;
  const allow = new Set<string>();
  if (Array.isArray(o.allowlist)) for (const a of o.allowlist) { const n = normalizeRecipient(a); if (n && allow.size < MAX_ALLOWLIST) allow.add(n); }
  let frozen: FrozenInfo | null = null;
  const f = o.frozen;
  if (f && typeof f === 'object' && !Array.isArray(f)) frozen = { at: safeText((f as { at?: unknown }).at, 40), reason: safeText((f as { reason?: unknown }).reason, 160) || 'frozen' };
  return { caps, allowlist: [...allow], frozen };
}

/** The sha256 that binds a card (and so an approval) to the exact request. */
export function requestHash(r: SpendRequest): string {
  return createHash('sha256').update(JSON.stringify({
    id: r.requestId, net: r.network, agent: r.agentId, task: r.taskId, reason: r.reason, tainted: r.tainted,
    in: r.decoded.inputSats, fee: r.decoded.feeSats, out: r.decoded.outputs.map((o) => [o.recipient, o.sats, !!o.change]),
  })).digest('hex');
}

export interface PolicyOptions {
  config?: PolicyConfig;
  clock?: Clock;
  onEvent?: (e: PolicyEvent) => void;
  /** Executed spends from earlier sessions (rebuilt from the audit log), so a restart does not reset the rolling 24 h cap. */
  ledger?: LedgerRecord[];
  sessionId?: string;
}

export class PolicyEngine {
  private caps: Caps;
  private allowlist: string[];
  private frozen: FrozenInfo | null;
  private armedUntilWall: number | null = null;
  private armedUntilMono: number | null = null;
  private readonly requests = new Map<string, Record_>();
  private ledger: LedgerRecord[];
  private readonly clock: Clock;
  private readonly emit: (e: PolicyEvent) => void;
  readonly sessionId: string;

  constructor(o: PolicyOptions = {}) {
    const cfg = sanitizePolicyConfig(o.config);
    this.caps = cfg.caps; this.allowlist = cfg.allowlist; this.frozen = cfg.frozen;
    this.clock = o.clock ?? systemClock;
    this.emit = (e) => { try { o.onEvent?.(e); } catch { /* an observer must not break the policy */ } };
    this.ledger = (o.ledger ?? []).filter((r) => isSats(r.sats) && Number.isFinite(r.at)).map((r) => ({ ...r }));
    this.sessionId = o.sessionId ?? `s${Math.floor(this.clock.wall())}`;
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
    for (const r of this.requests.values()) {
      if (r.status === 'pending' && wall >= r.expiresAt) { r.status = 'expired'; r.settledAt = wall; this.emit({ type: 'expired', requestId: r.requestId }); }
      else if (r.status === 'approved' && wall >= (r.approvedAt ?? 0) + EXEC_TTL_MS) { r.status = 'unknown'; r.settledAt = wall; this.emit({ type: 'settled', requestId: r.requestId, outcome: 'unknown', sats: null }); }
    }
  }

  arm(minutes: number): { until: number } {
    this.sweep();
    if (this.frozen) throw new PolicyError('the chain is frozen: unfreeze it first');
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

  /** Denies every pending card, disarms, and stays frozen until `unfreeze`. Approved-but-unsettled spends become unknown. Idempotent. */
  freeze(reason = 'frozen by the owner'): { denied: string[]; unknown: string[] } {
    this.sweep();
    const denied: string[] = []; const unknown: string[] = [];
    const wall = this.clock.wall();
    for (const r of this.requests.values()) {
      if (r.status === 'pending') { r.status = 'denied'; r.settledAt = wall; denied.push(r.requestId); }
      else if (r.status === 'approved') { r.status = 'unknown'; r.settledAt = wall; unknown.push(r.requestId); }
    }
    this.armedUntilWall = null; this.armedUntilMono = null;
    const was = this.frozen;
    this.frozen = was ?? { at: new Date(wall).toISOString(), reason: safeText(reason, 160) || 'frozen' };
    this.emit({ type: 'frozen', reason: this.frozen.reason, denied, unknown });
    return { denied, unknown };
  }

  unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = null;
    this.emit({ type: 'unfrozen' });
  }

  get isFrozen(): boolean { return this.frozen !== null; }

  // ---------------------------------------------------------------- the settings (the module calls these only behind admin + native)

  setCaps(partial: Partial<Caps>): Caps {
    this.caps = validateCaps(partial, this.caps);
    this.emit({ type: 'caps', caps: { ...this.caps } });
    return { ...this.caps };
  }

  setAllowlist(list: unknown): string[] {
    if (!Array.isArray(list) || list.length > MAX_ALLOWLIST) throw new PolicyError(`the allowlist is a list of at most ${MAX_ALLOWLIST} recipients`);
    const out = new Set<string>();
    for (const a of list) {
      const n = normalizeRecipient(typeof a === 'string' ? a.trim() : a); // the owner's input is trimmed once, here; a transaction's recipient never is
      if (!n) throw new PolicyError('a recipient must be 3 to 120 characters of letters, digits and . _ @ : + -');
      out.add(n);
    }
    this.allowlist = [...out];
    this.emit({ type: 'allowlist', size: this.allowlist.length });
    return [...this.allowlist];
  }

  /** The part of the state that is saved to disk. */
  config(): PolicyConfig { return { caps: { ...this.caps }, allowlist: [...this.allowlist], frozen: this.frozen ? { ...this.frozen } : null }; }

  // ---------------------------------------------------------------- usage

  private executedSince(from: number): number {
    return this.ledger.filter((r) => r.at > from).reduce((a, r) => a + r.sats, 0);
  }
  private reserved(exclude?: string): number {
    let n = 0;
    for (const r of this.requests.values()) if (RESERVING.has(r.status) && r.requestId !== exclude) n += r.totalSats;
    return n;
  }
  private sessionSats(): number {
    return this.ledger.filter((r) => r.session === this.sessionId).reduce((a, r) => a + r.sats, 0);
  }
  private hasUnknown(): boolean {
    for (const r of this.requests.values()) if (r.status === 'unknown') return true;
    return false;
  }

  // ---------------------------------------------------------------- evaluate: check, then reserve, in one synchronous step

  evaluate(req: SpendRequest): Decision {
    // whatever is wrong with the request object (a getter that throws, a proxy, a cyclic structure), the answer is a denial, never an exception
    try { return this.evaluateChecked(req); } catch {
      let id = '';
      try { id = typeof req?.requestId === 'string' && REQUEST_ID.test(req.requestId) ? req.requestId : ''; } catch { /* unreadable */ }
      return { verdict: 'deny', requestId: id, reasons: ['the request could not be read safely'], requiredConfirmations: ['approve'] };
    }
  }

  private evaluateChecked(req: SpendRequest): Decision {
    this.sweep();
    const requestId = typeof req?.requestId === 'string' ? req.requestId : '';
    const deny = (reasons: string[], confirmations: Confirmation[] = ['approve']): Decision => ({ verdict: 'deny', requestId, reasons, requiredConfirmations: confirmations });

    if (!REQUEST_ID.test(requestId)) return deny(['request id must be 8 to 64 characters of letters, digits, _ and -']);
    // a shape that cannot be decoded safely is refused before anything else looks at it
    const shape = this.shapeProblems(req);
    if (shape.length) return this.recordDeny(req, shape);

    const hash = requestHash(req);
    const seen = this.requests.get(requestId);
    if (seen) {
      if (seen.hash !== hash) return deny(['request id was already used with different content']);
      // the same request again: same answer, no second reservation. Once it has been acted on, it can never be accepted again.
      if (seen.status === 'pending' || seen.decision.verdict === 'deny') return { ...seen.decision, duplicate: true };
      return { verdict: 'deny', requestId, reasons: [`this request id was already used (status: ${seen.status}); a new request needs a new id`], duplicate: true, requiredConfirmations: ['approve'] };
    }

    const reasons: string[] = [];
    if (this.frozen) reasons.push(`the chain is frozen (${this.frozen.reason})`);
    if (this.hasUnknown()) reasons.push('an earlier spend has an unknown outcome: check the wallet, then resolve it');
    if (req.walletNetwork === 'unknown') reasons.push('the wallet did not report which network it is on');
    else if (req.walletNetwork !== req.network) reasons.push(`the wallet is on the ${req.walletNetwork === 'main' ? 'main' : 'test'} network but this transaction is for the ${req.network === 'main' ? 'main' : 'test'} network`);
    if (req.network === 'main' && !this.armedUntilWall) reasons.push('live funds are not armed (arming is done by the owner in the app window and expires)');

    const tx = req.decoded;
    const payments = tx.outputs.filter((o) => !o.change);
    const paid = payments.reduce((a, o) => a + o.sats, 0);
    const total = paid + tx.feeSats;
    if (!this.allowlist.length) reasons.push('the recipient allowlist is empty, so no recipient is allowed');
    for (const o of payments) if (this.allowlist.length && !this.allowlist.includes(normalizeRecipient(o.recipient) ?? '')) reasons.push(`recipient ${safeText(o.recipient, 48)} is not on the allowlist`);
    if (payments.length > this.caps.maxOutputs) reasons.push(`${payments.length} payment outputs, the limit is ${this.caps.maxOutputs}`);
    if (tx.feeSats > this.caps.maxFeeSats) reasons.push(`fee ${tx.feeSats} sats is above the ceiling of ${this.caps.maxFeeSats}`);
    if (total > this.caps.perTxSats) reasons.push(`${total} sats is above the per-transaction cap of ${this.caps.perTxSats}`);
    const wall = this.clock.wall();
    const reserved = this.reserved();
    if (this.sessionSats() + reserved + total > this.caps.perSessionSats) reasons.push(`this would go over the session cap of ${this.caps.perSessionSats} sats`);
    if (this.executedSince(wall - DAY_MS) + reserved + total > this.caps.per24hSats) reasons.push(`this would go over the 24-hour cap of ${this.caps.per24hSats} sats`);

    const required: Confirmation[] = ['approve'];
    if (req.tainted) required.push('untrusted-content');
    if (req.network === 'main') required.push('live-funds');

    if (reasons.length) return this.recordDeny(req, reasons, required);

    const card = this.buildCard(req, hash, total, required);
    const decision: Decision = { verdict: 'needs_approval', requestId, reasons: [], requiredConfirmations: required, card };
    this.requests.set(requestId, {
      requestId, hash, status: 'pending', agentId: req.agentId, taskId: req.taskId, network: req.network, totalSats: total,
      createdAt: card.createdAt, expiresAt: card.expiresAt, decision,
    });
    this.emit({ type: 'decision', requestId, verdict: 'needs_approval', reasons: [], duplicate: false, agentId: safeId(req.agentId), taskId: safeId(req.taskId), totalSats: total, network: req.network });
    return decision;
  }

  private recordDeny(req: SpendRequest, reasons: string[], required: Confirmation[] = ['approve']): Decision {
    const requestId = typeof req?.requestId === 'string' ? req.requestId : '';
    const decision: Decision = { verdict: 'deny', requestId, reasons, requiredConfirmations: required };
    let total = 0;
    try { total = (req.decoded.outputs as DecodedOutput[]).filter((o) => !o.change).reduce((a, o) => a + (isSats(o.sats) ? o.sats : 0), 0) + (isSats(req.decoded.feeSats) ? req.decoded.feeSats : 0); } catch { /* the shape was bad */ }
    // a denied request id is remembered (without a reservation) so that a retry with the same id gets the same answer
    if (REQUEST_ID.test(requestId) && !this.requests.has(requestId)) {
      let hash = '';
      try { hash = requestHash(req); } catch { hash = ''; }
      if (hash) this.requests.set(requestId, { requestId, hash, status: 'denied', agentId: safeId(req.agentId), taskId: safeId(req.taskId), network: req.network === 'main' ? 'main' : 'test', totalSats: 0, createdAt: this.clock.wall(), expiresAt: 0, decision });
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
    if (ok && isSats(d.feeSats) && isSats(d.inputSats) && sum + d.feeSats !== d.inputSats) p.push('the amounts do not add up (inputs must equal outputs plus fee)');
    return p;
  }

  private buildCard(req: SpendRequest, hash: string, total: number, required: Confirmation[]): ApprovalCard {
    const now = this.clock.wall();
    const reserved = this.reserved();
    const warnings: string[] = [];
    if (req.network === 'main') warnings.push('LIVE FUNDS: this is the main network. A mistake cannot be undone.');
    if (req.tainted) warnings.push('This run read untrusted content (web, files, chain data or another program\'s output), so it may have been steered. Check the recipient and the amount yourself.');
    const paid = total - req.decoded.feeSats;
    if (paid > 0 && req.decoded.feeSats * 10 > paid) warnings.push('The fee is more than a tenth of the payment.');
    const outputs: CardOutput[] = req.decoded.outputs.map((o, index) => ({
      index, recipient: safeText(o.recipient, 120), sats: o.sats, bsv: fmtBsv(o.sats), kind: o.change ? 'change' : 'payment',
      allowlisted: !!o.change || this.allowlist.includes(normalizeRecipient(o.recipient) ?? ''),
    }));
    return {
      requestId: req.requestId, network: req.network, networkLabel: req.network === 'main' ? 'LIVE FUNDS (main network)' : 'TESTNET',
      agentId: safeId(req.agentId), taskId: safeId(req.taskId),
      purpose: safeText(req.reason, 200), purposeNote: 'Written by the agent. Not checked by Legion.',
      outputs, fee: { sats: req.decoded.feeSats, bsv: fmtBsv(req.decoded.feeSats) },
      totalSpendSats: total, totalSpendBsv: fmtBsv(total),
      remaining: {
        perTxSats: Math.max(0, this.caps.perTxSats - total),
        perSessionSats: Math.max(0, this.caps.perSessionSats - this.sessionSats() - reserved - total),
        per24hSats: Math.max(0, this.caps.per24hSats - this.executedSince(now - DAY_MS) - reserved - total),
      },
      warnings, requiredConfirmations: required, createdAt: now, expiresAt: now + CARD_TTL_MS, hash,
    };
  }

  // ---------------------------------------------------------------- the human's answer

  /**
   * The human approves a pending card. They must present the card's hash (so they approve THIS content) and every confirmation the card
   * requires. Everything that could have changed since the card was made is checked again: freeze, arming, the wallet's network, the clock.
   */
  approve(requestId: string, input: { cardHash: string; confirmations: readonly string[]; walletNetwork: WalletNet }): { ok: true; totalSats: number } | { ok: false; reason: string } {
    this.sweep();
    const r = this.requests.get(requestId);
    if (!r) return { ok: false, reason: 'unknown request' };
    if (r.status !== 'pending') return { ok: false, reason: `this request is ${r.status}, not waiting for approval` };
    if (this.frozen) { r.status = 'denied'; r.settledAt = this.clock.wall(); return { ok: false, reason: 'the chain is frozen' }; }
    if (input.cardHash !== r.hash || r.decision.card?.hash !== r.hash) return { ok: false, reason: 'the card changed: approve what is on screen' };
    const need = r.decision.requiredConfirmations;
    const have = new Set(input.confirmations);
    const missing = need.filter((c) => !have.has(c));
    if (missing.length) return { ok: false, reason: `missing confirmation: ${missing.join(', ')}` };
    if (this.hasUnknown()) return { ok: false, reason: 'an earlier spend has an unknown outcome' };
    if (input.walletNetwork !== r.network) return { ok: false, reason: 'the wallet is no longer on the network this card was made for' };
    if (r.network === 'main' && !this.armedUntilWall) { r.status = 'denied'; r.settledAt = this.clock.wall(); return { ok: false, reason: 'live funds are no longer armed' }; }
    r.status = 'approved'; r.approvedAt = this.clock.wall();
    this.emit({ type: 'approved', requestId, totalSats: r.totalSats });
    return { ok: true, totalSats: r.totalSats };
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
   */
  settle(requestId: string, outcome: { kind: 'executed'; sats: number } | { kind: 'failed' } | { kind: 'unknown' }): { ok: boolean; reason?: string } {
    this.sweep();
    const r = this.requests.get(requestId);
    if (!r || r.status !== 'approved') return { ok: false, reason: 'not an approved request' };
    const wall = this.clock.wall();
    r.settledAt = wall;
    if (outcome.kind === 'failed') { r.status = 'failed'; this.emit({ type: 'settled', requestId, outcome: 'failed', sats: null }); return { ok: true }; }
    if (outcome.kind === 'unknown') { r.status = 'unknown'; this.emit({ type: 'settled', requestId, outcome: 'unknown', sats: null }); return { ok: true }; }
    if (!isSats(outcome.sats)) { r.status = 'unknown'; this.emit({ type: 'settled', requestId, outcome: 'unknown', sats: null }); return { ok: false, reason: 'the reported amount is not a number of sats' }; }
    r.status = 'executed'; r.actualSats = outcome.sats;
    this.ledger.push({ requestId, sats: outcome.sats, at: wall, session: this.sessionId });
    this.emit({ type: 'settled', requestId, outcome: 'executed', sats: outcome.sats });
    if (outcome.sats !== r.totalSats) { this.freeze(`the amount sent (${outcome.sats} sats) is not the amount approved (${r.totalSats} sats)`); return { ok: true, reason: 'mismatch: frozen' }; }
    return { ok: true };
  }

  /** A person checked the wallet and says whether an unknown spend went out. */
  resolveUnknown(requestId: string, outcome: { kind: 'sent'; sats: number } | { kind: 'not-sent' }): boolean {
    const r = this.requests.get(requestId);
    if (!r || r.status !== 'unknown') return false;
    const wall = this.clock.wall();
    if (outcome.kind === 'sent') {
      if (!isSats(outcome.sats)) return false;
      r.status = 'executed'; r.actualSats = outcome.sats; this.ledger.push({ requestId, sats: outcome.sats, at: wall, session: this.sessionId });
    } else r.status = 'failed';
    r.settledAt = wall;
    this.emit({ type: 'resolved', requestId, outcome: outcome.kind });
    return true;
  }

  // ---------------------------------------------------------------- reading

  status(requestId: string): RequestStatus | undefined { this.sweep(); return this.requests.get(requestId)?.status; }

  executedRecords(): LedgerRecord[] { return this.ledger.map((r) => ({ ...r })); }

  snapshot(): PolicySnapshot {
    this.sweep();
    const wall = this.clock.wall();
    const live = [...this.requests.values()];
    return {
      frozen: this.frozen ? { ...this.frozen } : null,
      armed: this.armedUntilWall !== null,
      armedUntil: this.armedUntilWall,
      remainingMs: this.armedUntilWall === null ? 0 : Math.max(0, Math.min(this.armedUntilWall - wall, (this.armedUntilMono as number) - this.clock.mono())),
      caps: { ...this.caps }, hardCaps: { ...HARD_CAPS }, allowlist: [...this.allowlist],
      usage: { sessionSats: this.sessionSats(), last24hSats: this.executedSince(wall - DAY_MS), reservedSats: this.reserved() },
      pending: live.filter((r) => r.status === 'pending' || r.status === 'approved').map((r) => ({ requestId: r.requestId, status: r.status, agentId: r.agentId, totalSats: r.totalSats, expiresAt: r.expiresAt, network: r.network })),
      unknown: live.filter((r) => r.status === 'unknown').map((r) => ({ requestId: r.requestId, agentId: r.agentId, totalSats: r.totalSats })),
    };
  }
}

/** The executed spends in an audit log (decision "executed" with a numeric `sats` field), for rebuilding the rolling window after a restart. */
export function ledgerFromAudit(entries: ReadonlyArray<{ decision: string; ts: string; fields: Record<string, unknown> }>): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (const e of entries) {
    if (e.decision !== 'executed') continue;
    const sats = e.fields.sats; const at = Date.parse(e.ts);
    if (isSats(sats) && Number.isFinite(at)) out.push({ requestId: typeof e.fields.requestId === 'string' ? e.fields.requestId : 'audit', sats, at });
  }
  return out;
}
