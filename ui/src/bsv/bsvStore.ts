/**
 * Store for BSV mode (testnet mode, a read-only wallet status check, policy state, the list of pending and unknown spend requests, and an audit log).
 * Own tiny external store, same pattern as the main store. Talks to GET/POST /api/bsv, GET /api/bsv/wallet, GET /api/bsv/policy and
 * GET /api/bsv/audit. Policy CHANGES (arm, freeze, ...) never go through this file's requests: they go through the Electron bridge
 * (window.legion.bsvPolicy), whose main process shows a native confirmation and holds the secret the core demands.
 *
 * Spend requests are answered in main's native dialogs; this file only names a request id to main (review, deny, resolve). Performance rules
 * (a requirement, tested by source guards): no continuous animation anywhere in the BSV UI; the only timers are the
 * 60 s status poll (runs only while the window is visible AND focused, and only re-renders when an answer actually changed) and the
 * once-per-second countdown in ChainOverlay while mainnet is armed.
 */
import { useSyncExternalStore } from 'react';
import { ApiError, request } from '../api';
import { getState, refresh, selectAgent, toast } from '../store';
import { describeSeed } from '../../../src/shared/bsv-seed';
import type { SeedReport } from '../../../src/shared/bsv-seed';
import { BSV_POLL_MS, shouldPoll } from '../../../src/shared/bsv-view';
import type { AuditView, KnowledgeSummary, PolicyView, WalletView } from '../../../src/shared/bsv-view';

export interface BsvStatus {
  enabled: boolean;
  network: 'testnet';
  assayerAvailable: boolean;
  knowledgeLoaded: boolean;
  /** null = unknown (the count could not be read, or is too old). Never 0 for "could not read". */
  knowledgeNodes: number | null;
  /** The count against the bundled pack, from the same answer (null when unknown). */
  knowledge?: KnowledgeSummary | null;
}
type SeedResult = SeedReport;

/** A status read slower than this is treated as failed. */
const KNOWLEDGE_READ_TIMEOUT_MS = 10_000;

export interface BsvUiState extends BsvStatus {
  /** When the note count was last read successfully (ms). 0 = never. */
  knowledgeAt: number;
  /** First /api/bsv answer has arrived. */
  loaded: boolean;
  /** A toggle request is in flight. */
  busy: boolean;
  /** The first-enable confirmation dialog is open. */
  confirmOpen: boolean;
  /** The BSV panel is open. */
  panelOpen: boolean;
  /** Last answer of the read-only wallet status check (null until BSV mode is on and it was asked). */
  wallet: WalletView | null;
  /** Last answer of GET /api/bsv/policy (null until BSV mode is on). */
  policy: PolicyView | null;
  /** A policy change is waiting for the native dialog or the core. */
  changing: boolean;
  /** The Activity list (loaded when the panel opens, on Refresh and on Older). */
  audit: { entries: AuditView[]; total: number; ok: boolean; reason?: string; more: boolean; loading: boolean; error?: string } | null;
}

export const BSV_TIP = 'BSV Dev Kit: testnet mode. Spends need your confirmation.';
const CONFIRMED_KEY = 'legion.bsv.confirmed';

let state: BsvUiState = {
  loaded: false, busy: false, confirmOpen: false, panelOpen: false, wallet: null, policy: null, changing: false, audit: null,
  enabled: false, network: 'testnet', assayerAvailable: false, knowledgeLoaded: false, knowledgeNodes: null, knowledge: null, knowledgeAt: 0,
};
const listeners = new Set<() => void>();
const set = (p: Partial<BsvUiState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
/** Equal answers do not re-render anything: the wallet and policy are compared by what the UI shows. */
const sameWallet = (a: WalletView | null, b: WalletView | null) => (a === b) || (!!a && !!b && a.condition === b.condition && a.network === b.network && a.height === b.height && a.authenticated === b.authenticated && a.reachable === b.reachable && a.version === b.version && a.probed === b.probed && a.message === b.message);
const samePolicy = (a: PolicyView | null, b: PolicyView | null) => (a === b) || (!!a && !!b && JSON.stringify({ ...a, remainingMs: 0 }) === JSON.stringify({ ...b, remainingMs: 0 }));
const sub = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useBsv<T>(selector: (s: BsvUiState) => T): T { return useSyncExternalStore(sub, () => selector(state)); }

function lsGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore: the dialog just shows again */ } }
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Re-reads /api/state (agent list) and keeps the selection coherent if the selected agent vanished or appeared. */
export async function syncAgents(): Promise<void> {
  const before = getState().selectedAgentId;
  await refresh();
  const after = getState().selectedAgentId;
  if (after !== before) selectAgent(after);
}

