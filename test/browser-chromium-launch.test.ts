import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LaunchError, buildBrowserEnv, launchBrowser } from '../src/core/browser/launcher.js';
import type { LaunchPorts } from '../src/core/browser/launcher.js';
import { RUN_DIR_PREFIX, createLaunchPorts, createProcessPort, removeRunDir } from '../src/core/browser/system.js';

const FAKE = fileURLToPath(new URL('./browser-fake-chromium.js', import.meta.url));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/**
 * Poll `cond` until true or the deadline passes.
 *
 * `cond` is allowed to THROW, and a throw counts as "not yet": the conditions below call `t.read()`,
 * which parses a file the child process has not necessarily written. A bare `if (cond())` let that
 * ENOENT escape and fail the test on the first poll instead of retrying — the cause of an intermittent
 * E4 failure that reproduced under batch load. A condition that never becomes true still fails the test,
 * so nothing is weakened: the helper now polls, which is what its name says.
 */
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => {
  const end = Date.now() + ms;
  const ok = () => { try { return cond(); } catch { return false; } };
  while (Date.now() < end) { if (ok()) return true; await new Promise((r) => setTimeout(r, 40)); }
  return ok();
};

/** The real process port, but the program is `node fake-chromium.js <report> <mode> <pages> <chrome arguments>` (never a real browser). */
function rig(mode: string, over: Partial<LaunchPorts> = {}) {
  const dir = cleanupTemp('br-chr-');
  const report = join(dir, 'report.json');
  const pages = join(dir, 'pages.json');
  writeFileSync(pages, JSON.stringify({ 'https://a.test/': { title: 'T', text: 'x' } }));
  const base = createLaunchPorts();
  const p: LaunchPorts = { ...base, proc: { spawn(req) { return base.proc.spawn({ ...req, file: process.execPath, prefixArgs: [FAKE, report, mode, pages] }); }, kill: base.proc.kill }, ...over };
  const found = { path: join(dir, 'msedge.exe') };
  const read = () => JSON.parse(readFileSync(report, 'utf8')) as { argv: string[]; env: Record<string, string>; cwd: string; pid: number; userDataDir: string };
  return { p, found, read, base };
}

test('E4: a Chromium-family browser is started with its arguments, a scrubbed environment and a fresh profile; the port comes from DevToolsActivePort; stop() kills the process and removes the folder', async () => {
  process.env.LEGION_TEST_SECRET = 'sk-ant-api03-THISMUSTNEVERREACHTHECHILD0123456789';
  try {
    const t = rig('ok');
    const run = await launchBrowser(t.p, t.found, { label: 'Fake Edge 120.0.0.0 (headless)' });
    const rep = t.read();
    try {
      assert.equal(run.label, 'Fake Edge 120.0.0.0 (headless)');
      assert.ok(rep.argv.includes('--headless=new') && rep.argv.includes('--remote-debugging-port=0'));
      assert.ok(!rep.argv.includes('--no-sandbox'));
      // a fresh profile inside the run folder, which is inside the system temp folder and carries Legion's prefix. Compared as real paths:
      // on macOS the child reports its cwd resolved (/private/var/...) while the temp folder is /var/..., and on a Windows runner it reports
      // the 8.3 short form (RUNNER~1) it was given, so both sides are resolved
      const real = (p: string): string => realpathSync.native(p);
      assert.ok(real(rep.userDataDir).startsWith(real(rep.cwd)), 'the profile is inside the run folder');
      assert.ok(real(rep.cwd).startsWith(real(tmpdir())) && rep.cwd.includes(RUN_DIR_PREFIX));
      assert.deepEqual(await run.cdp.send('Target.getTargets'), { targetInfos: [] });
      // scrubbed environment
      assert.ok(!('LEGION_TEST_SECRET' in rep.env));
      assert.ok(!Object.keys(rep.env).some((k) => /key|token|secret/i.test(k)));
      assert.equal(run.pid, rep.pid);
    } finally {
      // a failed assertion above must not leave the browser running: it kept this file alive until the runner's timeout
      await run.stop();
    }
    assert.equal(await until(() => !alive(rep.pid)), true, 'process gone');
    assert.equal(existsSync(rep.cwd), false, 'run folder removed');
    await run.stop();
  } finally { delete process.env.LEGION_TEST_SECRET; }
});

test('E4: a DevToolsActivePort file with CRLF line endings works', async () => {
  const t = rig('crlf');
  const run = await launchBrowser(t.p, t.found);
  try { assert.deepEqual(await run.cdp.send('Target.getTargets'), { targetInfos: [] }); } finally { await run.stop(); }
});

