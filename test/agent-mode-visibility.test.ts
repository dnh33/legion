/**
 * Who a project limits, said in a live line; what the run chip and its hover say (own mode, project preset, result, one source); the words for
 * Smart with file edits; the "Comes with Legion" mark; the one-time notice. Pure logic against the REAL seeded roster.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { MODE_LABEL, runsAsChip } from '../ui/src/gates/presetsLogic.js';
import type { GatesView } from '../ui/src/gates/presetsLogic.js';
import { PROJECT_NOTICE, legacyModeChip, limitWords, runChips, seedWords } from '../ui/src/gates/agentFollowLogic.js';
import type { AgentProfile } from '../src/shared/types.js';
import type { Project } from '../src/shared/projects.js';

const P = 'proj_0000000000aa';
const view = (o: Partial<GatesView> = {}): GatesView => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...o });
const seeds = (): AgentProfile[] => { const d = cleanupTemp('legion-vis-'); const s = new Store(join(d, 'data')); s.seedDefaults(join(d, 'ws')); return s.listAgents(); };
const project = (members: string[], name = 'Shop'): Project => ({ id: P, name, instructions: '', folder: 'D:/p/' + name, members, status: 'active', createdAt: '', updatedAt: '' });
const withPreset = (preset: 'ask' | 'smart' | 'accept-edits' | 'bypass', limit?: boolean): GatesView => view({ projects: { [P]: { version: 1, preset, ...(limit === undefined ? {} : { limit }) } } });

// ---------------------------------------------------------------- the limit line

test('limit on, preset Ask: names who it limits, loosest first, and how many already ask', () => {
  const all = seeds();
  const w = limitWords(all, project(all.map((a) => a.id)), withPreset('ask'));
  assert.equal(w.on, `This limits 3 agents here: Builder (Full), Marshal (Accept edits) and Scribe (Accept edits) run as Ask in Shop. ${all.length - 3} agents already ask.`);
});

test('limit on, the sentence of the design: Builder and Marshal limited, the rest already ask', () => {
  const all = seeds().filter((a) => a.name !== 'Scribe');
  const w = limitWords(all, project(all.map((a) => a.id)), withPreset('ask'));
  assert.equal(w.on, `This limits 2 agents here: Builder (Full) and Marshal (Accept edits) run as Ask in Shop. ${all.length - 2} agents already ask.`);
  assert.equal(w.off, 'With the limit off, Builder runs as Full and Marshal runs as Accept edits in Shop. Builder never asks.');
});

test('limit off, one agent: the sentence of the design', () => {
  const all = seeds().filter((a) => ['builder', 'scout'].includes(a.id));
  const w = limitWords(all, project(all.map((a) => a.id)), withPreset('ask', false));
  assert.equal(w.off, 'With the limit off, Builder runs as Full in Shop and never asks.');
  assert.equal(w.on, 'This limits 1 agent here: Builder (Full) runs as Ask in Shop. 1 agent already asks.');
});

test('followers are named apart, and a project without a preset says nothing', () => {
  const all = seeds().filter((a) => ['builder', 'scout', 'inquisitor'].includes(a.id)).map((a) => (a.id === 'inquisitor' ? { ...a, approvalSource: 'project' as const } : a));
  const w = limitWords(all, project(all.map((a) => a.id)), withPreset('ask'));
  assert.equal(w.on, 'This limits 1 agent here: Builder (Full) runs as Ask in Shop. 1 agent already asks. 1 agent follows the preset.');
  assert.deepEqual(limitWords(all, project(all.map((a) => a.id)), view()), {}, 'Per agent: no preset, no line');
  assert.equal(limitWords([], project([]), withPreset('ask')).on, 'This project has no agents yet.');
});

test('a looser preset limits only the agents above it; Smart makes Accept edits agents run Smart with file edits', () => {
  const all = seeds().filter((a) => ['builder', 'zealot', 'scout'].includes(a.id));
  const smart = limitWords(all, project(all.map((a) => a.id)), withPreset('smart'));
  assert.equal(smart.on, 'This limits 2 agents here: in Shop, Builder (Full) runs as Smart; Marshal (Accept edits) runs as Smart, and file edits run. 1 agent is not limited by it.');
  const bypass = limitWords(all, project(all.map((a) => a.id)), withPreset('bypass'));
  assert.equal(bypass.on, 'This limits no agent here. 3 agents are not limited by it.');
  assert.equal(bypass.off, undefined, 'nothing runs looser than the preset');
});

test('many names are shortened, never hidden in a count with no names at all', () => {
  const base = seeds().find((a) => a.id === 'builder')!;
  const many = Array.from({ length: 7 }, (_, i) => ({ ...base, id: `b${i}`, name: `Bot${i}` }));
  const w = limitWords(many, project(many.map((a) => a.id)), withPreset('ask'));
  assert.match(w.on ?? '', /^This limits 7 agents here: Bot0 \(Full\), Bot1 \(Full\), Bot2 \(Full\), Bot3 \(Full\) and 3 more run as Ask in Shop\./);
});

// ---------------------------------------------------------------- one source for the chip and the hover

test('a follower in a project with no preset says app default, never project', () => {
  assert.deepEqual(runsAsChip({ effective: 'smart', agentMode: 'ask', source: 'project', projectName: 'Shop', limit: false }), { text: 'Runs as Smart', reason: 'Following the app default' });
  assert.deepEqual(runsAsChip({ effective: 'full', agentMode: 'ask', source: 'project', projectName: 'Shop', projectPreset: 'bypass', limit: true }), { text: 'Runs as Bypass', reason: 'Following project Shop (Bypass)' });
});

test('smart-edits has plain words', () => {
  assert.equal(MODE_LABEL['smart-edits'], 'Smart, and file edits run');
  assert.deepEqual(runsAsChip({ effective: 'smart-edits', agentMode: 'auto-edits', source: 'own', projectName: 'Shop', projectPreset: 'smart', limit: true }), { text: 'Runs as Smart, and file edits run', reason: 'Agent is Accept edits, limited by project Shop' });
});

test('the run chip hover explains the agent\'s own mode, the project preset and the result', () => {
  const v = withPreset('ask', true);
  const names = [{ id: 'builder', name: 'Builder' }];
  const c = runChips({ runsAs: { mode: 'ask', projectId: P } }, { approval: 'full', approvalSource: 'own', name: 'Builder' }, [project(['builder'])], v);
  assert.equal(c.runsAs?.title, 'Builder\'s own setting is Full. Project Shop is set to Ask and limits agents to it. Result: this run asks before every command and file change.');
  void names;
  const follower = runChips({ runsAs: { mode: 'smart' } }, { approval: 'ask', approvalSource: 'project', name: 'Scout' }, [], view({ app: { version: 1, preset: 'smart' } }));
  assert.equal(follower.runsAs?.title, 'Scout follows the app default, which is Smart. Its own setting (Ask) is kept for when it stops following. Result: this run asks only before risky actions.');
  const off = runChips({ runsAs: { mode: 'full', projectId: P } }, { approval: 'full', approvalSource: 'own', name: 'Builder' }, [project(['builder'])], withPreset('ask', false));
  assert.equal(off.runsAs?.title, 'Builder\'s own setting is Full. Project Shop is set to Ask and does not limit agents. Result: this run never asks.');
  const outside = runChips({ runsAs: { mode: 'ask' }, origin: { roomId: 'r', fromAgentId: 'x', hop: 0, approvalCeiling: 'ask' } }, { approval: 'full', approvalSource: 'own', name: 'Builder' }, [], view());
  assert.match(outside.runsAs?.title ?? '', /An outside app started this run, so it asks\./);
  assert.doesNotMatch(JSON.stringify([c, follower, off, outside]), /\u2014/);
});

test('a run from before the chip existed shows the agent\'s setting in the same words', () => {
  assert.equal(legacyModeChip({ approval: 'full' }), 'Full');
  assert.equal(legacyModeChip({ approval: 'auto-edits' }), 'Accept edits');
  assert.equal(legacyModeChip({ approval: 'ask' }), 'Ask');
  assert.equal(legacyModeChip({ approval: 'full', approvalSource: 'project' }), 'Follows the project or app default');
});

// ---------------------------------------------------------------- Comes with Legion, the notice

test('Comes with Legion: only a marked agent, in plain words; absent means nothing at all', () => {
  assert.equal(seedWords({ seedApproval: true }), 'Comes with Legion. You have not changed this agent\'s setting.');
  assert.equal(seedWords({}), '');
  assert.equal(seedWords(undefined), '');
});

test('the one-time notice says nothing changed and points to Settings, Gates', () => {
  assert.match(PROJECT_NOTICE.text, /nothing changed/i);
  assert.match(PROJECT_NOTICE.text, /Settings, Gates/);
  assert.doesNotMatch(PROJECT_NOTICE.text + PROJECT_NOTICE.dismiss, /\u2014|this computer/i);
});
