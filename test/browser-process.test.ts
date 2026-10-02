import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, LaunchError, buildBrowserEnv } from '../src/core/browser/launcher.js';
import type { LaunchPorts } from '../src/core/browser/launcher.js';
import { createLaunchPorts, createProcessPort } from '../src/core/browser/system.js';

const FAKE = fileURLToPath(new URL('./browser-fake-lightpanda.js', import.meta.url));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 40)); } return cond(); };

/** Real process port, but the program is `node fake-lightpanda.js <report> <mode> <pages> serve ...` (never the real binary). */
function ports(mode: string, over: Partial<LaunchPorts> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'br-proc-'));
  const report = join(dir, 'report.json');
  const pages = join(dir, 'pages.json');
  writeFileSync(pages, JSON.stringify({ 'https://a.test/': { title: 'T', text: 'x' } }));
  const base = createLaunchPorts();
  const p: LaunchPorts = { ...base, ...over };
  const bin = { file: process.execPath, prefixArgs: [FAKE, report, mode, pages], wsl: false };
  const read = () => JSON.parse(readFileSync(report, 'utf8')) as { argv: string[]; env: Record<string, string>; cwd: string; pid: number };
  return { p, bin, read, report };
}

test('C11: the child gets an argument list with the hardening options, a scrubbed environment and its own empty folder; stop() removes the process and the folder', async () => {
  process.env.LEGION_TEST_SECRET = 'sk-ant-api03-THISMUSTNEVERREACHTHECHILD0123456789';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak-0123456789';
  try {
    const t = ports('ok');
    const run = await launchBrowser(t.p, t.bin, { allowLocal: false });
    const rep = t.read();
    const a = rep.argv;
    assert.deepEqual(a.slice(0, 3), ['serve', '--port', String(run.port)]);
    assert.ok(!a.some((x) => /^--(host|bind|advertise-host)/.test(x)), 'no bind option: the default is loopback');
    assert.ok(a.includes('--block-private-networks'), 'private networks blocked by the browser itself');
    assert.equal(a[a.indexOf('--block-cidrs') + 1], '169.254.0.0/16');
    for (const f of ['--cdp-max-connections', '--cdp-max-message-size', '--http-max-response-size', '--v8-max-heap-mb', '--watchdog-ms', '--disable-metrics']) assert.ok(a.includes(f), f);
    for (const bad of ['--cookie-jar', '--cookie', '--http-cache-dir', '--http-proxy', '--insecure-disable-tls-host-verification', '--host 0.0.0.0']) assert.ok(!a.join(' ').includes(bad), bad);
    assert.ok(run.port >= 20000 && run.port < 60000);
    // the environment is built from an allowlist
    assert.equal(rep.env.LIGHTPANDA_DISABLE_TELEMETRY, 'true');
    assert.ok(!('LEGION_TEST_SECRET' in rep.env) && !('ANTHROPIC_API_KEY' in rep.env), 'no secret reached the child');
    assert.ok(!JSON.stringify(rep.env).includes('THISMUSTNEVERREACH'));
    assert.deepEqual(Object.keys(rep.env).filter((k) => /key|token|secret/i.test(k)), []);
    // its own working folder, empty
    assert.notEqual(rep.cwd, process.cwd());
    assert.ok(existsSync(rep.cwd));
    assert.equal(run.pid, rep.pid);
    // C12: stop() kills the process by PID and removes the folder
    await run.stop();
    assert.equal(await until(() => !alive(rep.pid)), true, 'process is gone');
    assert.equal(existsSync(rep.cwd), false, 'working folder removed');
    await run.stop();
  } finally { delete process.env.LEGION_TEST_SECRET; delete process.env.ANTHROPIC_API_KEY; }
});

test('C11: allow-local only removes the private-network block; the metadata range stays blocked; still no bind option', async () => {
  const t = ports('ok');
  const run = await launchBrowser(t.p, t.bin, { allowLocal: true });
  try {
    const a = t.read().argv;
    assert.ok(!a.includes('--block-private-networks'));
    assert.ok(a.includes('--block-cidrs'));
    assert.ok(!a.includes('--host'));
  } finally { await run.stop(); }
});

