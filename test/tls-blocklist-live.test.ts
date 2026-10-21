/**
 * Live proof that a TLS chain through a compromised eMudhra intermediate CA is refused by every TLS stack Legion uses. It talks to
 * the incident tracker's test hosts, so it runs only with LEGION_LIVE_TLS=1 (.github/workflows/tls-live.yml and the release ladder),
 * never in the normal suite. A chain that is TRUSTED fails. An unreachable host skips, or fails with LEGION_LIVE_TLS_REQUIRE=1 (CI).
 *
 *   - the core's key block (src/core/tls-blocklist-install.ts) on Electron's Node and on plain Node.js: how the core runs in a
 *     Windows package install, and on Mac, Linux and source installs. Each runtime is first asked without the block; when it trusts
 *     the chain on its own, the block is what refuses it (the proof that case can fail).
 *   - Electron's own Node, without the block: Electron 44.9.1 and later refuse these chains themselves (CERT_REVOKED).
 *   - Electron's Chromium (net.fetch and a hidden window): the app window. Needs a display.
 *   - the Claude Code the Agent SDK bundles: Claude agents reach Anthropic through it, on its own runtime (Bun). It is pointed at the
 *     test host with a made-up key and an empty config folder, so no credential can leave; a TLS failure must stop it.
 *
 * LEGION_LIVE_TLS_ELECTRON=<electron binary> and LEGION_LIVE_TLS_CLAUDE=<claude binary> point those cases at other builds: Electron
 * 44.5.1 and Claude Code 2.1.296 (SDK 0.3.296) must make them fail, which is how CI shows the test can fail.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './tmp-cleanup.js';

const LIVE = process.env.LEGION_LIVE_TLS === '1';
const root = fileURLToPath(new URL('../../', import.meta.url));
const probes = join(root, 'test', 'fixtures', 'tls-probe');
const probe = join(probes, 'node-probe.mjs');
const block = pathToFileURL(join(root, 'dist', 'src', 'core', 'tls-blocklist-install.js')).href;
/**
 * The emSign host serves a chain every runtime here can build to a root it ships, so an unprotected runtime trusts it (the proof).
 * The -aaa host serves the Sectigo cross-signed intermediate without a path to a shipped root: Node and Chromium on Linux refuse it
 * as an unknown authority whatever their version, so for them it only shows "refused". Claude Code (Bun) builds that chain, so for
 * it the -aaa host is a real case.
 */
const HOSTS = [{ host: 'dv-g3b-emudhra.we-have-a-problem.com', buildable: true }, { host: 'ov-g3c-aaa-emudhra.we-have-a-problem.com', buildable: false }];
const electron = process.env.LEGION_LIVE_TLS_ELECTRON
  || join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
/** The bundled Claude Code: node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]/claude[.exe]. */
function bundledClaude(): string {
  const base = join(root, 'node_modules', '@anthropic-ai');
  const want = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const dirs = existsSync(base) ? readdirSync(base).filter((d) => d === want || d === `${want}-musl`).sort() : [];
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found = dirs.map((d) => join(base, d, exe)).find((p) => existsSync(p));
  return found ?? join(base, want, exe);
}
const claude = process.env.LEGION_LIVE_TLS_CLAUDE || bundledClaude();
const hasDisplay = process.platform !== 'linux' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
/** Errors that mean "could not ask", not "trusted" or "refused". */
const UNREACHABLE = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|TIMEOUT|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION/;

interface Outcome { trusted: boolean; status?: number; code?: string }
type Probe = Record<string, Outcome | string> & { runtime: string };
/** Runs a probe. `clean` starts from an empty environment (only what the OS needs to start a program) instead of this process's. */
function run(cmd: string, args: string[], env: Record<string, string | undefined>, o: { clean?: boolean; cwd?: string } = {}): { stdout: string; stderr: string; status: number | null } {
  const base: NodeJS.ProcessEnv = o.clean ? Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]])) : { ...process.env };
  const merged: NodeJS.ProcessEnv = { ...base, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120_000, env: merged, windowsHide: true, ...(o.cwd ? { cwd: o.cwd } : {}) });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}
const pick = (p: Probe, keys: string[]): Outcome[] => keys.map((k) => p[k] as Outcome);
const codes = (os: Outcome[]): string => os.map((o) => (o.trusted ? `TRUSTED ${o.status ?? ''}`.trim() : o.code)).join(', ');
/** A connection that never got a TLS verdict (timeout, reset, no DNS): "could not ask", neither trusted nor refused. */
const isNet = (o: Outcome): boolean => !o.trusted && UNREACHABLE.test(o.code ?? '');
/**
 * Runs a probe, up to three times while any of its connections could not ask: the tracker's test hosts are slow under load (4-5 s to
 * connect, seen 2026-10-21), and several CI runners at once time out on single connections.
 */
