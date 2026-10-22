/**
 * R63: the four Hermes switches follow Legion's loosening rule. A change that loosens (Stop disaster commands off, Ignore Hermes's skip-approval
 * settings off, Answer each request once off, Match Legion's mode on) needs the app's native confirmation and the native secret; a change that
 * tightens saves directly. The core refuses a loosening that arrives without the secret (a window script cannot skip the dialog).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { acpSwitchChange, parseAcpSwitchChange, resetAcpSwitchForTests } from '../src/electron/acp-switch-ipc.js';
import type { AcpSwitchIpcDeps } from '../src/electron/acp-switch-ipc.js';
import { LOOSEN_LINES, loosenedSwitches, SWITCH_ORDER } from '../src/shared/acp-copy.js';
import type { AcpSwitches } from '../src/shared/acp-view.js';
import { AUTH, makeFakes, start } from './helpers-c.js';

const NATIVE = 'native-secret';
const J = { 'Content-Type': 'application/json' };
const OFF: AcpSwitches = { disasterStop: false, modeMap: false, stripSkipFlags: false, answerOnce: false };
const NO_DASH = /[–—]/;

test('loosenedSwitches: only a real change that lets Hermes ask less counts, whichever way each switch reads', () => {
  assert.deepEqual(loosenedSwitches(OFF, { disasterStop: true, stripSkipFlags: true, answerOnce: true }), [], 'turning a safety switch ON tightens');
  assert.deepEqual(loosenedSwitches(OFF, { modeMap: true }), ['modeMap'], "Match Legion's mode ON loosens");
  const on: AcpSwitches = { disasterStop: true, modeMap: true, stripSkipFlags: true, answerOnce: true };
  assert.deepEqual(loosenedSwitches(on, { modeMap: false }), [], "Match Legion's mode OFF tightens");
  assert.deepEqual(loosenedSwitches(on, { disasterStop: false, stripSkipFlags: false, answerOnce: false }), ['disasterStop', 'stripSkipFlags', 'answerOnce']);
  assert.deepEqual(loosenedSwitches(on, { disasterStop: true }), [], 'no change is no loosening');
  assert.deepEqual(loosenedSwitches(OFF, { disasterStop: false }), [], 'off to off is no change');
});

test('every loosening has one plain line, no dash, no outside product', () => {
  for (const k of SWITCH_ORDER) {
    const l = LOOSEN_LINES[k];
    assert.ok(l && l.length > 20, k);
    assert.doesNotMatch(l, NO_DASH);
    assert.doesNotMatch(l, /this computer|Claude Code|Codex/i);
  }
});

test('parse: only the four boolean switches, at least one', () => {
  assert.deepEqual(parseAcpSwitchChange({ switches: { modeMap: true } }), { switches: { modeMap: true } });
  assert.equal(parseAcpSwitchChange({ switches: {} }), undefined);
  assert.equal(parseAcpSwitchChange({ switches: { modeMap: 'yes' } }), undefined);
  assert.equal(parseAcpSwitchChange({ switches: { other: true } }), undefined);
  assert.equal(parseAcpSwitchChange({ switches: { modeMap: true }, extra: 1 }), undefined);
  assert.equal(parseAcpSwitchChange('x'), undefined);
});

async function boot(answers: boolean[], start0?: Partial<AcpSwitches>) {
  resetAcpSwitchForTests();
  const f = makeFakes();
  (f.ctx as { nativeSecret?: string }).nativeSecret = NATIVE;
  const s = await start(f.ctx);
  const calls: Array<{ method: string; route: string; native: boolean; body?: unknown }> = [];
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const real = async (method: string, route: string, body?: unknown, native?: boolean) => {
    calls.push({ method, route, native: native === true, ...(body !== undefined ? { body } : {}) });
    const r = await fetch(s.base + route, { method, headers: { ...AUTH, ...J, ...(native ? { 'X-Legion-Native': NATIVE } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  if (start0) await real('PATCH', '/api/settings', { acp: { switches: start0 } });
  calls.length = 0;
  const deps: AcpSwitchIpcDeps = { call: real as AcpSwitchIpcDeps['call'], async confirm(d) { dialogs.push(d); return answers.shift() ?? false; } };
  const read = async () => ((await real('GET', '/api/settings')).json as { acp: { switches: AcpSwitches } }).acp.switches;
  return { deps, calls, dialogs, read, base: s.base, close: s.close };
}

test('a loosening shows one native dialog that says what it allows, and saves with the native secret only after Confirm', async () => {
  const r = await boot([true], { disasterStop: true, answerOnce: true });
  try {
    const res = await acpSwitchChange({ switches: { disasterStop: false, answerOnce: false } }, r.deps);
    assert.equal(res.ok, true);
    assert.equal(r.dialogs.length, 1);
    assert.ok(r.dialogs[0]!.detail.includes(LOOSEN_LINES.disasterStop) && r.dialogs[0]!.detail.includes(LOOSEN_LINES.answerOnce), 'one plain line per loosened switch');
    assert.doesNotMatch(JSON.stringify(r.dialogs[0]), NO_DASH);
    const write = r.calls.find((c) => c.method === 'PATCH')!;
    assert.equal(write.native, true, 'the secret goes with a loosening');
    const sw = await r.read();
    assert.equal(sw.disasterStop, false);
    assert.equal(sw.answerOnce, false);
  } finally { await r.close(); }
});

test('Cancel leaves the switches as they were and sends nothing', async () => {
  const r = await boot([false], { stripSkipFlags: true });
  try {
    const res = await acpSwitchChange({ switches: { stripSkipFlags: false } }, r.deps);
    assert.equal(res.ok, false);
    assert.equal(res.cancelled, true);
    assert.equal(r.calls.filter((c) => c.method === 'PATCH').length, 0);
    assert.equal((await r.read()).stripSkipFlags, true);
  } finally { await r.close(); }
});

test('a tightening saves directly: no dialog, no native secret', async () => {
  const r = await boot([]);
  try {
    const res = await acpSwitchChange({ switches: { disasterStop: true, answerOnce: true } }, r.deps);
    assert.equal(res.ok, true);
    assert.equal(r.dialogs.length, 0);
    const write = r.calls.find((c) => c.method === 'PATCH')!;
    assert.equal(write.native, false);
    const sw = await r.read();
    assert.equal(sw.disasterStop, true);
    assert.equal(sw.answerOnce, true);
  } finally { await r.close(); }
});

test("Match Legion's mode on is a loosening and asks; off again saves directly", async () => {
  const r = await boot([true]);
  try {
    assert.equal((await acpSwitchChange({ switches: { modeMap: true } }, r.deps)).ok, true);
    assert.equal(r.dialogs.length, 1);
    assert.equal((await acpSwitchChange({ switches: { modeMap: false } }, r.deps)).ok, true);
    assert.equal(r.dialogs.length, 1, 'no second dialog');
    assert.equal((await r.read()).modeMap, false);
  } finally { await r.close(); }
});

test('the core refuses a loosening that arrives without the native secret, and takes a tightening or the same value without it', async () => {
  const r = await boot([], { answerOnce: true });
  try {
    const plain = (body: unknown) => fetch(r.base + '/api/settings', { method: 'PATCH', headers: { ...AUTH, ...J }, body: JSON.stringify(body) });
    const refused = await plain({ acp: { switches: { answerOnce: false } } });
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as { error: string }).error, /native/);
    assert.equal((await r.read()).answerOnce, true, 'nothing changed');
    assert.equal((await plain({ acp: { switches: { answerOnce: true, disasterStop: true } } })).status, 200, 'same value and a tightening');
    assert.equal((await plain({ acp: { watchdogMinutes: 12 } })).status, 200, 'other acp settings are not guarded');
    const ok = await fetch(r.base + '/api/settings', { method: 'PATCH', headers: { ...AUTH, ...J, 'X-Legion-Native': NATIVE }, body: JSON.stringify({ acp: { switches: { answerOnce: false } } }) });
    assert.equal(ok.status, 200);
    const wrong = await fetch(r.base + '/api/settings', { method: 'PATCH', headers: { ...AUTH, ...J, 'X-Legion-Native': 'nope' }, body: JSON.stringify({ acp: { switches: { modeMap: true } } }) });
    assert.equal(wrong.status, 403, 'a wrong secret');
  } finally { await r.close(); }
});

test('a core that was not started by the app (no native secret) refuses every loosening', async () => {
  resetAcpSwitchForTests();
  const f = makeFakes();
  const s = await start(f.ctx);
  try {
    const res = await fetch(s.base + '/api/settings', { method: 'PATCH', headers: { ...AUTH, ...J, 'X-Legion-Native': NATIVE }, body: JSON.stringify({ acp: { switches: { modeMap: true } } }) });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /native_unavailable/);
  } finally { await s.close(); }
});

test('the window reaches it through the bridge, main handles it only from the Legion window, and the Settings page uses it for the four switches', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const at = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), 'utf8');
  assert.match(at('src/electron/preload.cjs'), /acpSwitchChange\(change\)[\s\S]*legion:acp-switch-change/);
  assert.match(at('src/electron/main.ts'), /legion:acp-switch-change[\s\S]*trustedSender[\s\S]*acpSwitchChange\(raw/);
  assert.match(at('ui/src/api.ts'), /acpSwitchChange\?\(/);
  assert.match(at('ui/src/settings/AgentHostsSection.tsx'), /acpSwitchChange/);
});
