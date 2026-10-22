// test/smart-card-copy.test.ts: the confirm cards and the agent's own facts tell the truth about Claude agents on Claude's own checks.
// Found in a real run: a Claude agent in Smart ran `curl https://example.com` with no card, while both cards said "asks before anything that reaches the web".
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { GatesStore } from '../src/core/gates-settings/store.js';
import { previewAgentMode } from '../src/core/gates-settings/agent-mode.js';
import type { AgentModeFields, ModeWorld } from '../src/core/gates-settings/agent-mode.js';
import { renderCapabilities } from '../src/core/agent-facts.js';
import { CLAUDE_PRESET_LINES } from '../src/shared/claude-checks-copy.js';
import { PRESET_LINES, PRESETS } from '../src/shared/gates-registry.js';
import type { Preset } from '../src/shared/gates-registry.js';
import { makeSigner } from '../src/core/gates-settings/sign.js';
import { mkAgent } from './helpers-c.js';
import { IDS, withBoot } from './agent-mode-rig.js';

const PROJ = 'proj_000000000001';
const OLD_SMART = "Legion decides when to ask. Asks before anything that reaches the web, deletes, can't be undone, or that Legion can't classify. Tests and builds run without asking, and the code they run can reach the web. Everything else runs.";
const store = (claudeOwn: boolean): GatesStore => {
  const s = new GatesStore(join(cleanupTemp('legion-smartcopy-'), 'gates'), { allowed: PRESETS, signer: makeSigner(Buffer.alloc(32, 9)), keyState: 'new' });
  if (!claudeOwn) s.patchApp({ claudeOwnChecks: false });
  return s;
};
const lines = (s: GatesStore, name: string, preset: Preset): string[] => s.preview(name, { preset }).loosening;

// ---- the shared Claude line for Smart matches what was observed in the real run

test('the Claude Smart line says it runs the safe, blocks the risky by itself, and asks when unsure', () => {
  assert.equal(CLAUDE_PRESET_LINES.smart, "Claude's own checker decides. It runs what it judges safe, blocks what it judges risky by itself (the block shows in the task), and asks you when it is unsure.");
  assert.ok(!CLAUDE_PRESET_LINES.smart.includes('—'));
});

// ---- the app preset card (and a project preset card)

test('app preset card, Claude checks on: Smart shows both lines, labelled like the Gates page', () => {
  const l = lines(store(true), 'app', 'smart');
  assert.equal(l[0], `Other providers: ${OLD_SMART}`);
  assert.equal(l[1], `Claude agents: ${CLAUDE_PRESET_LINES.smart}`);
  assert.ok(!l[1]!.includes('reaches the web'), 'the Claude line does not promise a web card');
});
test('app preset card, Claude checks on: Accept edits and Bypass show both lines too', () => {
  const ae = lines(store(true), 'app', 'accept-edits');
  assert.equal(ae[0], 'Other providers: File edits run without asking. Everything else still asks.');
  assert.equal(ae[1], `Claude agents: ${CLAUDE_PRESET_LINES['accept-edits']}`);
  const by = lines(store(true), 'app', 'bypass');
  assert.match(by[0]!, /^Other providers: No permission cards\./);
  assert.equal(by[1], `Claude agents: ${CLAUDE_PRESET_LINES.bypass}`);
});
test('app preset card, Claude checks off: exactly the old text, no Claude line', () => {
  const s = store(false);
  assert.deepEqual(lines(s, 'app', 'smart').slice(0, 1), [OLD_SMART]);
  assert.equal(lines(s, 'app', 'accept-edits')[0], 'File edits run without asking. Everything else still asks.');
  for (const p of PRESETS.filter((x) => x !== 'ask')) assert.ok(!lines(s, 'app', p).some((x) => x.includes('Claude agents:') || x.startsWith('Other providers:')), p);
});
test('project preset card follows the app setting for Claude checks', () => {
  assert.equal(lines(store(true), PROJ, 'smart')[1], `Claude agents: ${CLAUDE_PRESET_LINES.smart}`);
  assert.deepEqual(lines(store(false), PROJ, 'smart').slice(0, 1), [OLD_SMART]);
});
test('every Legion preset line the card uses still comes from PRESET_LINES', () => {
  assert.ok(lines(store(true), 'app', 'smart')[0]!.includes(PRESET_LINES.smart));
});

// ---- the agent card

const OWN_ASK: AgentModeFields = { approval: 'ask', approvalSource: 'own' };
const world = (preset: Preset | undefined, claudeChecks: boolean | undefined): ModeWorld => ({ appPreset: preset, ...(claudeChecks === undefined ? {} : { claudeChecks }), projects: [] });
const agentCard = (o: { claudeAgent?: boolean; claudeChecks?: boolean; change: { approval?: 'ask' | 'auto-edits' | 'full'; approvalSource?: 'own' | 'project' }; preset?: Preset }) =>
  previewAgentMode({ agentId: 'alpha', name: 'Alpha', before: OWN_ASK, change: o.change, world: world(o.preset, o.claudeChecks), ...(o.claudeAgent === undefined ? {} : { claudeAgent: o.claudeAgent }) });

