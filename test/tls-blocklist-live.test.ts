/**
 * Live proof that a TLS chain through a compromised eMudhra intermediate CA fails in every TLS stack Legion uses. It talks to the
 * incident tracker's test hosts, so it runs only with LEGION_LIVE_TLS=1 (the "TLS key block (live)" CI job and the release ladder),
 * never in the normal suite. A host that cannot be reached skips; a chain that is TRUSTED fails.
 *
 *   - Electron's Node (ELECTRON_RUN_AS_NODE, how the core runs in a Windows package install): https.get and fetch.
 *   - Electron's Chromium (the app window, net.fetch in the main process): a hidden window and net.fetch. Needs a display.
 *   - plain Node.js with the core's own key block (src/core/tls-blocklist-install.ts): source installs, Mac and Linux, LEGION_NODE.
 *
 * LEGION_LIVE_TLS_ELECTRON=<electron binary> points the Electron cases at another build: an older Electron (44.5.1) must make
 * them fail, which is how this test was shown able to fail.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';

const LIVE = process.env.LEGION_LIVE_TLS === '1';
const root = fileURLToPath(new URL('../../', import.meta.url));
const probes = join(root, 'test', 'fixtures', 'tls-probe');
/**
 * The emSign host serves a chain any verifier can build to a root it ships, so an unpatched stack trusts it (the proof).
 * The -aaa host serves the Sectigo cross-signed intermediate without the path to a shipped root; a verifier that does not fetch
 * missing issuers (Node, Chromium on Linux) refuses it as an unknown authority whatever its version, so for Chromium it only
 * shows "refused". Electron's Node still names it revoked: its block also checks the certificates the server sent.
 */
const HOSTS = [{ host: 'dv-g3b-emudhra.we-have-a-problem.com', buildable: true }, { host: 'ov-g3c-aaa-emudhra.we-have-a-problem.com', buildable: false }];
const electron = process.env.LEGION_LIVE_TLS_ELECTRON
  || join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
/** Opted in but no Electron: a failure, so a CI job whose install skipped the download can never pass without testing anything. */
const requireElectron = (): void => { assert.ok(existsSync(electron), `no Electron binary at ${electron} (npm ci with CI and ELECTRON_SKIP_BINARY_DOWNLOAD empty, or set LEGION_LIVE_TLS_ELECTRON)`); };
const hasDisplay = process.platform !== 'linux' || !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
/** Errors that mean "could not ask", not "trusted" or "refused". */
const UNREACHABLE = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|TIMEOUT|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION/;

interface Outcome { trusted: boolean; status?: number; code?: string }
function run(cmd: string, args: string[], env: Record<string, string | undefined>): Record<string, Outcome | string> {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 90_000, env: merged, windowsHide: true });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('{'));
  assert.ok(line, `no probe output from ${cmd} (exit ${r.status}): ${(r.stderr ?? '').slice(0, 400)}`);
  return JSON.parse(line) as Record<string, Outcome | string>;
}
/** Asserts each outcome refused the chain as revoked; skips the test when every outcome only says the host was unreachable. */
function expectRevoked(t: { skip(msg: string): void }, label: string, out: Record<string, Outcome | string>, keys: string[], revoked: RegExp): void {
  const results = keys.map((k) => [k, out[k] as Outcome] as const);
  if (results.every(([, o]) => !o.trusted && UNREACHABLE.test(o.code ?? ''))) { t.skip(`${label}: test host unreachable (${results.map(([, o]) => o.code).join(', ')})`); return; }
  for (const [k, o] of results) {
    assert.equal(o.trusted, false, `${label} ${k} TRUSTS a chain through a compromised eMudhra CA (${out.runtime})`);
    assert.match(o.code ?? '', revoked, `${label} ${k} refused it, but not as revoked: ${o.code}`);
  }
}

describe('TLS key block, live (eMudhra test hosts)', { skip: LIVE ? false : 'set LEGION_LIVE_TLS=1 to run (talks to the incident tracker)' }, () => {
  for (const { host, buildable } of HOSTS) {
    it(`Electron's Node refuses ${host}`, (t) => {
      requireElectron();
      const out = run(electron, [join(probes, 'node-probe.mjs'), host], { ELECTRON_RUN_AS_NODE: '1' });
      expectRevoked(t, "Electron's Node", out, ['https', 'fetch'], /CERT_REVOKED/);
    });

    it(`Electron's Chromium refuses ${host}`, { skip: hasDisplay ? false : 'no display for an Electron window' }, (t) => {
      requireElectron();
      // A CI runner has no setuid sandbox helper and no GPU; this hidden window only loads one test page.
      const linux = process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : [];
      const out = run(electron, [join(probes, 'electron-main-probe.cjs'), `--user-data-dir=${tempDir('legion-tls-probe-')}`, ...linux], { LEGION_PROBE_HOST: host, ELECTRON_RUN_AS_NODE: undefined });
      // ERR_CERT_REVOKED is Electron's own block. On Windows, Chromium asks the OS to verify, and a Windows that already has
      // Microsoft's update distrusts these CAs itself (ERR_CERT_AUTHORITY_INVALID) whatever the Electron version: still refused,
      // but it proves nothing about Electron, so the strict proof runs on Linux in CI (Electron 44.5.1 must fail there), on the
      // host whose chain can be built.
      const strict = buildable && (process.platform !== 'win32' || process.env.LEGION_LIVE_TLS_STRICT === '1');
      expectRevoked(t, "Electron's Chromium", out, ['netFetch', 'window'], strict ? /ERR_CERT_REVOKED/ : /ERR_CERT_(REVOKED|AUTHORITY_INVALID)/);
      for (const k of ['netFetch', 'window']) if (/AUTHORITY_INVALID/.test((out[k] as Outcome).code ?? '')) t.diagnostic(`${k}: refused as an unknown authority (the OS trust store, or a chain no verifier here can complete), not by Electron's block`);
    });

    it(`plain Node.js with the core's key block refuses ${host}`, (t) => {
      const install = join(root, 'dist', 'src', 'core', 'tls-blocklist-install.js');
      const control = run(process.execPath, [join(probes, 'node-probe.mjs'), host], {});
      const ctl = [control.https, control.fetch] as Outcome[];
      if (ctl.every((o) => !o.trusted && UNREACHABLE.test(o.code ?? ''))) { t.skip(`test host unreachable (${ctl.map((o) => o.code).join(', ')})`); return; }
      if (!ctl.some((o) => o.trusted)) {
        // Nothing for the block to do. CERT_REVOKED here means Node.js itself now blocks the keys: once every supported Node does, remove src/core/tls-blocklist*.ts.
        t.skip(`plain ${control.runtime} does not trust ${host} even without Legion's block (${ctl.map((o) => o.code).join(', ')})`);
        return;
      }
      const out = run(process.execPath, ['--import', `file:///${install.replace(/\\/g, '/').replace(/^\//, '')}`, join(probes, 'node-probe.mjs'), host], {});
      expectRevoked(t, "the core's key block", out, ['https', 'fetch'], /CERT_REVOKED/);
    });
  }
});
