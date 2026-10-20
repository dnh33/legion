/**
 * The agent editor's save and the first-run screen's two buttons, without a window: the approval fields of a save go through the app bridge,
 * everything else saves as before; every outcome has words; Decide later is remembered; a cancelled Continue leaves Ask selected.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CANCELLED_NEW_TEXT, CANCELLED_TEXT, saveWithMode } from '../ui/src/gates/agentModeSave.js';
import type { AgentBody, ModeBridge, SaveDeps } from '../ui/src/gates/agentModeSave.js';
import { mayRaiseMode, runChips } from '../ui/src/gates/agentFollowLogic.js';
import { CANCELLED_NOTE, applyViaBridge, runAction } from '../ui/src/gates/gatesAction.js';
import { continueFrom, laterFrom, shouldShowPresetChoice } from '../ui/src/welcome/presetChoiceLogic.js';
import type { GatesView } from '../ui/src/gates/presetsLogic.js';
import { GatesStore } from '../src/core/gates-settings/store.js';
import { Store } from '../src/core/store.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';
import type { AgentProfile } from '../src/shared/types.js';

const agent = (id: string, over: Record<string, unknown> = {}): AgentProfile => ({ id, name: id, emoji: 'x', description: '', systemPrompt: '', model: 'auto', approval: 'ask', mcpServers: ['*'], vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, createdAt: '', updatedAt: '', ...over }) as AgentProfile;

const SEEDS = (() => { const d = cleanupTemp('legion-ui-seeds-'); const st = new Store(join(d, 'data')); st.seedDefaults(join(d, 'ws')); return st.listAgents(); })();

function rig(bridgeAnswer: Awaited<ReturnType<ModeBridge>> | null = { ok: true }) {
  const log: string[] = [];
  const seen: { patch?: AgentBody; create?: AgentBody; bridge?: Parameters<ModeBridge>[0] } = {};
  const bridge: ModeBridge | undefined = bridgeAnswer ? async (c) => { log.push('bridge'); seen.bridge = c; return bridgeAnswer; } : undefined;
  const deps: SaveDeps = {
    bridge,
    patch: async (id, b) => { log.push('patch'); seen.patch = b; return agent(id, { name: b.name }); },
    create: async (b) => { log.push('create'); seen.create = b; return agent('made', { name: b.name }); },
  };
  return { log, seen, deps };
}

test('a saved agent: the approval change goes through the bridge FIRST, and the rest saves without the approval fields', async () => {
  const r = rig();
  const res = await saveWithMode('a1', { name: 'A', description: 'd', approval: 'full', approvalSource: 'own' }, r.deps);
  assert.equal(res.state, 'saved');
  assert.deepEqual(r.log, ['bridge', 'patch']);
  assert.deepEqual(r.seen.bridge, { agentId: 'a1', approval: 'full', approvalSource: 'own' });
  assert.deepEqual(r.seen.patch, { name: 'A', description: 'd' });
});

test('a cancel changes nothing at all: no save, and the words say so', async () => {
  const r = rig({ ok: false, cancelled: true });
  const res = await saveWithMode('a1', { name: 'A', approval: 'full', approvalSource: 'own' }, r.deps);
  assert.deepEqual(res, { state: 'cancelled', text: 'Cancelled. Nothing changed.' });
  assert.equal(CANCELLED_TEXT, 'Cancelled. Nothing changed.');
  assert.deepEqual(r.log, ['bridge']);
});

test('a refusal shows its reason and saves nothing', async () => {
  const r = rig({ ok: false, error: 'The settings changed while this was being checked. Try again.' });
  const res = await saveWithMode('a1', { name: 'A', approval: 'auto-edits', approvalSource: 'own' }, r.deps);
  assert.deepEqual(res, { state: 'error', text: 'The settings changed while this was being checked. Try again.' });
  assert.deepEqual(r.log, ['bridge']);
});

test('a save with no approval fields never touches the bridge', async () => {
  const r = rig();
  const res = await saveWithMode('a1', { name: 'A', description: 'd' }, r.deps);
  assert.equal(res.state, 'saved');
  assert.deepEqual(r.log, ['patch']);
  assert.deepEqual(r.seen.patch, { name: 'A', description: 'd' });
});

test('with no bridge (a plain browser) the whole save goes in one request as before', async () => {
  const r = rig(null);
  const res = await saveWithMode('a1', { name: 'A', approval: 'ask', approvalSource: 'own' }, r.deps);
  assert.equal(res.state, 'saved');
  assert.deepEqual(r.log, ['patch']);
  assert.deepEqual(r.seen.patch, { name: 'A', approval: 'ask', approvalSource: 'own' });
});

test('a new agent is created asking first, then the mode is set; a cancel keeps the agent and says how it asks', async () => {
  const ok = rig();
  const made = await saveWithMode(null, { name: 'New', approval: 'ask', approvalSource: 'project' }, ok.deps);
  assert.equal(made.state, 'saved');
  assert.deepEqual(ok.log, ['create', 'bridge']);
  assert.deepEqual(ok.seen.create, { name: 'New' }, 'created with no approval fields, so the core takes the safe default');
  assert.deepEqual(ok.seen.bridge, { agentId: 'made', approval: 'ask', approvalSource: 'project' });

  const no = rig({ ok: false, cancelled: true });
  const res = await saveWithMode(null, { name: 'New', approval: 'full', approvalSource: 'own' }, no.deps);
  assert.equal(res.state, 'cancelled');
  assert.equal((res as { text: string }).text, CANCELLED_NEW_TEXT);
  assert.equal((res as { created?: AgentProfile }).created?.id, 'made');
  assert.doesNotMatch(CANCELLED_NEW_TEXT, /—/);

  const plain = rig();
  const asks = await saveWithMode(null, { name: 'Plain', approval: 'ask', approvalSource: 'own' }, plain.deps);
  assert.equal(asks.state, 'saved');
  assert.deepEqual(plain.log, ['create'], 'Ask on its own is what a new agent already has');
});

test('a bridge that throws is an error message, not a crash', async () => {
  const r = rig();
  r.deps.bridge = async () => { throw new Error('boom'); };
  assert.deepEqual(await saveWithMode('a1', { name: 'A', approval: 'full', approvalSource: 'own' }, r.deps), { state: 'error', text: 'boom' });
});

test('mayRaiseMode words the wait only for a change that can open the question', () => {
  const view = (o: Record<string, unknown> = {}) => ({ app: { version: 1 }, projects: {}, unreadable: [], changedOutside: [], canSign: true, ...o }) as unknown as GatesView;
  const P = { id: 'proj_000000000001', name: 'Shop', members: ['a1'], status: 'active' } as never;
  const a1 = agent('a1');
  assert.equal(mayRaiseMode(a1, 'ask', [], null), false);
  assert.equal(mayRaiseMode(a1, 'full', [], null), true);
  assert.equal(mayRaiseMode(a1, 'auto-edits', [], null), true);
  assert.equal(mayRaiseMode(agent('a1', { approval: 'full' }), 'full', [], null), false, 'unchanged');
  assert.equal(mayRaiseMode(a1, 'project', [P], view()), false, 'no preset anywhere');
  assert.equal(mayRaiseMode(a1, 'project', [P], view({ projects: { proj_000000000001: { version: 1, preset: 'bypass' } } })), true);
  assert.equal(mayRaiseMode(a1, 'project', [], view({ app: { version: 1, preset: 'smart' } })), true);
  assert.equal(mayRaiseMode(undefined, 'project', [], view()), false);
});

test('the run chip of a run that asks for nothing is marked full (the warning tint); an Ask run is not', () => {
  const a = agent('a1', { approval: 'full' });
  assert.equal(runChips({ runsAs: { mode: 'full' } }, a, [], null).runsAs?.full, true);
  assert.equal(runChips({ runsAs: { mode: 'ask' } }, a, [], null).runsAs?.full, undefined);
  assert.equal(runChips({ runsAs: { mode: 'auto-edits' } }, a, [], null).runsAs?.full, undefined);
});

// ---------------------------------------------------------------- the first-run screen

type Note = { tone: string; text: string };
const runWith = (bridge: (c: unknown) => Promise<{ ok: boolean; error?: string; cancelled?: boolean }>, out: { note: Note | null }) =>
  async (change: Parameters<typeof runAction>[1], done: string): Promise<boolean> => {
    const r = await runAction((c) => applyViaBridge(bridge, c, async () => undefined), change, done);
    out.note = r.note;
    return r.ok;
  };

test('Continue cancelled: nothing is saved, Ask stays selected, and the note says so', async () => {
  const sent: unknown[] = [];
  const out: { note: Note | null } = { note: null };
  const r = await continueFrom('bypass', false, SEEDS, runWith(async (c) => { sent.push(c); return { ok: false, cancelled: true }; }, out), undefined);
  assert.deepEqual(r, { done: false, selected: 'ask' });
  assert.deepEqual(sent, [{ kind: 'app', patch: { preset: 'bypass', firstRunChoice: true, claudeNoticeSeen: true } }]);
  assert.deepEqual(out.note, { tone: 'info', text: CANCELLED_NOTE });
  assert.equal(CANCELLED_NOTE, 'Cancelled. Nothing changed.');
  // a looser pick that is refused (not cancelled) also goes back to Ask and shows the reason
  assert.deepEqual(await continueFrom('smart', false, SEEDS, runWith(async () => ({ ok: false, error: 'Only Ask can be used.' }), out), undefined), { done: false, selected: 'ask' });
  assert.deepEqual(out.note, { tone: 'error', text: 'Only Ask can be used.' });
});

test('Continue confirmed: the screen is done with the chosen preset and the saved words', async () => {
  const out: { note: Note | null } = { note: null };
  const r = await continueFrom('smart', false, SEEDS, runWith(async () => ({ ok: true }), out), undefined);
  assert.deepEqual([r.done, r.selected], [true, 'smart']);
  assert.equal(r.saved?.text, 'Saved. The app default is Smart. Your agents keep their own settings.');
  assert.deepEqual(out.note, { tone: 'ok', text: 'Saved. The app default is Smart.' });
});

test('Decide later is remembered: the app file gets firstRunChoice (no preset, no dialog), and the screen does not come back', async () => {
  const mk = (folder: string) => new GatesStore(folder, { allowed: ['ask'], signer: makeSigner(Buffer.alloc(32, 7))! });
  const store = mk(join(cleanupTemp('legion-later-'), 'gates'));
  const sent: unknown[] = [];
  // the window's bridge, as the core would apply it: a patch that is not a loosening needs no dialog
  const bridge = async (c: unknown) => {
    sent.push(c);
    const patch = (c as { patch: Record<string, unknown> }).patch;
    assert.equal(store.isLoosening('app', patch), false, 'Decide later never loosens');
    store.patchApp(patch);
    return { ok: true };
  };
  const view = (s: GatesStore): GatesView => ({ app: s.app(), projects: {}, unreadable: [], changedOutside: [], canSign: true }) as unknown as GatesView;
  assert.equal(shouldShowPresetChoice(view(store), true, SEEDS), true, 'before: a fresh install sees it');
  await laterFrom(runWith(bridge, { note: null }));
  assert.deepEqual(sent, [{ kind: 'app', patch: { firstRunChoice: true, claudeNoticeSeen: true } }]);
  assert.equal(store.app().preset, undefined, 'the preset stays unset: today is behavior kept');
  assert.equal(shouldShowPresetChoice(view(store), true, SEEDS), false, 'after: it does not return');
  await store.flush();
  assert.equal(shouldShowPresetChoice(view(mk(store.folder)), true, SEEDS), false, 'a restart keeps it');
});
