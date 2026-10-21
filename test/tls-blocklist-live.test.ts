/**
 * Live proof that the core's key block (src/core/tls-blocklist-install.ts) refuses a TLS chain through a compromised eMudhra
 * intermediate CA on every runtime the core runs on. It talks to the incident tracker's test hosts, so it runs only with
 * LEGION_LIVE_TLS=1 (the "TLS key block (live)" CI job and the release ladder), never in the normal suite. A chain that is TRUSTED
 * with the block on fails. An unreachable host skips, or fails with LEGION_LIVE_TLS_REQUIRE=1 (CI).
 *
 *   - Electron's Node (ELECTRON_RUN_AS_NODE): how the core runs in a Windows package install.
 *   - plain Node.js: source installs, Mac and Linux, LEGION_NODE.
 *
 * Each runtime is first asked WITHOUT the block. When it trusts the chain on its own, the block is what refuses it: that is the
 * proof the test can fail. When it already refuses on its own (a runtime that ships the fix), the case still has to refuse, and a
 * diagnostic says so. LEGION_LIVE_TLS_ELECTRON=<electron binary> points the Electron case at another build.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIVE = process.env.LEGION_LIVE_TLS === '1';
const root = fileURLToPath(new URL('../../', import.meta.url));
const probe = join(root, 'test', 'fixtures', 'tls-probe', 'node-probe.mjs');
const block = pathToFileURL(join(root, 'dist', 'src', 'core', 'tls-blocklist-install.js')).href;
/**
 * The emSign host serves a chain every runtime here can build to a root it ships, so an unprotected runtime trusts it (the proof).
 * The -aaa host serves the Sectigo cross-signed intermediate without a path to a shipped root: plain Node refuses it as an unknown
 * authority anyway, so for it the case only shows "refused".
 */
const HOSTS = ['dv-g3b-emudhra.we-have-a-problem.com', 'ov-g3c-aaa-emudhra.we-have-a-problem.com'];
const electron = process.env.LEGION_LIVE_TLS_ELECTRON
  || join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
/** Errors that mean "could not ask", not "trusted" or "refused". */
const UNREACHABLE = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|TIMEOUT/;

interface Outcome { trusted: boolean; status?: number; code?: string }
interface Probe { runtime: string; https: Outcome; fetch: Outcome }
function run(cmd: string, args: string[], env: Record<string, string>): Probe {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 90_000, env: { ...process.env, ...env }, windowsHide: true });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, `no probe output from ${cmd} (exit ${r.status}): ${(r.stderr ?? '').slice(0, 400)}`);
  return JSON.parse(line) as Probe;
}
const both = (p: Probe): Outcome[] => [p.https, p.fetch];
const codes = (p: Probe): string => both(p).map((o) => (o.trusted ? `TRUSTED ${o.status}` : o.code)).join(', ');
const unreachable = (p: Probe): boolean => both(p).every((o) => !o.trusted && UNREACHABLE.test(o.code ?? ''));

/** Runs the probe without and with the block on one runtime and asserts the block refuses the chain as revoked. */
function check(t: { skip(msg: string): void; diagnostic(msg: string): void }, label: string, cmd: string, pre: string[], env: Record<string, string>, host: string): void {
  const bare = run(cmd, [...pre, probe, host], env);
  if (unreachable(bare)) {
    const msg = `${label}: test host unreachable (${codes(bare)})`;
    if (process.env.LEGION_LIVE_TLS_REQUIRE === '1') assert.fail(`${msg}; LEGION_LIVE_TLS_REQUIRE=1 turns this into a failure`);
    t.skip(msg); return;
  }
  if (!both(bare).some((o) => o.trusted)) {
    t.diagnostic(`${label} without the block already refuses ${host} (${codes(bare)}): ${/CERT_REVOKED/.test(codes(bare)) ? 'this runtime blocks the keys itself' : 'it cannot build this chain'}`);
    if (!/CERT_REVOKED/.test(codes(bare))) { t.skip(`${label}: ${host} is refused as an unknown authority even without the block, so it proves nothing here`); return; }
  } else t.diagnostic(`${label} without the block TRUSTS ${host} (${codes(bare)}): the block is what refuses it`);
  const guarded = run(cmd, [...pre, '--import', block, probe, host], env);
  for (const [k, o] of [['https', guarded.https], ['fetch', guarded.fetch]] as const) {
    assert.equal(o.trusted, false, `${label} with the block ${k} TRUSTS a chain through a compromised eMudhra CA (${guarded.runtime})`);
    assert.match(o.code ?? '', /CERT_REVOKED/, `${label} with the block ${k} refused it, but not as revoked: ${o.code}`);
  }
}

describe('core TLS key block, live (eMudhra test hosts)', { skip: LIVE ? false : 'set LEGION_LIVE_TLS=1 to run (talks to the incident tracker)' }, () => {
  it('has the built block to load', () => {
    assert.ok(existsSync(fileURLToPath(block)), 'run npm run build:ts first');
  });
  for (const host of HOSTS) {
    it(`the core on Electron's Node (a Windows package) refuses ${host}`, (t) => {
      assert.ok(existsSync(electron), `no Electron binary at ${electron} (npm ci with CI and ELECTRON_SKIP_BINARY_DOWNLOAD empty, node node_modules/electron/install.js, or set LEGION_LIVE_TLS_ELECTRON)`);
      check(t, "Electron's Node", electron, [], { ELECTRON_RUN_AS_NODE: '1' }, host);
    });
    it(`the core on plain Node.js (Mac, Linux, source installs) refuses ${host}`, (t) => {
      check(t, 'plain Node.js', process.execPath, [], {}, host);
    });
  }
});
