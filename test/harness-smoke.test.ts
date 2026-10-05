/**
 * Smoke test for scripts/harness (see docs/TESTING.md): starts the harness through its CLI, runs two scenarios in it, stops it and asserts
 * that no process and no temp folder is left. It starts real child processes (a core, a supervisor), all on 127.0.0.1 with fakes.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(root, 'scripts', 'harness', 'legion-harness.mjs');
const run = (args: string[], timeout = 120_000) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout, cwd: root });
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

test('harness: start, run two scenarios, stop; no process and no temp folder is left; no 64-hex secret on disk', { timeout: 240_000 }, () => {
  const started = run(['start', '--no-pointer']);
  assert.equal(started.status, 0, started.stderr);
  const handle = JSON.parse(started.stdout) as { baseUrl: string; handleFile: string; supervisorPid: number; corePid: number; harnessDir: string };
  let stopped = false;
  try {
    assert.match(handle.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(alive(handle.supervisorPid) && alive(handle.corePid), 'both processes run');
    assert.ok(existsSync(handle.harnessDir));
    // the printed handle holds no secret
    assert.doesNotMatch(started.stdout, /[0-9a-f]{40}/i);

    const status = JSON.parse(run(['status', '--handle', handle.handleFile]).stdout) as { core: { alive: boolean; hasAdmin: boolean; hasNative: boolean } };
    assert.deepEqual([status.core.alive, status.core.hasAdmin, status.core.hasNative], [true, true, true], 'the core received both launch secrets over stdin');

    // `call` adds the right headers: admin sees the Inbox, the token class does not
    const adminCall = JSON.parse(run(['call', 'GET', '/api/kg/inbox', '--handle', handle.handleFile]).stdout) as { status: number };
    const tokenCall = JSON.parse(run(['call', 'GET', '/api/kg/inbox', '--auth', 'token', '--handle', handle.handleFile]).stdout) as { status: number };
    assert.deepEqual([adminCall.status, tokenCall.status], [200, 403]);

    const sc = run(['scenarios', 'core-task-run', 'mcp-token-limits', '--handle', handle.handleFile]);
    const out = JSON.parse(sc.stdout) as { ok: boolean; passed: number; failed: number; results: Array<{ name: string; status: string; error?: string }> };
    assert.equal(sc.status, 0, sc.stdout);
    assert.deepEqual(out.results.map((r) => [r.name, r.status]), [['core-task-run', 'PASS'], ['mcp-token-limits', 'PASS']]);

    // the per-launch secrets are not in any file the harness wrote (they are 64 hex characters; config.json's token is 48)
    const files: string[] = [];
    // the live core renames its .tmp files while we walk: a file that vanished between the listing and the stat holds nothing to check
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) { if (n !== 'workspaces') walk(p); } else files.push(p); } };
    walk(handle.harnessDir);
    for (const f of files.filter((p) => /(handle\.json|config\.json|\.log)$/.test(p))) assert.doesNotMatch(readFileSync(f, 'utf8'), /\b[0-9a-f]{64}\b/i, `${f} holds a 64-hex value`);
  } finally {
    const s = run(['stop', '--handle', handle.handleFile]);
    stopped = s.status === 0;
    assert.equal(stopped, true, s.stdout + s.stderr);
  }
  assert.ok(!alive(handle.supervisorPid), 'supervisor is gone');
  assert.ok(!alive(handle.corePid), 'core is gone');
  assert.ok(!existsSync(handle.harnessDir), 'temp folder is gone');
});

test('harness: the harness core entry composes the same modules as src/bin/legion-core.ts', () => {
  const product = readFileSync(join(root, 'src', 'bin', 'legion-core.ts'), 'utf8');
  const entry = readFileSync(join(root, 'scripts', 'harness', 'core-entry.mjs'), 'utf8');
  const creates = (s: string) => [...s.matchAll(/\b(create[A-Z]\w*Module)\(/g)].map((m) => m[1]).sort();
  assert.deepEqual(creates(entry), creates(product), 'update scripts/harness/core-entry.mjs to match the composition root');
  const list = (s: string) => /const modules = \[[^\]]*\];/.exec(s)?.[0];
  assert.ok(list(product), 'the product still builds `const modules = [...]`');
  assert.equal(list(entry), list(product), 'same module list, in the same order');
  for (const piece of ['readLaunchSecrets', 'new Engine(', 'new VmManager(', 'new ApprovalBroker(', 'new SettingsService(', 'createServer(', 'recoverInterrupted', 'seedDefaults', 'engine.setModules(']) {
    assert.ok(product.includes(piece) && entry.includes(piece), `both compositions use ${piece}`);
  }
});

test('harness: nothing the harness adds names the real wallet port except the refusal guard', () => {
  const files = [...readdirSync(join(root, 'scripts', 'harness')).filter((n) => /\.mjs$/.test(n)).map((n) => `scripts/harness/${n}`),
    ...readdirSync(join(root, 'docs')).filter((n) => /^TESTING.*\.md$/.test(n)).map((n) => `docs/${n}`)];
  const port = new RegExp(`\\b${33}${21}\\b`); // built from parts so that this file does not name the port either
  const hits = files.filter((f) => port.test(readFileSync(join(root, f), 'utf8')));
  // the guard in the fake wallet is the one place that names it (that is how it can refuse it)
  assert.deepEqual(hits, ['scripts/harness/fake-wallet.mjs'], 'only the refusal guard may name the port');
});

// ---- harness self-tests (review findings 1, 3, 5) ----
const lib = (name: string) => import(pathToFileURL(join(root, 'scripts', 'harness', name)).href);

test('harness runner: a scenario with zero checks FAILS, and so does one whose cleanup left a process or folder', async () => {
  const { judgeScenario } = await lib('scenarios.mjs');
  assert.equal(judgeScenario({ name: 'x', checks: 3, ms: 1 }).status, 'PASS');
  const zero = judgeScenario({ name: 'x', checks: 0, ms: 1 });
  assert.equal(zero.status, 'FAIL'); assert.match(zero.error, /zero checks/);
  assert.equal(judgeScenario({ name: 'x', checks: 3, ms: 1, cleanup: { pidsAlive: [123], dirLeft: false } }).status, 'FAIL');
  assert.equal(judgeScenario({ name: 'x', checks: 3, ms: 1, cleanup: { pidsAlive: [], dirLeft: true } }).status, 'FAIL');
  assert.equal(judgeScenario({ name: 'x', checks: 3, ms: 1, cleanup: { pidsAlive: [], dirLeft: false } }).status, 'PASS');
  assert.equal(judgeScenario({ name: 'x', checks: 3, ms: 1, error: 'boom' }).status, 'FAIL');
});

test('harness core env: an allowlist; a planted token-like variable does not reach the core, the basics do', async () => {
  const { coreEnv } = await lib('core-env.mjs');
  const planted = { GITHUB_TOKEN: 'ghp_planted', MY_SECRET_KEY: 'x', AWS_SECRET_ACCESS_KEY: 'y', ANTHROPIC_API_KEY: 'z', PATH: '/bin', Path: 'C:\\x', SystemRoot: 'C:\\Windows', TEMP: '/t', HOME: '/h' };
  const env = coreEnv(planted, { LEGION_HOME: '/lh' });
  for (const k of ['GITHUB_TOKEN', 'MY_SECRET_KEY', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY']) assert.equal(k in env, false, k);
  assert.deepEqual([env.PATH, env.Path, env.SystemRoot, env.TEMP, env.HOME, env.LEGION_HOME], ['/bin', 'C:\\x', 'C:\\Windows', '/t', '/h', '/lh']);
});

test('harness sweep: removes only dead, marked legion-harness-* folders; never an alive one, an unmarked one or a foreign one', async () => {
  const { sweepDeadHarnessDirs, MARKER_FILE } = await lib('lib.mjs');
  const base = cleanupTemp('sweep-test-');
  try {
    const mk = (name: string, marker?: object) => { const d = join(base, name); mkdirSync(d); if (marker) writeFileSync(join(d, MARKER_FILE), JSON.stringify(marker)); return d; };
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid as number; // exited, so not alive
    const dead = mk('legion-harness-dead', { harness: true, supervisorPid: deadPid });
    const live = mk('legion-harness-live', { harness: true, supervisorPid: process.pid });
    const unmarked = mk('legion-harness-nomarker');
    const wrongMarker = mk('legion-harness-wrong', { harness: false, supervisorPid: deadPid });
    const foreign = mk('other-dir', { harness: true, supervisorPid: deadPid });
    assert.deepEqual(sweepDeadHarnessDirs(base), [dead]);
    assert.deepEqual([existsSync(dead), existsSync(live), existsSync(unmarked), existsSync(wrongMarker), existsSync(foreign)], [false, true, true, true, true]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
