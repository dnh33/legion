/**
 * The app's native confirmation for gate changes. These tests run the REAL core (store and routes), not a fake store: the dialog must list
 * exactly what the core says the change loosens, and the core must refuse a change that differs from what was confirmed.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatesChange, parseGatesChange, resetGatesCancelForTests } from '../src/electron/gates-ipc.js';
import type { GatesIpcDeps } from '../src/electron/gates-ipc.js';
import { createGatesCore, createGatesModule } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import { NO_SANDBOX_LINE } from '../src/shared/gates-registry.js';
import { AUTH, makeFakes, start } from './helpers-c.js';

const NATIVE = 'native-secret';
const J = { 'Content-Type': 'application/json' };
type Dialog = { title: string; message: string; detail: string; confirmLabel: string };
interface Prep { data: string; pid: string; file: string }
interface Opts { keyed?: boolean; keyring?: { get(): Buffer | undefined; state?(): 'new' | 'old' | 'lost' | 'unreadable' }; prepare?: (p: Prep) => void }

async function boot(answers: boolean[], o: Opts = {}) {
  resetGatesCancelForTests();
  const data = join(cleanupTemp('legion-gates-ipc-'), 'data');
  const projects = new ProjectStore(data, join(data, 'ws'));
  const f = makeFakes({ holdRuns: true });
  const p = projects.create({ name: 'Shop‮' });
  const keyring = o.keyring ?? (o.keyed === false ? undefined : { get: () => Buffer.alloc(32, 9) });
  o.prepare?.({ data, pid: p.id, file: join(data, 'gates', `${p.id}.json`) });
  const core = createGatesCore({ dataDir: data, projects, ...(keyring ? { keyring } : {}) });
  const mod = createGatesModule({ config: f.ctx.config, store: f.ctx.store, bus: f.ctx.bus, engine: f.ctx.engine, approvals: f.ctx.approvals, dataDir: data, bsvEnabled: () => false }, { projects, core, nativeSecret: NATIVE });
  (f.ctx as { modules?: unknown }).modules = [mod];
  const s = await start(f.ctx);
  const dialogs: Dialog[] = [];
  const calls: Array<{ method: string; route: string; native: boolean; headers: Record<string, string>; body?: unknown }> = [];
  const state = { down: false, onConfirm: undefined as undefined | (() => Promise<void> | void) };
  const real = async (method: string, route: string, body?: unknown, native?: boolean, extra?: Record<string, string>) => {
    // the project's name comes from the projects module in the app; the gates-only test core has none, so it is read from the same store
    if (route.startsWith('/api/projects/')) return { status: 200, json: { name: projects.get(route.split('/').pop()!)?.name } };
    const headers = { ...AUTH, ...J, ...(native ? { 'X-Legion-Native': NATIVE } : {}), ...(extra ?? {}) };
    calls.push({ method, route, native: native === true, headers: extra ?? {}, ...(body !== undefined ? { body } : {}) });
    if (state.down) return undefined;
    const r = await fetch(s.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  const deps: GatesIpcDeps = {
    call: real as GatesIpcDeps['call'],
    async confirm(d) { dialogs.push(d); if (state.onConfirm) await state.onConfirm(); return answers.shift() ?? false; },
  };
  const preview = async (name: string, patch: unknown) => (await real('POST', '/api/gates/preview', { name, patch }))!.json as { loosening: string[]; loosens: boolean; digest: string };
  return { core, pid: p.id, deps, dialogs, calls, state, preview, base: s.base, file: join(data, 'gates', `${p.id}.json`), close: async () => { await mod.dispose?.(); await s.close(); } };
}
type R = Awaited<ReturnType<typeof boot>>;
const writes = (r: R) => r.calls.filter((x) => x.method !== 'GET' && x.route !== '/api/gates/preview');
const withHarness = (answers: boolean[], o: Opts, fn: (r: R) => Promise<void>) => async () => { const r = await boot(answers, o); try { await fn(r); } finally { await r.close(); } };

test('a bypass change shows one dialog and calls the core with native and the shown digest only after Confirm', withHarness([true], {}, async (r) => {
  const shown = await r.preview('app', { preset: 'bypass' });
  const res = await gatesChange({ kind: 'app', patch: { preset: 'bypass' } }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(r.dialogs.length, 1);
  const w = writes(r);
  assert.equal(w.length, 1);
  assert.deepEqual([w[0]!.method, w[0]!.route, w[0]!.native, w[0]!.headers['x-legion-gates-digest'], w[0]!.body], ['PATCH', '/api/gates/app', true, shown.digest, { preset: 'bypass' }]);
  assert.equal(r.core.store.app().preset, 'bypass');
}));

test('cancel changes nothing and makes no write', withHarness([false], {}, async (r) => {
  const res = await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, r.deps);
  assert.deepEqual([res.ok, res.cancelled], [false, true]);
  assert.equal(writes(r).length, 0);
  assert.equal(r.core.store.app().preset, undefined);
}));

test('a tightening shows no dialog and sends no native header; Smart to Accept edits is not ordered, so it asks', withHarness([true], {}, async (r) => {
  r.core.store.patchApp({ preset: 'bypass' });
  assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, r.deps)).ok, true);
  assert.equal(r.dialogs.length, 0); assert.equal(writes(r)[0]!.native, false);
  assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'ask' } }, r.deps)).ok, true); assert.equal(r.dialogs.length, 0);
  r.core.store.patchApp({ preset: 'smart' });
  assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'accept-edits' } }, r.deps)).ok, true);
  assert.equal(r.dialogs.length, 1);
  assert.equal(r.core.store.app().preset, 'accept-edits');
}));

test('a second change while a dialog is open is refused without a second dialog', withHarness([], {}, async (r) => {
  let release!: (b: boolean) => void;
  r.deps.confirm = (d) => { r.dialogs.push(d); return new Promise<boolean>((res) => { release = res; }); };
  const first = gatesChange({ kind: 'app', patch: { preset: 'smart' } }, r.deps);
  await new Promise((res) => setTimeout(res, 100));
  const second = await gatesChange({ kind: 'app', patch: { preset: 'bypass' } }, r.deps);
  assert.equal(second.ok, false); assert.equal(r.dialogs.length, 1);
  release(false); await first;
  r.deps.confirm = async (d) => { r.dialogs.push(d); return false; };
  // the open flag is released (a different change is not held back by the pause after Cancel)
  assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'accept-edits' } }, r.deps)).cancelled, true);
}));

const PID = 'proj_0123456789ab';
test('a malformed request is refused before any dialog or call', withHarness([true], {}, async (r) => {
  const bad: unknown[] = [
    null, 'x', { kind: 'app' }, { kind: 'app', patch: { preset: 'wild' } }, { kind: 'app', patch: { overrides: { nope: false } } },
    { kind: 'app', patch: { allowedHosts: 'docs.python.org' } }, { kind: 'app', patch: { envKeep: [1] } }, { kind: 'app', patch: { allowedHosts: new Array(201).fill('a.com') } },
    { kind: 'project', id: PID, patch: { allowedHosts: ['a.com'] } },
    { kind: 'project', id: PID, patch: { overrides: { 'rail-shell-floor': false } } },
    { kind: 'project', id: PID, patch: { overrides: { 'attempt-caps': { on: true, limit: 500 } } } },
    { kind: 'project', id: PID, patch: { overrides: { 'attempt-caps': { on: true, limit: 1.5 } } } },
    { kind: 'project', id: PID, patch: { limit: 'no' } },
    { kind: 'project', patch: {} }, { kind: 'project', id: 'x', patch: {} }, { kind: 'accept' }, { kind: 'accept', name: '../app' }, { kind: 'delete', name: 'app' },
  ];
  for (const b of bad) assert.equal((await gatesChange(b, r.deps)).ok, false, JSON.stringify(b));
  assert.equal(r.dialogs.length, 0); assert.equal(r.calls.length, 0);
}));

test('there is no shell-floor switch: a patch that names it is refused, no dialog, no call', withHarness([true], {}, async (r) => {
  const res = await gatesChange({ kind: 'app', patch: { shellFloorOff: true } } as never, r.deps);
  assert.equal(res.ok, false); assert.equal(r.dialogs.length, 0); assert.equal(r.calls.length, 0);
  assert.equal(parseGatesChange({ kind: 'app', patch: { preset: 'ask', shellFloorOff: true } }), undefined);
}));

test('the window cannot send an extra field: the parsed change carries only known keys', () => {
  assert.deepEqual(parseGatesChange({ kind: 'project', id: PID, patch: { preset: 'ask', limit: true }, native: true, extra: 1 }), { kind: 'project', id: PID, patch: { preset: 'ask', limit: true } });
  assert.deepEqual(parseGatesChange({ kind: 'project', id: PID, patch: { overrides: { 'attempt-caps': { on: true, limit: 8 }, 'tool-cards': false } } }), { kind: 'project', id: PID, patch: { overrides: { 'attempt-caps': { on: true, limit: 8 }, 'tool-cards': false } } });
  assert.deepEqual(parseGatesChange({ kind: 'app', patch: { allowedHosts: ['docs.python.org'], envKeep: ['AWS_PROFILE'] } }), { kind: 'app', patch: { allowedHosts: ['docs.python.org'], envKeep: ['AWS_PROFILE'] } });
});

test('with no keystore key a loosening is refused with the plain reason, and Ask still works', async () => {
  const r = await boot([true], { keyed: false });
  try {
    const res = await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, r.deps);
    assert.equal(res.ok, false); assert.match(res.error ?? '', /no safe keystore, so only Ask can be used/);
    assert.equal(r.dialogs.length, 0); assert.equal(writes(r).length, 0);
    assert.doesNotMatch(res.error ?? '', /this computer/i);
    assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'ask' } }, r.deps)).ok, true);
  } finally { await r.close(); }
  const u = await boot([true], { keyring: { get: () => undefined, state: () => 'unreadable' }, prepare: (p) => { mkdirSync(p.data, { recursive: true }); writeFileSync(join(p.data, 'gates-key.bin'), 'wrapped, does not open'); } }); // the key file is there and does not open
  try {
    assert.match((await gatesChange({ kind: 'project', id: u.pid, patch: { preset: 'smart' } }, u.deps)).error ?? '', /could not open its settings key/);
    assert.equal(u.dialogs.length, 0);
  } finally { await u.close(); }
});

// ---- the dialog is the core's own list ----
const KINDS: Array<[string, 'app' | 'project', unknown, RegExp]> = [
  ['Accept edits', 'app', { preset: 'accept-edits' }, /File edits run without asking/],
  ['Smart', 'project', { preset: 'smart' }, /Legion decides when to ask/],
  ['Bypass', 'project', { preset: 'bypass' }, /No permission cards/],
  ['limit off', 'project', { limit: false }, /go beyond this project's setting/],
  ['a gate off', 'project', { overrides: { 'github-write-card': false } }, /Agents write to GitHub without asking/],
  ['Per agent', 'project', { preset: null }, /Each agent's own mode applies, Bypass included/],
  ['an approved site', 'app', { allowedHosts: ['docs.python.org'] }, /Agents may read docs\.python\.org without asking/],
  ['a kept variable', 'app', { envKeep: ['AWS_PROFILE'] }, /Commands keep the variable AWS_PROFILE, which can hold a secret. In API key or cloud mode, Claude.s own scrub may still hide it from Claude.s commands./],
];
for (const [label, kind, patch, re] of KINDS) {
  test(`the dialog for ${label} lists exactly the lines the core returns, and nothing is sent until Confirm`, async () => {
    const r = await boot([false], {});
    try {
      const before = JSON.stringify([r.core.store.app(), r.core.store.project(r.pid)]);
      const name = kind === 'app' ? 'app' : r.pid;
      // Per agent only loosens a project that has a preset
      if (label === 'Per agent') r.core.store.patchProject(r.pid, { preset: 'ask' });
      const core = await r.preview(name, patch);
      assert.equal(core.loosens, true);
      const res = await gatesChange(kind === 'app' ? { kind: 'app', patch } : { kind: 'project', id: r.pid, patch }, r.deps);
      assert.equal(res.cancelled, true);
      assert.equal(r.dialogs.length, 1);
      const d = r.dialogs[0]!;
      assert.equal(d.detail, core.loosening.join('\n\n'), 'the dialog shows exactly the core lines');
      assert.match(d.detail, re);
      assert.ok(d.message.includes(kind === 'app' ? 'all projects' : 'the project "Shop"'), d.message);
      assert.doesNotMatch(d.message, /‮/);
      for (const s of [d.title, d.message, d.detail, d.confirmLabel]) { assert.ok(!s.includes('—'), s); assert.doesNotMatch(s, /this computer|this machine/i); }
      assert.equal(writes(r).length, 0);
      if (label !== 'Per agent') assert.equal(JSON.stringify([r.core.store.app(), r.core.store.project(r.pid)]), before);
    } finally { await r.close(); }
  });
}

for (const preset of ['accept-edits', 'smart', 'bypass'] as const) {
  test(`the ${preset} confirm says deny rules and safety rails stay and that Legion has no sandbox for commands`, withHarness([false], {}, async (r) => {
    await gatesChange({ kind: 'app', patch: { preset } }, r.deps);
    const d = r.dialogs[0]!;
    assert.match(d.detail, /deny rules/i); assert.match(d.detail, /safety rails/i);
    assert.ok(d.detail.includes(NO_SANDBOX_LINE), 'no-sandbox line');
  }));
}

test('the no-sandbox line also appears when command cards go off or the limit goes off, and not for a GitHub-only change', withHarness([false, false, false], {}, async (r) => {
  await gatesChange({ kind: 'project', id: r.pid, patch: { overrides: { 'tool-cards': false } } }, r.deps);
  await gatesChange({ kind: 'project', id: r.pid, patch: { limit: false } }, r.deps);
  await gatesChange({ kind: 'project', id: r.pid, patch: { overrides: { 'github-write-card': false } } }, r.deps);
  assert.ok(r.dialogs[0]!.detail.includes(NO_SANDBOX_LINE)); assert.ok(r.dialogs[1]!.detail.includes(NO_SANDBOX_LINE)); assert.ok(!r.dialogs[2]!.detail.includes(NO_SANDBOX_LINE));
}));

test('C1: dropping an override that rides on another change is named in the dialog and the digest binds it', withHarness([true], {}, async (r) => {
  r.core.store.patchProject(r.pid, { preset: 'bypass', overrides: { 'tool-cards': true } });
  const res = await gatesChange({ kind: 'project', id: r.pid, patch: { overrides: { 'stall-ladder': false } } }, r.deps);
  assert.equal(res.ok, true, res.error);
  const d = r.dialogs[0]!.detail;
  assert.match(d, /Stop runs that stall: off/);
  assert.match(d, /Ask before tools run: off\. Agents run commands and change files without asking/, 'the dropped tool-cards override is named');
  assert.equal(r.core.store.project(r.pid).overrides?.['tool-cards'], undefined);
}));

test('a limit raise rides on Accept edits and is named', withHarness([true], {}, async (r) => {
  r.core.store.patchProject(r.pid, { preset: 'ask', overrides: { 'attempt-caps': { on: true, limit: 2 } } });
  await gatesChange({ kind: 'project', id: r.pid, patch: { preset: 'accept-edits', overrides: { 'attempt-caps': { on: true, limit: 100 } } } }, r.deps);
  const d = r.dialogs[0]!.detail;
  assert.match(d, /File edits run without asking/);
  assert.match(d, /Limit retries on one item: the limit goes from 2 to 100/); assert.doesNotMatch(d, /Limit the size of a goal/);
}));

test('N1 through the dialog: Accept edits that drops owner caps names the cap raises', withHarness([true], {}, async (r) => {
  r.core.store.patchProject(r.pid, { preset: 'ask', overrides: { 'attempt-caps': { on: true, limit: 1 } } });
  const res = await gatesChange({ kind: 'project', id: r.pid, patch: { preset: 'accept-edits', overrides: {} } }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.doesNotMatch(r.dialogs[0]!.detail, /Limit the size of a goal/);
  assert.match(r.dialogs[0]!.detail, /Limit retries on one item: the limit goes from 1 to 4/);
}));

test('N5: the dialog title says what is being loosened', async () => {
  const cases: Array<[string, unknown, string]> = [
    ['preset', { preset: 'smart' }, 'Let agents do more without asking?'],
    ['sites', { allowedHosts: ['docs.python.org'] }, 'Allow these sites?'],
    ['variables', { envKeep: ['AWS_PROFILE'] }, 'Keep these variables?'],
  ];
  for (const [, patch, title] of cases) {
    const r = await boot([false], {});
    try { await gatesChange({ kind: 'app', patch } as never, r.deps); assert.equal(r.dialogs[0]!.title, title); } finally { await r.close(); }
  }
  const r = await boot([false, false], {});
  try {
    await gatesChange({ kind: 'project', id: r.pid, patch: { overrides: { 'attempt-caps': { on: true, limit: 100 } } } }, r.deps);
    assert.equal(r.dialogs[0]!.title, 'Raise these limits?');
    await gatesChange({ kind: 'project', id: r.pid, patch: { overrides: { 'attempt-caps': { on: true, limit: 100 }, 'stall-ladder': false } } }, r.deps);
    assert.equal(r.dialogs[1]!.title, 'Let agents do more without asking?', 'a mixed change gets the general title');
  } finally { await r.close(); }
});

test('N5: a long list shows the first 10 lines and a count, and keeps the safety lines', withHarness([false], {}, async (r) => {
  const hosts = Array.from({ length: 40 }, (_, i) => `site${i}.example.com`);
  await gatesChange({ kind: 'app', patch: { allowedHosts: hosts } }, r.deps);
  const lines = r.dialogs[0]!.detail.split('\n\n');
  assert.equal(lines.filter((l) => /^Agents may read site/.test(l)).length, 10);
  assert.ok(lines.includes('and 30 more (see the Gates page)'), lines.join('|'));
  assert.ok(lines.some((l) => /deny rules/.test(l)), 'the safety line is still there');
}));

test('N5: a list that is not longer than 12 lines is shown whole', withHarness([false], {}, async (r) => {
  await gatesChange({ kind: 'app', patch: { allowedHosts: Array.from({ length: 11 }, (_, i) => `s${i}.example.com`) } }, r.deps);
  assert.doesNotMatch(r.dialogs[0]!.detail, /more \(see the Gates page\)/);
  assert.equal(r.dialogs[0]!.detail.split('\n\n').length, 12);
}));

test('M4: after Cancel the same change cannot raise another dialog for 3 seconds', async () => {
  const r = await boot([false, false, false], {});
  try {
    let t = 1_000_000; (r.deps as { now?: () => number }).now = () => t;
    assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, r.deps)).cancelled, true);
    t += 1000;
    const again = await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, r.deps);
    assert.equal(again.ok, false); assert.notEqual(again.cancelled, true); assert.match(again.error ?? '', /cancelled this change a moment ago/);
    assert.equal(r.dialogs.length, 1, 'no second dialog');
    // a different change is not held back
    assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'bypass' } }, r.deps)).cancelled, true);
    assert.equal(r.dialogs.length, 2);
    t += 3100;
    assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, r.deps)).cancelled, true);
    assert.equal(r.dialogs.length, 3);
  } finally { await r.close(); }
});

test('a change that differs from what the dialog showed is refused by the core, and nothing is applied', withHarness([true], {}, async (r) => {
  // while the dialog is open, another edit lands
  r.state.onConfirm = () => { r.core.store.patchProject(r.pid, { preset: 'ask', overrides: { 'digest-hold': false } }); };
  const res = await gatesChange({ kind: 'project', id: r.pid, patch: { preset: 'smart' } }, r.deps);
  assert.equal(res.ok, false); assert.match(res.error ?? '', /differs from what you confirmed/);
  assert.equal(r.core.store.project(r.pid).preset, 'ask');
}));

test('a tightening whose result changes while it is checked is refused, not applied', withHarness([], {}, async (r) => {
  r.core.store.patchProject(r.pid, { preset: 'bypass' });
  const real = r.deps.call;
  r.deps.call = async (m, route, body, native, extra) => {
    if (m === 'PATCH') r.core.store.patchProject(r.pid, { overrides: { 'digest-hold': false } });
    return real(m, route, body, native, extra);
  };
  const res = await gatesChange({ kind: 'project', id: r.pid, patch: { preset: 'ask' } }, r.deps);
  assert.equal(res.ok, false); assert.match(res.error ?? '', /differs from what you confirmed/);
  assert.equal(r.core.store.project(r.pid).preset, 'bypass');
}));

// ---- Accept and Keep ----
function outsideFile(preset: string) {
  return ({ data, pid, file }: Prep) => {
    const first = createGatesCore({ dataDir: data, keyring: { get: () => Buffer.alloc(32, 9) } });
    first.store.patchProject(pid, { preset: 'ask' });
    void first.store.flush();
    const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; j.preset = preset; writeFileSync(file, JSON.stringify(j));
  };
}

test('accept asks with what the file sets, only for a name the core lists as changed outside; keep needs no dialog', async () => {
  const r = await boot([true], { prepare: outsideFile('smart') });
  try {
    const res = await gatesChange({ kind: 'accept', name: r.pid }, r.deps);
    assert.equal(res.ok, true, res.error);
    assert.equal(r.dialogs.length, 1);
    assert.match(r.dialogs[0]!.detail, /Legion decides when to ask/); assert.ok(r.dialogs[0]!.detail.includes(NO_SANDBOX_LINE));
    assert.match(r.dialogs[0]!.message, /the project "Shop"/);
    assert.deepEqual([writes(r)[0]!.method, writes(r)[0]!.route, writes(r)[0]!.native], ['POST', `/api/gates/accept/${r.pid}`, true]);
    assert.equal(r.core.store.project(r.pid).preset, 'smart');
    assert.equal((await gatesChange({ kind: 'accept', name: r.pid }, r.deps)).ok, false, 'nothing left to accept');
  } finally { await r.close(); }
  const c = await boot([false], { prepare: outsideFile('bypass') });
  try {
    assert.equal((await gatesChange({ kind: 'accept', name: c.pid }, c.deps)).cancelled, true); assert.equal(writes(c).length, 0);
    assert.equal(c.core.store.project(c.pid).preset, 'ask');
    const k = await gatesChange({ kind: 'keep', name: c.pid }, c.deps);
    assert.equal(k.ok, true); assert.equal(c.dialogs.length, 1);
    assert.deepEqual([writes(c)[0]!.route, writes(c)[0]!.native], [`/api/gates/keep/${c.pid}`, false]);
  } finally { await c.close(); }
  const none = await boot([true], {});
  try { assert.equal((await gatesChange({ kind: 'accept', name: none.pid }, none.deps)).ok, false); assert.equal(none.dialogs.length, 0); assert.equal(writes(none).length, 0); } finally { await none.close(); }
});

test('Accept: a file swapped while the dialog is open is refused', async () => {
  const r = await boot([true], { prepare: outsideFile('smart') });
  try {
    r.state.onConfirm = async () => {
      const j = JSON.parse(readFileSync(r.file, 'utf8')) as Record<string, unknown>; j.preset = 'bypass'; writeFileSync(r.file, JSON.stringify(j));
      await fetch(r.base + '/api/gates/reload', { method: 'POST', headers: { ...AUTH, ...J }, body: '{}' });
    };
    const res = await gatesChange({ kind: 'accept', name: r.pid }, r.deps);
    assert.equal(res.ok, false); assert.match(res.error ?? '', /differs from what you confirmed/);
    assert.equal(r.core.store.project(r.pid).preset, 'ask');
  } finally { await r.close(); }
});

test('a refusing or unreachable core is reported in plain words', async () => {
  const r = await boot([true], {});
  try {
    const bad = await gatesChange({ kind: 'app', patch: { allowedHosts: ['not a site'] } }, r.deps);
    assert.equal(bad.ok, false); assert.match(bad.error ?? '', /not a site name/); assert.equal(r.dialogs.length, 0);
    r.state.down = true;
    const down = await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, r.deps);
    assert.equal(down.ok, false); assert.match(down.error ?? '', /could not reach/);
  } finally { await r.close(); }
});

test('M3: the window reaches the handler only through main, which checks the sender; the preload only forwards', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const main = readFileSync(root + 'src/electron/main.ts', 'utf8').replace(/\r\n/g, '\n');
  const i = main.indexOf("'legion:gates-change'");
  assert.ok(i > 0);
  const block = main.slice(i, i + 700);
  assert.match(block, /trustedSender\(frameUrl, uiUrl\)/); assert.match(block, /sender !== win\.webContents/); assert.match(block, /gatesChange\(raw, \{ call: ownCoreCall, confirm: makeConfirm\(dialog/);
  assert.match(main, /extraHeaders\?: Record<string, string>/); assert.match(main, /Object\.assign\(headers, extraHeaders\)/);
  const pre = readFileSync(root + 'src/electron/preload.cjs', 'utf8').replace(/\r\n/g, '\n');
  assert.match(pre, /gatesChange\(change\) \{\s*return ipcRenderer\.invoke\('legion:gates-change', change\);/);
  assert.doesNotMatch(pre, /nativeSecret|X-Legion-Native/i);
});

// ---------------------------------------------------------------- the keep list editor ("Variables commands may keep")

test('keep list: Add raises one dialog titled "Keep these variables?" that names the variable, then saves with native and the shown digest', withHarness([true], {}, async (r) => {
  const res = await gatesChange({ kind: 'app', patch: { envKeep: ['NPM_TOKEN'] } }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(r.dialogs.length, 1);
  assert.equal(r.dialogs[0]!.title, 'Keep these variables?');
  assert.match(r.dialogs[0]!.detail, /Commands keep the variable NPM_TOKEN, which can hold a secret/);
  const w = writes(r);
  assert.equal(w.length, 1);
  assert.deepEqual([w[0]!.method, w[0]!.route, w[0]!.native, w[0]!.body], ['PATCH', '/api/gates/app', true, { envKeep: ['NPM_TOKEN'] }]);
  assert.deepEqual(r.core.store.app().envKeep, ['NPM_TOKEN']);
}));

test('keep list: Cancel on the dialog saves nothing', withHarness([false], {}, async (r) => {
  const res = await gatesChange({ kind: 'app', patch: { envKeep: ['NPM_TOKEN'] } }, r.deps);
  assert.deepEqual([res.ok, res.cancelled], [false, true]);
  assert.equal(writes(r).length, 0);
  assert.equal(r.core.store.app().envKeep, undefined);
}));

test('keep list: Remove needs no dialog and no native header; removing the last name sends [] and clears the key', withHarness([], {}, async (r) => {
  r.core.store.patchApp({ envKeep: ['NPM_TOKEN', 'GH_TOKEN'] });
  const one = await gatesChange({ kind: 'app', patch: { envKeep: ['GH_TOKEN'] } }, r.deps);
  assert.equal(one.ok, true, one.error);
  assert.equal(r.dialogs.length, 0, 'removing a name is a tightening');
  assert.equal(writes(r)[0]!.native, false);
  assert.deepEqual(r.core.store.app().envKeep, ['GH_TOKEN']);
  const last = await gatesChange({ kind: 'app', patch: { envKeep: [] } }, r.deps);
  assert.equal(last.ok, true, last.error);
  assert.equal(r.dialogs.length, 0);
  assert.equal(writes(r)[1]!.native, false);
  assert.equal(r.core.store.app().envKeep, undefined);
}));

test('keep list: adding one name to a list that already has names asks about the new one only', withHarness([true], {}, async (r) => {
  r.core.store.patchApp({ envKeep: ['NPM_TOKEN'] });
  const res = await gatesChange({ kind: 'app', patch: { envKeep: ['NPM_TOKEN', 'GH_TOKEN'] } }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(r.dialogs.length, 1);
  assert.match(r.dialogs[0]!.detail, /GH_TOKEN/);
  assert.doesNotMatch(r.dialogs[0]!.detail, /NPM_TOKEN/, 'a name already kept is not asked about again');
  assert.deepEqual(r.core.store.app().envKeep, ['NPM_TOKEN', 'GH_TOKEN']);
}));

test('keep list: a project cannot carry a keep list (the list is the app file only)', async () => {
  assert.equal(parseGatesChange({ kind: 'project', id: 'proj_0123456789ab', patch: { envKeep: ['NPM_TOKEN'] } }), undefined);
});