function probeJson(cmd: string, args: string[], env: Record<string, string | undefined>, keys: string[] = ['https', 'fetch']): Probe {
  let p: Probe | undefined;
  for (let i = 0; i < 3; i++) {
    const r = run(cmd, args, env);
    const line = r.stdout.split('\n').find((l) => l.startsWith('{'));
    assert.ok(line, `no probe output from ${cmd} (exit ${r.status}): ${r.stderr.slice(0, 400)}`);
    p = JSON.parse(line) as Probe;
    if (!pick(p, keys).some(isNet)) break;
  }
  return p!;
}
/** An unreachable test host skips, except with LEGION_LIVE_TLS_REQUIRE=1 (CI), where a run that tested nothing must not be green. */
function unreachable(t: { skip(msg: string): void }, msg: string): void {
  if (process.env.LEGION_LIVE_TLS_REQUIRE === '1') assert.fail(`${msg}; LEGION_LIVE_TLS_REQUIRE=1 turns this into a failure`);
  t.skip(msg);
}
/**
 * Every connection that got a verdict must be refused and match `refused`. Connections that could not ask are left out (a diagnostic
 * names them); when none got a verdict, the host counts as unreachable.
 */
function expectRefused(t: { skip(msg: string): void; diagnostic?(msg: string): void }, label: string, p: Probe, keys: string[], refused: RegExp): boolean {
  const os = pick(p, keys);
  if (os.every(isNet)) { unreachable(t, `${label}: test host unreachable (${codes(os)})`); return false; }
  for (const [i, o] of os.entries()) {
    if (isNet(o)) { t.diagnostic?.(`${label} ${keys[i]}: could not ask (${o.code}); judged on the other connection`); continue; }
    assert.equal(o.trusted, false, `${label} ${keys[i]} TRUSTS a chain through a compromised eMudhra CA (${p.runtime})`);
    assert.match(o.code ?? '', refused, `${label} ${keys[i]} refused it, but not as revoked: ${o.code}`);
  }
  return true;
}

/** The core's block on one runtime: without it, then with it; with it the chain must be refused as revoked. */
function coreBlock(t: { skip(msg: string): void; diagnostic(msg: string): void }, label: string, cmd: string, env: Record<string, string | undefined>, host: string): void {
  const bare = probeJson(cmd, [probe, host], env);
  const b = pick(bare, ['https', 'fetch']);
  if (b.every(isNet)) { unreachable(t, `${label}: test host unreachable (${codes(b)})`); return; }
  if (!b.some((o) => o.trusted)) {
    if (!/CERT_REVOKED/.test(codes(b))) { t.skip(`${label}: ${host} is refused as an unknown authority even without the block, so it proves nothing here`); return; }
    t.diagnostic(`${label} without the block already refuses ${host} (${codes(b)}): this runtime blocks the keys itself`);
  } else t.diagnostic(`${label} without the block TRUSTS ${host} (${codes(b)}): the block is what refuses it`);
  const guarded = probeJson(cmd, ['--import', block, probe, host], env);
  const g = pick(guarded, ['https', 'fetch']);
  if (g.every(isNet)) { unreachable(t, `${label} with the block: test host unreachable (${codes(g)})`); return; }
  for (const [k, o] of [['https', g[0]!], ['fetch', g[1]!]] as const) {
    if (isNet(o)) { t.diagnostic(`${label} with the block ${k}: could not ask (${o.code}); judged on the other connection`); continue; }
    assert.equal(o.trusted, false, `${label} with the block ${k} TRUSTS a chain through a compromised eMudhra CA (${guarded.runtime})`);
    assert.match(o.code ?? '', /CERT_REVOKED/, `${label} with the block ${k} refused it, but not as revoked: ${o.code}`);
  }
}

