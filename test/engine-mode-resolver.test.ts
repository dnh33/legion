import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './away-rig.js';
import type { ModeResolver } from '../src/core/gates-settings/index.js';
import type { ProjectStore } from '../src/core/projects/store.js';

type CanUseTool = (name: string, input: Record<string, unknown>, o: { signal: AbortSignal }) => Promise<unknown>;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sig = () => ({ signal: new AbortController().signal });

/**
 * A scripted run with no real model. Each step makes one tool decision through the engine's canUseTool, without awaiting it
 * (an Ask-mode call waits on its card). The run then stays open until the test cancels it, so no result is yielded.
 */
function toolSteps(...steps: Array<(can: CanUseTool) => void>) {
  return (params: { options: Record<string, unknown> }) => (async function* () {
    yield { type: 'system', subtype: 'init', session_id: 's1' };
    const can = params.options.canUseTool as CanUseTool;
    for (const step of steps) { step(can); await pause(50); }
    await new Promise<void>(() => undefined);
  })();
}

test('the engine asks the resolver for the mode on every tool call, with the project the run started in', async () => {
  const calls: Array<{ agentMode: string; startProjectId?: string; ceiling?: string }> = [];
  const modes: ModeResolver = { mode: (a) => { calls.push({ ...a }); return a.agentMode; } };
  const r = setup({ approval: 'ask', modes, script: toolSteps((can) => { void can('Bash', { command: 'echo 1' }, sig()); }) });
  const task = r.start('a1', 'go');
  try {
    await pause(150);
    assert.ok(calls.length >= 1, 'the resolver was asked');
    assert.equal(calls[0]!.agentMode, 'ask');
    assert.equal(calls[0]!.startProjectId, r.project.id);
  } finally { r.engine.cancel(task.id); }
});

test('resolver re-reads the agent mode on every call (a promotion mid-run takes effect)', async () => {
  const seen: string[] = [];
  const modes: ModeResolver = { mode: (a) => { seen.push(a.agentMode); return a.agentMode; } };
  const r = setup({
    approval: 'ask', modes,
    script: toolSteps(
      (can) => { void can('Bash', { command: 'echo 1' }, sig()); },
      (can) => { r.store.agents.get('a1')!.approval = 'full'; void can('Bash', { command: 'echo 2' }, sig()); },
    ),
  });
  const task = r.start('a1', 'go');
  try {
    await pause(150);
    // the run start asks too, so the first answer is 'ask' and the last one, after the promotion, is 'full'
    assert.equal(seen[0], 'ask');
    assert.equal(seen[seen.length - 1], 'full', `the last call saw ${JSON.stringify(seen)}`);
  } finally { r.engine.cancel(task.id); }
});

test('without a resolver the engine behaves exactly as before', async () => {
  const r = setup({ approval: 'full' });
  const task = r.start('a1', 'go');
  try {
    await pause(100);
    assert.equal(r.calls[0]!.options.permissionMode, 'bypassPermissions');
  } finally { r.engine.cancel(task.id); }
});

test('a full agent capped to Ask by the resolver starts on the normal path, with cards', async () => {
  const modes: ModeResolver = { mode: (a) => (a.agentMode === 'full' ? 'ask' : a.agentMode) };
  const r = setup({ approval: 'full', modes });
  const task = r.start('a1', 'go');
  try {
    await pause(100);
    assert.equal(r.calls[0]!.options.permissionMode, 'default');
    assert.equal(typeof r.calls[0]!.options.canUseTool, 'function');
  } finally { r.engine.cancel(task.id); }
});

test('a project archived mid-run keeps its cap (the start project is passed, not the live one)', async () => {
  const pids: Array<string | undefined> = [];
  const modes: ModeResolver = { mode: (a) => { pids.push(a.startProjectId); return a.startProjectId ? 'ask' : a.agentMode; } };
  const r = setup({
    approval: 'full', modes,
    script: toolSteps(
      (can) => { void can('Bash', { command: 'echo 1' }, sig()); },
      (can) => {
        // the engine keeps the ProjectStore private; the test reaches it to archive the project mid-run
        const projects = (r.engine as unknown as { projects: ProjectStore }).projects;
        projects.update(r.project.id, { status: 'archived' });
        void can('Bash', { command: 'echo 2' }, sig());
      },
    ),
  });
  const task = r.start('a1', 'go');
  try {
    await pause(200);
    // run start, then call 1, then call 2 after the archive: every one is asked with the project the run started in
    assert.ok(pids.length >= 3, `expected at least 3 resolver calls, got ${pids.length}`);
    assert.ok(pids.every((p) => p === r.project.id), `every call names the start project, got ${JSON.stringify(pids)}`);
  } finally { r.engine.cancel(task.id); }
});

test('a task with no project uses the resolver with no start project', async () => {
  const calls: Array<string | undefined> = [];
  const modes: ModeResolver = { mode: (a) => { calls.push(a.startProjectId); return a.agentMode; } };
  const r = setup({ approval: 'ask', modes, script: toolSteps((can) => { void can('Bash', { command: 'echo hi' }, sig()); }) });
  const task = r.start('a1', 'go', { projectId: undefined });
  try {
    await pause(150);
    assert.ok(calls.length >= 1, 'the resolver was asked');
    assert.equal(calls[0], undefined);
  } finally { r.engine.cancel(task.id); }
});
