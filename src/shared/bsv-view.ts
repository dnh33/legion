/**
 * What the BSV UI shows, as pure functions over the three read-only answers of the core (status, wallet probe, policy). Shared so the
 * title-bar overlay, the panel and the tests use the same text and the same decisions. Nothing here talks to a wallet or can spend.
 */

export type WalletCondition = 'off' | 'not-configured' | 'not-connected' | 'rejected-url' | 'not-detected' | 'testnet' | 'mainnet-warning' | 'unknown-network';

/** GET /api/bsv/wallet (a subset: the UI never needs the wire log). */
export interface WalletView {
  probed: boolean;
  /** The owner pressed Connect in this launch. */
  connected: boolean;
  reachable: boolean;
  authenticated: boolean;
  network: 'main' | 'test' | 'unknown';
  version: string | null;
  height: number | null;
  checkedAt: string;
  url: string;
  condition: WalletCondition;
  message: string;
}

export interface PolicyCaps { perTxSats: number; perSessionSats: number; per24hSats: number; maxOutputs: number; maxFeeSats: number }

/** GET /api/bsv/policy (a subset). */
export interface PolicyView {
  frozen: { at?: string; reason?: string } | null;
  armed: boolean;
  /** Wall-clock ms when arming ends, or null. */
  armedUntil: number | null;
  caps: PolicyCaps;
  hardCaps: PolicyCaps;
  allowlist: string[];
  usage: { sessionSats: number; last24hSats: number; reservedSats: number };
  pending: Array<{ requestId: string; totalSats: number }>;
  unknown: Array<{ requestId: string; totalSats: number }>;
  network: 'testnet';
  nativeAvailable: boolean;
  spendTools: boolean;
  armChoicesMinutes: number[];
  audit: { ok: boolean; entries: number; reason?: string };
}

/** GET /api/bsv/audit entries. */
export interface AuditView {
  seq: number; ts: string; agent: string; task: string | null; tool: string; decision: string; reason: string | null;
  fields: Record<string, string | number | boolean | null>;
}

export type OverlayMode = 'off' | 'testnet' | 'armed' | 'frozen';

export interface OverlayModel {
  mode: OverlayMode;
  /** The wallet says mainnet while Legion is in testnet knowledge mode (a warning, not a mode). */
  mainnetWarning: boolean;
  /** The Freeze chain button must be on screen. */
  showFreeze: boolean;
  /** Title-bar text, longest first (the overlay picks the longest that fits). */
  tiers: string[][];
  /** The wording the pill shows, or null for no pill. */
  pill: { kind: 'armed' | 'pending' | 'frozen' | 'mainnet'; text: string } | null;
}

export const MAINNET_SENTENCE = 'The wallet is on MAINNET; Legion is in testnet knowledge mode; Legion will not use it.';