test('agent card, Claude agent on Claude checks, following Smart: only the Claude meaning', () => {
  const pv = agentCard({ claudeAgent: true, claudeChecks: true, preset: 'smart', change: { approvalSource: 'project' } });
  assert.equal(pv.raises, true);
  assert.equal(pv.loosening[0], `Alpha will follow the way agents ask outside a project. For a Claude agent: ${CLAUDE_PRESET_LINES.smart}`);
  assert.doesNotMatch(pv.loosening.join('\n'), /reaches the web/);
});
test('agent card, non-Claude agent: the Legion text, whatever the Claude setting', () => {
  for (const claudeChecks of [true, false, undefined]) {
    const pv = agentCard({ claudeAgent: false, ...(claudeChecks === undefined ? {} : { claudeChecks }), preset: 'smart', change: { approvalSource: 'project' } });
    assert.match(pv.loosening[0]!, /^Alpha will follow the way agents ask outside a project\. There it will ask before anything that reaches the web, deletes/);
    assert.doesNotMatch(pv.loosening.join('\n'), /Claude agent/);
  }
});
test('agent card, Claude agent but Claude checks off: the Legion text', () => {
  const pv = agentCard({ claudeAgent: true, claudeChecks: false, preset: 'smart', change: { approvalSource: 'project' } });
  assert.match(pv.loosening[0]!, /There it will ask before anything that reaches the web/);
});
test('agent card, own mode on a Claude agent: Accept edits and Full say what Claude does', () => {
  const ae = agentCard({ claudeAgent: true, claudeChecks: true, change: { approval: 'auto-edits' } });
  assert.equal(ae.loosening[0], `Alpha will use Claude's own checks. ${CLAUDE_PRESET_LINES['accept-edits']}`);
  const full = agentCard({ claudeAgent: true, claudeChecks: true, change: { approval: 'full' } });
  assert.equal(full.loosening[0], `Alpha will use Claude's own checks. ${CLAUDE_PRESET_LINES.bypass}`);
  const legion = agentCard({ claudeAgent: true, claudeChecks: false, change: { approval: 'auto-edits' } });
  assert.equal(legion.loosening[0], 'Alpha will change files without asking, and still ask before it runs commands.');
});
test('agent card: Claude or not, the closing safety lines stay and the digest binds the wording', () => {
  const a = agentCard({ claudeAgent: true, claudeChecks: true, preset: 'smart', change: { approvalSource: 'project' } });
  const b = agentCard({ claudeAgent: false, claudeChecks: true, preset: 'smart', change: { approvalSource: 'project' } });
  assert.equal(a.loosening.length, b.loosening.length);
  assert.deepEqual(a.loosening.slice(1), b.loosening.slice(1));
  assert.notEqual(a.digest, b.digest, 'what the owner reads is part of what they confirm');
});

test('core route: mode-preview words a Claude agent and a provider agent apart, and follows the app switch', withBoot([], async (r) => {
  r.f.ctx.store.upsertAgent({ ...mkAgent('prov', 'Prov'), model: 'openrouter:vendor/model' });
  const ask = async (agentId: string) => (await r.http('POST', '/api/agents/mode-preview', { agentId, approvalSource: 'project', assumeAppPreset: 'smart' })).json as { loosening: string[] };
  assert.ok(IDS.includes('alpha'));
  assert.equal((await ask('alpha')).loosening[0], `Alpha will follow the way agents ask outside a project. For a Claude agent: ${CLAUDE_PRESET_LINES.smart}`);
  assert.match((await ask('prov')).loosening[0]!, /There it will ask before anything that reaches the web/);
  r.core.store.patchApp({ claudeOwnChecks: false });
  assert.match((await ask('alpha')).loosening[0]!, /There it will ask before anything that reaches the web/);
}));

// ---- what the agent itself is told

test('agent facts: a Claude agent on Claude checks in Smart is told the Claude meaning, not Legion\'s', () => {
  const a = mkAgent('a1', 'A1');
  const t = renderCapabilities(a, { servers: {}, vmEnabledForAgent: false, runMode: 'smart', claudeOwnChecks: true });
  assert.ok(t.includes(`your mode is smart (${CLAUDE_PRESET_LINES.smart})`), t);
  assert.doesNotMatch(t, /reaches the web|Legion can't classify/);
});
test('agent facts: without Claude checks (off, or a run on another provider) Smart keeps the Legion meaning', () => {
  const a = mkAgent('a1', 'A1');
  for (const ctx of [{ claudeOwnChecks: false }, {}]) {
    const t = renderCapabilities(a, { servers: {}, vmEnabledForAgent: false, runMode: 'smart', ...ctx });
    assert.match(t, /your mode is smart \(asks before anything that reaches the web, deletes, can't be undone, or that Legion can't classify; tests and builds run without asking, and the code they run can reach the web\)/);
  }
});
test('agent facts: Accept edits with Smart checks on a Claude agent is told Claude asks as in Ask', () => {
  const a = mkAgent('a1', 'A1');
  const t = renderCapabilities(a, { servers: {}, vmEnabledForAgent: false, runMode: 'smart-edits', claudeOwnChecks: true });
  assert.ok(t.includes(CLAUDE_PRESET_LINES.ask), t);
  assert.doesNotMatch(t, /edits inside your project run/);
});
