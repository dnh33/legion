import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LaunchError, launchBrowser } from '../src/core/browser/launcher.js';
import type { LaunchPorts } from '../src/core/browser/launcher.js';
import { RUN_DIR_PREFIX, createLaunchPorts, removeRunDir } from '../src/core/browser/system.js';

const FAKE = fileURLToPath(new URL('./browser-fake-chromium.js', import.meta.url));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const until = async (cond: () => boolean, ms = 4000): Promise<boolean> => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 40)); } return cond(); };

function rig(mode: string, over: Partial<LaunchPorts> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'br-chr-'));
  const report = join(dir, 'report.json');
  const pages = join(dir, 'pages.json');
  writeFileSync(pages, JSON.stringify({ 'https://a.test/': { title: 'T', text: 'x' } }));
  const p: LaunchPorts = { ...createLaunchPorts(), ...over };
  const bin = { file: process.execPath, prefixArgs: [FAKE, report, mode, pages], wsl: false };
  const read = () => JSON.parse(readFileSync(report, 'utf8')) as { argv: string[]; env: Record<string, string>; cwd: string; pid: number; userDataDir: string };
  return { p, bin, read };
}

test('E4: a Chromium-family browser is started with its arguments, a scrubbed environment and a fresh profile; the port comes from DevToolsActivePort; stop() kills the process and removes the folder', async () => {
  process.env.LEGION_TEST_SECRET = 'sk-ant-api03-THISMUSTNEVERREACHTHECHILD0123456789';
  try {
    const t = rig('ok');
    const run = await launchBrowser(t.p, t.bin, { allowLocal: false, engine: 'chromium', label: 'Fake Edge 120.0.0.0 (headless)' });
    const rep = t.read();
    assert.equal(run.engine, 'chromium'); assert.equal(run.label, 'Fake Edge 120.0.0.0 (headless)');
    assert.ok(rep.argv.includes('--headless=new') && rep.argv.includes('--remote-debugging-port=0'));
    assert.ok(!rep.argv.includes('--no-sandbox'));
    // a fresh profile inside the run folder, which is inside the system temp folder and carries Legion's prefix
    assert.ok(rep.userDataDir.startsWith(rep.cwd), 'the profile is inside the run folder');
    assert.ok(rep.cwd.startsWith(tmpdir()) && rep.cwd.includes(RUN_DIR_PREFIX));
    assert.deepEqual(await run.cdp.send('Target.getTargets'), { targetInfos: [] });
    // scrubbed environment
    assert.ok(!('LEGION_TEST_SECRET' in rep.env));
    assert.equal(rep.env.LIGHTPANDA_DISABLE_TELEMETRY, 'true');
    assert.equal(run.pid, rep.pid);
    await run.stop();
    assert.equal(await until(() => !alive(rep.pid)), true, 'process gone');
    assert.equal(existsSync(rep.cwd), false, 'run folder removed');
    await run.stop();
  } finally { delete process.env.LEGION_TEST_SECRET; }
});

test('E4: a DevToolsActivePort file with CRLF line endings works', async () => {
  const t = rig('crlf');
  const run = await launchBrowser(t.p, t.bin, { allowLocal: false, engine: 'chromium' });
  try { assert.deepEqual(await run.cdp.send('Target.getTargets'), { targetInfos: [] }); } finally { await run.stop(); }
});

test('E4: on Windows the profile and app-data folders point into the run folder, never the real AppData', async () => {
  const seen: Array<Record<string, string>> = [];
  const base = createLaunchPorts();
  const t = rig('never');
  const p: LaunchPorts = { ...t.p, platform: 'win32', hostEnv: { SystemRoot: 'C:\\Windows', APPDATA: 'C:\\Users\\Real\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Real\\AppData\\Local', OPENAI_API_KEY: 'sk-1' } as NodeJS.ProcessEnv,
    proc: { spawn(req) { seen.push(req.env); return base.proc.spawn({ ...req, file: process.execPath, prefixArgs: ['-e', 'setTimeout(()=>{},300)'], args: [] }); }, kill: base.proc.kill }, sleep: async () => undefined };
  await assert.rejects(launchBrowser(p, t.bin, { allowLocal: false, engine: 'chromium', startMs: 100 }), LaunchError);
  const env = seen[0]!;
  assert.ok(env.APPDATA && !env.APPDATA.includes('Real') && env.LOCALAPPDATA && !env.LOCALAPPDATA.includes('Real'));
  assert.equal(env.APPDATA, env.LOCALAPPDATA); assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.ok(!('OPENAI_API_KEY' in env));
});

test('E4: failures: never reports a port, a bad path in the port file, a missing program, a crash', async () => {
  let t = rig('never'); let cwd = '';
  const mk = t.p.mkTemp; t.p.mkTemp = () => (cwd = mk());
  await assert.rejects(launchBrowser(t.p, t.bin, { allowLocal: false, engine: 'chromium', startMs: 600 }), (e: Error) => e instanceof LaunchError && /did not report its debugging port/.test(e.message));
  assert.equal(await until(() => !alive(t.read().pid)), true, 'the stuck browser was killed');
  assert.equal(existsSync(cwd), false);

  t = rig('badpath');
  await assert.rejects(launchBrowser(t.p, t.bin, { allowLocal: false, engine: 'chromium', startMs: 600 }), LaunchError);
  assert.equal(await until(() => !alive(t.read().pid)), true, 'a port file that does not name the browser endpoint is never connected to');

  t = rig('ok');
  await assert.rejects(launchBrowser(t.p, { file: join(tmpdir(), 'no-such-browser-xyz.exe'), prefixArgs: [], wsl: false }, { allowLocal: false, engine: 'chromium', startMs: 800 }), (e: Error) => e instanceof LaunchError && /could not be started/.test(e.message));

  t = rig('crash');
  const run = await launchBrowser(t.p, t.bin, { allowLocal: false, engine: 'chromium' });
  await Promise.race([run.exited, new Promise((r) => setTimeout(r, 4000))]);
  assert.equal(await until(() => !alive(run.pid!)), true);
  await run.stop();
});

test('E5: the run folder is removed only if it is Legion\'s own: directly inside the temp root, with the prefix, a real folder and not a link', () => {
  const root = mkdtempSync(join(tmpdir(), 'br-root-'));
  const mine = join(root, `${RUN_DIR_PREFIX}abc`); mkdirSync(mine); writeFileSync(join(mine, 'f'), 'x');
  assert.equal(removeRunDir(mine, root), true); assert.equal(existsSync(mine), false);
  // a folder without the prefix, outside the root, nested, or the root itself: refused and left alone
  const other = join(root, 'precious'); mkdirSync(other); writeFileSync(join(other, 'keep'), 'x');
  assert.equal(removeRunDir(other, root), false); assert.ok(existsSync(join(other, 'keep')));
  const outside = mkdtempSync(join(tmpdir(), `${RUN_DIR_PREFIX}outside-`)); writeFileSync(join(outside, 'keep'), 'x');
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
