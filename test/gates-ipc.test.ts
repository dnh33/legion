/** The app's native confirmation for gate changes: the window names a change, main words the dialog, the core is called with the native secret only after Confirm. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bypassDetail, gatesChange, parseGatesChange } from '../src/electron/gates-ipc.js';
import type { GatesIpcDeps } from '../src/electron/gates-ipc.js';
import { NO_SANDBOX_LINE } from '../src/shared/gates-registry.js';

const PID = 'proj_0123456789ab';
const view = (o: Record<string, unknown> = {}) => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, keyUnreadable: false, ...o });

interface Opts { view?: unknown; patchStatus?: number; patchError?: string; probe403?: boolean; coreDown?: boolean }
function mkDeps(answers: boolean[], o: Opts = {}) {
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const calls: Array<{ method: string; route: string; native: boolean; body?: unknown }> = [];
  const deps: GatesIpcDeps = {
    async call(method, route, body, native) {
      calls.push({ method, route, native: native === true, ...(body !== undefined ? { body } : {}) });
      if (o.coreDown) return undefined;
      if (route === '/api/gates/settings') return { status: 200, json: o.view ?? view() };
      if (route.startsWith('/api/projects/')) return { status: 200, json: { id: PID, name: 'Shop\u202e' } };
      if (o.probe403 && native !== true) return { status: 403, json: { error: 'native_confirmation_required: a change that loosens a gate comes only from the app after its confirmation dialog' } };
      if (o.patchStatus && o.patchStatus !== 200) return { status: o.patchStatus, json: { error: o.patchError ?? 'refused by core' } };
      return { status: 200, json: { version: 1 } };
    },
    async confirm(d) { dialogs.push(d); return answers.shift() ?? false; },
  };
  return { dialogs, calls, deps };
}
const writes = (c: ReturnType<typeof mkDeps>['calls']) => c.filter((x) => x.method !== 'GET');

test('a bypass change shows one dialog and calls the core with native only after Confirm', async () => {
  const m = mkDeps([true]);
  const res = await gatesChange({ kind: 'app', patch: { preset: 'bypass' } }, m.deps);
  assert.equal(res.ok, true);
  assert.equal(m.dialogs.length, 1);
  const w = writes(m.calls);
  assert.equal(w.length, 1);
  assert.deepEqual([w[0]!.method, w[0]!.route, w[0]!.native, w[0]!.body], ['PATCH', '/api/gates/app', true, { preset: 'bypass' }]);
});

test('cancel changes nothing and makes no write', async () => {
  const m = mkDeps([false]);
  const res = await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, m.deps);
  assert.deepEqual([res.ok, res.cancelled], [false, true]);
  assert.equal(writes(m.calls).length, 0);
});

test('a tightening change shows no dialog and sends no native header', async () => {
  const m = mkDeps([], { view: view({ app: { version: 1, preset: 'bypass' } }) });
  const res = await gatesChange({ kind: 'app', patch: { preset: 'ask' } }, m.deps);
  assert.equal(res.ok, true); assert.equal(m.dialogs.length, 0);
  assert.equal(writes(m.calls)[0]!.native, false);
});

test('Bypass to Smart is a tightening: no dialog; Smart to Accept edits is not ordered, so it asks', async () => {
  const down = mkDeps([], { view: view({ app: { version: 1, preset: 'bypass' } }) });
  assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, down.deps)).ok, true); assert.equal(down.dialogs.length, 0);
  const side = mkDeps([true], { view: view({ app: { version: 1, preset: 'smart' } }) });
  assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'accept-edits' } }, side.deps)).ok, true); assert.equal(side.dialogs.length, 1);
});

test('the core stays the authority: a change the dialog logic took for a tightening but the core calls a loosening asks, then retries with native', async () => {
  const m = mkDeps([true], { probe403: true });
  const res = await gatesChange({ kind: 'project', id: PID, patch: { preset: null } }, m.deps);
  assert.equal(res.ok, true); assert.equal(m.dialogs.length, 1);
  assert.deepEqual(writes(m.calls).map((c) => c.native), [false, true]);
  const no = mkDeps([false], { probe403: true });
  const r2 = await gatesChange({ kind: 'project', id: PID, patch: { preset: null } }, no.deps);
  assert.equal(r2.cancelled, true); assert.deepEqual(writes(no.calls).map((c) => c.native), [false]);
});

test('a second change while a dialog is open is refused without a second dialog', async () => {
  const m = mkDeps([]);
  let release!: (b: boolean) => void;
  m.deps.confirm = (d) => { m.dialogs.push(d); return new Promise<boolean>((r) => { release = r; }); };
  const first = gatesChange({ kind: 'app', patch: { preset: 'smart' } }, m.deps);
  await new Promise((r) => setTimeout(r, 10));
  const second = await gatesChange({ kind: 'app', patch: { preset: 'bypass' } }, m.deps);
  assert.equal(second.ok, false); assert.equal(m.dialogs.length, 1);
  release(false); await first;
  // the flag is released afterwards
  const again = mkDeps([false]);
  assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, again.deps)).cancelled, true);
});

test('a malformed request is refused before any dialog or call', async () => {
  const m = mkDeps([true]);
  const bad: unknown[] = [
    null, 'x', { kind: 'app' }, { kind: 'app', patch: { preset: 'wild' } }, { kind: 'app', patch: { overrides: { nope: false } } },
    { kind: 'project', id: PID, patch: { overrides: { 'rail-shell-floor': false } } },
    { kind: 'project', id: PID, patch: { overrides: { 'attempt-caps': { on: true, limit: 500 } } } },
    { kind: 'project', id: PID, patch: { overrides: { 'attempt-caps': { on: true, limit: 1.5 } } } },
    { kind: 'project', id: PID, patch: { limit: 'no' } },
    { kind: 'project', patch: {} }, { kind: 'project', id: 'x', patch: {} }, { kind: 'accept' }, { kind: 'accept', name: '../app' }, { kind: 'delete', name: 'app' },
  ];
  for (const b of bad) assert.equal((await gatesChange(b, m.deps)).ok, false, JSON.stringify(b));
  assert.equal(m.dialogs.length, 0); assert.equal(m.calls.length, 0);
});

test('there is no shell-floor switch: a patch that names it is refused, no dialog, no call', async () => {
  const m = mkDeps([true]);
  const res = await gatesChange({ kind: 'app', patch: { shellFloorOff: true } } as never, m.deps);
  assert.equal(res.ok, false); assert.equal(m.dialogs.length, 0); assert.equal(m.calls.length, 0);
  assert.equal(parseGatesChange({ kind: 'app', patch: { preset: 'ask', shellFloorOff: true } }), undefined);
});

test('the window cannot send an extra field: the call to the core carries only the parsed patch', async () => {
  assert.deepEqual(parseGatesChange({ kind: 'project', id: PID, patch: { preset: 'ask', limit: true }, native: true, extra: 1 }), { kind: 'project', id: PID, patch: { preset: 'ask', limit: true } });
  assert.deepEqual(parseGatesChange({ kind: 'project', id: PID, patch: { overrides: { 'attempt-caps': { on: true, limit: 8 }, 'tool-cards': false } } }), { kind: 'project', id: PID, patch: { overrides: { 'attempt-caps': { on: true, limit: 8 }, 'tool-cards': false } } });
});

test('with no keystore key a loosening is refused with the plain reason, and Ask still works', async () => {
  const m = mkDeps([true], { view: view({ canSign: false }) });
  const res = await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, m.deps);
  assert.equal(res.ok, false); assert.match(res.error ?? '', /no safe keystore, so only Ask can be used/);
  assert.equal(m.dialogs.length, 0); assert.equal(writes(m.calls).length, 0);
  assert.doesNotMatch(res.error ?? '', /this computer/i);
  const ask = mkDeps([], { view: view({ canSign: false }) });
  assert.equal((await gatesChange({ kind: 'app', patch: { preset: 'ask' } }, ask.deps)).ok, true);
  const unreadable = mkDeps([true], { view: view({ canSign: false, keyUnreadable: true }) });
  assert.match((await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, unreadable.deps)).error ?? '', /could not open its settings key/);
});

test('the dialog names the scope from the core, the limit and each gate switched off, and strips control characters', async () => {
  const m = mkDeps([false]);
  await gatesChange({ kind: 'project', id: PID, patch: { preset: 'smart', limit: false, overrides: { 'github-write-card': false, 'tool-cards': true } } }, m.deps);
  const d = m.dialogs[0]!;
  assert.match(d.message, /Shop/); assert.doesNotMatch(d.message, /\u202e/);
  assert.match(d.detail, /Agents with their own mode can go beyond this project's setting\./);
  assert.match(d.detail, /Agents write to GitHub without asking/);
  assert.doesNotMatch(d.detail, /Agents run commands and change files without asking/);
});

for (const preset of ['accept-edits', 'smart', 'bypass'] as const) {
  test(`the ${preset} confirm says deny rules and safety rails stay, that Legion has no sandbox for commands, and has no em dash`, async () => {
    const m = mkDeps([false]);
    await gatesChange({ kind: 'app', patch: { preset } }, m.deps);
    assert.equal(m.dialogs.length, 1);
    const d = m.dialogs[0]!;
    assert.match(d.detail, /deny rules/i); assert.match(d.detail, /safety rails/i);
    assert.ok(d.detail.includes(NO_SANDBOX_LINE), 'no-sandbox line');
    for (const s of [d.title, d.message, d.detail, d.confirmLabel]) { assert.ok(!s.includes('\u2014'), preset); assert.doesNotMatch(s, /this computer|this machine/i); }
  });
}
test('the Accept edits and Bypass texts match the plan', () => {
  assert.match(bypassDetail(), /No permission cards/);
  assert.ok(bypassDetail().includes(NO_SANDBOX_LINE));
});

test('the Ask choice (a tightening) shows no dialog and so no sandbox line', async () => {
  const m = mkDeps([], { view: view({ app: { version: 1, preset: 'smart' } }) });
  await gatesChange({ kind: 'app', patch: { preset: 'ask' } }, m.deps);
  assert.equal(m.dialogs.length, 0);
});

test('accept always asks, and only for a name the core lists as changed outside; keep needs no dialog', async () => {
  const m = mkDeps([true], { view: view({ changedOutside: [PID] }) });
  const res = await gatesChange({ kind: 'accept', name: PID }, m.deps);
  assert.equal(res.ok, true); assert.equal(m.dialogs.length, 1);
  assert.deepEqual([writes(m.calls)[0]!.method, writes(m.calls)[0]!.route, writes(m.calls)[0]!.native], ['POST', `/api/gates/accept/${PID}`, true]);
  assert.ok(!m.dialogs[0]!.detail.includes('\u2014'));
  const cancel = mkDeps([false], { view: view({ changedOutside: [PID] }) });
  assert.equal((await gatesChange({ kind: 'accept', name: PID }, cancel.deps)).cancelled, true); assert.equal(writes(cancel.calls).length, 0);
  const none = mkDeps([true]);
  assert.equal((await gatesChange({ kind: 'accept', name: PID }, none.deps)).ok, false); assert.equal(none.dialogs.length, 0); assert.equal(writes(none.calls).length, 0);
  const keep = mkDeps([], { view: view({ changedOutside: ['app'] }) });
  const k = await gatesChange({ kind: 'keep', name: 'app' }, keep.deps);
  assert.equal(k.ok, true); assert.equal(keep.dialogs.length, 0);
  assert.deepEqual([writes(keep.calls)[0]!.route, writes(keep.calls)[0]!.native], ['/api/gates/keep/app', false]);
});

test('a refusing or unreachable core is reported in plain words', async () => {
  const bad = mkDeps([true], { patchStatus: 400, patchError: 'The bypass preset is not available.' });
  const r = await gatesChange({ kind: 'app', patch: { preset: 'bypass' } }, bad.deps);
  assert.equal(r.ok, false); assert.match(r.error ?? '', /not available/);
  const down = mkDeps([true], { coreDown: true });
  const r2 = await gatesChange({ kind: 'app', patch: { preset: 'smart' } }, down.deps);
  assert.equal(r2.ok, false); assert.match(r2.error ?? '', /could not reach/);
});
