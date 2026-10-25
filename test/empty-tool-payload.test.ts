import test from 'node:test';
import assert from 'node:assert/strict';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import type { FakeReq } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';

const toolMsg = (req: FakeReq, id: string): string => (req.body.messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';

test('E1 ask with an agent and no message or brief says what it received and what it needs', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'e1', name: 'mcp__legion__ask', args: { agent: 'builder' } }]); else replyText(res, 'ok'); });
  try {
    const t = await run(setup(f));
    assert.equal(t.status, 'done');
    const m = toolMsg(f.requests[1]!, 'e1');
    assert.match(m, /Received: agent=builder, message=<absent>, brief=<absent>\./);
    assert.match(m, /Pass message \(string\) or brief \{goal, done_when\[1-4\]\}\./);
    assert.doesNotMatch(m, /^Error: Give a message or a brief\.$/);
  } finally { await f.close(); }
});

test('E2 a tool call whose arguments arrive empty is refused before dispatch, with the reason and the required fields', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'e2', name: 'mcp__legion__ask', args: '' }]); else replyText(res, 'ok'); });
  try {
    const h = setup(f);
    const t = await run(h);
    assert.equal(t.status, 'done');
    const m = toolMsg(f.requests[1]!, 'e2');
    assert.match(m, /arrived empty/);
    assert.match(m, /The tool was not run/);
    assert.match(m, /agent/);
  } finally { await f.close(); }
});

test('E3 the second identical failing call is corrected and not run; the third ends the run and leaves a diagnostic in the task', async () => {
  let r = 0;
  const f = await startFake((_q, res) => { r++; replyTools(res, [{ id: `f${r}`, name: 'mcp__legion__ask', args: { agent: 'nobody' } }]); });
  try {
    const h = setup(f);
    const t = await run(h);
    assert.equal(t.status, 'error');
    assert.equal(f.requests.length, 3);
    assert.match(toolMsg(f.requests[1]!, 'f1'), /Received: agent=nobody/);
    const second = toolMsg(f.requests[2]!, 'f2');
    assert.match(second, /same call again/);
    assert.match(second, /message/);
    assert.match(t.error ?? '', /kept repeating a failing tool call/);
    assert.match(t.error ?? '', /mcp__legion__ask/);
    assert.match(t.error ?? '', /3 times/);
    assert.match(t.error ?? '', /"agent":"nobody"/);
  } finally { await f.close(); }
});
