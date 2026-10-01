// Node microbenchmark for the core half of perf round L. Usage: DIST=/path/to/dist node test-perf/core/bench.mjs   (default: ./dist)
// Prints JSON: first seed, already-loaded re-apply, search over N nodes (Zipf-ish vocabulary), vault export+import round trip.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dist = resolve(process.env.DIST ?? 'dist');
const imp = (p) => import(pathToFileURL(join(dist, 'src/core', p)).href);
const { Graph } = await imp('kg/graph.js');
const { applySeedPack, loadBsvSeed } = await imp('kg/seed.js');
const { HUMAN } = await imp('kg/types.js');
const { exportVault, importVault } = await imp('kg/vault.js');
const ms = (f) => { const t = process.hrtime.bigint(); const r = f(); return [Number(process.hrtime.bigint() - t) / 1e6, r]; };
const out = {};
const dir = mkdtempSync(join(tmpdir(), 'legion-bench-'));
const g = new Graph({ dir, bsvEnabled: () => true });
const pack = loadBsvSeed();
out.firstSeedMs = +ms(() => applySeedPack(g, pack))[0].toFixed(1);
out.alreadyLoadedMs = +[1, 2, 3].map(() => ms(() => applySeedPack(g, pack))[0]).sort((a, b) => a - b)[1].toFixed(1);
const v = mkdtempSync(join(tmpdir(), 'legion-bench-v-'));
const before = g.counts();
exportVault(g, HUMAN, v); importVault(g, v, HUMAN, { userInitiated: true });
out.roundTrip = { before, after: g.counts() };
// search at scale
const N = Number(process.env.N ?? 3000);
const g2 = new Graph({ dir: mkdtempSync(join(tmpdir(), 'legion-bench-s-')), bsvEnabled: () => false });
const vocab = Array.from({ length: 400 }, (_, i) => `w${i}x`);
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const zipf = () => vocab[Math.floor(Math.pow(rnd(), 2.2) * vocab.length)];
const fill = () => { for (let i = 0; i < N; i++) g2.upsertNode(HUMAN, { title: `n${i} ${zipf()}`, body: Array.from({ length: 120 }, zipf).join(' ') }); };
if (g2.batch) g2.batch(fill); else fill();
const qs = vocab.slice(0, 60);
const times = qs.map((q) => ms(() => g2.search(HUMAN, q, { limit: 25 }))[0]).sort((a, b) => a - b);
out.search = { nodes: N, p50: +times[30].toFixed(2), p95: +times[57].toFixed(2), totalMs: +times.reduce((a, b) => a + b, 0).toFixed(1) };
console.log(JSON.stringify(out, null, 1));