test('E4: on Windows the profile and app-data folders point into the run folder, never the real AppData, and no host variable is copied', async () => {
  const seen: Array<Record<string, string>> = [];
  const t = rig('never');
  const p: LaunchPorts = { ...t.p, platform: 'win32', hostEnv: { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\Real\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Real\\AppData\\Local', USERPROFILE: 'C:\\Users\\Real', OPENAI_API_KEY: 'sk-1', PATH: 'C:\\evil' } as NodeJS.ProcessEnv,
    proc: { spawn(req) { seen.push(req.env); return t.base.proc.spawn({ ...req, file: process.execPath, prefixArgs: ['-e', 'setTimeout(()=>{},300)'], args: [] }); }, kill: t.base.proc.kill }, sleep: async () => undefined };
  await assert.rejects(launchBrowser(p, t.found, { startMs: 100 }), LaunchError);
  const env = seen[0]!;
  assert.ok(env.APPDATA && !env.APPDATA.includes('Real') && env.LOCALAPPDATA && !env.LOCALAPPDATA.includes('Real'));
  assert.equal(env.APPDATA, env.LOCALAPPDATA); assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.ok(!('OPENAI_API_KEY' in env));
  assert.equal(env.Path, 'C:\\Windows\\System32', 'a fixed system path, not the host PATH');
  // USERPROFILE must NOT be set: redirecting it into the run folder stops Edge from resolving its own paths, so
  // it starts, stays alive and never writes DevToolsActivePort ("did not report its debugging port in time").
  // Verified against real Edge — see the comment on buildBrowserEnv.
  assert.ok(!('USERPROFILE' in env), 'USERPROFILE must not be redirected; it breaks Chromium launch');
  assert.ok(!JSON.stringify(env).includes('Real'), 'no host path may leak into the child environment');
  const l = buildBrowserEnv('linux', { SECRET_TOKEN: 'abc' } as NodeJS.ProcessEnv, '/tmp/run1');
  assert.deepEqual(Object.keys(l).sort(), ['HOME', 'LANG', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
});

test('E4b: the Windows environment never carries USERPROFILE, in any host configuration', () => {
  // The regression that broke the browser for the owner and two agents: a single wrongly-set variable.
  for (const host of [{}, { USERPROFILE: 'C:\\Users\\Real' }, { USERPROFILE: '' }, { APPDATA: 'x', LOCALAPPDATA: 'y' }]) {
    const env = buildBrowserEnv('win32', host as NodeJS.ProcessEnv, 'D:\\run1');
    assert.ok(!('USERPROFILE' in env), `USERPROFILE leaked for host ${JSON.stringify(host)}`);
    assert.equal(env.TEMP, 'D:\\run1');
  }
});

test('the process port starts only the file it is given, with no shell: a shell metacharacter in an argument stays an argument', async () => {
  const proc = createProcessPort();
  const dir = cleanupTemp('br-shell-');
  const marker = join(dir, 'pwned');
  const pr = proc.spawn({ args: ['-e', 'console.log(process.argv.slice(1).join("|"))', `; touch ${marker}`, '$(touch ' + marker + ')'], cwd: dir, env: { PATH: '/usr/bin:/bin' }, maxOutputBytes: 10_000, file: process.execPath });
  await pr.exited;
  assert.equal(existsSync(marker), false);
  assert.match(pr.stdout(), /touch/);
});

test('E4: failures: never reports a port, a bad path in the port file, a missing program, a crash', async () => {
  let t = rig('never'); let cwd = '';
  const mk = t.p.mkTemp; t.p.mkTemp = () => (cwd = mk());
  await assert.rejects(launchBrowser(t.p, t.found, { startMs: 600 }), (e: Error) => e instanceof LaunchError && /did not report its debugging port/.test(e.message));
  assert.equal(await until(() => !alive(t.read().pid)), true, 'the stuck browser was killed');
  assert.equal(existsSync(cwd), false);

  t = rig('badpath');
  await assert.rejects(launchBrowser(t.p, t.found, { startMs: 600 }), LaunchError);
  assert.equal(await until(() => !alive(t.read().pid)), true, 'a port file that does not name the browser endpoint is never connected to');

  t = rig('ok');
  await assert.rejects(launchBrowser(createLaunchPorts(), { path: join(tmpdir(), 'no-such-browser-xyz.exe') }, { startMs: 800 }), (e: Error) => e instanceof LaunchError && /could not be started/.test(e.message));

  t = rig('crash');
  const run = await launchBrowser(t.p, t.found);
  await Promise.race([run.exited, new Promise((r) => setTimeout(r, 4000))]);
  assert.equal(await until(() => !alive(run.pid!)), true);
  await run.stop();
});

test('E5: the run folder is removed only if it is Legion\'s own: directly inside the temp root, with the prefix, a real folder and not a link', () => {
  const root = cleanupTemp('br-root-');
  const mine = join(root, `${RUN_DIR_PREFIX}abc`); mkdirSync(mine); writeFileSync(join(mine, 'f'), 'x');
  assert.equal(removeRunDir(mine, root), true); assert.equal(existsSync(mine), false);
  // a folder without the prefix, outside the root, nested, or the root itself: refused and left alone
  const other = join(root, 'precious'); mkdirSync(other); writeFileSync(join(other, 'keep'), 'x');
  assert.equal(removeRunDir(other, root), false); assert.ok(existsSync(join(other, 'keep')));
  const outside = cleanupTemp(`${RUN_DIR_PREFIX}outside-`); writeFileSync(join(outside, 'keep'), 'x');
  assert.equal(removeRunDir(outside, root), false); assert.ok(existsSync(join(outside, 'keep')));
  const nested = join(root, `${RUN_DIR_PREFIX}n`, 'inner'); mkdirSync(nested, { recursive: true });
  assert.equal(removeRunDir(nested, root), false); assert.ok(existsSync(nested));
  assert.equal(removeRunDir(root, root), false);
  assert.equal(removeRunDir(join(root, `${RUN_DIR_PREFIX}missing`), root), false);
  // a link with the right name and place pointing at a folder that matters: refused, and the target is untouched
  const victim = join(root, 'victim'); mkdirSync(victim); writeFileSync(join(victim, 'keep'), 'x');
  const link = join(root, `${RUN_DIR_PREFIX}link`);
  try { symlinkSync(victim, link, 'junction'); } catch { return; /* links need a privilege on this system: nothing to test */ }
  assert.equal(removeRunDir(link, root), false); assert.ok(existsSync(join(victim, 'keep')));
});
