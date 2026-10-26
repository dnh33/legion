import type { Catalog, CatalogModel } from '../../src/shared/types';
import { FALLBACK_MODELS, modelList } from '../../src/shared/model-groups';
import { providerModelLabel } from './providers/providersStore';
import { acpModelLabel } from '../../src/shared/acp-copy';

export { FALLBACK_MODELS, groupModels, modelList, providerCreatorGroups, vendorName } from '../../src/shared/model-groups';

export const AUTO_INFO = 'Legion picks Sonnet or Opus per task';

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9.]+/g, '');

/** Pretty label for a model id/alias, using the catalog displayName when it matches. */
export function modelLabel(c: Catalog | null, value: string | undefined): string {
  if (!value) return '';
  if (value === 'auto') return 'Auto';
  const viaHost = acpModelLabel(value, (id) => c?.hosts?.find((h) => h.entryId === id)?.label);
  if (viaHost) return viaHost;
  const viaProvider = providerModelLabel(value);
  if (viaProvider) return viaProvider;
  const v = norm(value);
  const hit = c?.models.find((m) => norm(m.value) === v || (m.resolvedModel && norm(m.resolvedModel) === v) || norm(m.displayName) === v);
  if (hit) return hit.displayName;
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(value);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

const VALID = /^[A-Za-z0-9._:/[\]-]{1,80}$/;
/** Resolves user input (value, display name or alias) to a model choice, or null if it cannot be one. */
export function resolveModel(c: Catalog | null, input: string): string | null {
  const t = input.trim();
  if (!t) return null;
  if (t.toLowerCase() === 'auto') return 'auto';
  const n = norm(t);
  const fallback: CatalogModel[] = modelList(null).models;
  const hit = c?.models.find((m) => norm(m.value) === n || norm(m.displayName) === n || (m.resolvedModel && norm(m.resolvedModel) === n))
    ?? fallback.find((m) => norm(m.value) === n);
  if (hit) return hit.value;
  return VALID.test(t) ? t : null;
}
