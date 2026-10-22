import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_BUSY, ConfirmBusyError } from '../src/electron/confirm-window-logic.js';
import { parseWebSearchChange, webSearchChange } from '../src/electron/web-search-ipc.js';
import type { WebSearchIpcDeps } from '../src/electron/web-search-ipc.js';

const KEY = 'k_test_12345';
const VIEW = { providers: [{ id: 'exa', label: 'Exa' }, { id: 'brave', label: 'Brave Search' }, { id: 'searxng', label: 'SearXNG' }] };

function deps(over: { confirm?: boolean; coreDown?: boolean; status?: number; check?: Record<string, unknown> } = {}) {
  const calls: Array<{ method: string; route: string; body?: unknown; native?: boolean }> = [];
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const d: WebSearchIpcDeps = {
    async call(method, route, body, native) {
      calls.push({ method, route, body, native });
      if (over.coreDown) return undefined;
      if (method === 'GET') return { status: 200, json: VIEW };
      if (route.endsWith('/check')) return { status: 200, json: over.check ?? { ok: true } };
      return { status: over.status ?? 200, json: over.status && over.status !== 200 ? { error: 'refused by core' } : { ok: true } };
    },
    async confirm(o) { dialogs.push(o); return over.confirm !== false; },
  };
  return { d, calls, dialogs };
}

test('the window\'s request is parsed strictly', () => {
  assert.equal(parseWebSearchChange(null), undefined);
  assert.equal(parseWebSearchChange({ kind: 'key', provider: 'searxng', key: KEY }), undefined);
  assert.equal(parseWebSearchChange({ kind: 'key', provider: 'nope', key: KEY }), undefined);
  assert.equal(parseWebSearchChange({ kind: 'key', provider: 'exa', key: 'short' }), undefined);
  assert.equal(parseWebSearchChange({ kind: 'key', provider: 'exa', key: 'has a space 12345' }), undefined);
  assert.equal(parseWebSearchChange({ kind: 'address', baseUrl: 'ftp://x.example' }), undefined);
  assert.equal(parseWebSearchChange({ kind: 'address', baseUrl: 'not a url' }), undefined);
  assert.equal(parseWebSearchChange({ kind: 'address', baseUrl: 'https://s.example', acknowledge: 'exa' }), undefined);
  assert.equal(parseWebSearchChange({ kind: 'wipe' }), undefined);
  assert.deepEqual(parseWebSearchChange({ kind: 'key', provider: 'exa', key: KEY }), { kind: 'key', provider: 'exa', key: KEY });
  assert.deepEqual(parseWebSearchChange({ kind: 'address', baseUrl: 'http://192.168.1.5:8080', acknowledge: 'searxng' }), { kind: 'address', baseUrl: 'http://192.168.1.5:8080', acknowledge: 'searxng' });
});

test('saving a key: the dialog names the fixed host, never shows the key, and the core gets the native secret only after Confirm', async () => {
  const { d, calls, dialogs } = deps();
  const r = await webSearchChange({ kind: 'key', provider: 'exa', key: KEY }, d);
  assert.equal(r.ok, true);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0]!.message, /Exa/); assert.match(dialogs[0]!.detail, /api\.exa\.ai/);
  assert.equal(JSON.stringify(dialogs).includes(KEY), false);
  const post = calls.find((c) => c.method === 'POST')!;
  assert.equal(post.route, '/api/settings/web-search/key'); assert.equal(post.native, true); assert.deepEqual(post.body, { provider: 'exa', key: KEY });
  assert.equal(JSON.stringify(r).includes(KEY), false);
});

test('Cancel changes nothing: the core is never asked to write', async () => {
  const { d, calls } = deps({ confirm: false });
  const r = await webSearchChange({ kind: 'key', provider: 'brave', key: KEY }, d);
  assert.deepEqual([r.ok, r.cancelled], [false, true]);
  assert.equal(calls.some((c) => c.method !== 'GET'), false);
});