const pick = (s: BsvStatus): BsvStatus => ({
  enabled: s.enabled, network: 'testnet', assayerAvailable: s.assayerAvailable, knowledgeLoaded: s.knowledgeLoaded, knowledgeNodes: typeof s.knowledgeNodes === 'number' ? s.knowledgeNodes : null, knowledge: s.knowledge ?? null,
});

let lastPollAt = 0;

/** The read-only answers behind the overlay: policy state and the wallet status check. Only asked while BSV mode is on. */
async function loadDetails(): Promise<void> {
  const [policy, wallet] = await Promise.allSettled([request<PolicyView>('GET', '/api/bsv/policy'), request<WalletView>('GET', '/api/bsv/wallet')]);
  const patch: Partial<BsvUiState> = {};
  if (policy.status === 'fulfilled' && !samePolicy(state.policy, policy.value)) patch.policy = policy.value;
  if (wallet.status === 'fulfilled' && !sameWallet(state.wallet, wallet.value)) patch.wallet = wallet.value;
  if (Object.keys(patch).length) set(patch);
}

export async function loadBsv(): Promise<void> {
  lastPollAt = Date.now();
  try {
    // a slow answer is a failed answer: it must not leave an old number on screen
    const s = await Promise.race([request<BsvStatus>('GET', '/api/bsv'), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('slow')), KNOWLEDGE_READ_TIMEOUT_MS))]);
    const changedElsewhere = state.loaded && s.enabled !== state.enabled && !state.busy;
    const next = pick(s);
    const same = state.loaded && next.enabled === state.enabled && next.assayerAvailable === state.assayerAvailable && next.knowledgeLoaded === state.knowledgeLoaded && next.knowledgeNodes === state.knowledgeNodes && JSON.stringify(next.knowledge) === JSON.stringify(state.knowledge);
    if (!same) set({ ...next, loaded: true, knowledgeAt: Date.now() });
    else set({ knowledgeAt: Date.now() }); // still the same, and freshly read: the age of the number is what makes it trustworthy
    if (!next.enabled) { if (state.wallet || state.policy || state.panelOpen) set({ wallet: null, policy: null, panelOpen: false }); }
    else await loadDetails();
    if (changedElsewhere) await syncAgents();
  } catch {
    // offline, slow, or an older core without /api/bsv: the main connection chip says so. A count that could not be read is UNKNOWN, not 0 and not the last number.
    if (state.knowledgeNodes !== null || state.knowledge) set({ knowledgeNodes: null, knowledge: null, knowledgeLoaded: false });
  }
}

/** Re-reads the policy only (after a change made through main, or a tray Freeze). */
export async function loadPolicy(): Promise<void> {
  try { const p = await request<PolicyView>('GET', '/api/bsv/policy'); if (!samePolicy(state.policy, p)) set({ policy: p }); } catch { /* keep what is shown */ }
}

/**
 * The Connect button: the ONLY way Legion first contacts a wallet. Main shows a native dialog that names the address, then asks the core
 * (which refuses anything but a loopback address). The address is typed by the owner; there is no default.
 */
export async function connectWallet(url: string): Promise<void> {
  const bridge = window.legion?.bsvPolicy;
  if (!bridge) { toast('Open the Legion app to connect a wallet.', 'error'); return; }
  if (state.changing) return;
  set({ changing: true });
  try {
    const r = await bridge({ kind: 'connect', url: url.trim() });
    if (r.ok) { if (r.view) set({ wallet: r.view as WalletView }); toast('Connected. Legion asked the wallet its status.'); }
    else if (!r.cancelled) toast(r.error ?? 'Could not connect.', 'error');
  } catch (e) { toast(`Could not connect: ${msg(e)}`, 'error'); } finally {
    set({ changing: false });
    void loadDetails();
    if (state.panelOpen) void loadAudit(true);
  }
}

