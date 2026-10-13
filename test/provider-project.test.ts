/**
 * Council A5: an agent on another provider, running in a project, gets the project's rules and folder in its system
 * prompt, as a Claude run does. Before, runProvider built its prompt without the project section.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
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
