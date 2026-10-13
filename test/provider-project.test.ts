/**
 * Council A5: an agent on another provider, running in a project, gets the project's rules and folder in its system
 * prompt, as a Claude run does. Before, runProvider built its prompt without the project section.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectStore } from '../src/core/projects/store.js';
import { startFake, replyText } from './providers-fakes.js';
import { setup, run } from './providers-harness.js';
import { tempDir as cleanupTemp } from './tmp-cleanup.js';

test('a provider run in a project carries the project section (name, instructions, folder) in its system prompt', async () => {
  const f = await startFake((_r, res) => replyText(res, 'done'));
  try {
    const root = cleanupTemp('legion-prov-proj-');
    const projects = new ProjectStore(join(root, 'data'), join(root, 'ws'));
    const p = projects.setMembers(projects.create({ name: 'Atlas', instructions: 'PROJECT-RULE-MARKER: write tests first.' }).id, ['a1']);
    const h = setup(f, { agent: { approval: 'full' }, projects });
    const t = await run(h, 'hello', { projectId: p.id });
    assert.equal(t.status, 'done', t.error);
    assert.equal(t.projectId, p.id);
    const sent = f.requests.find((r) => r.url.endsWith('/chat/completions'));
    const system = String(sent!.body.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '');
    assert.match(system, /legion-project/);
    assert.match(system, /Atlas/);
    assert.match(system, /PROJECT-RULE-MARKER: write tests first\./);
  } finally { await f.close(); }
});

const systemOf = (f: { requests: Array<{ url: string; body: any }> }): string => {
  const sent = f.requests.filter((r) => r.url.endsWith('/chat/completions')).at(-1);
  return String(sent!.body.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '');
};

test('a provider run in a project hands the project to the modules (board digest, Library briefing), as a Claude run does', async () => {
  const f = await startFake((_r, res) => replyText(res, 'done'));
  try {
    const root = cleanupTemp('legion-prov-proj2-');
    const projects = new ProjectStore(join(root, 'data'), join(root, 'ws'));
    const p = projects.setMembers(projects.create({ name: 'Atlas' }).id, ['a1']);
    const h = setup(f, { agent: { approval: 'full' }, projects });
    const seen: Array<string | undefined> = [];
    h.engine.setModules([{ id: 'spy', preamble: (_a, ctx) => { if (ctx) seen.push(ctx.projectId); return ''; } }]);
    const t = await run(h, 'hello', { projectId: p.id });
    assert.equal(t.status, 'done', t.error);
    assert.deepEqual(seen, [p.id]);
  } finally { await f.close(); }
});

test('a provider run queued in a project that is lost before it starts says so in the thread, once', async () => {
  const f = await startFake((_r, res) => replyText(res, 'done'));
  try {
    const root = cleanupTemp('legion-prov-proj3-');
    const projects = new ProjectStore(join(root, 'data'), join(root, 'ws'));
    const p = projects.setMembers(projects.create({ name: 'Atlas' }).id, ['a1']);
    const h = setup(f, { agent: { approval: 'full' }, projects });
    const queued = h.engine.startTask({ agentId: 'a1', prompt: 'x', source: 'ui', projectId: p.id } as any);
    projects.setMembers(p.id, []);
    await h.engine.waitFor(queued.id, 16000);
    const notes = h.store.listMessages(queued.id).filter((m: { role: string }) => m.role === 'system').map((m: { text: string }) => m.text);
    assert.equal(notes.length, 1, notes.join(' | '));
    assert.match(notes[0]!, /This run is not in project "Atlas": Alpha is not a member of it any more/);
  } finally { await f.close(); }
});

test('a provider run without the agent shell is not told it may edit files in the project folder', async () => {
  const f = await startFake((_r, res) => replyText(res, 'done'));
  try {
    const root = cleanupTemp('legion-prov-proj4-');
    const projects = new ProjectStore(join(root, 'data'), join(root, 'ws'));
    const p = projects.setMembers(projects.create({ name: 'Atlas' }).id, ['a1']);
    const h = setup(f, { agent: { approval: 'full' }, projects });
    await run(h, 'hello', { projectId: p.id });
    const system = systemOf(f);
    assert.match(system, /Project folder: .*this run cannot open files there/);
    assert.doesNotMatch(system, /you may read and write files there/);
  } finally { await f.close(); }
});

test('live 0.2.6-y: a provider run with the agent shell in a project creates the project folder, so a shell call can work there', async () => {
  const f = await startFake((_r, res) => replyText(res, 'done'));
  try {
    const root = cleanupTemp('legion-prov-proj5-');
    const projects = new ProjectStore(join(root, 'data'), join(root, 'ws'));
    const p = projects.setMembers(projects.create({ name: 'Atlas' }).id, ['a1']);
    const h = setup(f, { agent: { approval: 'full', host: { enabled: true } } as any, projects });
    assert.equal(existsSync(p.folder), false, 'a new project has no folder on disk yet');
    const t = await run(h, 'hello', { projectId: p.id });
    assert.equal(t.status, 'done', t.error);
    assert.equal(existsSync(p.folder), true, 'the run made the folder its shell is given');
  } finally { await f.close(); }
});