describe('TLS key block, live (eMudhra test hosts)', { skip: LIVE ? false : 'set LEGION_LIVE_TLS=1 to run (talks to the incident tracker)' }, () => {
  it('has the built block and the binaries to test', () => {
    assert.ok(existsSync(fileURLToPath(block)), 'run npm run build:ts first');
    assert.ok(existsSync(electron), `no Electron binary at ${electron} (npm ci with CI and ELECTRON_SKIP_BINARY_DOWNLOAD empty, node node_modules/electron/install.js, or set LEGION_LIVE_TLS_ELECTRON)`);
    assert.ok(existsSync(claude), `no Claude Code binary at ${claude} (the Agent SDK's platform package, or set LEGION_LIVE_TLS_CLAUDE)`);
  });

  for (const { host, buildable } of HOSTS) {
    it(`the core on Electron's Node (a Windows package) refuses ${host}`, (t) => coreBlock(t, "Electron's Node", electron, { ELECTRON_RUN_AS_NODE: '1' }, host));
    it(`the core on plain Node.js (Mac, Linux, source installs) refuses ${host}`, (t) => coreBlock(t, 'plain Node.js', process.execPath, {}, host));

    it(`Electron's own Node, without Legion's block, refuses ${host}`, (t) => {
      const p = probeJson(electron, [probe, host], { ELECTRON_RUN_AS_NODE: '1' });
      expectRefused(t, "Electron's own Node", p, ['https', 'fetch'], /CERT_REVOKED/);
    });

    it(`Electron's Chromium (the app window) refuses ${host}`, { skip: hasDisplay ? false : 'no display for an Electron window' }, (t) => {
      // A CI runner has no setuid sandbox helper and no GPU; this hidden window only loads one test page.
      const linux = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];
      const r = run(electron, [join(probes, 'electron-main-probe.cjs'), `--user-data-dir=${tempDir('legion-tls-probe-')}`, ...linux], { LEGION_PROBE_HOST: host, ELECTRON_RUN_AS_NODE: undefined });
      const line = r.stdout.split('\n').find((l) => l.startsWith('{'));
      assert.ok(line, `no probe output from Electron (exit ${r.status}): ${r.stderr.slice(0, 400)}`);
      const p = JSON.parse(line) as Probe;
      // ERR_CERT_REVOKED is Electron's own block. On Windows, Chromium asks the OS to verify, and a Windows that already has
      // Microsoft's update distrusts these CAs itself (ERR_CERT_AUTHORITY_INVALID) whatever the Electron version: refused, but it
      // proves nothing about Electron, so the strict proof runs off Windows, on the host whose chain can be built.
      const strict = buildable && (process.platform !== 'win32' || process.env.LEGION_LIVE_TLS_STRICT === '1');
      if (expectRefused(t, "Electron's Chromium", p, ['netFetch', 'window'], strict ? /ERR_CERT_REVOKED/ : /ERR_CERT_(REVOKED|AUTHORITY_INVALID)/)) {
        for (const k of ['netFetch', 'window']) if (/AUTHORITY_INVALID/.test((p[k] as Outcome).code ?? '')) t.diagnostic(`${k}: refused as an unknown authority (the OS trust store, or a chain no verifier here can complete), not by Electron's block`);
      }
    });

    it(`the bundled Claude Code (Claude agents) refuses ${host}`, (t) => {
      // Nothing real can reach the test host: a made-up key, an empty environment (no tokens, headers or cloud logins from this
      // process), home and config folders and a working folder that are empty temp folders (no login, no CLAUDE.md). Without TLS
      // trust the request never leaves; with it, the host answers HTTP and Claude Code reports an "API Error: <status>". Both hosts:
      // Claude Code builds the cross-signed chain too, and 2.1.296 trusts both.
      const home = tempDir('legion-tls-claude-');
      const r = run(claude, ['-p', 'hi', '--max-turns', '1'], {
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: 'sk-ant-FAKE-EXAMPLE-not-a-key', ANTHROPIC_BASE_URL: `https://${host}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
      }, { clean: true, cwd: home });
      const said = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-3).join(' | ');
      const version = run(claude, ['--version'], { HOME: home, USERPROFILE: home }, { clean: true, cwd: home }).stdout.trim();
      // Claude Code retries a host it cannot reach without printing anything: a timeout or no output means "could not ask".
      if (r.status === null || said === '') { unreachable(t, `Claude Code: no answer within 120 s (test host unreachable?)`); return; }
      if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|timed out|Unable to connect to API: (?!SSL)/i.test(said) && !/SSL|CERT/i.test(said)) { unreachable(t, `Claude Code: test host unreachable (${said})`); return; }
      assert.doesNotMatch(said, /API Error: \d{3}/, `Claude Code TRUSTS a chain through a compromised eMudhra CA (${version}): ${said}`);
      assert.match(said, /SSL|CERT|certificate/i, `Claude Code failed, but not on the certificate (${version}): ${said}`);
    });
  }
});
