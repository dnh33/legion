/**
 * Per-model context windows, so compaction is tuned to the model actually in use.
 *
 * One window per *provider entry* cannot be right for an aggregator: OpenRouter alone lists 466 models whose windows
 * run from 16k to 1M. A single number either compacts a 1M model far too early or lets a 32k one overflow — and the
 * default (deliberately small) compacted a 1M-token model at 16% of what it could hold.
 *
 * The table is a fact about each model, not a setting, so it ships with the app: 466 rows, ~15 KB, no names, no
 * pricing, no licence text. Regenerate with `scripts/scrape-model-windows.mjs`.
 *
 * Order of preference, and why: an owner who states a window for their entry means it (a self-hosted server may
 * differ from the catalogue); otherwise the table; otherwise the conservative default. An unknown model falling back
 * to "small" costs some detail. An unknown model falling back to "large" ends the run.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW } from './compaction.js';

let table: Map<string, number> | undefined;

/** The shipped table, loaded once. A missing or unreadable file is not fatal: every lookup has a fallback. */
function windows(): Map<string, number> {
  if (table) return table;
  table = new Map();
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const line of readFileSync(join(here, 'data', 'model-windows.tsv'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const tab = line.indexOf('\t');
      if (tab <= 0) continue;
      const id = line.slice(0, tab);
      const n = Number(line.slice(tab + 1));
      if (id && Number.isFinite(n) && n >= MIN_CONTEXT_WINDOW && n <= MAX_CONTEXT_WINDOW) table.set(id, n);
    }
  } catch { /* no table: the default below is the safe direction */ }
  return table;
}

/**
 * The window to use for one model.
 *
 * `entryWindow` is what the owner configured for the provider entry, and it wins: a self-hosted or proxied model can
 * differ from any public catalogue, and the owner knows their own server.
 */
export function contextWindowFor(model: string | undefined, entryWindow?: number): number {
  if (entryWindow !== undefined && Number.isFinite(entryWindow)) return clampWindow(entryWindow);
  const id = (model ?? '').trim();
  if (!id) return DEFAULT_CONTEXT_WINDOW;
  const exact = windows().get(id);
  if (exact !== undefined) return exact;
  // Aggregators publish suffixed variants (`id:batch`, `id:free`, a date-stamped alias). The base id is the same model,
  // so fall back to the longest known prefix rather than to the default.
  let best: string | undefined;
  for (const known of windows().keys()) {
    if (id.startsWith(known) && (best === undefined || known.length > best.length)) best = known;
  }
  if (best !== undefined) return windows().get(best)!;
  return DEFAULT_CONTEXT_WINDOW;
}

/** True when the table knows this model — lets Settings say "known" instead of guessing. */
export function knowsModel(model: string | undefined): boolean {
  const id = (model ?? '').trim();
  return id.length > 0 && windows().has(id);
}

/** How many models the shipped table covers. Used by a test so the table cannot silently go empty. */
export function knownModelCount(): number {
  return windows().size;
}

function clampWindow(n: number): number {
  return Math.round(Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, n)));
}