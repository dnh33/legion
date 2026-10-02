/**
 * PRODUCTION WIRING: the module is built exactly the way src/bin/legion-core.ts builds it (createBlenderModule(deps, { vms, boatConfigured, log }):
 * no injected `local`, the real process port, the real IO). A fake `blender` executable sits on a temp install path (a node script with a
 * shebang, so POSIX only; the Windows run of the same path is in claude/tracker-pc-checks.md). Before this test existed every local test injected a
 * fake runner, so nothing noticed that production never built one.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { createBlenderModule } from '../src/core/blender/index.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import type { ModuleDeps } from '../src/core/modules.js';
import { agent, GOOD_SCRIPT, tmp } from './blender-helpers.js';

// the child's PATH is scrubbed on purpose, so the shebang names node by absolute path
const FAKE_BLENDER = `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('Blender 4.2.0'); process.exit(0); }
const [task, run, hash] = a.slice(a.indexOf('--') + 1);
const src = fs.readFileSync(path.join(task, 'script-' + run + '.py'), 'utf8');
fs.writeFileSync(path.join(task, 'scene.blend'), 'BLEND');
fs.writeFileSync(path.join(task, 'self.pid'), String(process.pid));
if (src.includes('HANG')) { setInterval(() => {}, 1000); }
else {
  const f = path.join(task, 'result-' + run + '.json');
  fs.writeFileSync(f + '.t', JSON.stringify({ ok: true, output: 'fake blender ran', run, hash, violations: [] }));
  fs.renameSync(f + '.t', f);
}
`;

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

function build() {
  const dir = tmp('legion-prodwire-');
  const dataDir = join(dir, 'data');
  mkdirSync(dataDir, { recursive: true });
  const bin = join(dir, 'fakeblender');
  mkdirSync(bin, { recursive: true });
  const exe = join(bin, 'blender');
  writeFileSync(exe, FAKE_BLENDER);
  chmodSync(exe, 0o755);
  const config = defaultConfig();
  Object.assign(config, { workspaceDir: join(dir, 'ws'), blender: { enabled: true, installPath: exe } });
  const store = new Store(dir);
  store.seedDefaults(join(dir, 'ws'));
  const bus = new EventBus();
  const approvals = new ApprovalBroker(bus, { timeoutMs: 5000 });
  bus.on((e) => { if (e.type === 'approval.requested') setImmediate(() => approvals.resolve(e.approval.id, true)); });
  const moduleDeps = { config, store, bus, engine: {} as never, approvals, dataDir, bsvEnabled: () => false } as ModuleDeps;
  // the same call as src/bin/legion-core.ts: no `local`, no `io`
  const vms: any = { touch() {}, ensureRunning: async () => ({}), stop: async () => ({}), status: (id: string) => ({ agentId: id, state: 'none' }) };
  const mod = createBlenderModule(moduleDeps, { vms, boatConfigured: () => false, log: () => undefined });
  return { dir, dataDir, mod };
}

const skip = process.platform === 'win32' ? 'the fake blender is a shebang script' : false;

test('production wiring: auto resolves to local, one blender_exec runs through the LocalRunner, the light says Local ready', { skip }, async () => {
  const { mod, dataDir } = build();
  try {
    const sc = agent('sculptor');
    // no status call and no detect() first: the first exec after a core start must not see "not found"
    const r = await mod.guard.exec(sc, { taskId: 'wire_1', taint: () => false, markTainted: () => undefined }, { script: GOOD_SCRIPT });
    const text = (r.content[0] as { text: string }).text;
    assert.equal(r.isError, undefined, text);
    assert.match(text, /fake blender ran/);
    assert.match(text, /source="local"/);
    const task = readdirSync(join(dataDir, 'blender', 'local')).find((n) => n.startsWith('wire_1')) ?? '';
    assert.ok(task !== '', 'the task folder is under <data>/blender/local');
    assert.equal(readFileSync(join(dataDir, 'blender', 'local', task, 'scene.blend'), 'utf8'), 'BLEND');
    const st = await mod.status();
    assert.equal(st.mode, 'auto');
    assert.equal(st.light, 'local');
    assert.equal(st.localReady, true);
    assert.match(st.nextRun ?? '', /On this computer/);
  } finally { await mod.dispose?.(); }
});

test('production wiring: dispose() kills a running local child by PID and waits for it', { skip }, async () => {
  const { mod, dataDir } = build();
  const sc = agent('sculptor');
  const running = mod.guard.exec(sc, { taskId: 'wire_2', taint: () => false, markTainted: () => undefined }, { script: GOOD_SCRIPT + '# HANG\n' });
  let pidFile = '';
  for (let i = 0; i < 300 && !pidFile; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const root = join(dataDir, 'blender', 'local');
    const t = existsSync(root) ? readdirSync(root).find((n) => n.startsWith('wire_2')) : undefined;
    if (t && existsSync(join(root, t, 'self.pid'))) pidFile = join(root, t, 'self.pid');
  }
  assert.ok(pidFile, 'the fake blender started');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  await mod.dispose?.();
  assert.equal(alive(pid), false, 'dispose left no running Blender behind');
  const r = await running;
  assert.ok(r.isError, 'the interrupted run reports a failure');
});
