/**
 * Smoke test for scripts/harness (see docs/TESTING.md): starts the harness through its CLI, runs two scenarios in it, stops it and asserts
 * that no process and no temp folder is left. It starts real child processes (a core, a supervisor), all on 127.0.0.1 with fakes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (n !== 'workspaces') walk(p); } else files.push(p); } };
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
  const hits = files.filter((f) => /\b3321\b/.test(readFileSync(join(root, f), 'utf8')));
  // the guard in the fake wallet is the one place that names it (that is how it can refuse it)
  assert.deepEqual(hits, ['scripts/harness/fake-wallet.mjs'], 'only the refusal guard may name the port');
});
