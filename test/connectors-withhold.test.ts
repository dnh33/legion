/** The MCP bearer token cannot read connector data from a run the owner started (design 5, R1): task read, wait, legion_status, the event stream, and continue. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { WITHHELD } from '../src/core/connector-withhold.js';
import { CONNECTORS_SERVER_NAME } from '../src/core/connectors/gateway.js';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import type { FakeGitHub } from './connectors-fake-github.js';
import { signedInGitHub } from './connectors-rig.js';
import { init, ok, toolUse } from './library-fakes.js';
import { asClient, AUTH } from './helpers-c.js';
import { closeAll, mk, mount, startedTask } from './token-harness.js';

const MARK = 'SECRET-ISSUE-BODY-7731';
const FINAL = 'FINAL-RESULT-5521';
const fakes: FakeGitHub[] = [];
after(async () => { await closeAll(); for (const f of fakes) await f.stop(); });

async function rig() {
  const gh = await signedInGitHub();
  fakes.push(gh.fake);
  gh.fake.override = (host, _m, path) => host === 'api.github.com' && path.startsWith('/repos/o/r/issues/1') ? [200, { number: 1, title: 'T', state: 'open', user: { login: 'x' }, body: MARK, labels: [], comments: 0 }, {}] : undefined;
  const m = await mount((c) => c.agent === 'reader' ? (async function* () {
    yield init('s-r');
    yield toolUse('mcp__legion_connectors__github_issue_get', 'tu1', { repo: 'o/r', number: 1 });
    const r = await c.options.mcpServers[CONNECTORS_SERVER_NAME].instance._registeredTools.github_issue_get.handler({ repo: 'o/r', number: 1 }, {});
    yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: r.content[0].text }] } };
    yield ok(`summary: ${FINAL}`, 's-r');
  })() : undefined, { extraModules: (deps) => [createConnectorsModule(deps, { keys: gh.keys, client: () => gh.client })] });
  m.store.upsertAgent({ ...mk('reader', 'Reader', 'full'), connectors: ['github'] });
  return m;
}
/** Reads an event stream into a string until aborted. */
function listen(base: string, headers: Record<string, string>) {
  const ac = new AbortController();
  let buf = '';
  const done = (async () => {
    try {
      const r = await fetch(base + '/api/events', { headers, signal: ac.signal });
      const rd = r.body!.getReader();
      for (;;) { const { done: d, value } = await rd.read(); if (d) break; buf += Buffer.from(value).toString('utf8'); }
    } catch { /* aborted */ }
  })();
  return { text: () => buf, stop: async () => { await new Promise((r) => setTimeout(r, 50)); ac.abort(); await done; } };
}

test('a bearer-only caller gets no connector data from an owner-started run, on every read path; the app window still does', async () => {
  const m = await rig();
  const client = listen(m.srv.base, asClient);
  const admin = listen(m.srv.base, AUTH);
  await new Promise((r) => setTimeout(r, 50));
  const started = await m.http('POST', '/api/tasks', { agentId: 'reader', prompt: 'read the issue' }, AUTH);
  assert.equal(started.status, 201);
  const id = started.json.id as string;
  await m.engine.waitFor(id, 10000);
  await new Promise((r) => setTimeout(r, 100));
  // (a) GET /api/tasks/:id and /wait
  const get = await m.http('GET', `/api/tasks/${id}`, undefined, asClient);
  assert.ok(![MARK, FINAL].some((x) => get.text.includes(x)), 'GET /api/tasks/:id leaked');
  assert.match(get.text, new RegExp(WITHHELD));
  const waited = (await m.http('GET', `/api/tasks/${id}/wait?timeoutMs=100`, undefined, asClient)).text;
  assert.ok(![MARK, FINAL].some((x) => waited.includes(x)), '/wait leaked');
  assert.ok((await m.http('GET', `/api/tasks/${id}`, undefined, AUTH)).text.includes(MARK), 'the app window keeps the data');
  // (b) legion_status
  const c = await m.mcp();
  const status = (await m.tool(c, 'legion_status', { taskId: id })).text;
  assert.ok(![MARK, FINAL].some((x) => status.includes(x)), 'legion_status leaked');
  // (c) the event stream
  await client.stop(); await admin.stop();
  assert.ok(admin.text().includes(MARK) && admin.text().includes(FINAL), 'the app stream carries the data (control)');
  assert.ok(![MARK, FINAL].some((x) => client.text().includes(x)), 'the bearer stream leaked');
  // (d) continue
  const viaHttp = await m.http('POST', '/api/tasks', { agentId: 'reader', prompt: 'more', continueTaskId: id }, asClient);
  assert.equal(viaHttp.status, 403);
  const viaTool = await m.tool(c, 'legion_continue', { taskId: id, prompt: 'more' });
  assert.equal(viaTool.isError, true);
  assert.match(viaTool.text, /cannot be continued from an MCP client/);
  assert.equal((await m.http('POST', '/api/tasks', { agentId: 'reader', prompt: 'more', continueTaskId: id }, AUTH)).status, 201, 'the owner may continue');
  await c.close();
});

test('a run that never used a connector is not withheld', async () => {
  const m = await rig();
  const t = (await m.http('POST', '/api/tasks', { agentId: 'zealot', prompt: 'hi' }, AUTH)).json.id as string;
  await m.engine.waitFor(t, 10000);
  const r = await m.http('GET', `/api/tasks/${t}`, undefined, asClient);
  assert.match(r.text, /zealot done/);
  assert.ok(!r.text.includes(WITHHELD));
  void startedTask;
});
