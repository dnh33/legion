#!/usr/bin/env node
// Summarises a real-PC test run. Zero dependencies.
//
//   node scripts/harness/pc-report.mjs [results.json] [--plan pc-checks.json] [--by-safety] [--json] [--strict]
//   node scripts/harness/pc-report.mjs --emit-md      prints the per-area check tables for claude/real-pc-test-plan.md
//   node scripts/harness/pc-report.mjs --list         prints id, area, safety, automation and title of every check
//
// The results file is JSON: { "results": { "PC-INST-01": { "status": "pass", "date": "2026-10-02", "evidence": "path" } } }
// (an array of { id, status, date, evidence } also works). A check with no entry is NOT-RUN. When no results file is given,
// the `result` fields inside the plan are used. Statuses: pass | fail | not-run | skip (skip = owner declined or not applicable
// on this build; counted separately and never a failure).
// Exit codes: 0 no FAIL; 1 at least one FAIL (or, with --strict, any NOT-RUN); 2 unreadable or invalid input.
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STATUSES = ['pass', 'fail', 'not-run', 'skip'];
const here = dirname(fileURLToPath(import.meta.url));
export const defaultPlanPath = join(here, 'pc-checks.json');

export function loadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')); }
  catch (e) { throw new Error(`cannot read ${path}: ${e.message}`); }
}

/** Normalises the two accepted results shapes to a Map(id -> {status,date,evidence}). Throws on a bad status. */
export function parseResults(raw) {
  const out = new Map();
  const entries = Array.isArray(raw) ? raw.map((r) => [r?.id, r])
    : raw && typeof raw === 'object' ? Object.entries(raw.results ?? raw) : [];
  for (const [id, r] of entries) {
    if (typeof id !== 'string' || !r || typeof r !== 'object') throw new Error(`bad result entry for ${String(id)}`);
    const status = String(r.status ?? 'not-run').toLowerCase();
    if (!STATUSES.includes(status)) throw new Error(`${id}: unknown status "${r.status}" (use ${STATUSES.join(', ')})`);
    out.set(id, { status, date: r.date ?? null, evidence: r.evidence ?? null });
  }
  return out;
}

/** results: Map or null (null = use each check's own result field). Returns the summary used by the CLI and the tests. */
export function summarize(plan, results = null) {
  const known = new Set(plan.checks.map((c) => c.id));
  if (results) for (const id of results.keys()) if (!known.has(id)) throw new Error(`results file names an unknown check: ${id}`);
  const count = () => ({ pass: 0, fail: 0, 'not-run': 0, skip: 0, total: 0 });
  const byArea = new Map(plan.areas.map((a) => [a.id, count()]));
  const bySafety = {};
  const failures = [];
  const rows = [];
  for (const c of plan.checks) {
    const r = results ? results.get(c.id) : c.result;
    const status = STATUSES.includes(r?.status) ? r.status : 'not-run';
    rows.push({ id: c.id, area: c.area, status, date: r?.date ?? null, evidence: r?.evidence ?? null });
    const a = byArea.get(c.area) ?? count(); byArea.set(c.area, a);
    const s = (bySafety[c.safety] ??= count());
    for (const bucket of [a, s]) { bucket[status]++; bucket.total++; }
    if (status === 'fail') failures.push(c.id);
  }
  const total = count();
  for (const a of byArea.values()) for (const k of Object.keys(total)) total[k] += a[k];
  return { byArea: Object.fromEntries(byArea), bySafety, total, failures, rows };
}

export function validatePlan(plan) {
  const problems = [];
  const areaIds = new Set(plan.areas.map((a) => a.id));
  const ids = new Set();
  const safety = new Set(['none', 'downloads', 'spends-money', 'native-dialog', 'real-wallet', 'real-funds', 'account']);
  const automation = new Set(['computer-use-ok', 'command-only', 'owner-must-be-present', 'owner-only']);
  for (const c of plan.checks) {
    if (!/^PC-[A-Z]+-\d\d$/.test(c.id)) problems.push(`${c.id}: id shape`);
    if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
    ids.add(c.id);
    if (!areaIds.has(c.area) || !c.id.startsWith(`PC-${c.area}-`)) problems.push(`${c.id}: area ${c.area}`);
    if (!safety.has(c.safety)) problems.push(`${c.id}: safety ${c.safety}`);
    if (!automation.has(c.automation)) problems.push(`${c.id}: automation ${c.automation}`);
    for (const f of ['title', 'preconditions', 'expected', 'evidence']) if (!c[f] || typeof c[f] !== 'string') problems.push(`${c.id}: ${f} missing`);
    if (!Array.isArray(c.steps) || c.steps.length === 0) problems.push(`${c.id}: steps missing`);
    if (!Array.isArray(c.source) || c.source.length === 0) problems.push(`${c.id}: source missing`);
    if (!STATUSES.includes(c.result?.status)) problems.push(`${c.id}: result.status`);
  }
  for (const c of plan.checks) for (const d of c.depends ?? []) if (!ids.has(d)) problems.push(`${c.id}: depends on unknown ${d}`);
  return problems;
}

