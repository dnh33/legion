/**
 * A model that writes a tool call as plain text, or sends a native call with arguments that are not an object.
 * The owner must not see raw call markup as the answer, and the model must get an error it can act on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hideLeakedToolCalls, parseToolArguments } from '../src/core/providers/tool-loop.js';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import type { FakeReq } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';

const toolMsg = (req: FakeReq, id: string): string => (req.body.messages as any[]).find((m) => m.role === 'tool' && m.tool_call_id === id)?.content ?? '';

test('leaked <tool_call> and <function=...> markup is removed from the shown text; ordinary text stays', () => {
  const a = hideLeakedToolCalls('I will check.\n<tool_call>\n{"name": "x", "arguments": {}}\n</tool_call>\nDone.');
  assert.equal(a.hidden, true);
  assert.equal(a.text.replace(/\s+/g, ' ').trim(), 'I will check. Done.');
  const b = hideLeakedToolCalls('Reading it.\n<function=read_file>\n<parameter=path>a.txt</parameter>\n</function>');
  assert.equal(b.text.trim(), 'Reading it.');
  // a call that never closed (the reply was cut) goes to the end
  const c = hideLeakedToolCalls('Start.\n<tool_call>{"name": "x", "argu');
  assert.equal(c.text.trim(), 'Start.');
  // prose that merely mentions the words is not markup
  const d = hideLeakedToolCalls('A tool_call is a request. Use function=none rarely.');
  assert.equal(d.hidden, false);
  assert.equal(d.text, 'A tool_call is a request. Use function=none rarely.');
});

test('arguments: an object passes, a doubled-up JSON string is repaired, everything else gets a precise problem', () => {
  assert.deepEqual(parseToolArguments('{"path":"a.txt"}'), { input: { path: 'a.txt' } });
  assert.deepEqual(parseToolArguments('  '), { input: {} });
  // the object arrived as a JSON string of an object: one reading only, so it is accepted
  assert.deepEqual(parseToolArguments(JSON.stringify(JSON.stringify({ path: 'a.txt' }))), { input: { path: 'a.txt' } });
  const bad = parseToolArguments('{not json');
  assert.ok('problem' in bad && /not valid JSON/.test(bad.problem));
  const arr = parseToolArguments('["a"]');
  assert.ok('problem' in arr && /array/.test(arr.problem));
  const str = parseToolArguments('"just text"');
  assert.ok('problem' in str && /string/.test(str.problem));
  const big = parseToolArguments(JSON.stringify({ a: 'x'.repeat(70_000) }));
  assert.ok('problem' in big && /size limit/.test(big.problem));
});

test('a native call with bad arguments: the model is told which problem and to send one JSON object', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n === 1) replyTools(res, [{ id: 'j', name: 'mcp__legion__agents', args: '["a"]' }]); else replyText(res, 'ok'); });
  try {
    const h = setup(f);
    const t = await run(h);
    assert.equal(t.status, 'done');
    const msg = toolMsg(f.requests[1]!, 'j');
    assert.match(msg, /mcp__legion__agents/);
    assert.match(msg, /JSON array/);
    assert.match(msg, /send it as one JSON object/i);
    assert.match(msg, /not run/);
  } finally { await f.close(); }
});

test('a reply that is only leaked call markup is not shown as the answer; the run says what happened', async () => {
  const f = await startFake((_r, res) => replyText(res, '<tool_call>\n{"name": "mcp__legion__agents", "arguments": {}}\n</tool_call>'));
  try {
    const h = setup(f);
    const t = await run(h);
    assert.equal(t.status, 'error');
    assert.match(t.error ?? '', /as plain text/);
    assert.equal(h.store.msgs.some((m: any) => /<tool_call>/.test(m.text ?? '')), false);
  } finally { await f.close(); }
});

test('live stream: leaked markup split across deltas never reaches the UI; prose with "<" still comes through', async () => {
  const { streamWithoutLeakedCalls } = await import('../src/core/providers/tool-loop.js');
  const run1 = (chunks: string[]) => {
    const out: string[] = [];
    const f = streamWithoutLeakedCalls((t) => out.push(t));
    for (const c of chunks) f.push(c);
    f.flush();
    return out.join('');
  };
  const a = run1(['<tool', '_call><function=x>', '{"a":1}</tool', '_call>Done']);
  assert.equal(a, 'Done');
  assert.equal(run1(['Hi <fun', 'ction=read>x</function> bye']), 'Hi  bye');
  assert.equal(run1(['a ', '< b', ' and <t', 'able> ok']), 'a < b and <table> ok');
  assert.equal(run1(['ends with <tool']), 'ends with <tool');
  assert.equal(run1(['x<tool_call>never closed']), 'x');
});