/** Whole seconds to mm:ss (h:mm:ss from an hour). Negative and junk give 00:00. */
export function formatCountdown(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

export function remainingMs(policy: Pick<PolicyView, 'armed' | 'armedUntil'> | null, now: number): number {
  if (!policy || !policy.armed || typeof policy.armedUntil !== 'number') return 0;
  return Math.max(0, policy.armedUntil - now);
}

/** "1,234,567" for a block height; empty for anything that is not a plain count. */
export function heightText(h: unknown): string {
  return typeof h === 'number' && Number.isSafeInteger(h) && h >= 0 ? h.toLocaleString('en-US') : '';
}

/** The decision for the title bar, the pill and the Freeze button. `now` only matters for an armed state that has run out. */
export function overlayModel(i: { enabled: boolean; policy: PolicyView | null; wallet: WalletView | null; nodes?: number; knowledgeLoaded?: boolean; now: number }): OverlayModel {
  if (!i.enabled) return { mode: 'off', mainnetWarning: false, showFreeze: false, tiers: [], pill: null };
  const p = i.policy;
  const mainnetWarning = i.wallet?.condition === 'mainnet-warning';
  const armed = !!p && p.armed && remainingMs(p, i.now) > 0 && !p.frozen;
  const frozen = !!p?.frozen;
  const pending = (p?.pending.length ?? 0);
  const count = i.knowledgeLoaded && (i.nodes ?? 0) > 0 ? `${i.nodes} bsv node${i.nodes === 1 ? '' : 's'}` : '';
  const block = i.wallet?.condition === 'testnet' && heightText(i.wallet.height) ? `block ${heightText(i.wallet.height)}` : '';
  const second = block || count;
  const showFreeze = (armed || pending > 0) && !frozen;
  if (frozen) {
    return { mode: 'frozen', mainnetWarning, showFreeze: false, tiers: [['BSV FROZEN', 'BSV tools stopped'], ['BSV FROZEN']], pill: { kind: 'frozen', text: 'The BSV chain is frozen.' } };
  }
  if (armed) {
    return {
      mode: 'armed', mainnetWarning, showFreeze,
      tiers: [['LIVE FUNDS ARMED', 'policy only: no spend tool'], ['LIVE FUNDS ARMED'], ['LIVE']],
      pill: { kind: 'armed', text: 'LIVE FUNDS armed' },
    };
  }
  if (pending > 0) return { mode: 'testnet', mainnetWarning, showFreeze, tiers: [['TESTNET', `${pending} pending`]], pill: { kind: 'pending', text: `${pending} request${pending === 1 ? '' : 's'} pending` } };
  if (mainnetWarning) {
    return { mode: 'testnet', mainnetWarning, showFreeze: false, tiers: [['WALLET ON MAINNET', 'Legion stays on testnet'], ['WALLET ON MAINNET']], pill: { kind: 'mainnet', text: MAINNET_SENTENCE } };
  }
  return { mode: 'testnet', mainnetWarning: false, showFreeze: false, tiers: [['TESTNET \u00b7 knowledge mode', ...(second ? [second] : [])], ['TESTNET', ...(second ? [second] : [])], ['TESTNET']], pill: null };
}

/** One calm headline for the wallet row of the panel. */
export function walletHeadline(w: WalletView | null, enabled: boolean): string {
  if (!enabled) return 'BSV mode is off, so the wallet is not checked.';
  if (!w) return 'Not connected. Legion has not contacted any wallet.';
  switch (w.condition) {
    case 'not-configured': return 'No wallet address is set. Type the address of your wallet and press Connect. Until then Legion contacts nothing.';
    case 'not-connected': return 'Not connected. Legion has not contacted a wallet in this session and will not until you press Connect.';
    case 'mainnet-warning': return `MAINNET: ${MAINNET_SENTENCE}${w.authenticated ? '' : ' It reports that it is not signed in.'}`;
    case 'testnet': return `Answers as a testnet wallet${w.version ? `, version ${safeLine(w.version, 40)}` : ''}${heightText(w.height) ? `, block ${heightText(w.height)}` : ''}${w.authenticated ? '' : ', not signed in'}. This is the wallet's own claim.`;
    case 'unknown-network': return 'Something answered but did not say which network it is on. Legion will not use it.';
    case 'rejected-url': return 'The configured wallet address is not a loopback address, so Legion did not contact it.';
    case 'not-detected': return 'No wallet answered.';
    default: return w.probed ? 'Not checked.' : 'Not checked yet.';
  }
}

/** Text that came from outside (a wallet's version string, an audit reason): printable, one line, short. Data, never markup. */
export function safeLine(s: unknown, max = 200): string {
  const t = (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

/** One audit entry as a line of words for the Activity list. */
export function auditLine(e: AuditView): { when: string; who: string; what: string; why: string } {
  const d = new Date(e.ts);
  const when = Number.isNaN(d.getTime()) ? safeLine(e.ts, 30) : d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  return { when, who: safeLine(e.agent, 40), what: `${safeLine(e.tool, 40)}: ${safeLine(e.decision, 40)}`, why: safeLine(e.reason ?? '', 240) };
}

/** Polling rule: the BSV status is re-read only while the window is visible and focused, and never more often than once a minute. */
export const BSV_POLL_MS = 60_000;
export function shouldPoll(i: { hidden: boolean; focused: boolean; lastPollAt: number; now: number; minGapMs?: number }): boolean {
  return !i.hidden && i.focused && i.now - i.lastPollAt >= (i.minGapMs ?? BSV_POLL_MS);
}
