// test/web-search-cap-native.test.ts: raising the treg spending cap needs the app's native confirm, like every loosening; lowering it does not (final review M5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateWebSearchPatch } from '../src/core/web-search/index.js';
import { parseWebSearchChange, webSearchChange } from '../src/electron/web-search-ipc.js';
import type { WebSearchIpcDeps } from '../src/electron/web-search-ipc.js';
import { webSearchRoutes } from './web-search-rig.js';

const cur = (cap: number) => ({ ...defaultConfig().webSearch, tregMaxCostUsd: cap });

test('M5 validate: a raise needs native, a lowering or the same cap does not', () => {
  assert.equal(validateWebSearchPatch({ tregMaxCostUsd: 0.05 }, cur(0.01)).needsNative, true);
  assert.equal(validateWebSearchPatch({ tregMaxCostUsd: 1 }, cur(0.5)).needsNative, true);
  assert.equal(validateWebSearchPatch({ tregMaxCostUsd: 0.005 }, cur(0.01)).needsNative, undefined);
  assert.equal(validateWebSearchPatch({ tregMaxCostUsd: 0.01 }, cur(0.01)).needsNative, undefined);
  assert.equal(validateWebSearchPatch({ search: 'builtin' }, cur(0.01)).needsNative, undefined, 'a change that leaves the cap alone');
});

test('M5 routes: a raise without the native header is refused and changes nothing; with it, it is stored; a lowering needs no header', async () => {
  const w = webSearchRoutes({ native: 'n_secret' });
  await assert.rejects(w.call('PATCH', '/api/settings/web-search', { tregMaxCostUsd: 0.05 }), /native_confirmation_required/);
  assert.equal(w.config().tregMaxCostUsd, 0.01, 'nothing changed');
  const up = await w.call('PATCH', '/api/settings/web-search', { tregMaxCostUsd: 0.05 }, { 'x-legion-native': 'n_secret' }) as { tregMaxCostUsd: number };
  assert.equal(up.tregMaxCostUsd, 0.05);
  const down = await w.call('PATCH', '/api/settings/web-search', { tregMaxCostUsd: 0.02 }) as { tregMaxCostUsd: number };
  assert.equal(down.tregMaxCostUsd, 0.02);
  const check = await w.call('POST', '/api/settings/web-search/check', { tregMaxCostUsd: 0.5 }) as { ok: boolean; needsNative?: boolean };
  assert.equal(check.ok, true); assert.equal(check.needsNative, true);
  assert.equal(((await w.call('POST', '/api/settings/web-search/check', { tregMaxCostUsd: 0.01 })) as { needsNative?: boolean }).needsNative, undefined);
});

test('M5 routes: a core that was not started by the app cannot raise the cap at all', async () => {
  const w = webSearchRoutes();
  await assert.rejects(w.call('PATCH', '/api/settings/web-search', { tregMaxCostUsd: 0.05 }, { 'x-legion-native': 'anything' }), /native_unavailable/);
});

function deps(over: { confirm?: boolean; check?: Record<string, unknown>; cap?: number } = {}) {
  const calls: Array<{ method: string; route: string; body?: unknown; native?: boolean }> = [];
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const d: WebSearchIpcDeps = {
    async call(method, route, body, native) {
      calls.push({ method, route, body, native });
      if (method === 'GET') return { status: 200, json: { providers: [], tregMaxCostUsd: over.cap ?? 0.01 } };
      if (route.endsWith('/check')) return { status: 200, json: over.check ?? { ok: true } };
      return { status: 200, json: { ok: true } };
    },
    async confirm(o) { dialogs.push(o); return over.confirm !== false; },
  };
  return { d, calls, dialogs };
}

test('M5 window: the cap change is parsed strictly', () => {
  assert.deepEqual(parseWebSearchChange({ kind: 'cap', usd: 0.05 }), { kind: 'cap', usd: 0.05 });
  for (const bad of [{ kind: 'cap' }, { kind: 'cap', usd: '0.05' }, { kind: 'cap', usd: Number.NaN }, { kind: 'cap', usd: Infinity }, { kind: 'cap', usd: 0.05, extra: 1 }]) assert.equal(parseWebSearchChange(bad), undefined, JSON.stringify(bad));
});

test('M5 window: a raise shows a dialog with both amounts, then PATCHes with the native secret; Cancel writes nothing', async () => {
  const a = deps({ check: { ok: true, needsNative: true }, cap: 0.01 });
  const r = await webSearchChange({ kind: 'cap', usd: 0.25 }, a.d);
  assert.equal(r.ok, true);
  assert.equal(a.dialogs.length, 1);
  assert.match(a.dialogs[0]!.detail, /0\.01/); assert.match(a.dialogs[0]!.detail, /0\.25/);
  assert.equal(a.dialogs[0]!.title, 'Raise the per-call spending cap?', 'the title says the cap is per call, not a total');
  assert.doesNotMatch(JSON.stringify(a.dialogs), /—|–/);
  const patch = a.calls.find((c) => c.method === 'PATCH')!;
  assert.equal(patch.native, true); assert.deepEqual(patch.body, { tregMaxCostUsd: 0.25 });
  const b = deps({ check: { ok: true, needsNative: true }, confirm: false });
  const cancelled = await webSearchChange({ kind: 'cap', usd: 0.25 }, b.d);
  assert.deepEqual([cancelled.ok, cancelled.cancelled], [false, true]);
  assert.equal(b.calls.some((c) => c.method === 'PATCH'), false);
});

test('M5 window: a lowering needs no dialog and goes without the native secret', async () => {
  const a = deps({ check: { ok: true }, cap: 0.25 });
  const r = await webSearchChange({ kind: 'cap', usd: 0.05 }, a.d);
  assert.equal(r.ok, true); assert.equal(a.dialogs.length, 0);
  const patch = a.calls.find((c) => c.method === 'PATCH')!;
  assert.equal(patch.native, false); assert.deepEqual(patch.body, { tregMaxCostUsd: 0.05 });
});
