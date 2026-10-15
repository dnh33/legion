/**
 * Picker grouping for Claude models and for provider models. Pure functions with no UI imports, so the Node tests can read them.
 */
import type { Catalog, CatalogModel } from './types.js';

/** Shown when Claude Code's model list is unavailable, so the picker is never empty: the four 5.x models by alias, no older ones. */
export const FALLBACK_MODELS: CatalogModel[] = [
  { value: 'opus', displayName: 'Opus 5.5', description: 'Deepest reasoning. Slower and uses more of your plan.' },
  { value: 'sonnet', displayName: 'Sonnet 5.5', description: 'Fast and capable. Good for most work.' },
  { value: 'fable', displayName: 'Fable 5.1', description: 'The strongest model. Needs usage credits.' },
  { value: 'haiku', displayName: 'Haiku 5.5', description: 'Fastest and cheapest. Good for simple work.' },
];

/** Picker order inside a version: Opus, Sonnet, Fable, Haiku. */
const FAMILIES = ['opus', 'sonnet', 'fable', 'haiku'];
const family = (m: CatalogModel) => (/^[A-Za-z]+/.exec(m.displayName)?.[0] ?? m.value).toLowerCase();
const version = (m: CatalogModel): number[] => {
  const v = /(\d+(?:\.\d+)*)/.exec(m.displayName)?.[1];
  return v ? v.split('.').map(Number) : [];
};
const major = (m: CatalogModel): number | undefined => version(m)[0];
/** Newest first: the comparator puts the larger version earlier. */
const cmpVer = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (b[i] ?? 0) - (a[i] ?? 0); if (d) return d; } return 0; };
const famRank = (f: string) => { const i = FAMILIES.indexOf(f); return i < 0 ? FAMILIES.length : i; };
const bySeries = (a: CatalogModel, b: CatalogModel) => famRank(family(a)) - famRank(family(b)) || family(a).localeCompare(family(b)) || cmpVer(version(a), version(b));

export function modelList(c: Catalog | null): { models: CatalogModel[]; fallback: boolean } {
  return c && c.models.length ? { models: c.models, fallback: false } : { models: FALLBACK_MODELS, fallback: true };
}

/**
 * Groups the Claude models for the picker. "current" is every model of the newest major version present (Fable included),
 * newest first within each family. "older" is everything with a lower major version, newest major first. A model with no version
 * in its name counts as current. The catalog's `default` row is dropped and rows that resolve to the same model are merged.
 */
export function groupModels(c: Catalog | null): { current: CatalogModel[]; older: CatalogModel[]; fallback: boolean } {
  const { models, fallback } = modelList(c);
  if (fallback) return { current: models, older: [], fallback };
  const seen = new Set<string>();
  const uniq: CatalogModel[] = [];
  for (const m of models) {
    if (m.value === 'default') continue;
    const key = m.resolvedModel || m.value;
    if (seen.has(key)) continue;
    seen.add(key); uniq.push(m);
  }
  const majors = uniq.map(major).filter((x): x is number => x !== undefined);
  const newest = majors.length ? Math.max(...majors) : undefined;
  const current = uniq.filter((m) => major(m) === undefined || major(m) === newest).sort(bySeries);
  const older = uniq.filter((m) => !current.includes(m))
    .sort((a, b) => (major(b) ?? 0) - (major(a) ?? 0) || bySeries(a, b));
  return { current, older, fallback };
}

/** Vendor prefixes (the part of a `vendor/model` id before the slash) that read better with their own capitals. */
const VENDORS: Record<string, string> = {
  deepseek: 'DeepSeek', openai: 'OpenAI', google: 'Google', 'meta-llama': 'Meta', mistralai: 'Mistral', 'x-ai': 'xAI',
  qwen: 'Qwen', moonshotai: 'Moonshot', 'z-ai': 'Z.ai', anthropic: 'Anthropic', xiaomi: 'Xiaomi', cohere: 'Cohere',
  nvidia: 'NVIDIA', microsoft: 'Microsoft', amazon: 'Amazon', perplexity: 'Perplexity', minimax: 'MiniMax', bytedance: 'ByteDance',
};

/** The creator's readable name for a vendor prefix. An unknown vendor gets its own name with the first letter capitalised. */
export function vendorName(vendor: string): string {
  const known = VENDORS[vendor.toLowerCase()];
  if (known) return known;
  return vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

export interface ProviderModels { id: string; label: string; models: string[] }
export interface CreatorGroup { id: string; label: string; providerId: string; models: string[] }

/**
 * Splits each switched-on provider's model ids into creator groups. A `vendor/model` id goes under its vendor, labelled with the
 * provider in brackets ("DeepSeek (OpenRouter)"). An id with no slash (Ollama, LM Studio, vLLM, OpenAI direct) goes under the
 * provider's own label. Groups of one provider are sorted by label; the providers keep their order.
 */
export function providerCreatorGroups(providers: ProviderModels[]): CreatorGroup[] {
  const out: CreatorGroup[] = [];
  for (const p of providers) {
    const byKey = new Map<string, CreatorGroup>();
    for (const m of p.models) {
      const slash = m.indexOf('/');
      const vendor = slash > 0 ? m.slice(0, slash) : '';
      const key = vendor ? `${p.id}/${vendor}` : p.id;
      let g = byKey.get(key);
      if (!g) {
        g = { id: key, label: vendor ? `${vendorName(vendor)} (${p.label})` : p.label, providerId: p.id, models: [] };
        byKey.set(key, g);
      }
      if (!g.models.includes(m)) g.models.push(m);
    }
    for (const g of [...byKey.values()].map((g) => ({ ...g, models: g.models.sort((a, b) => a.localeCompare(b)) })).sort((a, b) => a.label.localeCompare(b.label))) out.push(g);
  }
  return out;
}