export async function disconnectWallet(): Promise<void> {
  const bridge = window.legion?.bsvPolicy;
  if (!bridge || state.changing) return;
  set({ changing: true });
  try {
    const r = await bridge({ kind: 'disconnect' });
    if (r.ok) { if (r.view) set({ wallet: r.view as WalletView }); toast('Disconnected. Legion will not contact the wallet.'); } else if (!r.cancelled) toast(r.error ?? 'Could not disconnect.', 'error');
  } catch (e) { toast(`Could not disconnect: ${msg(e)}`, 'error'); } finally { set({ changing: false }); void loadDetails(); }
}

/** The "Check now" button: asks the wallet again (the core limits how often it really does, and asks nothing until Connect was pressed). */
export async function checkWallet(): Promise<void> {
  try { const w = await request<WalletView>('GET', '/api/bsv/wallet'); if (!sameWallet(state.wallet, w)) set({ wallet: w }); } catch (e) { toast(`Could not check the wallet: ${msg(e)}`, 'error'); }
}

let started = false;
export function initBsv(): void {
  if (started) return;
  started = true;
  void loadBsv();
  const due = () => shouldPoll({ hidden: document.hidden, focused: document.hasFocus(), lastPollAt, now: Date.now() });
  window.setInterval(() => { if (due()) void loadBsv(); }, BSV_POLL_MS);
  const onBack = () => { if (due()) void loadBsv(); };
  document.addEventListener('visibilitychange', onBack);
  window.addEventListener('focus', onBack);
  // main tells the window when a change was made through the tray or by another window action
  try { window.legion?.onBsvChanged?.(() => { void loadPolicy(); }); } catch { /* an older shell: no bridge */ }
}

// ---- panel

export function openBsvPanel(): void { set({ panelOpen: true }); void loadBsv(); void loadAudit(true); }
export function closeBsvPanel(): void { set({ panelOpen: false }); }

const AUDIT_PAGE = 40;
/** The Activity list. `reset` loads the newest page; otherwise the next older one. Asked on demand only: there is no polling of the log. */
export async function loadAudit(reset: boolean): Promise<void> {
  const cur = state.audit;
  set({ audit: { entries: reset || !cur ? [] : cur.entries, total: cur?.total ?? 0, ok: cur?.ok ?? true, reason: cur?.reason, more: false, loading: true } });
  try {
    const before = !reset && cur && cur.entries.length ? cur.entries[cur.entries.length - 1]!.seq : undefined;
    const r = await request<{ entries: AuditView[]; verify: { ok: boolean; reason?: string }; total: number }>('GET', `/api/bsv/audit?limit=${AUDIT_PAGE}${before ? `&before=${before}` : ''}`);
    const entries = [...(reset || !cur ? [] : cur.entries), ...r.entries];
    set({ audit: { entries, total: r.total, ok: r.verify.ok, reason: r.verify.reason, more: r.entries.length === AUDIT_PAGE && entries.length < r.total, loading: false } });
  } catch (e) {
    set({ audit: { entries: reset || !cur ? [] : cur.entries, total: cur?.total ?? 0, ok: cur?.ok ?? true, more: false, loading: false, error: msg(e) } });
  }
}

// ---- policy changes: through the Electron bridge only

export type PolicyAction =
  | { kind: 'arm'; minutes: number } | { kind: 'disarm' } | { kind: 'freeze' } | { kind: 'unfreeze' }
  | { kind: 'mainnet-enable' } | { kind: 'mainnet-disable' }
  | { kind: 'caps'; net?: 'test' | 'main'; caps: Partial<Record<'perTxSats' | 'perSessionSats' | 'per24hSats' | 'maxOutputs' | 'maxFeeSats', number>> } | { kind: 'allowlist'; net?: 'test' | 'main'; list: string[] }
  | { kind: 'spend-review'; requestId: string } | { kind: 'spend-deny'; requestId: string } | { kind: 'spend-resolve'; requestId: string };

const DONE_TOAST: Record<PolicyAction['kind'], string> = {
  arm: 'LIVE FUNDS armed for one mainnet spend', 'mainnet-enable': 'Mainnet switched on (not armed)', 'mainnet-disable': 'Mainnet switched off', caps: 'Limits changed', allowlist: 'Recipient list replaced', disarm: 'Disarmed', freeze: 'BSV chain frozen', unfreeze: 'BSV chain unfrozen',
  'spend-review': 'Your answer was sent to the core.', 'spend-deny': 'Request denied.', 'spend-resolve': 'Outcome recorded.',
};