const pad = (s, n) => String(s).padEnd(n);
function table(title, map) {
  const lines = [title, `${pad('', 28)}${pad('PASS', 6)}${pad('FAIL', 6)}${pad('NOT-RUN', 9)}${pad('SKIP', 6)}TOTAL`];
  for (const [k, v] of Object.entries(map)) lines.push(`${pad(k, 28)}${pad(v.pass, 6)}${pad(v.fail, 6)}${pad(v['not-run'], 9)}${pad(v.skip, 6)}${v.total}`);
  return lines.join('\n');
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function emitMarkdown(plan) {
  const out = [];
  for (const a of plan.areas) {
    const list = plan.checks.filter((c) => c.area === a.id);
    out.push(`### ${a.name} (${a.id}, ${list.length} checks, gate ${a.gate})`, '');
    for (const c of list) {
      out.push(`#### ${c.id}: ${c.title}`, '');
      out.push(`- **Source:** ${c.source.map((s) => s).join('; ')}${c.inferred ? `. **INFERRED:** ${c.inferredNote ?? 'inferred from code or docs; no agent listed it.'}` : ''}`);
      out.push(`- **Gate / depends:** ${c.gate}${c.depends?.length ? ` / after ${c.depends.join(', ')}` : ''}`);
      out.push(`- **Safety / automation:** ${c.safety} / ${c.automation}`);
      out.push(`- **Preconditions:** ${c.preconditions}`);
      out.push('- **Steps:**');
      c.steps.forEach((s, i) => out.push(`  ${i + 1}. ${s}`));
      out.push(`- **Expected:** ${c.expected}`);
      out.push(`- **Evidence:** ${c.evidence}`);
      out.push(`- **Result:** ${c.result.status} | date: ${c.result.date ?? '-'} | evidence path: ${c.result.evidence ?? '-'}`, '');
    }
  }
  return out.join('\n');
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !['--plan'].includes(a)));
  const pi = argv.indexOf('--plan');
  const planPath = pi >= 0 ? resolve(argv[pi + 1] ?? '') : defaultPlanPath;
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(pi >= 0 && i === pi + 1));
  let plan;
  try { plan = loadJson(planPath); } catch (e) { console.error(e.message); return 2; }
  const problems = validatePlan(plan);
  if (problems.length) { console.error(`plan is invalid:\n  ${problems.join('\n  ')}`); return 2; }
  if (flags.has('--emit-md')) { console.log(emitMarkdown(plan)); return 0; }
  if (flags.has('--list')) { for (const c of plan.checks) console.log(`${c.id}\t${c.area}\t${c.safety}\t${c.automation}\t${c.title}`); return 0; }
  let results = null;
  try { if (positional[0]) results = parseResults(loadJson(resolve(positional[0]))); }
  catch (e) { console.error(e.message); return 2; }
  let sum;
  try { sum = summarize(plan, results); } catch (e) { console.error(e.message); return 2; }
  if (flags.has('--json')) console.log(JSON.stringify(sum, null, 2));
  else {
    const areaNames = Object.fromEntries(plan.areas.map((a) => [`${a.id} ${a.name.slice(0, 20)}`, sum.byArea[a.id]]));
    console.log(table('By area', areaNames));
    if (flags.has('--by-safety')) console.log(`\n${table('By safety class', sum.bySafety)}`);
    console.log(`\n${table('Total', { all: sum.total })}`);
    if (sum.failures.length) console.log(`\nFAIL: ${sum.failures.join(', ')}`);
    console.log(`\n${sum.failures.length ? 'FAIL' : sum.total['not-run'] === sum.total.total ? 'NOT-RUN' : sum.total['not-run'] ? 'PASS so far (some NOT-RUN)' : 'PASS'}`);
  }
  if (sum.failures.length) return 1;
  if (flags.has('--strict') && sum.total['not-run'] > 0) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
