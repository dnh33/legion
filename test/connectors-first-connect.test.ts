/** First Connect on a launch without a key: main makes the key, restarts the core, and only then starts the sign-in (design 4.4, restart fallback). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectGithub, GITHUB_DEVICE_PAGE_URL } from '../src/electron/connector-ipc.js';
import type { ConnectorIpcDeps } from '../src/electron/connector-ipc.js';

function rig(o: { key?: 'installed' | 'missing'; available?: boolean; ensure?: string | undefined; confirms?: boolean[]; restartErr?: string | null; keyAfterRestart?: boolean; running?: boolean } = {}) {
  const log: string[] = [];
  const confirms = [...(o.confirms ?? [true, true])];
  let key = o.key ?? 'missing';
  const deps: ConnectorIpcDeps = {
    async call(method, route, body) {
      log.push(`${method} ${route}${body && (body as { memoryOnly?: boolean }).memoryOnly ? ' memoryOnly' : ''}`);
      if (route === '/api/connectors/github' && method === 'GET') return { status: 200, json: { available: o.available ?? true, key } };
      if (route === '/api/state') return { status: 200, json: { tasks: o.running ? [{ status: 'running' }] : [] } };
      if (route === '/api/connectors/github/connect') return { status: 200, json: { phase: 'pending', userCode: 'ABCD-1234', verificationUri: 'https://evil.example/x' } };
      return { status: 404, json: {} };
    },
    async confirm(c) { log.push(`confirm: ${c.title}${/running now/.test(c.detail) ? ' (running tasks named)' : ''}`); return confirms.shift() ?? false; },
    async ensureKey() { log.push('ensureKey'); return 'ensure' in o ? o.ensure : 'a'.repeat(64); },
    async restartCore() { log.push('restart'); if (o.restartErr) return o.restartErr; if (o.keyAfterRestart !== false) key = 'installed'; return null; },
    openExternal(u) { log.push(`open ${u}`); },
  };
  return { deps, log };
}

test('no key: confirm, make the key, restart, check the key is there, and only then start the flow and open the fixed page', async () => {
  const r = rig({ running: true });
  const out = await connectGithub(r.deps);
  assert.deepEqual(out, { ok: true, restarted: true, memoryOnly: false });
  const i = (s: RegExp) => r.log.findIndex((l) => s.test(l));
  assert.ok(i(/^confirm: Restart/) < i(/^ensureKey/), 'the keystore is touched only after the owner said yes');
  assert.ok(i(/^ensureKey/) < i(/^restart/));
  assert.ok(i(/^restart/) < i(/POST \/api\/connectors\/github\/connect/), 'the sign-in starts after the restart');
  assert.ok(r.log.filter((l) => /GET \/api\/connectors\/github$/.test(l)).length === 2, 'the key was re-checked after the restart');
  assert.ok(r.log.some((l) => /running tasks named/.test(l)));
  assert.ok(r.log.includes(`open ${GITHUB_DEVICE_PAGE_URL}`));
  assert.ok(!r.log.some((l) => l.includes('evil.example')), 'only the fixed page is ever opened');
});

test('a key already in the core: no confirmation, no keystore use, no restart', async () => {
  const r = rig({ key: 'installed' });
  assert.deepEqual(await connectGithub(r.deps), { ok: true, restarted: false, memoryOnly: false });
  assert.ok(!r.log.some((l) => /ensureKey|restart|confirm/.test(l)));
});

test('cancel at the dialog: nothing is made, restarted or started', async () => {
  const r = rig({ confirms: [false] });
  assert.deepEqual(await connectGithub(r.deps), { ok: false, cancelled: true });
  assert.ok(!r.log.some((l) => /ensureKey|restart|POST/.test(l)));
});

test('keystore unusable: a second confirmation, then memory-only sign-in without a restart; declining stops', async () => {
  const r = rig({ ensure: undefined });
  assert.deepEqual(await connectGithub(r.deps), { ok: true, restarted: false, memoryOnly: true });
  assert.ok(!r.log.includes('restart'));
  assert.ok(r.log.some((l) => /connect memoryOnly/.test(l)));
  const d = rig({ ensure: undefined, confirms: [true, false] });
  assert.deepEqual(await connectGithub(d.deps), { ok: false, cancelled: true });
  assert.ok(!d.log.some((l) => /POST/.test(l)));
});

test('a failed restart, or a restart where the core never got the key, never starts the sign-in', async () => {
  const a = rig({ restartErr: 'Core did not become ready' });
  assert.equal((await connectGithub(a.deps)).ok, false);
  assert.ok(!a.log.some((l) => /POST/.test(l)));
  const b = rig({ keyAfterRestart: false });
  const out = await connectGithub(b.deps);
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /did not receive the key/);
  assert.ok(!b.log.some((l) => /POST|open/.test(l)));
});

test('the GitHub App not registered: a plain "not available" before anything else happens', async () => {
  const r = rig({ available: false });
  const out = await connectGithub(r.deps);
  assert.equal(out.ok, false);
  assert.match(out.error ?? '', /not available yet/);
  assert.ok(!r.log.some((l) => /ensureKey|restart|confirm|POST/.test(l)));
});
