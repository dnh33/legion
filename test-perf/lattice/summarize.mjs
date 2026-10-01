// node test-perf/lattice/summarize.mjs base1.json base2.json -- new1.json new2.json   (median over runs, min for gap/long-task maxima)
import fs from 'node:fs';
const i = process.argv.indexOf('--'); const A = process.argv.slice(2, i).map((f) => JSON.parse(fs.readFileSync(f))), B = process.argv.slice(i + 1).map((f) => JSON.parse(fs.readFileSync(f)));
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const labels = A[0].windows.map((w) => w.label);
const cols = ['apiReqs', 'ticks', 'draws', 'settledMs', 'scriptMs', 'cpuTaskMs', 'tickMsPerFrameMax', 'setDataCalls', 'setDataMsMax', 'gapMax', 'longTaskMax', 'longTaskSum', 'gapsOver34'];
const pick = (runs, label, k) => { const v = runs.map((r) => r.windows.find((w) => w.label === label)?.[k]).filter((x) => x !== undefined); return v.length ? (k === 'gapMax' || k === 'longTaskMax' || k === 'tickMsPerFrameMax' || k === 'setDataMsMax' ? Math.min(...v) : med(v)) : '-'; };
const rows = [['window', ...cols.map((c) => c + ' (base -> new)')]];
for (const l of labels) rows.push([l, ...cols.map((c) => `${pick(A, l, c)} -> ${pick(B, l, c)}`)]);
for (const r of rows) console.log(r.join(' | '));
console.log('\nrequests per window (run 1)');
for (const l of labels) console.log(l, JSON.stringify(A[0].windows.find((w) => w.label === l).req), '->', JSON.stringify(B[0].windows.find((w) => w.label === l).req));
console.log('\ndraw micro (min over runs)');
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flat(v, p + k + '.') : [[p + k, v]]);
const dA = flat(A[0].draw); for (const [k] of dA) { const f = (R) => Math.min(...R.map((r) => Object.fromEntries(flat(r.draw))[k])); console.log(k.padEnd(28), f(A), '->', f(B)); }
