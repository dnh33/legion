import type { Catalog, CatalogModel } from '../../src/shared/types';

/** Shown when Claude Code's model list is unavailable, so the picker is never empty. */
export const FALLBACK_MODELS: CatalogModel[] = [
  { value: 'sonnet', displayName: 'Sonnet', description: 'Fast and capable. Good for most work.' },
  { value: 'opus', displayName: 'Opus', description: 'Deepest reasoning. Slower and uses more of your plan.' },
];

export const AUTO_INFO = 'Legion picks Sonnet or Opus per task';
export const AUTO_LABEL = 'Auto \u00b7 Legion picks Sonnet or Opus per task';

export function modelList(c: Catalog | null): { models: CatalogModel[]; fallback: boolean } {
  return c && c.models.length ? { models: c.models, fallback: false } : { models: FALLBACK_MODELS, fallback: true };
}

const FAMILIES = ['opus', 'sonnet', 'fable', 'haiku'];
const family = (m: CatalogModel) => (/^[A-Za-z]+/.exec(m.displayName)?.[0] ?? m.value).toLowerCase();
const version = (m: CatalogModel): number[] => (/(\d+(?:\.\d+)*)/.exec(m.displayName)?.[1] ?? '0').split('.').map(Number);
const cmpVer = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (b[i] ?? 0) - (a[i] ?? 0); if (d) return d; } return 0; };
const famRank = (f: string) => { const i = FAMILIES.indexOf(f); return i < 0 ? FAMILIES.length : i; };

/**
 * Groups catalog models for the picker: "current" is the newest version of each family, "more" is the rest.
 * The catalog's `default` row is dropped (Auto plus the explicit models cover it) and rows that resolve to the same model are merged.
 */
export function groupModels(c: Catalog | null): { current: CatalogModel[]; more: CatalogModel[]; fallback: boolean } {
  const { models, fallback } = modelList(c);
  if (fallback) return { current: models, more: [], fallback };
  const seen = new Set<string>();
  const uniq: CatalogModel[] = [];
  for (const m of models) {
    if (m.value === 'default') continue;
    const key = m.resolvedModel || m.value;
    if (seen.has(key)) continue;
    seen.add(key); uniq.push(m);
  }
  const sorted = uniq.slice().sort((a, b) => famRank(family(a)) - famRank(family(b)) || family(a).localeCompare(family(b)) || cmpVer(version(a), version(b)));
  const top = new Set<string>(); const current: CatalogModel[] = []; const more: CatalogModel[] = [];
  for (const m of sorted) { const f = family(m); if (!top.has(f)) { top.add(f); current.push(m); } else more.push(m); }
  return { current, more, fallback };
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9.]+/g, '');

/** Pretty label for a model id/alias, using the catalog displayName when it matches. */
export function modelLabel(c: Catalog | null, value: string | undefined): string {
  if (!value) return '';
  if (value === 'auto') return 'Auto';
  const v = norm(value);
  const hit = c?.models.find((m) => norm(m.value) === v || (m.resolvedModel && norm(m.resolvedModel) === v) || norm(m.displayName) === v);
  if (hit) return hit.displayName;
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(value);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const VALID = /^[A-Za-z0-9._:[\]-]{1,80}$/;
/** Resolves user input (value, display name or alias) to a model choice, or null if it cannot be one. */
export function resolveModel(c: Catalog | null, input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (t.toLowerCase() === 'auto') return 'auto';
  const n = norm(t);
  const hit = c?.models.find((m) => norm(m.value) === n || norm(m.displayName) === n || (m.resolvedModel && norm(m.resolvedModel) === n))
    ?? FALLBACK_MODELS.find((m) => norm(m.value) === n);
  if (hit) return hit.value;
  return VALID.test(t) ? t : null;
}
