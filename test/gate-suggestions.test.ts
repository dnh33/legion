/**
 * Learned gate suggestions: after the owner allows the same kind of call for an agent three times, Settings, Gates offers
 * the rule the approval card's Remember would make, so a habit becomes one click. Never for something a rule already
 * allows, a rail (Blender, downloads), or a call no allow can hold on; a dismissed suggestion stays dismissed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/bus.js';
import { createGateSuggestionsModule, MAX_ENTRIES, SUGGEST_AFTER } from '../src/core/gate-suggestions.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultConfig, normalizeGates } from '../src/shared/config.js';
import { tempDir } from './tmp-cleanup.js';
import type { Handler } from '../src/core/server.js';

let n = 0;
function rig(dir = tempDir('legion-gsug-')) {
  const bus = new EventBus();
  const config = defaultConfig();
  const mod = createGateSuggestionsModule({ bus, config, dataDir: dir } as never);
  const routes = new Map<string, Handler>();
  mod.routes!((method, pattern, handler) => { routes.set(`${method} ${pattern}`, handler); });
  /** One approval card for this call, answered allow or deny. */
  const answer = (agentId: string, toolName: string, input: Record<string, unknown>, allowed: boolean) => {
    const id = `ap_${++n}`;
    bus.emit({ type: 'approval.requested', approval: { id, taskId: 't', agentId, toolName, summary: '', input, at: '' } });
    bus.emit({ type: 'approval.resolved', approvalId: id, allowed });
  };
  const list = async () => (await routes.get('GET /api/gates/suggestions')!({ body: undefined } as never)) as { suggestions: Array<{ key: string; when: any; count: number }> };
  return { bus, config, mod, routes, answer, list, dir };
}

test('three allows of the same kind of call become one suggestion: the rule Remember would make', async () => {
  const r = rig();
  r.answer('builder', 'Bash', { command: 'git status -s' }, true);
  r.answer('builder', 'Bash', { command: 'git status' }, true);
  assert.equal((await r.list()).suggestions.length, 0, 'not yet');
  r.answer('builder', 'mcp__host__shell', { command: 'git status --short' }, true);
  const s = (await r.list()).suggestions;
  assert.equal(SUGGEST_AFTER, 3);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0]!.when, { agents: ['builder'], commands: ['git status', 'git status *'] });
  assert.equal(s[0]!.count, 3);
});

test('denials do not count, other agents and other commands count apart', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.answer('builder', 'Bash', { command: 'git push' }, false);
  for (let i = 0; i < 2; i++) r.answer('builder', 'Bash', { command: 'npm test' }, true);
  r.answer('scout', 'Bash', { command: 'npm test' }, true);
  assert.equal((await r.list()).suggestions.length, 0);
});

test('never suggested: what a rule already allows, a rail, a call no allow can hold on', async () => {
  const r = rig();
  r.config.gates = { rules: [{ id: 'gr_aaaaaaaaaaaa', enabled: true, then: 'allow', label: 'l', source: 'user', when: { agents: ['builder'], commands: ['ls', 'ls *'] } }], presetsVersion: 0 };
  for (let i = 0; i < 3; i++) {
    r.answer('builder', 'Bash', { command: 'ls -la' }, true);
    r.answer('builder', 'mcp__legion_blender__blender_exec', { code: 'x' }, true);
    r.answer('builder', 'Bash', { command: 'echo $(date)' }, true);
  }
  assert.equal((await r.list()).suggestions.length, 0);
});

test('switched off (gates.learn false): nothing is counted, nothing is listed and the file is deleted', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.answer('builder', 'Bash', { command: 'npm test' }, true);
  assert.ok(existsSync(join(r.dir, 'gate-suggestions.json')));
  r.config.gates = { rules: [], presetsVersion: 0, learn: false };
  assert.equal((await r.list()).suggestions.length, 0);
  assert.equal(existsSync(join(r.dir, 'gate-suggestions.json')), false, 'nothing kept while off');
  for (let i = 0; i < 3; i++) r.answer('builder', 'Bash', { command: 'npm run build' }, true);
  assert.equal(existsSync(join(r.dir, 'gate-suggestions.json')), false);
  r.config.gates = { rules: [], presetsVersion: 0 };
  assert.equal((await r.list()).suggestions.length, 0, 'switched back on, it starts from zero');
});

test('the file stays small: past MAX_ENTRIES the least-seen shapes are dropped', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.answer('builder', 'Bash', { command: 'npm test' }, true);
  for (let i = 0; i < MAX_ENTRIES + 20; i++) r.answer('builder', 'Write', { file_path: `D:/site/d${i}/a.ts` }, true);
  const saved = JSON.parse(readFileSync(join(r.dir, 'gate-suggestions.json'), 'utf8')) as { counts: Record<string, unknown> };
  assert.ok(Object.keys(saved.counts).length <= MAX_ENTRIES);
  assert.equal((await r.list()).suggestions.length, 1, 'the earned suggestion survives the pruning');
});

test('a dismissed suggestion stays dismissed, also after a restart; counts survive a restart', async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.answer('builder', 'Bash', { command: 'npm test' }, true);
  for (let i = 0; i < 2; i++) r.answer('builder', 'Write', { file_path: 'D:/site/src/a.ts' }, true);
  const [s] = (await r.list()).suggestions;
  await r.routes.get('POST /api/gates/suggestions/dismiss')!({ body: { key: s!.key } } as never);
  assert.equal((await r.list()).suggestions.length, 0);
  r.mod.dispose?.();
  const again = rig(r.dir);
  assert.equal((await again.list()).suggestions.length, 0, 'still dismissed');
  again.answer('builder', 'Write', { file_path: 'D:/site/src/b.ts' }, true);
  const s2 = (await again.list()).suggestions;
  assert.equal(s2.length, 1, 'the two earlier allows were kept');
  assert.deepEqual(s2[0]!.when, { agents: ['builder'], tools: ['Write'], paths: ['D:/site/src/**'] });
});

test('gates.learn: on unless the stored value is the literal false; a bad value is refused when saved', () => {
  assert.equal(normalizeGates({ rules: [] }).learn, undefined, 'absent means on');
  assert.equal(normalizeGates({ rules: [], learn: true }).learn, true);
  assert.equal(normalizeGates({ rules: [], learn: false }).learn, false);
  assert.throws(() => normalizeGates({ rules: [], learn: 'no' }, { strict: true }), /gates\.learn/);
});
