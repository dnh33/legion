/**
 * The per-agent switch for Claude Code's own task tools (AgentProfile.taskList): POST/PATCH /api/agents store 'on' or
 * 'off', null clears it back to the default (on for the lead, off for the rest), and any other value is a 400.
 */
import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { makeFakes, start, AUTH } from './helpers-c.js';

describe('agent task list setting (AgentProfile.taskList)', () => {
  const f = makeFakes();
  let base = '';
  let close: () => Promise<void>;
  before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
  after(async () => { await close(); });

  const api = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { ...AUTH, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } });
  const post = async (body: unknown) => api('/api/agents', { method: 'POST', body: JSON.stringify(body) });
  const patch = async (id: string, body: unknown) => api(`/api/agents/${id}`, { method: 'PATCH', body: JSON.stringify(body) });

  it('PATCH stores on/off, a patch without the key leaves it alone, null clears it to the default', async () => {
    const a = await (await post({ name: 'Lister' })).json();
    assert.equal(a.taskList, undefined, 'no setting until one is made');
    const on = await (await patch(a.id, { taskList: 'on' })).json();
    assert.equal(on.taskList, 'on');
    assert.equal(f.ctx.store.getAgent(a.id)?.taskList, 'on', 'stored, so the engine reads it');
    const kept = await (await patch(a.id, { description: 'x' })).json();
    assert.equal(kept.taskList, 'on');
    const cleared = await (await patch(a.id, { taskList: null })).json();
    assert.equal(cleared.taskList, undefined);
    assert.equal(f.ctx.store.getAgent(a.id)?.taskList, undefined);
  });

  it('POST takes the setting too; any other value is a 400 naming the field', async () => {
    const a = await (await post({ name: 'Offer', taskList: 'off' })).json();
    assert.equal(a.taskList, 'off');
    const r = await patch(a.id, { taskList: 'maybe' });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(await r.json()), /taskList/);
  });
});
