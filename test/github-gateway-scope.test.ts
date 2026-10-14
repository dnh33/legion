/**
 * Gateway scope (design 4.2, 4.3, 6.3): an agent sees only the repos turned on in Legion, the master switch turns every tool off, and a
 * write goes through the order: opted in, not an MCP-client run, master on, repo in `githubWrite`, repo ticked, write app signed in with
 * write access, then the handler (which raises the card). A refusal at any step gives plain words and no card.
 * Mutation negatives (each one is made on the code, must fail the named test, then is reverted): the isTicked check in `scope` removed;
 * `masterOn` removed from `gate`; `github_repo_list` listing `/user/repos` again; `normRepo` dropped from the githubWrite match; the
 * ticked check skipped for writes; the githubWrite check skipped; the write-app check skipped; connector_call_read allowed to run writes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classOf, SHIPPED_CLASSES } from '../src/core/connectors/classes.js';
import { CONNECTORS_SERVER_NAME, CLIENT_REFUSED } from '../src/core/connectors/gateway.js';
import type { ReadTool, WriteApp } from '../src/core/connectors/gateway.js';
import { setMaster, setTicked } from '../src/core/connectors/github/allowlist.js';
import { GITHUB_WRITE_TOOLS } from '../src/core/connectors/github/write-tools.js';
import type { GhApi } from '../src/core/connectors/github/tools.js';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import type { ModuleDeps, ModuleJob } from '../src/core/modules.js';
import { GITHUB_AGENTS_OFF_TEXT, GITHUB_NOT_SIGNED_FOR_WRITE_TEXT, GITHUB_UNTICKED_TEXT, GITHUB_WRITE_NEEDS_ACCESS_TEXT, GITHUB_WRITE_NOT_GRANTED_TEXT } from '../src/shared/connectors-view.js';
import type { AgentProfile } from '../src/shared/types.js';
import { mkAgent } from './armory-rig.js';
import { tempDir } from './tmp-cleanup.js';

const READ_REPO_TOOLS = Object.entries(SHIPPED_CLASSES.github!).filter(([n, c]) => c === 'READ' && n !== 'github_status' && n !== 'github_repo_list').map(([n]) => n);
const WRITE_NAMES = Object.entries(SHIPPED_CLASSES.github!).filter(([, c]) => c === 'WRITE').map(([n]) => n);
const ARGS: Record<string, unknown> = { number: 1, runId: 5, path: 'a.md', branch: 'main' };

interface Rig {
  dir: string; paths: string[]; cards: string[]; writes: Array<{ tool: string; agent?: string }>;
  agents: Map<string, AgentProfile>; tasks: Map<string, { status?: string; origin?: { viaMcpClient?: boolean } }>; app: { value: WriteApp | undefined };
  registered(): string[];
  call(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

function mk(o: { agent?: Partial<AgentProfile>; withWriteApp?: boolean; defaultWriteApp?: boolean; realWriteTable?: boolean; answer?: (p: string) => unknown; sleep?: (ms: number) => Promise<void> } = {}): Rig {
  const dir = tempDir('legion-ghscope-');
  const paths: string[] = [];
  const cards: string[] = [];
  const writes: Rig['writes'] = [];
  const api = { request: async (p: string) => { paths.push(p); return { json: o.answer ? o.answer(p) : { full_name: p.replace('/repos/', ''), private: false }, rate: { limit: 5000, remaining: 4000, resetAt: new Date(0).toISOString() } }; }, connection: async () => ({}) } as unknown as GhApi;
  const agents = new Map([['alpha', mkAgent('alpha', { connectors: ['github'], mcpServers: ['*'], ...o.agent })]]);
  const tasks = new Map<string, { status?: string; origin?: { viaMcpClient?: boolean } }>();
  const deps = { dataDir: dir, store: { getAgent: (id: string) => agents.get(id), getTask: (id: string) => tasks.get(id) } } as unknown as ModuleDeps;
  const app: Rig['app'] = { value: o.withWriteApp === false ? undefined : { api, can: () => 'yes' } };
  // a write spy stands for a real handler: it would raise the card, so reaching it means "a card was raised"
  const spy = (tool: string): ReadTool => async (_c, _a, x) => { cards.push(tool); writes.push({ tool, ...(x.agent ? { agent: x.agent.name } : {}) }); return { data: 'done' }; };
  const writeTools = Object.fromEntries(WRITE_NAMES.map((n) => [n, spy(n)]));
  const mod = createConnectorsModule(deps, {
    keys: new ConnectorKeyring(), client: () => api as never,
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.realWriteTable ? {} : { writeTools }),
    ...(o.defaultWriteApp ? {} : { writeApp: () => app.value }),
  });
  const job = { taskId: 't1', runtime: 'claude', taint: () => false, markTainted: () => undefined } as unknown as ModuleJob;
  const server = () => mod.mcpServers!(agents.get('alpha')!, job)[CONNECTORS_SERVER_NAME] as any;
  const registered = () => Object.keys(server().instance._registeredTools);
  const built = server();
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = built.instance._registeredTools[name];
    assert.ok(t, `${name} is registered`);
    const out = await t.handler(args, {});
    return { text: out.content.map((c: any) => c.text).join('\n') as string, isError: out.isError === true };
  };
  return { dir, paths, cards, writes, agents, tasks, app, registered, call };
}

// ------------------------------------------------------------------------------------------------ read scope

test('every read tool refuses a repo that is not turned on, and no request leaves the core (mutation: drop the isTicked check)', async () => {
  const r = mk();
  setTicked(r.dir, 'o/other', true);
  for (const t of READ_REPO_TOOLS) {
    const out = await r.call(t, { repo: 'o/r', ...ARGS });
    assert.equal(out.isError, true, t);
    assert.equal(out.text, GITHUB_UNTICKED_TEXT, t);
    const via = await r.call('connector_call_read', { connector: 'github', tool: t, args: { repo: 'o/r', ...ARGS } });
    assert.equal(via.text, GITHUB_UNTICKED_TEXT, `${t} through connector_call_read`);
  }
  assert.equal(GITHUB_UNTICKED_TEXT, 'That repo is not turned on in Legion. Turn it on in the GitHub area.');
  assert.deepEqual(r.paths, [], 'nothing was requested');
  // a missing or odd repo argument is the same refusal, never a request
  const bad = [undefined, 7, '', '../x', 'o/r/../x', 'o/r?x=1', 'о/r', 'o/г', 'ｏ/ｒ', 'o​/r', 'o/r‍', 'https://github.com/o/r', 'github.com/o/r', 'https://api.github.com/repos/o/r', '//evil.example/o/r'];
  for (const b of bad) for (const t of READ_REPO_TOOLS) assert.equal((await r.call(t, { repo: b, ...ARGS })).text, GITHUB_UNTICKED_TEXT, `${t} ${JSON.stringify(b)}`);
  assert.deepEqual(r.paths, []);
  // ticking it lets the same call through
  setTicked(r.dir, 'o/r', true);
  assert.equal((await r.call('github_repo_get', { repo: 'o/r' })).isError, false);
  assert.deepEqual(r.paths, ['/repos/o/r']);
});

test('master switch off refuses every github tool, connector_call_read and connector_list, with no request (mutation: remove masterOn from gate)', async () => {
  const r = mk();
  setTicked(r.dir, 'o/r', true);
  setMaster(r.dir, false);
  for (const t of ['github_status', 'github_repo_list', ...READ_REPO_TOOLS]) {
    const out = await r.call(t, { repo: 'o/r', ...ARGS });
    assert.equal(out.text, GITHUB_AGENTS_OFF_TEXT, t);
    assert.equal(out.isError, true, t);
  }
  assert.equal((await r.call('connector_call_read', { connector: 'github', tool: 'github_repo_get', args: { repo: 'o/r' } })).text, GITHUB_AGENTS_OFF_TEXT);
  assert.equal((await r.call('connector_list')).text, GITHUB_AGENTS_OFF_TEXT);
  assert.deepEqual(r.paths, []);
  setMaster(r.dir, true);
  assert.equal((await r.call('github_repo_get', { repo: 'o/r' })).isError, false);
});

test('a gateway without a data folder fails closed: nothing is turned on', async () => {
  const agent = mkAgent('alpha', { connectors: ['github'], mcpServers: ['*'] });
  const deps = { store: { getAgent: () => agent, getTask: () => undefined } } as unknown as ModuleDeps; // no dataDir
  const mod = createConnectorsModule(deps, { keys: new ConnectorKeyring(), client: () => ({ request: async () => { throw new Error('no'); }, connection: async () => ({}) }) as never });
  const job = { taskId: 't1', runtime: 'claude', taint: () => false, markTainted: () => undefined } as unknown as ModuleJob;
  const srv = mod.mcpServers!(agent, job)[CONNECTORS_SERVER_NAME] as any;
  const out = await srv.instance._registeredTools.github_repo_get.handler({ repo: 'o/r' }, {});
  assert.equal(out.content[0].text, GITHUB_AGENTS_OFF_TEXT);
});

test('github_repo_list returns the turned-on repos only and never calls /user/repos (mutation: list /user/repos again)', async () => {
  const r = mk();
  setTicked(r.dir, 'Dnh33/Legion', true);
  setTicked(r.dir, 'dnh33/other', true);
  setTicked(r.dir, 'acme/site', true);
  const all = (await r.call('github_repo_list', {})).text;
  for (const n of ['acme/site', 'dnh33/legion', 'dnh33/other']) assert.match(all, new RegExp(`"full_name": "${n}"`));
  assert.ok(r.paths.every((p) => p.startsWith('/repos/')), r.paths.join(','));
  assert.equal(r.paths.some((p) => p.includes('/user/repos') || p.includes('/users/')), false);
  r.paths.length = 0;
  const mine = (await r.call('github_repo_list', { owner: 'DNH33' })).text;
  assert.match(mine, /dnh33\/legion/); assert.match(mine, /dnh33\/other/); assert.doesNotMatch(mine, /acme\/site/);
  assert.equal(r.paths.some((p) => p.includes('acme')), false, 'an owner filter reads nothing of other owners');
  // nothing turned on: an empty list, and still no request
  const none = mk();
  assert.match((await none.call('github_repo_list', {})).text, /\[\]/);
  assert.deepEqual(none.paths, []);
});

test('Review Focus 1: odd case and a .git suffix are the same repo for the tick, the read check and the write list (mutation: drop normRepo)', async () => {
  const r = mk({ agent: { githubWrite: ['dnh33/legion.git'] } });
  setTicked(r.dir, 'Dnh33/Legion', true);
  for (const form of ['Dnh33/Legion', 'dnh33/legion.git', 'DNH33/LEGION.GIT']) {
    assert.equal((await r.call('github_repo_get', { repo: form })).isError, false, form);
  }
  for (const form of ['Dnh33/Legion', 'dnh33/legion.git', 'DNH33/LEGION.GIT']) {
    assert.equal((await r.call('github_comment', { repo: form, fields: { number: 1, body: 'x' } })).isError, false, `write ${form}`);
  }
  assert.equal(r.cards.length, 3);
  assert.equal((await r.call('github_comment', { repo: 'dnh33/legion-2', fields: {} })).text, GITHUB_WRITE_NOT_GRANTED_TEXT, 'a different repo is not the same repo');
});

// ------------------------------------------------------------------------------------------------ write order

test('write order: each early refusal is plain words, no card, no request; the full path raises exactly one (mutations: skip each step)', async () => {
  const w = { repo: 'o/r', fields: { number: 1, body: 'hi' } };
  const a = mk({ agent: { githubWrite: ['o/r'] } }); setTicked(a.dir, 'o/r', true);
  a.agents.set('alpha', { ...a.agents.get('alpha')!, connectors: [] }); // the owner switched GitHub off mid-run; the server is already built
  assert.match((await a.call('github_comment', w)).text, /Connectors are not enabled/, 'not opted in');
  const b = mk({ agent: { githubWrite: ['o/r'] } }); setTicked(b.dir, 'o/r', true); b.tasks.set('t1', { origin: { viaMcpClient: true } });
  assert.equal((await b.call('github_comment', w)).text, CLIENT_REFUSED);
  const c = mk({ agent: { githubWrite: ['o/r'] } }); setTicked(c.dir, 'o/r', true); setMaster(c.dir, false);
  assert.equal((await c.call('github_comment', w)).text, GITHUB_AGENTS_OFF_TEXT);
  const d = mk({ agent: { githubWrite: ['o/else'] } }); setTicked(d.dir, 'o/r', true);
  assert.equal((await d.call('github_comment', w)).text, GITHUB_WRITE_NOT_GRANTED_TEXT, 'another repo is listed');
  const d2 = mk(); setTicked(d2.dir, 'o/r', true);
  assert.equal((await d2.call('github_comment', w)).text, GITHUB_WRITE_NOT_GRANTED_TEXT, 'level Read cannot write');
  const e = mk({ agent: { githubWrite: ['o/r'] } });
  assert.equal((await e.call('github_comment', w)).text, GITHUB_UNTICKED_TEXT, 'listed but not ticked');
  const f = mk({ agent: { githubWrite: ['o/r'] }, withWriteApp: false }); setTicked(f.dir, 'o/r', true);
  assert.equal((await f.call('github_comment', w)).text, GITHUB_NOT_SIGNED_FOR_WRITE_TEXT);
  f.app.value = { api: {} as GhApi, can: () => 'no' };
  assert.equal((await f.call('github_comment', w)).text, GITHUB_WRITE_NEEDS_ACCESS_TEXT);
  f.app.value = { api: {} as GhApi, can: () => 'unknown' };
  assert.equal((await f.call('github_comment', w)).text, GITHUB_WRITE_NEEDS_ACCESS_TEXT, 'unknown is not a yes');
  for (const r of [a, b, c, d, d2, e, f]) { assert.deepEqual(r.cards, [], 'no card'); assert.deepEqual(r.paths, [], 'no request'); }
  const g = mk({ agent: { name: 'Scribe', githubWrite: ['O/R'] } }); setTicked(g.dir, 'o/r', true);
  assert.equal((await g.call('github_comment', w)).isError, false);
  assert.deepEqual(g.writes, [{ tool: 'github_comment', agent: 'Scribe' }]);
});

test('Review Focus 2: a repo unticked after the owner granted write is refused in plain words with no card, on every write tool', async () => {
  const r = mk({ agent: { githubWrite: ['o/r'] } });
  setTicked(r.dir, 'o/r', true);
  assert.equal((await r.call('github_issue_write', { repo: 'o/r', fields: { title: 't' } })).isError, false);
  assert.equal(r.cards.length, 1);
  setTicked(r.dir, 'o/r', false); // unticked, or removed from the GitHub install: the tick follows it
  for (const t of WRITE_NAMES) {
    const out = await r.call(t, { repo: 'o/r', fields: { number: 1, runId: 2 } });
    assert.equal(out.isError, true, t);
    assert.equal(out.text, GITHUB_UNTICKED_TEXT, t);
  }
  assert.equal(r.cards.length, 1, 'no further card');
});

test('the real write table holds the six write names; connector_call_read never opens a write tool (mutation: allow it)', async () => {
  assert.deepEqual(Object.keys(GITHUB_WRITE_TOOLS).sort(), [...WRITE_NAMES].sort(), 'the table is exactly the six names of classes.ts');
  const real = mk({ agent: { githubWrite: ['o/r'] }, realWriteTable: true });
  setTicked(real.dir, 'o/r', true);
  for (const t of WRITE_NAMES) { assert.equal(classOf('github', t), 'WRITE'); assert.equal(real.registered().includes(t), true, `${t} is registered with its handler`); }
  const withSpies = mk({ agent: { githubWrite: ['o/r'] } });
  setTicked(withSpies.dir, 'o/r', true);
  for (const t of WRITE_NAMES) {
    const out = await withSpies.call('connector_call_read', { connector: 'github', tool: t, args: { repo: 'o/r' } });
    assert.match(out.text, /not a read tool/, t);
  }
  assert.deepEqual(withSpies.cards, []);
});

test('the default write app is "not signed in": a granted, ticked write is refused in plain words and no card is raised', async () => {
  const r = mk({ agent: { githubWrite: ['o/r'] }, defaultWriteApp: true });
  setTicked(r.dir, 'o/r', true);
  const out = await r.call('github_ci_rerun', { repo: 'o/r', fields: { runId: 9 } });
  assert.equal(out.text, GITHUB_NOT_SIGNED_FOR_WRITE_TEXT);
  assert.deepEqual(r.cards, []);
});

test('github_ci_wait ends with a plain message, and no further GitHub call, when the repo or the master switch is turned off mid-wait (mutation: drop the per-poll re-check)', async () => {
  const run = { id: 5, name: 'CI', head_branch: 'main', head_sha: 'a', display_title: 't', status: 'in_progress', conclusion: null, html_url: 'https://github.com/o/r/actions/runs/5', event: 'push', run_attempt: 1, created_at: '2026-10-07T10:00:00Z', run_started_at: '2026-10-07T10:00:00Z', updated_at: '2026-10-07T10:05:00Z' };
  for (const off of ['repo', 'master'] as const) {
    const turn: { f?: () => void } = {};
    let slept = 0;
    const r = mk({ answer: () => run, sleep: async () => { if (++slept > 3) throw new Error('kept waiting'); turn.f?.(); } });
    setTicked(r.dir, 'o/r', true);
    turn.f = () => { if (off === 'repo') setTicked(r.dir, 'o/r', false); else setMaster(r.dir, false); };
    const out = await r.call('github_ci_wait', { repo: 'o/r', runId: 5 });
    assert.match(out.text, /That repo was turned off in Legion while waiting\./, off);
    assert.equal(r.paths.length, 1, `${off}: only the first poll was made`);
  }
});
