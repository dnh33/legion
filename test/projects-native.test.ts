/** The app's native confirmation for project folder and member changes (control C2, app side). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectChange, projectChange } from '../src/electron/project-ipc.js';
import type { ProjectIpcDeps } from '../src/electron/project-ipc.js';

const ID = 'proj_0123456789ab';
const PROJECT = { id: ID, name: 'Site\u202e', folder: 'C:\\work\\site', members: ['zealot'] };
const AGENTS = [{ id: 'zealot', name: 'Zealot' }, { id: 'scout', name: 'Scout' }, { id: 'builder', name: 'Builder' }];
function deps(over: { confirm?: boolean; picked?: string | undefined; status?: number; coreDown?: boolean } = {}) {
  const calls: Array<{ method: string; route: string; body?: unknown; native?: boolean }> = [];
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const d: ProjectIpcDeps = {
    async call(method, route, body, native) {
      calls.push({ method, route, body, native });
      if (over.coreDown) return undefined;
      if (method === 'GET') return { status: 200, json: route === '/api/agents' ? AGENTS : PROJECT };
      return { status: over.status ?? 200, json: over.status && over.status !== 200 ? { error: 'refused by core' } : { ok: true } };
    },
    async confirm(o) { dialogs.push(o); return over.confirm !== false; },
    async pickFolder() { return 'picked' in over ? over.picked : 'D:\\projects\\site-2'; },
  };
  return { d, calls, dialogs };
}

test('the window\'s request is parsed strictly', () => {
  assert.equal(parseProjectChange(null), undefined);
  assert.equal(parseProjectChange({ kind: 'members', id: 'x', members: [] }), undefined);
  assert.equal(parseProjectChange({ kind: 'members', id: ID, members: ['a b'] }), undefined);
  assert.equal(parseProjectChange({ kind: 'members', id: ID, members: Array.from({ length: 25 }, (_, i) => 'a' + i) }), undefined);
  assert.equal(parseProjectChange({ kind: 'folder', id: ID, mode: 'pick', folder: 'C:\\Windows' }) !== undefined, true, 'extra fields are ignored, never forwarded');
  assert.deepEqual(parseProjectChange({ kind: 'folder', id: ID, mode: 'pick', folder: 'C:\\Windows' }), { kind: 'folder', id: ID, mode: 'pick' }, 'the window cannot name a folder: only main\'s chooser can');
  assert.equal(parseProjectChange({ kind: 'folder', id: ID, mode: 'wipe' }), undefined);
  assert.equal(parseProjectChange({ kind: 'delete', id: ID }), undefined);
  assert.deepEqual(parseProjectChange({ kind: 'members', id: ID, members: ['a', 'a', 'b'] }), { kind: 'members', id: ID, members: ['a', 'b'] });
});

test('members: the dialog names who is added and removed from the core\'s own facts; the core is called with the native secret only after Confirm', async () => {
  const { d, calls, dialogs } = deps();
  const r = await projectChange({ kind: 'members', id: ID, members: ['scout', 'builder'] }, d);
  assert.equal(r.ok, true);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0]!.detail, /Added: Scout, Builder/);
  assert.match(dialogs[0]!.detail, /Removed: Zealot/);
  assert.doesNotMatch(dialogs[0]!.message, /\u202e/, 'control characters are stripped from dialog text');
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.route, `/api/projects/${ID}/members`); assert.equal(put.native, true); assert.deepEqual(put.body, { members: ['scout', 'builder'] });
});

test('Cancel changes nothing, and a no-op change shows no dialog', async () => {
  const c = deps({ confirm: false });
  const r = await projectChange({ kind: 'members', id: ID, members: ['scout'] }, c.d);
  assert.equal(r.cancelled, true);
  assert.equal(c.calls.some((x) => x.method === 'PUT'), false);
  const same = deps();
  const r2 = await projectChange({ kind: 'members', id: ID, members: ['zealot'] }, same.d);
  assert.equal(r2.ok, true); assert.equal(same.dialogs.length, 0); assert.equal(same.calls.some((x) => x.method === 'PUT'), false);
});

test('folder: the chooser path is shown with the old one; cancelling the chooser or the dialog changes nothing; default needs a confirmation too', async () => {
  const a = deps();
  const r = await projectChange({ kind: 'folder', id: ID, mode: 'pick' }, a.d);
  assert.equal(r.ok, true);
  assert.match(a.dialogs[0]!.detail, /D:\\projects\\site-2/); assert.match(a.dialogs[0]!.detail, /C:\\work\\site/);
  const put = a.calls.find((c) => c.method === 'PUT')!;
  assert.deepEqual(put.body, { folder: 'D:\\projects\\site-2' }); assert.equal(put.native, true);
  const none = deps({ picked: undefined });
  assert.equal((await projectChange({ kind: 'folder', id: ID, mode: 'pick' }, none.d)).cancelled, true);
  assert.equal(none.dialogs.length, 0); assert.equal(none.calls.some((x) => x.method === 'PUT'), false);
  const no = deps({ confirm: false });
  assert.equal((await projectChange({ kind: 'folder', id: ID, mode: 'pick' }, no.d)).cancelled, true);
  assert.equal(no.calls.some((x) => x.method === 'PUT'), false);
  const def = deps();
  await projectChange({ kind: 'folder', id: ID, mode: 'default' }, def.d);
  assert.equal(def.dialogs.length, 1); assert.deepEqual(def.calls.find((c) => c.method === 'PUT')!.body, { folder: null });
});

test('a refusing or unreachable core is reported in plain words', async () => {
  const bad = deps({ status: 400 });
  const r = await projectChange({ kind: 'folder', id: ID, mode: 'pick' }, bad.d);
  assert.equal(r.ok, false); assert.match(r.error!, /refused by core/);
  const down = deps({ coreDown: true });
  const r2 = await projectChange({ kind: 'members', id: ID, members: ['scout'] }, down.d);
  assert.equal(r2.ok, false); assert.match(r2.error!, /could not reach/);
});