test('a private SearXNG address: native dialog with the host, then PATCH with the native secret and the acknowledgement', async () => {
  const { d, calls, dialogs } = deps({ check: { ok: true, needsNative: true, privateNetwork: true } });
  const r = await webSearchChange({ kind: 'address', baseUrl: 'http://192.168.1.5:8080', acknowledge: 'searxng' }, d);
  assert.equal(r.ok, true);
  assert.equal(dialogs.length, 1); assert.match(dialogs[0]!.detail, /192\.168\.1\.5:8080/); assert.match(dialogs[0]!.detail, /private network|your computer/);
  const patch = calls.find((c) => c.method === 'PATCH')!;
  assert.equal(patch.route, '/api/settings/web-search'); assert.equal(patch.native, true);
  assert.deepEqual(patch.body, { searxng: { baseUrl: 'http://192.168.1.5:8080' }, acknowledge: 'searxng' });
});

test('B-L2: a new public SearXNG address gets its own native dialog (the web, not a private network), then the PATCH with the native secret', async () => {
  const { d, calls, dialogs } = deps({ check: { ok: true, needsNative: true, privateNetwork: false } });
  const r = await webSearchChange({ kind: 'address', baseUrl: 'https://searx.example.org' }, d);
  assert.equal(r.ok, true); assert.equal(dialogs.length, 1);
  assert.match(dialogs[0]!.detail, /searx.example.org/);
  assert.match(dialogs[0]!.detail, /can see every search/);
  assert.doesNotMatch(dialogs[0]!.detail + dialogs[0]!.message, /private network|your computer/, 'the private-network words are for private addresses only');
  assert.equal(calls.find((c) => c.method === 'PATCH')!.native, true);
  const cancelled = deps({ check: { ok: true, needsNative: true, privateNetwork: false }, confirm: false });
  assert.equal((await webSearchChange({ kind: 'address', baseUrl: 'https://searx.example.org' }, cancelled.d)).cancelled, true);
  assert.equal(cancelled.calls.some((c) => c.method === 'PATCH'), false);
});

test('an address the core says needs no confirm (the same one again) goes without a dialog or the native secret', async () => {
  const { d, calls, dialogs } = deps({ check: { ok: true } });
  const r = await webSearchChange({ kind: 'address', baseUrl: 'https://searx.example.org' }, d);
  assert.equal(r.ok, true); assert.equal(dialogs.length, 0);
  assert.equal(calls.find((c) => c.method === 'PATCH')!.native, false);
});

test('errors: core down, unknown provider, a check the core refuses, a refused write', async () => {
  assert.equal((await webSearchChange({ kind: 'key', provider: 'exa', key: KEY }, deps({ coreDown: true }).d)).ok, false);
  const view = { providers: [{ id: 'brave', label: 'Brave Search' }] };
  const odd: WebSearchIpcDeps = { async call() { return { status: 200, json: view }; }, async confirm() { return true; } };
  assert.match((await webSearchChange({ kind: 'key', provider: 'exa', key: KEY }, odd)).error ?? '', /Unknown provider/);
  assert.match((await webSearchChange({ kind: 'address', baseUrl: 'https://u.example' }, deps({ check: { ok: false, error: 'Bad address.' } }).d)).error ?? '', /Bad address/);
  assert.match((await webSearchChange({ kind: 'key', provider: 'exa', key: KEY }, deps({ status: 403 }).d)).error ?? '', /refused by core/);
});

test('the hosts the key dialog names are the hosts the adapters send the key to', async () => {
  const { WEB_PROVIDER_HOSTS } = await import('../src/shared/web-search-config.js');
  const { ADAPTERS } = await import('../src/core/web-search/adapters.js');
  for (const id of ['treg', 'exa', 'tavily', 'brave'] as const) {
    assert.equal(new URL(ADAPTERS[id].origin({} as never)!).host, WEB_PROVIDER_HOSTS[id], id);
  }
});

test('busy: a question that lost to an open one is "already open", not Cancel, and nothing is written', async () => {
  const lost = deps(); lost.d.confirm = async () => { throw new ConfirmBusyError(); };
  const r = await webSearchChange({ kind: 'key', provider: 'exa', key: KEY }, lost.d);
  assert.deepEqual(r, { ok: false, error: CONFIRM_BUSY });
  assert.equal(lost.calls.some((c) => c.method === 'PUT' || c.method === 'POST'), false);
  assert.equal((await webSearchChange({ kind: 'key', provider: 'exa', key: KEY }, deps().d)).ok, true);
});