test('C11: the environment builder never copies the host environment (Windows keeps only the named system variables)', () => {
  const host = { PATH: '/x', SECRET_TOKEN: 'abc', SystemRoot: 'C:\\Windows', OPENAI_API_KEY: 'sk-1' } as NodeJS.ProcessEnv;
  const w = buildBrowserEnv('win32', host, 'C:\\tmp\\run1');
  assert.equal(w.SystemRoot, 'C:\\Windows');
  assert.ok(!('SECRET_TOKEN' in w) && !('OPENAI_API_KEY' in w) && !('PATH' in w));
  const l = buildBrowserEnv('linux', host, '/tmp/run1');
  assert.deepEqual(Object.keys(l).sort(), ['HOME', 'LANG', 'LIGHTPANDA_DISABLE_CORE_DUMP', 'LIGHTPANDA_DISABLE_TELEMETRY', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
  assert.equal(l.PATH, '/usr/bin:/bin');
});

test('a WSL launcher puts a hard wall-time `timeout` BEFORE the Linux program, so the program does not receive it as an argument', async () => {
  const seen: Array<{ prefix: string[]; args: string[] }> = [];
  const base = createLaunchPorts();
  const mk = (): LaunchPorts => ({ ...base, proc: { spawn(req) { seen.push({ prefix: req.prefixArgs ?? [], args: req.args }); return base.proc.spawn({ ...req, file: process.execPath, prefixArgs: ['-e', 'setTimeout(()=>{},300)'], args: [] }); }, kill: base.proc.kill }, connect: async () => { throw new Error('no'); }, sleep: async () => undefined });
  await assert.rejects(launchBrowser(mk(), { file: 'wsl.exe', prefixArgs: ['-d', 'Ubuntu', '-e', '/home/me/lightpanda'], wsl: true }, { allowLocal: false, wallMs: 90_000, startMs: 150 }), LaunchError);
  assert.deepEqual(seen[0]!.prefix, ['-d', 'Ubuntu', '-e']);
  assert.deepEqual(seen[0]!.args.slice(0, 6), ['timeout', '-s', 'KILL', '90s', '/home/me/lightpanda', 'serve']);
  // the program is never given `timeout` as its own first argument
  assert.notEqual(seen[0]!.args[0], '/home/me/lightpanda');
  // no `-e`/`--`: no safe place for the wrapper, so none is added and the arguments are passed through untouched
  seen.length = 0;
  await assert.rejects(launchBrowser(mk(), { file: 'wsl.exe', prefixArgs: ['/home/me/lightpanda'], wsl: true }, { allowLocal: false, startMs: 150 }), LaunchError);
  assert.deepEqual(seen[0]!.prefix, ['/home/me/lightpanda']); assert.equal(seen[0]!.args[0], 'serve');
  // a non-WSL launcher is untouched
  seen.length = 0;
  await assert.rejects(launchBrowser(mk(), { file: '/opt/lightpanda', prefixArgs: [], wsl: false }, { allowLocal: false, startMs: 150 }), LaunchError);
  assert.equal(seen[0]!.args[0], 'serve');
});

test('failure: a build that rejects the safety options is reported and NOT retried without them', async () => {
  const t = ports('reject');
  await assert.rejects(launchBrowser(t.p, t.bin, { allowLocal: false }), (e: Error) => e instanceof LaunchError && /rejected a required safety option/.test(e.message));
  // started exactly once: the report holds the one invocation and it carried the option
  assert.ok(t.read().argv.includes('--block-private-networks'));
});

test('failure: a program that never listens is stopped and the folder removed', async () => {
  const t = ports('never');
  let cwd = '';
  const origMk = t.p.mkTemp;
  t.p.mkTemp = () => (cwd = origMk());
  await assert.rejects(launchBrowser(t.p, t.bin, { allowLocal: false, startMs: 500 }), (e: Error) => e instanceof LaunchError && /did not start/.test(e.message));
  const pid = t.read().pid;
  assert.equal(await until(() => !alive(pid)), true, 'the stuck process was killed');
  assert.equal(existsSync(cwd), false);
});

test('failure: a missing program is reported plainly', async () => {
  const t = ports('ok');
  await assert.rejects(launchBrowser(t.p, { file: join(tmpdir(), 'no-such-lightpanda-xyz'), prefixArgs: [], wsl: false }, { allowLocal: false, startMs: 800 }), (e: Error) => e instanceof LaunchError && /could not be started/.test(e.message));
});

test('failure: a crash after start is visible through `exited` and the process is gone', async () => {
  const t = ports('crash');
  const run = await launchBrowser(t.p, t.bin, { allowLocal: false });
  await Promise.race([run.exited, new Promise((r) => setTimeout(r, 4000))]);
  assert.equal(await until(() => !alive(run.pid!)), true);
  await run.stop();
});

test('the process port starts only the file it is given, with no shell: a shell metacharacter in an argument stays an argument', async () => {
  const proc = createProcessPort();
  const dir = mkdtempSync(join(tmpdir(), 'br-shell-'));
  const marker = join(dir, 'pwned');
  const p = proc.spawn({ args: ['-e', 'console.log(process.argv.slice(1).join("|"))', `; touch ${marker}`, '$(touch ' + marker + ')'], cwd: dir, env: { PATH: '/usr/bin:/bin' }, maxOutputBytes: 10_000, file: process.execPath });
  await p.exited;
  assert.equal(existsSync(marker), false);
  assert.match(p.stdout(), /touch/);
});
