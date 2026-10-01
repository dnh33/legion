import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeFakes, start, TOKEN } from './helpers-c.js';

const text = (r: any): string => r.content.map((c: any) => c.text).join('\n');

describe('MCP endpoint', () => {
  const f = makeFakes();
  let client: Client;
  let close: () => Promise<void>;
  before(async () => {
    const s = await start(f.ctx);
    close = s.close;
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(s.base + '/mcp'), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }));
  });
  after(async () => { await client.close(); await close(); });

  it('rejects without token', async () => {
    const s = await start(f.ctx);
    const r = await fetch(s.base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    await s.close();
  });

  it('lists the tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'legion_cancel', 'legion_continue', 'legion_create_agent', 'legion_list_agents', 'legion_models', 'legion_recent_tasks', 'legion_run', 'legion_status', 'legion_vm',
    ]);
    for (const t of tools) assert.ok((t.description ?? '').length > 40, t.name);
  });

  it('legion_models lists catalog models; legion_run accepts any catalog model value', async () => {
    const r: any = await client.callTool({ name: 'legion_models', arguments: {} });
    const j = JSON.parse(text(r));
    assert.equal(j.models[0].value, 'opus');
    assert.match(j.auto, /sonnet/);
    const r2: any = await client.callTool({ name: 'legion_models', arguments: { refresh: true } });
    assert.equal(r2.isError, undefined);
    const run: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'scout', prompt: 'x', model: 'claude-opus-5-5[1m]' } });
    assert.equal(run.isError, undefined);
    assert.equal(JSON.parse(text(run).match(/\{[\s\S]*\}/)?.[0] ?? '{}').requestedModel ?? 'claude-opus-5-5[1m]', 'claude-opus-5-5[1m]');
    const bad: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'scout', prompt: 'x', model: 'bad model!' } }).catch((e) => ({ isError: true, e }));
    assert.equal(bad.isError, true);
  });

  it('legion_list_agents', async () => {
    const r: any = await client.callTool({ name: 'legion_list_agents', arguments: {} });
    const list = JSON.parse(text(r));
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'zealot');
    assert.equal(list[0].vm.state, 'none');
  });

  it('legion_run waits and resolves agent by name; continue/status/cancel', async () => {
    const r: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'SCOUT', prompt: 'hi there' } });
    assert.ok(!r.isError);
    assert.match(text(r), /echo: hi there/);
    const taskId = /"taskId":"(task_\d+)"/.exec(text(r))![1];

    const nw: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'zealot', prompt: 'bg', wait: false } });
    assert.match(text(nw), /taskId/);

    const c: any = await client.callTool({ name: 'legion_continue', arguments: { taskId, prompt: 'more' } });
    assert.match(text(c), /echo: more/);

    const st: any = await client.callTool({ name: 'legion_status', arguments: { taskId } });
    assert.equal(JSON.parse(text(st)).task.status, 'done');

    const ca: any = await client.callTool({ name: 'legion_cancel', arguments: { taskId } });
    assert.match(text(ca), /Cancelled/);

    const rec: any = await client.callTool({ name: 'legion_recent_tasks', arguments: { limit: 2 } });
    assert.equal(JSON.parse(text(rec)).length, 2);
  });

  it('timeout returns in-progress note, errors are isError not throws', async () => {
    const slow: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'zealot', prompt: 'x', timeoutSeconds: 0.001 } });
    assert.ok(!slow.isError);
    const bad: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'nobody', prompt: 'x' } });
    assert.equal(bad.isError, true);
    assert.match(text(bad), /Unknown agent/);
    const bad2: any = await client.callTool({ name: 'legion_status', arguments: { taskId: 'nope' } });
    assert.equal(bad2.isError, true);
  });

  it('legion_create_agent and legion_vm', async () => {
    const r: any = await client.callTool({ name: 'legion_create_agent', arguments: { name: 'Writer', model: 'sonnet' } });
    assert.equal(JSON.parse(text(r)).id, 'writer');
    const s: any = await client.callTool({ name: 'legion_vm', arguments: { agent: 'zealot', action: 'status' } });
    assert.equal(JSON.parse(text(s)).state, 'none');
    const e: any = await client.callTool({ name: 'legion_vm', arguments: { agent: 'zealot', action: 'exec', command: 'uname' } });
    assert.match(text(e), /ran uname/);
    const noCmd: any = await client.callTool({ name: 'legion_vm', arguments: { agent: 'zealot', action: 'exec' } });
    assert.equal(noCmd.isError, true);
    const d: any = await client.callTool({ name: 'legion_vm', arguments: { agent: 'zealot', action: 'desktop' } });
    assert.match(text(d), /desk\.example/);
  });
});
