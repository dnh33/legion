/**
 * The first-run screen with the box ticked: ONE native confirm for the app default AND every agent made looser. Cancel saves nothing. On Confirm the
 * default is saved first, then every agent is previewed again against the saved default and must read exactly as shown, then each change goes out
 * as an ordinary guarded PATCH. These tests run the real core and the real IPC code with a fake dialog.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { agentModeBatch, parseAgentModeBatch } from '../src/electron/agent-mode-ipc.js';
import { DENY_LINE, NO_SANDBOX_LINE } from '../src/shared/gates-registry.js';
import { IDS, withBoot } from './agent-mode-rig.js';

const NL = String.fromCharCode(10);
const follow = (ids: string[] = IDS) => ids.map((agentId) => ({ agentId, approvalSource: 'project' as const }));
const ALL_FOLLOW = IDS.map(() => 'ask/project');

test('core: assumeAppPreset is a read-only what-if: the looser default shows in the answer, nothing is saved, a bad value is a 400', withBoot([], async (r) => {
  const real = await r.http('POST', '/api/agents/mode-preview', { agentId: 'alpha', approvalSource: 'project' });
  assert.equal(real.json.raises, false, 'with the default at Ask, following cannot loosen');
  const smart = await r.http('POST', '/api/agents/mode-preview', { agentId: 'alpha', approvalSource: 'project', assumeAppPreset: 'smart' });
  assert.equal(smart.status, 200);
  assert.equal(smart.json.raises, true, 'if the default were Smart it would');
  assert.notEqual(smart.json.digest, real.json.digest, 'the digest carries the assumed default');
  assert.equal(r.core.store.app().preset, undefined, 'nothing was saved');
  for (const bad of ['root', 5, null]) assert.equal((await r.http('POST', '/api/agents/mode-preview', { agentId: 'alpha', approvalSource: 'project', assumeAppPreset: bad })).status, 400, String(bad));
  // the digest of a what-if answer fits the real save once that default stands
  r.core.store.patchApp({ preset: 'smart' });
  const now = await r.http('POST', '/api/agents/mode-preview', { agentId: 'alpha', approvalSource: 'project' });
  assert.equal(now.json.digest, smart.json.digest);
}));

test('parse: the preset is optional and must be one of the four', () => {
  assert.equal(parseAgentModeBatch({ changes: follow(['a']), preset: 'smart' })?.length, 1);
  for (const bad of [{ changes: follow(['a']), preset: 'root' }, { changes: follow(['a']), preset: null }, { changes: follow(['a']), preset: 'smart', extra: 1 }]) assert.equal(parseAgentModeBatch(bad), undefined);
});

test('one dialog holds the default and every agent made looser; Confirm saves the default first, then each agent with its own digest', withBoot([true], async (r) => {
  const res = await agentModeBatch({ preset: 'smart', changes: follow() }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.presetSaved, true);
  assert.deepEqual(res.applied, IDS);
  assert.equal(r.dialogs.length, 1, 'ONE dialog for the whole answer');
  const d = r.dialogs[0]!;
  assert.match(d.detail, /Legion decides when to ask/, 'the default is in it');
  for (const n of ['Alpha', 'Bravo', 'Charlie', 'Delta']) assert.ok(d.detail.includes(n), `${n} is named`);
  assert.equal(d.detail.split(DENY_LINE).length - 1, 1, 'the closing lines once');
  assert.equal(d.detail.split(NO_SANDBOX_LINE).length - 1, 1);
  assert.doesNotMatch(JSON.stringify(d), /—/);
  const w = r.writes();
  assert.equal(w[0]!.route, '/api/gates/app', 'the default is saved first');
  assert.equal(w[0]!.native, true);
  assert.deepEqual(w.slice(1).map((x) => x.route), IDS.map((i) => `/api/agents/${i}`));
  assert.ok(w.slice(1).every((x) => x.native && /^[0-9a-f]{64}$/.test(x.digest ?? '')));
  assert.equal(r.core.store.app().preset, 'smart');
  assert.equal(r.core.store.app().firstRunChoice, true);
  assert.deepEqual(r.modes(), ALL_FOLLOW);
}));

test('Cancel saves nothing at all: no default, no first-run answer, no agent, no request that writes', withBoot([false], async (r) => {
  const res = await agentModeBatch({ preset: 'smart', changes: follow() }, r.deps);
  assert.deepEqual([res.ok, res.cancelled, res.presetSaved, res.applied], [false, true, false, []]);
  assert.equal(r.writes().length, 0);
  assert.equal(r.core.store.app().preset, undefined);
  assert.equal(r.core.store.app().firstRunChoice, undefined, 'the screen comes back next time');
  assert.deepEqual(r.modes(), IDS.map(() => 'ask/own'));
}));

test('the dialog also says who will ask more often, so the owner confirms everything that is applied', withBoot([true], async (r) => {
  const res = await agentModeBatch({ preset: 'smart', changes: follow() }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.match(r.dialogs[0]!.detail, /Alpha will ask the same or more often/);
  assert.doesNotMatch(r.dialogs[0]!.detail.split('\n\n').filter((l) => /will ask only before/.test(l)).join(), /Alpha/, 'Alpha is not in the ask-less line');
}, { alpha: 'full' }));

test('a default that is only stricter, with agents that only get stricter, needs no dialog and sends no native secret', withBoot([true], async (r) => {
  const res = await agentModeBatch({ preset: 'ask', changes: follow() }, r.deps);
  assert.equal(res.ok, true, res.error);
  assert.equal(r.dialogs.length, 0);
  assert.ok(r.writes().every((x) => !x.native));
  assert.equal(r.core.store.app().preset, 'ask');
  assert.equal(r.core.store.app().firstRunChoice, true);
}, { alpha: 'full' }));

test('a default changed by someone else while the dialog is open: the save is refused, nothing is saved, no agent is touched', withBoot([], async (r) => {
  r.deps.confirm = async (d) => { r.dialogs.push(d); r.core.store.patchApp({ preset: 'accept-edits' }); return true; };
  const res = await agentModeBatch({ preset: 'smart', changes: follow() }, r.deps);
  assert.equal(res.ok, false);
  assert.equal(res.presetSaved, false);
  assert.deepEqual(res.applied, []);
  assert.match(res.error ?? '', /changed while/);
  assert.equal(r.core.store.app().preset, 'accept-edits', 'only the other change stands');
  assert.deepEqual(r.writes().map((w) => w.route), ['/api/gates/app'], 'no agent request was sent');
  assert.deepEqual(r.modes(), IDS.map(() => 'ask/own'));
}));

test('an agent that reads differently once the default is saved stops the agents: the default stays saved, no agent changes, and the words say so', withBoot([], async (r) => {
  // while the dialog is open Bravo becomes Full on its own: following Smart is then stricter, not looser, so it no longer reads as shown
  r.deps.confirm = async (d) => { r.dialogs.push(d); r.f.ctx.store.upsertAgent({ ...r.f.ctx.store.getAgent('bravo')!, approval: 'full' }); return true; };
  const res = await agentModeBatch({ preset: 'smart', changes: follow() }, r.deps);
  assert.equal(res.ok, false);
  assert.equal(res.presetSaved, true);
  assert.deepEqual(res.applied, []);
  assert.match(res.error ?? '', /no agent was changed/i);
  assert.equal(r.core.store.app().preset, 'smart');
  assert.deepEqual(r.writes().map((w) => w.route), ['/api/gates/app'], 'no agent request was sent');
  assert.deepEqual(r.modes(), ['ask/own', 'full/own', 'ask/own', 'ask/own']);
}));

test('one agent that goes stale after the default is saved is reported; the others still apply', withBoot([], async (r) => {
  const real = r.deps.call;
  let patched = 0;
  r.deps.call = async (m, route, body, nat, extra) => {
    // Charlie changes between the check and its own save
    if (m === 'PATCH' && route === '/api/agents/alpha' && ++patched === 1) r.f.ctx.store.upsertAgent({ ...r.f.ctx.store.getAgent('charlie')!, description: 'x', approval: 'auto-edits' });
    return real(m, route, body, nat, extra);
  };
  r.deps.confirm = async (d) => { r.dialogs.push(d); return true; };
  const res = await agentModeBatch({ preset: 'smart', changes: follow() }, r.deps);
  assert.equal(res.ok, false);
  assert.equal(res.presetSaved, true);
  assert.deepEqual(res.failed?.map((x) => x.agentId), ['charlie']);
  assert.deepEqual(res.applied, ['alpha', 'bravo', 'delta']);
}));

test('two agents with the same display name are both named, told apart by their id', withBoot([true], async (r) => {
  r.f.ctx.store.upsertAgent({ ...r.f.ctx.store.getAgent('bravo')!, name: 'Alpha' });
  const res = await agentModeBatch({ preset: 'smart', changes: follow() }, r.deps);
  assert.equal(res.ok, true, res.error);
  const d = r.dialogs[0]!.detail;
  assert.match(d, /Alpha \(alpha\)/);
  assert.match(d, /Alpha \(bravo\)/);
}));

test('a name over 60 characters does not leave its name inside the sentence', withBoot([true], async (r) => {
  const long = 'N'.repeat(70);
  r.f.ctx.store.upsertAgent({ ...r.f.ctx.store.getAgent('bravo')!, name: long });
  const res = await agentModeBatch({ preset: 'smart', changes: follow(['bravo']) }, r.deps);
  assert.equal(res.ok, true, res.error);
  const line = r.dialogs[0]!.detail.split(NL + NL).find((l) => /will follow the way agents ask/.test(l))!;
  assert.ok(line.indexOf(' will ') < 80, 'the name is in front once, shortened: ' + line.slice(0, 120));
  assert.doesNotMatch(r.dialogs[0]!.detail, /N{70}/);
}));

// ---------------------------------------------------------------- the window's entry point

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO = fileURLToPath(new URL('../../', import.meta.url));

test('main registers the batch channel with the same sender and frame checks as its siblings, and the preload exposes only that channel', () => {
  const main = readFileSync(join(REPO, 'src', 'electron', 'main.ts'), 'utf8').replace(/\r\n/g, '\n');
  const block = (name: string): string => { const i = main.indexOf(`ipcMain.handle('${name}'`); return i < 0 ? '' : main.slice(i, main.indexOf(String.fromCharCode(10) + '  });', i)); };
  const mine = block('legion:agent-mode-batch');
  const sibling = block('legion:agent-mode-change');
  assert.ok(mine && sibling);
  for (const must of ['senderFrame', 'win.webContents', 'trustedSender(frameUrl, uiUrl)', 'ownCoreCall', 'makeConfirm(dialog']) assert.ok(mine.includes(must), `the batch handler has ${must}`);
  assert.match(mine, /agentModeBatch\(raw,/);
  assert.match(mine, /Refused: not the Legion window/);
  const preload = readFileSync(join(REPO, 'src', 'electron', 'preload.cjs'), 'utf8');
  assert.match(preload, /agentModeBatch\(batch\) \{\s*return ipcRenderer\.invoke\('legion:agent-mode-batch', batch\);/);
});
