/**
 * The first-run screen "How should agents ask by default?": when it shows (fresh installs only), the live list built from the real roster,
 * what ticking "Also make my agents follow this" does and who it makes looser, and what Continue sends and says. Pure logic, no window.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { PRESET_STRINGS, continueFrom, followPlan, isFreshInstall, listWords, ownSettingLines, savedWords, shouldShowPresetChoice } from '../ui/src/welcome/presetChoiceLogic.js';
import type { Batch, BatchResult } from '../ui/src/welcome/presetChoiceLogic.js';
import type { GatesView } from '../ui/src/gates/presetsLogic.js';
import type { AgentProfile } from '../src/shared/types.js';

const view = (o: Partial<GatesView> = {}): GatesView => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...o });
function seeds(): AgentProfile[] {
  const dir = cleanupTemp('legion-firstrun-');
  const s = new Store(join(dir, 'data'));
  s.seedDefaults(join(dir, 'ws'));
  return s.listAgents();
}
const byName = (l: AgentProfile[], n: string): AgentProfile => l.find((a) => a.name === n)!;

test('fresh install: only seeded agents nobody changed. Empty, custom, edited or marked-absent all read as not fresh', () => {
  const all = seeds();
  assert.equal(isFreshInstall(all), true);
  assert.equal(isFreshInstall([]), false, 'the list has not arrived yet');
  assert.equal(isFreshInstall([...all, { ...all[0]!, id: 'mine', seedApproval: undefined } as AgentProfile]), false, 'a custom agent');
  assert.equal(isFreshInstall(all.map(({ seedApproval: _x, ...a }) => a as AgentProfile)), false, 'an install from before the mark');
  assert.equal(isFreshInstall(all.map((a) => (a.id === 'scout' ? ({ ...a, seedApproval: undefined } as AgentProfile) : a))), false, 'one agent was changed');
});

test('the screen shows for a fresh install only: not before sign-in, not after an answer, not with a preset, not on an upgrade', () => {
  const all = seeds();
  assert.equal(shouldShowPresetChoice(view(), true, all), true);
  assert.equal(shouldShowPresetChoice(view(), false, all), false, 'the sign-in step comes first');
  assert.equal(shouldShowPresetChoice(view({ app: { version: 1, firstRunChoice: true } }), true, all), false, 'answered once');
  assert.equal(shouldShowPresetChoice(view({ app: { version: 1, preset: 'smart' } }), true, all), false, 'the app already has a preset');
  assert.equal(shouldShowPresetChoice(view({ projects: { proj_000000000001: { version: 1, preset: 'ask' } } }), true, all), false, 'a project has a preset');
  assert.equal(shouldShowPresetChoice(view({ projects: { proj_000000000001: { version: 1 } } }), true, all), true, 'a project with no preset changes nothing');
  const upgraded = all.map(({ seedApproval: _x, ...a }) => a as AgentProfile);
  assert.equal(shouldShowPresetChoice(view(), true, upgraded), false, 'an install from 0.3.4 never sees it');
  assert.equal(shouldShowPresetChoice(view(), true, []), false, 'agents not loaded yet');
});

test('the live list is built from the real roster, in plain words, most open first', () => {
  const all = seeds();
  const lines = ownSettingLines(all);
  const asking = all.filter((a) => a.approval === 'ask').length;
  assert.equal(lines[0], 'Builder never asks (Full)');
  assert.equal(lines[1], 'Marshal and Scribe accept edits by themselves');
  assert.equal(lines[2], `Scout and ${asking - 1} others ask first`);
  assert.equal(lines.length, 3);
  // it follows the roster, never a fixed text
  assert.deepEqual(ownSettingLines([byName(all, 'Scout')]), ['Scout asks first']);
  assert.deepEqual(ownSettingLines(all.filter((a) => ['Scout', 'Herald', 'Archivist'].includes(a.name))), ['Scout, Archivist and Herald ask first']);
  assert.equal(ownSettingLines([{ ...byName(all, 'Builder'), approvalSource: 'project' }])[0], 'Builder follows the app default');
});

test('ticking: who asks less is named with the core rule (Smart and Accept edits are not ordered)', () => {
  const all = seeds();
  const smart = followPlan(all, 'smart');
  assert.deepEqual(smart.tighter, ['Builder'], 'Full to Smart is stricter');
  assert.ok(smart.looser.includes('Marshal') && smart.looser.includes('Scribe'), 'Accept edits to Smart is a raise, as the core counts it');
  assert.equal(smart.looser.length, all.length - 1);
  assert.equal(smart.changes.length, all.length);
  assert.ok(smart.changes.every((c) => c.approvalSource === 'project'));
  const ask = followPlan(all, 'ask');
  assert.deepEqual(ask.looser, []);
  assert.deepEqual(ask.tighter.sort(), ['Builder', 'Marshal', 'Scribe']);
  const edits = followPlan(all, 'accept-edits');
  assert.ok(!edits.looser.includes('Marshal') && !edits.looser.includes('Scribe'), 'same mode: no change in how they ask');
  assert.ok(edits.looser.includes('Scout'));
  const bypass = followPlan(all, 'bypass');
  assert.deepEqual(bypass.tighter, []);
  assert.equal(bypass.looser.length, all.length - 1, 'everyone but Builder');
  // agents that already follow are left out
  assert.equal(followPlan(all.map((a) => ({ ...a, approvalSource: 'project' as const })), 'smart').changes.length, 0);
});

test('the words under the presets: unticked keeps own settings, ticked says all N follow', () => {
  const all = seeds();
  const un = listWords(all, 'ask', false);
  assert.equal(un.head, 'Your agents keep their own settings:');
  assert.equal(un.lines.length, 3);
  assert.equal(un.warn, undefined, 'Ask needs no confirm');
  assert.equal(listWords(all, 'smart', false).warn, PRESET_STRINGS.confirmNote, 'a looser default asks for a confirm, said before Continue');
  const t = listWords(all, 'smart', true);
  assert.equal(t.head, `All ${all.length} agents will follow Smart.`);
  assert.deepEqual(t.lines, []);
  assert.match(t.warn ?? '', /^This makes Marshal, Scout, Inquisitor and \d+ others ask less than now\. Continue asks you to confirm in a separate window\.$/);
  assert.equal(t.info, 'Builder will ask more often than now.');
  const a = listWords(all, 'ask', true);
  assert.equal(a.head, `All ${all.length} agents will follow Ask.`);
  assert.equal(a.warn, undefined);
});

test('the screen strings: the owner\'s words, no em dash, "your computer"', () => {
  assert.equal(PRESET_STRINGS.title, 'How should agents ask by default?');
  assert.equal(PRESET_STRINGS.lead, 'This is the app default. It is only for agents that follow it. Your agents keep their own settings unless you tick the box below.');
  assert.equal(PRESET_STRINGS.followLabel, 'Also make my agents follow this');
  assert.equal(PRESET_STRINGS.followNote, 'Each agent can still be set back to its own setting in the agent editor.');
  assert.equal(PRESET_STRINGS.continue, 'Continue');
  assert.equal(PRESET_STRINGS.later, 'Decide later');
  const all = seeds();
  const words = [...Object.values(PRESET_STRINGS), ...ownSettingLines(all), ...(['ask', 'accept-edits', 'smart', 'bypass'] as const).flatMap((p) => [true, false].flatMap((f) => { const w = listWords(all, p, f); return [w.head, ...w.lines, w.warn ?? '', w.info ?? '']; }))].join('\n');
  assert.doesNotMatch(words, /—/);
  assert.doesNotMatch(words, /this computer/i);
});

// ---------------------------------------------------------------- Continue

function rig(o: { presetOk?: boolean; batch?: BatchResult | 'none' } = {}) {
  const log: string[] = [];
  const sent: unknown[] = [];
  const run = async (c: unknown): Promise<boolean> => { log.push('preset'); sent.push(c); return o.presetOk ?? true; };
  const batch: Batch = o.batch === 'none' ? undefined : async (b) => { log.push('batch'); sent.push(b); return (o.batch as BatchResult | undefined) ?? { ok: true, applied: b.changes.map((c) => c.agentId) }; };
  return { log, sent, run, batch };
}

test('Continue, box unticked: the default is saved and no agent is touched', async () => {
  const all = seeds(); const r = rig();
  const out = await continueFrom('smart', false, all, r.run, r.batch);
  assert.deepEqual(r.log, ['preset']);
  assert.equal(out.done, true);
  assert.equal(out.saved?.text, 'Saved. The app default is Smart. Your agents keep their own settings.');
});

test('Continue, box ticked: the default first, then ONE batch of follow changes for every agent; the line says only what changed', async () => {
  const all = seeds(); const r = rig();
  const out = await continueFrom('smart', true, all, r.run, r.batch);
  assert.deepEqual(r.log, ['preset', 'batch']);
  const b = r.sent[1] as { changes: Array<{ agentId: string; approvalSource: string }> };
  assert.equal(b.changes.length, all.length);
  assert.deepEqual(b.changes[0], { agentId: all[0]!.id, approvalSource: 'project' });
  assert.equal(out.saved?.text, `Saved. The app default is Smart. All ${all.length} agents follow it.`);
  assert.equal(out.saved?.tone, 'ok');
});

test('Continue: a cancelled or refused default stops before any agent is touched and keeps Ask selected', async () => {
  const all = seeds(); const r = rig({ presetOk: false });
  const out = await continueFrom('bypass', true, all, r.run, r.batch);
  assert.deepEqual(r.log, ['preset']);
  assert.deepEqual([out.done, out.selected, out.saved], [false, 'ask', undefined]);
});

test('Continue: a cancelled agent question leaves the saved default and says no agent changed', async () => {
  const all = seeds(); const r = rig({ batch: { ok: false, cancelled: true, applied: [] } });
  const out = await continueFrom('smart', true, all, r.run, r.batch);
  assert.equal(out.done, true);
  assert.equal(out.saved?.tone, 'info');
  assert.match(out.saved!.text, /^Saved\. The app default is Smart\. No agent was changed, because you cancelled that question\./);
});

test('Continue: a partial result and a total failure each say what happened', async () => {
  const all = seeds();
  const part = await continueFrom('smart', true, all, rig().run, async () => ({ ok: false, applied: ['zealot', 'builder'], failed: [{ agentId: 'scout', error: 'The agent changed while the question was open, so it was left as it was.' }, { agentId: 'x', error: 'e' }] }));
  assert.equal(part.saved?.tone, 'error');
  assert.match(part.saved!.text, /2 of \d+ agents follow it now\. 2 did not change: The agent changed while/);
  const none = await continueFrom('smart', true, all, rig().run, async () => ({ ok: false, error: 'Legion could not reach its own core. Restart Legion.', applied: [] }));
  assert.match(none.saved!.text, /No agent was changed: Legion could not reach its own core/);
  const thrown = await continueFrom('smart', true, all, rig().run, async () => { throw new Error('boom'); });
  assert.match(thrown.saved!.text, /No agent was changed: boom/);
  const noBridge = await continueFrom('smart', true, all, rig().run, undefined);
  assert.equal(noBridge.saved?.tone, 'error');
  assert.match(noBridge.saved!.text, /needs the Legion app window/);
});

test('Continue, everyone already follows: nothing to send', async () => {
  const all = seeds().map((a) => ({ ...a, approvalSource: 'project' as const })); const r = rig();
  const out = await continueFrom('ask', true, all, r.run, r.batch);
  assert.deepEqual(r.log, ['preset']);
  assert.equal(out.saved?.text, `Saved. The app default is Ask. All ${all.length} agents already follow it.`);
  assert.equal(savedWords('ask', false, 1, 'unchanged').tone, 'ok');
});
