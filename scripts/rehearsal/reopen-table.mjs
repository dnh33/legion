// Rehearsal-only: joins the result.json files of the reopen scenarios into one table for the job summary.
// usage: node reopen-table.mjs <folder holding the downloaded result files (any depth)>
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const found = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/^result.*\.json$/.test(n)) found.push(p); } };
walk(process.argv[2] ?? '.');
const rows = found.map((p) => JSON.parse(readFileSync(p, 'utf8'))).sort((x, y) => x.label.localeCompare(y.label, undefined, { numeric: true }));
const cell = (s) => String(s ?? '-').replace(/\|/g, '/');
const out = ['## Reopen during a full-package update (frozen 0.3.0 helper)', '',
  '| scenario | reopen | first attempt | outcome reason | final version | data survived | Legion instances left | later result |', '|---|---|---|---|---|---|---|---|'];
for (const r of rows) {
  const f = r.final ?? {};
  const later = r.selfHealed === true ? `self-healed after ${r.selfHealSeconds}s` : r.selfHealed === false ? 'STUCK (no self-heal in 14 min)' : r.timeline?.retryDoneAt ? `retry landed ${Math.round((r.timeline.retryDoneAt - r.timeline.retryPressedAt) / 1000)}s after Update` : '-';
  out.push(`| ${cell(r.scenario)} | ${r.reopenAt === 'never' ? 'never' : `+${cell(r.reopenAt)}s`} | ${cell(r.first?.kind)} | ${cell(r.first?.reason)} | ${cell(f.version)} | ${cell(f.data)} | ${cell(f.mains)} app, ${cell(f.cores)} core | ${cell(later)} |`);
}
out.push('', ...rows.flatMap((r) => [`**${r.label}** (copy ${r.timeline?.copySeconds ?? '?'}s on the runner)`, ...(r.findings ?? []).map((x) => `- ${x}`), ...(r.problems ?? []).map((x) => `- PROBLEM: ${x}`), '']));
const text = out.join('\n') + '\n';
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
