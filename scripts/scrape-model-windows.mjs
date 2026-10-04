// Regenerates src/core/providers/data/model-windows.tsv from a provider's public model catalogue.
//
//   node scripts/scrape-model-windows.mjs                       # OpenRouter (default)
//   node scripts/scrape-model-windows.mjs --url <url> --out <file>
//
// Only two facts per model are kept: the id and its context window. No names, no prices, no licence text — this file
// ships inside the app, and the smallest honest artefact is the one that cannot rot into a licensing question.
//
// Why a checked-in snapshot rather than a live lookup at runtime: compaction has to decide BEFORE the request, on the
// hot path, and a network call there would be slow, and would fail exactly when a provider is already in trouble.
// A stale number costs a little detail; a failed lookup at the wrong moment costs the run.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const url = arg('url', 'https://openrouter.ai/api/v1/models');
const out = arg('out', 'src/core/providers/data/model-windows.tsv');

const res = await fetch(url);
if (!res.ok) {
  console.error(`[scrape-model-windows] ${url} answered ${res.status}`);
  process.exit(1);
}
const body = await res.json();

const rows = [];
for (const m of body?.data ?? []) {
  if (typeof m?.id !== 'string' || !m.id) continue;
  const n = m.context_length;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
  rows.push([m.id, Math.round(n)]);
}
if (rows.length === 0) {
  // Never write an empty table: every lookup would fall back to the small default and compact constantly.
  console.error('[scrape-model-windows] the catalogue returned no usable context_length; nothing written');
  process.exit(1);
}

rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, rows.map(([id, n]) => `${id}\t${n}`).join('\n') + '\n', 'utf8');
console.log(`[scrape-model-windows] wrote ${rows.length} models to ${out}`);