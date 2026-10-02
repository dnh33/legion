import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogLine, parseProviderChange, providerChange } from '../src/electron/provider-ipc.js';
import type { ProviderIpcDeps } from '../src/electron/provider-ipc.js';
import { FAKE_KEY } from './providers-fakes.js';

const VIEW = { providers: [{ id: 'mine', label: 'Mine', baseUrl: 'https://old.example.com/v1' }, { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }] };
function deps(over: { confirm?: boolean; coreDown?: boolean; status?: number } = {}) {
  const calls: Array<{ method: string; route: string; body?: unknown; native?: boolean }> = [];
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const d: ProviderIpcDeps = {
    async call(method, route, body, native) {
      calls.push({ method, route, body, native });
      if (over.coreDown) return undefined;
      if (method === 'GET') return { status: 200, json: VIEW };
      return { status: over.status ?? 200, json: over.status && over.status !== 200 ? { error: 'refused by core' } : { ok: true } };
    },
    async confirm(o) { dialogs.push(o); return over.confirm !== false; },
  };
  return { d, calls, dialogs };
}

test('C6 the window\'s request is parsed strictly: unknown kinds, bad ids, bad keys and unknown patch fields are refused', () => {
  assert.equal(parseProviderChange(null), undefined);
  assert.equal(parseProviderChange({ kind: 'key', id: 'Bad Id', key: FAKE_KEY }), undefined);
  assert.equal(parseProviderChange({ kind: 'key', id: 'mine', key: 'short' }), undefined);
  assert.equal(parseProviderChange({ kind: 'key', id: 'mine', key: 'has a space in it 123' }), undefined);
  assert.equal(parseProviderChange({ kind: 'wipe', id: 'mine' }), undefined);
  assert.equal(parseProviderChange({ kind: 'entry', id: 'mine', patch: { baseUrl: 'https://x.example/v1', kind: 'cli' } }), undefined);
  assert.deepEqual(parseProviderChange({ kind: 'entry', id: 'mine', patch: { baseUrl: 'https://x.example/v1' } }), { kind: 'entry', id: 'mine', patch: { baseUrl: 'https://x.example/v1' } });
});

test('C6 saving a key: a native dialog words the host from the core\'s own facts, never shows the key, and the core is called with the native secret only after Confirm', async () => {
  const { d, calls, dialogs } = deps();
  const r = await providerChange({ kind: 'key', id: 'mine', key: FAKE_KEY }, d);
  assert.equal(r.ok, true);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0]!.detail, /old\.example\.com/);
  assert.equal(JSON.stringify(dialogs).includes(FAKE_KEY), false, 'the key is never in a dialog');
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.route, '/api/providers/mine/key'); assert.equal(put.native, true); assert.deepEqual(put.body, { key: FAKE_KEY });
  assert.equal(JSON.stringify(r).includes(FAKE_KEY), false, 'nor in the reply');
});

test('C6 Cancel changes nothing: the core is never asked to write', async () => {
  const { d, calls } = deps({ confirm: false });
  const r = await providerChange({ kind: 'key', id: 'mine', key: FAKE_KEY }, d);
  assert.equal(r.ok, false); assert.equal(r.cancelled, true);
  assert.equal(calls.some((c) => c.method === 'PUT'), false);
});

test('C6 an address change names the new host, says the old key is deleted, and says when it allows a private network or no key', async () => {
  const { d, dialogs, calls } = deps();
  const r = await providerChange({ kind: 'entry', id: 'mine', patch: { baseUrl: 'https://10.0.0.5/v1', allowPrivateNetwork: true, keyless: true } }, d);
  assert.equal(r.ok, true);
  const t = dialogs[0]!.detail;
  assert.match(t, /10\.0\.0\.5/); assert.match(t, /old\.example\.com/); assert.match(t, /key saved for the old address is deleted/); assert.match(t, /private network/); assert.match(t, /without a key/);
  assert.equal(calls.find((c) => c.method === 'PUT')!.native, true);
});

test('failure paths: no proven core, an unknown provider, a core refusal, a bad address; text from the core is flattened', async () => {
  assert.equal((await providerChange({ kind: 'key', id: 'mine', key: FAKE_KEY }, deps({ coreDown: true }).d)).ok, false);
  assert.match((await providerChange({ kind: 'key', id: 'nope', key: FAKE_KEY }, deps().d)).error ?? '', /Unknown provider/);
  assert.match((await providerChange({ kind: 'key', id: 'mine', key: FAKE_KEY }, deps({ status: 403 }).d)).error ?? '', /refused by core/);
  assert.match((await providerChange({ kind: 'entry', id: 'mine', patch: { baseUrl: 'not a url' } }, deps().d)).error ?? '', /not a valid URL/);
  assert.equal(dialogLine('a‮b\nc\u0000d'), 'a b c d');
});

test('only one confirmation is open at a time', async () => {
  let release: (v: boolean) => void = () => undefined;
  const first = deps().d;
  first.confirm = () => new Promise<boolean>((res) => { release = res; });
  const p1 = providerChange({ kind: 'key', id: 'mine', key: FAKE_KEY }, first);
  await new Promise((r) => setTimeout(r, 20));
  const r2 = await providerChange({ kind: 'key', id: 'openai', key: FAKE_KEY }, deps().d);
  assert.match(r2.error ?? '', /already open/);
  release(false);
  assert.equal((await p1).cancelled, true);
});
