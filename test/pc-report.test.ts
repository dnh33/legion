import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The real-PC test plan: claude/real-pc-test-plan.md (human) and scripts/harness/pc-checks.json (machine) must stay in step,
// and pc-report.mjs must summarise a results file and fail on any FAIL. Pure file and process logic: runs on Linux and Windows.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const planPath = join(root, 'scripts', 'harness', 'pc-checks.json');
const reportPath = join(root, 'scripts', 'harness', 'pc-report.mjs');
const mdPath = join(root, 'claude', 'real-pc-test-plan.md');
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib: any = await import(pathToFileURL(reportPath).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const plan: any = JSON.parse(read(planPath));
const walletPort = ['33', '21'].join(''); // never written whole in a file under test/ or scripts/

function run(args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [reportPath, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function withResults<T>(results: unknown, fn: (file: string) => T): T {
  const d = mkdtempSync(join(tmpdir(), 'legion-pc-report-'));
  try { const f = join(d, 'results.json'); writeFileSync(f, JSON.stringify(results)); return fn(f); }
  finally { rmSync(d, { recursive: true, force: true }); }
}

test('the plan validates: ids, areas, enums, required fields, results default to not-run, dependencies exist', () => {
  assert.deepEqual(lib.validatePlan(plan), []);
  assert.ok(plan.checks.length >= 100, 'the plan lost checks');
  for (const c of plan.checks) assert.equal(c.result.status, 'not-run', `${c.id} is committed with a recorded result: results belong in a results file or a deliberate update`);
});

test('ids are unique and numbered without gaps inside each area', () => {
  for (const a of plan.areas) {
    const nums = plan.checks.filter((c: { area: string }) => c.area === a.id).map((c: { id: string }) => Number(c.id.slice(-2)));
    assert.deepEqual(nums, nums.map((_: number, i: number) => nums[0] + i), `${a.id} is not sequential`);
    assert.equal(nums[0], a.id === 'BSVT' || a.id === 'BSVM' ? 0 : 1, `${a.id} starts at the wrong number`);
  }
});

test('safety rules: real-wallet, real-funds and native-dialog checks are owner-only; the whole mainnet area is real-funds, last', () => {
  for (const c of plan.checks) {
    if (['real-wallet', 'real-funds', 'native-dialog'].includes(c.safety)) assert.equal(c.automation, 'owner-only', `${c.id}: an agent must not drive a ${c.safety} check`);
    if (c.area === 'BSVM') assert.equal(c.safety, 'real-funds', c.id);
    if (c.safety === 'real-funds') assert.equal(c.gate, 'G11', `${c.id}: real funds run last`);
  }
});

test('dependencies point only at the same gate or an earlier one, and never back at the dependent', () => {
  const gateNo = (g: string): number => Number(g.slice(1));
  const byId = new Map<string, { id: string; gate: string; depends: string[] }>(plan.checks.map((c: { id: string }) => [c.id, c]));
  for (const c of byId.values()) for (const d of c.depends) {
    assert.ok(gateNo(byId.get(d)!.gate) <= gateNo(c.gate), `${c.id} (${c.gate}) depends on a later gate: ${d}`);
    assert.ok(!byId.get(d)!.depends.includes(c.id), `${c.id} and ${d} depend on each other`);
  }
});

test("nothing in the plan, the report script or the markdown names the owner's wallet port", () => {
  for (const [name, text] of [['pc-checks.json', read(planPath)], ['pc-report.mjs', read(reportPath)], ['real-pc-test-plan.md', read(mdPath)]]) {
    assert.ok(!text.includes(walletPort), `${name} contains the wallet port`);
  }
});

test('the markdown plan lists exactly the ids and titles of the JSON, and its generated block is current', () => {
  const md = read(mdPath);
  const mdIds = [...md.matchAll(/^#### (PC-[A-Z]+-\d\d): (.*)$/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(mdIds, plan.checks.map((c: { id: string; title: string }) => [c.id, c.title]));
  const block = md.split('<!-- BEGIN GENERATED CHECKS -->\n')[1]?.split('<!-- END GENERATED CHECKS -->')[0];
  assert.ok(block, 'generated block markers are missing');
  assert.equal(block, `${lib.emitMarkdown(plan)}\n`, 'claude/real-pc-test-plan.md is stale: run `node scripts/harness/pc-report.mjs --emit-md` and splice it in');
  for (const heading of ['Run order with gates', 'How a computer-use agent should run this', 'Rollback and cleanup per area', 'Sources scanned']) assert.ok(md.includes(heading), `missing section: ${heading}`);
});

test('summarize: no results means all NOT-RUN; a fail is listed; skip is not a failure; counts add up per area and per safety class', () => {
  const none = lib.summarize(plan, new Map());
  assert.equal(none.total['not-run'], plan.checks.length);
  assert.deepEqual(none.failures, []);
  const some = lib.parseResults({ results: { 'PC-INST-01': { status: 'pass', date: '2026-10-03', evidence: 'x.png' }, 'PC-INST-02': { status: 'FAIL' }, 'PC-INST-03': { status: 'skip' } } });
  const s = lib.summarize(plan, some);
  assert.deepEqual(s.failures, ['PC-INST-02']);
  assert.equal(s.byArea.INST.pass, 1); assert.equal(s.byArea.INST.fail, 1); assert.equal(s.byArea.INST.skip, 1);
  assert.equal(s.total.total, plan.checks.length);
  const safetySum = Object.values(s.bySafety).reduce((n: number, b) => n + (b as { total: number }).total, 0);
  assert.equal(safetySum, plan.checks.length);
});

test('bad input is rejected: unknown id, unknown status', () => {
  assert.throws(() => lib.summarize(plan, lib.parseResults({ results: { 'PC-NOPE-99': { status: 'pass' } } })), /unknown check/);
  assert.throws(() => lib.parseResults({ results: { 'PC-INST-01': { status: 'maybe' } } }), /unknown status/);
});

test('CLI: exit 0 with no FAIL, 1 on any FAIL, 1 on NOT-RUN only with --strict, 2 on bad input; prints PASS/FAIL/NOT-RUN by area', () => {
  const r0 = run([]);
  assert.equal(r0.code, 0); assert.match(r0.out, /By area/); assert.match(r0.out, /NOT-RUN/); assert.match(r0.out, /INST Installer/);
  assert.equal(run(['--strict']).code, 1);
  withResults({ results: { 'PC-INST-01': { status: 'pass', date: '2026-10-03', evidence: 'a.png' } } }, (f) => {
    const r = run([f, '--by-safety']);
    assert.equal(r.code, 0); assert.match(r.out, /By safety class/); assert.match(r.out, /PASS so far/);
  });
  withResults({ results: { 'PC-APP-01': { status: 'fail' } } }, (f) => {
    const r = run([f]);
    assert.equal(r.code, 1); assert.match(r.out, /FAIL: PC-APP-01/);
  });
  withResults({ results: { 'PC-NOPE-01': { status: 'pass' } } }, (f) => assert.equal(run([f]).code, 2));
  assert.equal(run([join(tmpdir(), 'legion-no-such-results.json')]).code, 2);
  const all: Record<string, { status: string }> = {};
  for (const c of plan.checks) all[c.id] = { status: 'pass' };
  withResults({ results: all }, (f) => { const r = run([f, '--strict']); assert.equal(r.code, 0); assert.match(r.out, /\nPASS\n?$/); });
});
