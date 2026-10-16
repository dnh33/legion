// test/mode-readers.test.ts: one resolver answers every mode reader (engine, guards, UI); Smart is a real mode; a helper gets the helped project's cap
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setup, mkAgent } from './away-rig.js';
import type { ProjectStore } from '../src/core/projects/store.js';
import { renderCapabilities } from '../src/core/agent-facts.js';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const idle = () => (async function* () { yield { type: 'system', subtype: 'init', session_id: 's1' }; await new Promise<void>(() => undefined); })();

test('resolver: a bad source fails closed to ask', () => {
  const r = setup({ gatesCore: true });
  assert.equal(r.core!.resolver.mode({ agentMode: 'full', source: 'weird' as never }), 'ask');
  assert.equal(r.core!.resolver.mode({ agentMode: 'full', source: 'weird' as never, ceiling: 'auto-edits' }), 'ask');
  assert.equal(r.core!.resolver.baseline!({ agentMode: 'full', source: 'weird' as never }), 'ask');
});
test('resolver: no preset and no source gives exactly the agent own mode (0.3.0)', () => {
  const r = setup({ gatesCore: true });
  for (const m of ['ask', 'auto-edits', 'full'] as const) {
    assert.equal(r.core!.resolver.mode({ agentMode: m }), m);
    assert.equal(r.core!.resolver.mode({ agentMode: m, source: 'own', startProjectId: r.project.id }), m);
  }
});
test('resolver: a smart project gives smart to an agent that follows it, and limits an own-mode agent to it', () => {
  const r = setup({ gatesCore: true });
  r.core!.store.patchProject(r.project.id, { preset: 'smart' });
  assert.equal(r.core!.resolver.mode({ agentMode: 'ask', source: 'project', startProjectId: r.project.id }), 'smart');
  assert.equal(r.core!.resolver.mode({ agentMode: 'full', source: 'own', startProjectId: r.project.id }), 'smart');
  assert.equal(r.core!.resolver.mode({ agentMode: 'auto-edits', source: 'own', startProjectId: r.project.id }), 'auto-edits');
});
test('resolver: a bypass project gives full to an agent that follows it (the old mapping handed back the agent mode)', () => {
  const r = setup({ gatesCore: true });
  r.core!.store.patchProject(r.project.id, { preset: 'bypass' });
  assert.equal(r.core!.resolver.mode({ agentMode: 'ask', source: 'project', startProjectId: r.project.id }), 'full');
  assert.equal(r.core!.resolver.mode({ agentMode: 'ask', source: 'own', startProjectId: r.project.id }), 'ask');
});
test('resolver: a smart app preset reaches an agent that follows it, with no project', () => {
  const r = setup({ gatesCore: true });
  r.core!.store.patchApp({ preset: 'smart' });
  assert.equal(r.core!.resolver.mode({ agentMode: 'ask', source: 'project' }), 'smart');
  assert.equal(r.core!.resolver.baseline!({ agentMode: 'ask', source: 'project' }), 'ask', 'the baseline ignores presets');
});
test('resolver: gate() reads the project value, and there is no shell floor switch on the core', () => {
  const r = setup({ gatesCore: true });
  assert.equal(typeof r.core!.gate, 'function');
  assert.equal('shellFloorOn' in r.core!, false);
});

test('runModeOf: a module asking by task gets the project cap, not the agent own mode', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  const task = r.start('a1', 'go');
  try {
    await pause(120);
    assert.equal(r.engine.runModeOf('a1', task.id), 'ask');
    assert.equal(r.engine.runModeOf('a1'), 'full', 'with no task there is no start project, so no cap');
    assert.equal(r.engine.runModeOf('nobody', task.id), undefined);
  } finally { r.engine.cancel(task.id); }
});
test('runModeOf: a smart project cap reaches the engine and the module readers as smart', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'smart' });
  const task = r.start('a1', 'go');
  try {
    await pause(120);
    assert.equal(r.engine.runModeOf('a1', task.id), 'smart');
  } finally { r.engine.cancel(task.id); }
});
test('runModeOf keeps the cap of the start project after the project is archived', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  const task = r.start('a1', 'go');
  try {
    await pause(120);
    (r.engine as unknown as { projects: ProjectStore }).projects.update(r.project.id, { status: 'archived' });
    assert.equal(r.engine.runModeOf('a1', task.id), 'ask');
  } finally { r.engine.cancel(task.id); }
});
test('runModeOf without a resolver is the stored agent mode (0.3.0)', async () => {
  const r = setup({ approval: 'auto-edits', script: idle });
  const task = r.start('a1', 'go');
  try {
    await pause(120);
    assert.equal(r.engine.runModeOf('a1', task.id), 'auto-edits');
    assert.equal(r.engine.runModeOf('nobody'), undefined);
  } finally { r.engine.cancel(task.id); }
});
test('a helper run for a project (outsideOf) gets the helped project cap', async () => {
  const r = setup({ gatesCore: true, approval: 'full', script: idle });
  r.core!.store.patchProject(r.project.id, { preset: 'ask' });
  // a9 is not a member of the project; it helps from outside when a1 (in the project) delegates to it
  r.store.agents.set('a9', mkAgent('a9', 'full'));
  const caller = r.start('a1', 'go');
  try {
    await pause(120);
    const helper = r.start('a9', 'help', { source: 'bot', projectId: undefined, bridge: { fromAgentId: 'a1', parentTaskId: caller.id, hop: 0 } });
    await pause(120);
    assert.equal(r.store.getTask(helper.id)?.helpingProjectId, r.project.id, 'a9 helps from outside the project');
    assert.equal(r.engine.runModeOf('a9', helper.id), 'ask');
    r.engine.cancel(helper.id);
  } finally { r.engine.cancel(caller.id); }
});

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}
test('no module reads the stored agent mode directly any more', () => {
  const root = process.cwd().replace(/[\\/]dist$/, '');
  const files = ['browser', 'blender', 'projects/board', 'comms'].flatMap((d) => walk(join(root, 'src/core', d))).concat(join(root, 'src/core/agent-facts.ts'));
  assert.ok(files.length > 10, 'the scan found the module files');
  const hits = files.filter((f) => /getAgent\([^)]*\)\??\.approval/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('agent facts say smart in the run mode, with what smart still asks for', () => {
  const a = mkAgent('a1', 'ask');
  const text = renderCapabilities(a, { servers: {}, vmEnabledForAgent: false, runMode: 'smart' });
  assert.match(text, /your mode is smart \(asks only for actions that leave your computer, delete, spend, can't be undone, or that Legion can't classify\)/);
  const plain = renderCapabilities(a, { servers: {}, vmEnabledForAgent: false });
  assert.match(plain, /your mode is ask/);
});
