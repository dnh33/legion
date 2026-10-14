/**
 * Agent level (design 4.3): None / Read / Read and write, derived from `connectors` and `githubWrite`. Older saved agents (no `githubWrite`,
 * `connectors: ['github']`) are level Read and keep working (Review Focus 5). The config route rejects a `githubWrite` entry that is not a
 * valid repo string, and stores the rest lower-case without a .git suffix.
 * Mutation negatives (made on the code, must fail the named test, then reverted): `parseGithubWrite` removed from the route fields (config
 * tests); `validRepoString` dropped from it (the 400 test); `githubLevelTag` counting entries without de-duplicating (the tag test); the
 * gateway letting level Read write (the legacy test).
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { setTicked } from '../src/core/connectors/github/allowlist.js';
import { CONNECTORS_SERVER_NAME } from '../src/core/connectors/gateway.js';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import type { GhApi } from '../src/core/connectors/github/tools.js';
import type { ModuleDeps, ModuleJob } from '../src/core/modules.js';
import { githubLevelTag } from '../src/shared/connectors-view.js';
import { agentGithubLevel } from '../src/shared/github-area.js';
import { mkAgent } from './armory-rig.js';
import { makeFakes, start, AUTH } from './helpers-c.js';
import { tempDir } from './tmp-cleanup.js';

describe('agentGithubLevel and the tag', () => {
  it('all combinations', () => {
    assert.equal(agentGithubLevel({}), 'none');
    assert.equal(agentGithubLevel({ connectors: [] }), 'none');
    assert.equal(agentGithubLevel({ connectors: ['other'], githubWrite: ['a/b'] }), 'none');
    assert.equal(agentGithubLevel({ githubWrite: ['a/b'] }), 'none', 'githubWrite alone grants nothing');
    assert.equal(agentGithubLevel({ connectors: ['github'] }), 'read');
    assert.equal(agentGithubLevel({ connectors: ['github'], githubWrite: [] }), 'read');
    assert.equal(agentGithubLevel({ connectors: ['github'], githubWrite: ['a/b'] }), 'write');
  });
  it('the tag says what the card should say', () => {
    assert.equal(githubLevelTag({}), '');
    assert.equal(githubLevelTag({ connectors: ['github'] }), 'GitHub: read');
    assert.equal(githubLevelTag({ connectors: ['github'], githubWrite: ['a/b'] }), 'GitHub: write, 1 repo');
    assert.equal(githubLevelTag({ connectors: ['github'], githubWrite: ['a/b', 'A/B.git', 'c/d'] }), 'GitHub: write, 2 repos', 'the same repo twice counts once');
  });
});

describe('Review Focus 5: a legacy agent (no githubWrite, connectors: [github]) is level Read and keeps working', () => {
  it('it reads a turned-on repo and cannot write', async () => {
    const dir = tempDir('legion-ghlevel-');
    setTicked(dir, 'o/r', true);
    const legacy = mkAgent('legacy', { connectors: ['github'], mcpServers: ['*'] });
    assert.equal('githubWrite' in legacy, false);
    assert.equal(agentGithubLevel(legacy), 'read');
    const paths: string[] = [];
    const api = { request: async (p: string) => { paths.push(p); return { json: { full_name: 'o/r' } }; }, connection: async () => ({}) } as unknown as GhApi;
    const deps = { dataDir: dir, store: { getAgent: () => legacy, getTask: () => undefined } } as unknown as ModuleDeps;
    let handlerRan = false;
    const mod = createConnectorsModule(deps, { keys: new ConnectorKeyring(), client: () => api as never, writeApp: () => ({ api, can: () => 'yes' }), writeTools: { github_comment: async () => { handlerRan = true; return { data: 'wrote' }; } } });
    const job = { taskId: 't', runtime: 'claude', taint: () => false, markTainted: () => undefined } as unknown as ModuleJob;
    const tools = (mod.mcpServers!(legacy, job)[CONNECTORS_SERVER_NAME] as any).instance._registeredTools;
    const read = await tools.github_repo_get.handler({ repo: 'o/r' }, {});
    assert.notEqual(read.isError, true);
    assert.deepEqual(paths, ['/repos/o/r']);
    const wrote = await tools.github_comment.handler({ repo: 'o/r', fields: {} }, {});
    assert.equal(wrote.isError, true, 'level Read never writes');
    assert.equal(handlerRan, false);
  });
});

describe('config: githubWrite on POST and PATCH /api/agents', () => {
  const f = makeFakes();
  let base = '';
  let close: () => Promise<void>;
  before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
  after(async () => { await close(); });
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...AUTH, 'Content-Type': 'application/json' } });
  const post = (body: unknown) => api('/api/agents', { method: 'POST', body: JSON.stringify(body) });
  const patch = (id: string, body: unknown) => api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

  it('a valid list is stored lower-case, de-duplicated, without .git; an empty list clears it; a patch without it keeps it', async () => {
    const a = await (await post({ name: 'Writer', connectors: ['github'], githubWrite: ['Dnh33/Legion', 'dnh33/legion.git', 'o/r'] })).json();
    assert.deepEqual(a.githubWrite, ['dnh33/legion', 'o/r']);
    assert.equal(f.ctx.store.getAgent(a.id)?.githubWrite?.length, 2);
    const kept = await (await patch(a.id, { description: 'x' })).json();
    assert.deepEqual(kept.githubWrite, ['dnh33/legion', 'o/r']);
    const cleared = await (await patch(a.id, { githubWrite: [] })).json();
    assert.equal(cleared.githubWrite, undefined);
    assert.equal(f.ctx.store.getAgent(a.id)?.githubWrite, undefined);
  });

  it('an entry that fails validRepoString is a 400 naming the field, on POST and PATCH, and nothing is stored', async () => {
    const a = await (await post({ name: 'Careful', connectors: ['github'], githubWrite: ['o/r'] })).json();
    for (const bad of ['nope', '../x', 'a/b/c', 'a/..', 'a b/c', 'a/b?x=1', '', 7, null, 'o/' + 'x'.repeat(250)]) {
      const r = await patch(a.id, { githubWrite: ['o/r', bad] });
      assert.equal(r.status, 400, String(bad));
      assert.match(JSON.stringify(await r.json()), /githubWrite/);
      assert.equal((await post({ name: 'Bad', githubWrite: [bad] })).status, 400, `post ${String(bad)}`);
    }
    assert.equal((await patch(a.id, { githubWrite: 'o/r' })).status, 400, 'not an array');
    assert.equal((await patch(a.id, { githubWrite: Array.from({ length: 101 }, (_, i) => `o/r${i}`) })).status, 400, 'over the cap');
    assert.deepEqual(f.ctx.store.getAgent(a.id)?.githubWrite, ['o/r'], 'unchanged after every refusal');
  });
});