/** True in the Legion app (the shell exposes the bridge). A browser tab has none: it can look, not change. */
export const canChangePolicy = (): boolean => typeof window !== 'undefined' && typeof window.legion?.bsvPolicy === 'function';

/**
 * Asks main to make a change. Main parses it, shows the NATIVE confirmation where one is due, and calls the core with a secret this
 * window never holds. A spend request is named by its id only: main reads the card from the core and words its own dialogs.
 */
export async function changePolicy(action: PolicyAction): Promise<void> {
  const bridge = window.legion?.bsvPolicy;
  if (!bridge) { toast('Open the Legion app to change BSV policy.', 'error'); return; }
  if (state.changing) return;
  set({ changing: true });
  try {
    const r = await bridge(action);
    if (r.ok) {
      if (r.view && !action.kind.startsWith('spend-')) set({ policy: r.view as PolicyView });
      toast(DONE_TOAST[action.kind]);
    } else if (!r.cancelled) {
      toast(r.error ?? 'The change was refused.', 'error');
    }
  } catch (e) {
    toast(`The change failed: ${msg(e)}`, 'error');
  } finally {
    set({ changing: false });
    void loadPolicy();
    if (state.panelOpen) void loadAudit(true);
  }
}

export async function setBsv(enabled: boolean): Promise<void> {
  if (state.busy) return;
  set({ busy: true, confirmOpen: false });
  try {
    const r = await request<BsvStatus & { seed?: SeedResult }>('POST', '/api/bsv', { enabled });
    set({ ...pick(r), loaded: true, knowledgeAt: Date.now(), ...(r.enabled ? {} : { wallet: null, policy: null, panelOpen: false }) });
    if (r.enabled) void loadDetails();
    await syncAgents();
    if (enabled && r.seed && (r.seed.status === 'error' || r.seed.status === 'no-kg')) toast(`BSV mode is on, but the knowledge pack did not load: ${describeSeed(r.seed).text}`, 'error');
    else if (enabled && r.seed && r.seed.status !== 'already-loaded') toast(`BSV mode on (testnet knowledge mode). ${describeSeed(r.seed).text}`); // loaded, upgraded or repaired: say what changed
    else toast(enabled ? 'BSV mode on (testnet knowledge mode)' : 'BSV mode off');
  } catch (e) {
    toast(`Could not change BSV mode: ${msg(e)}`, 'error');
    await loadBsv();
  } finally {
    set({ busy: false });
  }
}

/** The title-bar switch. Turning on the first time asks first; turning off is immediate. */
export function requestToggle(): void {
  if (state.busy) return;
  if (state.enabled) { void setBsv(false); return; }
  if (lsGet(CONFIRMED_KEY) === '1') { void setBsv(true); return; }
  set({ confirmOpen: true });
}
export function confirmEnable(): void { lsSet(CONFIRMED_KEY, '1'); void setBsv(true); }
export function cancelConfirm(): void { set({ confirmOpen: false }); }

/**
 * Brings back bundled notes that are NOT in the graph at all (never loaded, or deleted), through the existing seed route and its existing
 * rules (admin gate; nothing is overwritten: a note that exists is never named, so an edited note stays as it is). Retired notes are not
 * touched here: bring those back from the Library.
 */
export async function restoreBundledNotes(): Promise<void> {
  const ids = state.knowledge?.missingIds ?? [];
  if (!ids.length) { toast('Nothing is missing.'); return; }
  if (state.changing) return;
  set({ changing: true });
  try {
    const r = await request<{ added?: number; restored?: string[]; status?: string }>('POST', '/api/kg/seed/bsv', { restore: ids });
    toast(`Brought back ${r.restored?.length ?? r.added ?? 0} bundled note${(r.restored?.length ?? r.added ?? 0) === 1 ? '' : 's'}. Notes you edited were not touched.`);
  } catch (e) {
    toast(`Could not restore the notes: ${msg(e)}`, 'error');
  } finally {
    set({ changing: false });
    await loadBsv();
  }
}
