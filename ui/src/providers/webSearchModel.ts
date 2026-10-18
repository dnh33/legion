/** Settings, Web search: the pure rules the section uses (what the selects offer, the cap field, the key field text). No React, so the core suite can run it. */
import type { WebProviderId } from '../../../src/shared/web-search-config.js';

export interface WebSearchViewProvider { id: WebProviderId; label: string; canSearch: boolean; canRead: boolean; needsKey: boolean; ready: boolean }
export interface WebSearchView {
  search: 'builtin' | WebProviderId; read: 'builtin' | WebProviderId;
  tregMaxCostUsd: number;
  searxng?: { baseUrl: string; allowPrivateNetwork?: boolean };
  acknowledged: Partial<Record<WebProviderId, string>>;
  providers: WebSearchViewProvider[];
  keys: Record<string, { set: boolean; hint?: string }>;
  /** One plain line on how the saved keys are stored (from the core). */
  keyStore?: string;
  capLimits: { min: number; max: number };
  nativeAvailable: boolean;
}
export type WebJob = 'search' | 'read';

export const BUILTIN_LABEL = 'Built-in';
export const APPLIES_LINE = 'Applies to runs started after you save.';

/** Built-in first, then every provider that can do the job. */
export function selectOptions(v: Pick<WebSearchView, 'providers'>, job: WebJob): Array<{ value: 'builtin' | WebProviderId; label: string }> {
  return [{ value: 'builtin', label: BUILTIN_LABEL }, ...v.providers.filter((p) => (job === 'search' ? p.canSearch : p.canRead)).map((p) => ({ value: p.id, label: p.label }))];
}

export function parseCap(text: string, limits: { min: number; max: number }): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(text.trim().replace(',', '.'));
  if (text.trim() !== '' && Number.isFinite(n) && n >= limits.min && n <= limits.max) return { ok: true, value: n };
  return { ok: false, error: `The per-call spending cap must be between $${limits.min} and $${limits.max.toFixed(2)}.` };
}

export function keyPlaceholder(v: Pick<WebSearchView, 'keys'>, id: WebProviderId): string {
  const k = v.keys[`web:${id}`];
  return k?.set ? `Saved (${k.hint ?? '…'}). Paste a new one to replace it.` : 'Paste your key';
}

/** The label of the picked provider when it has no key or address yet, so the page can say so. */
export function pickedNotReady(v: WebSearchView, job: WebJob): string | undefined {
  const id = v[job];
  if (id === 'builtin') return undefined;
  const p = v.providers.find((x) => x.id === id);
  return p && !p.ready ? p.label : undefined;
}

/**
 * While a paid provider waits for "Use <name>", the select still shows what the runs use. Say that, and name the pick that is not in use yet.
 * `jobs` are the picks the change carries (search, read); nothing for a cap or an address.
 */
export function pendingStatus(v: Pick<WebSearchView, 'search' | 'read' | 'providers'>, pending: { name: string; enableLabel: string; body: Record<string, unknown> }): string | undefined {
  const jobs = (['search', 'read'] as const).filter((j) => typeof pending.body[j] === 'string');
  if (jobs.length === 0) return undefined;
  const label = (id: string): string => (id === 'builtin' ? BUILTIN_LABEL : v.providers.find((p) => p.id === id)?.label ?? id);
  const noun = { search: 'Search', read: 'Page reading' } as const;
  const now = jobs.map((j) => `${noun[j]} is still on ${label(v[j])}`);
  const head = now.length === 1 ? now[0]! : `${now[0]!} and ${now[1]!.charAt(0).toLowerCase()}${now[1]!.slice(1)}`;
  return `${head}. ${pending.name} is picked but not in use until you choose "${pending.enableLabel}".`;
}

export const noticeParagraphs = (notice: string): string[] => notice.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
