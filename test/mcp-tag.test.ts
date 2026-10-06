/**
 * The Legion mark inside Claude Code: legion_run and legion_continue end with one short status line, "Ŧ LEGION · sworn · <state>",
 * as a separate LAST text block. content[0] is unchanged, legion_status stays pure JSON, and the tag never instructs the model.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeFakes, start, TOKEN } from './helpers-c.js';
import { legionTag } from '../src/core/mcp-tools.js';

const TAG = /^Ŧ LEGION · sworn · (queued|running|done|fault|cancelled)$/;

describe('MCP: the Legion mark', () => {
  const f = makeFakes();
  let client: Client;
  let close: () => Promise<void>;
  before(async () => {
    const s = await start(f.ctx);
    close = s.close;
    client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(s.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
  });
  after(async () => { await client.close(); await close(); });

  it('legion_run: the answer stays first, the mark is the last block', async () => {
    const r: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'scout', prompt: 'hi there' } });
    assert.ok(!r.isError);
    assert.equal(r.content.length, 2);
    assert.match(r.content[0].text, /echo: hi there/);
    assert.match(r.content[0].text, /"taskId":"task_\d+"/);
    assert.ok(!r.content[0].text.includes('Ŧ'), 'the mark is not mixed into the answer');
    assert.equal(r.content[1].text, 'Ŧ LEGION · sworn · done');
  });

  it('legion_run wait=false and legion_continue carry the mark too', async () => {
    const nw: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'zealot', prompt: 'bg', wait: false } });
    assert.match(nw.content.at(-1).text, TAG);
    const taskId = /"taskId":"(task_\d+)"/.exec(nw.content[0].text)![1];
    const done: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'scout', prompt: 'x' } });
    const id2 = /"taskId":"(task_\d+)"/.exec(done.content[0].text)![1];
    const c: any = await client.callTool({ name: 'legion_continue', arguments: { taskId: id2, prompt: 'more' } });
    assert.equal(c.content.at(-1).text, 'Ŧ LEGION · sworn · done');
    assert.ok(taskId);
  });

  it('legion_status stays one pure JSON block; errors that are not a task carry no mark', async () => {
    const r: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'scout', prompt: 'y' } });
    const taskId = /"taskId":"(task_\d+)"/.exec(r.content[0].text)![1];
    const st: any = await client.callTool({ name: 'legion_status', arguments: { taskId } });
    assert.equal(st.content.length, 1);
    assert.equal(JSON.parse(st.content[0].text).task.status, 'done');
    const bad: any = await client.callTool({ name: 'legion_run', arguments: { agent: 'nobody', prompt: 'x' } });
    assert.equal(bad.isError, true);
    assert.equal(bad.content.length, 1);
  });

  it('the mark is a short label, never an instruction', () => {
    for (const s of ['queued', 'running', 'done', 'error', 'cancelled'] as const) {
      const t = legionTag(s);
      assert.match(t, TAG);
      assert.ok(t.length <= 48, t);
      assert.ok(!/\b(you|your|please|must|should|ignore|always|never)\b/i.test(t), t);
    }
    assert.equal(legionTag('error'), 'Ŧ LEGION · sworn · fault');
    assert.equal(legionTag('queued'), 'Ŧ LEGION · sworn · queued', 'a task waiting for a free seat is not called running');
  });
});
