import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import { run, setup } from './providers-harness.js';
import { TokenLedger } from '../src/core/providers/usage.js';
import { normalizeEntry } from '../src/core/providers/config.js';

const U = { prompt_tokens: 60, completion_tokens: 60 };
const sysText = (h: ReturnType<typeof setup>, id: string): string => h.store.listMessages(id).filter((m) => m.role === 'system').map((m) => m.text).join('\n');

test('A4 default: no cap at all, and tokens are still counted for the panel', async () => {
  let n = 0;
  const f = await startFake((_r, res) => { n++; if (n < 4) replyTools(res, [{ name: 'nope' + n, args: {} }], U); else replyText(res, 'done', U); });
  try {
    const h = setup(f);
    const t = await run(h);
    assert.equal(t.status, 'done'); assert.equal(f.requests.length, 4);
    assert.equal(f.requests.some((r) => 'max_tokens' in r.body), false, 'no output limit is sent without a cap');
    assert.equal(h.providers.usage.today('fake'), 480);
  } finally { await f.close(); }
});

test('A4 per-task cap: the run stops before the next model turn with a plain, visible message, and no further request is made', async () => {
  const f = await startFake((_r, res) => replyTools(res, [{ name: 'nope', args: {} }], U));
  try {
    const h = setup(f, { entry: { tokenCapPerTask: 100 } });
    const t = await run(h);
    assert.equal(t.status, 'error');
    assert.equal(f.requests.length, 1, 'turn 1 used 120 tokens, over 100: no turn 2');
    assert.match(t.error ?? '', /token limit you set per task \(120 of 100\)/);
    assert.match(sysText(h, t.id), /Settings, Providers/, 'a notice is in the thread');
    assert.equal(f.requests[0]!.body.max_tokens, 100, 'the http request carries the room left as the output limit');
  } finally { await f.close(); }
});

test('A4 per-task cap counts the earlier runs of a continued task', async () => {
  const f = await startFake((_r, res) => replyText(res, 'ok', U));
  try {
    const h = setup(f, { entry: { tokenCapPerTask: 150 } });
    const t1 = await run(h);
    assert.equal(t1.status, 'done');
    const t2 = h.engine.startTask({ agentId: 'a1', prompt: 'again', source: 'ui', continueTaskId: t1.id } as any);
    const d2 = await h.engine.waitFor(t2.id, 8000);
    assert.equal(d2.status, 'done', '120 used, 30 left: this run still starts');
    assert.equal(f.requests[1]!.body.max_tokens, 30);
    const t3 = h.engine.startTask({ agentId: 'a1', prompt: 'a third', source: 'ui', continueTaskId: t1.id } as any);
    const d3 = await h.engine.waitFor(t3.id, 8000);
    assert.equal(d3.status, 'error'); assert.match(d3.error ?? '', /per task/);
    assert.equal(f.requests.length, 2, 'the third run sent nothing');
  } finally { await f.close(); }
});

test('A4 per-day cap: a task over the cap the same day is refused before any request; the owner default (none) stays when the field is cleared', async () => {
  const f = await startFake((_r, res) => replyText(res, 'ok', U));
  try {
    const h = setup(f, { entry: { tokenCapPerDay: 150 } });
    assert.equal((await run(h)).status, 'done');
    assert.equal((await run(h, 'second')).status, 'done', '120 of 150 used: it starts with 30 left');
    assert.equal(f.requests[1]!.body.max_tokens, 30);
    const t3 = await run(h, 'third');
    assert.equal(t3.status, 'error'); assert.match(t3.error ?? '', /per day \(240 of 150\)/);
    assert.equal(f.requests.length, 2, 'the third task sent nothing');
    assert.equal(h.providers.view().providers.find((p) => p.id === 'fake')!.tokensToday, 240);
    const cleared = normalizeEntry('fake', { ...h.config.providers.entries.fake, tokenCapPerDay: null });
    assert.ok('entry' in cleared && cleared.entry.tokenCapPerDay === undefined, 'null clears the cap');
  } finally { await f.close(); }
});

test('A4 a provider that returns no token counts: the cap uses a stated estimate and still stops the run', async () => {
  const f = await startFake((_r, res) => replyTools(res, [{ name: 'nope', args: {} }]));
  try {
    const h = setup(f, { entry: { tokenCapPerTask: 50 } });
    const t = await run(h);
    assert.equal(t.status, 'error'); assert.match(t.error ?? '', /partly estimated/);
    assert.match(sysText(h, t.id), /no token counts.*estimate/);
  } finally { await f.close(); }
});

test('A4 the daily count is per local day, persisted without any text, and starts again the next day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-usage-'));
  const file = join(dir, 'providers', 'usage.json');
  let now = new Date(2026, 5, 1, 23, 0, 0);
  const a = new TokenLedger(file, () => now);
  a.add('p', 500);
  assert.equal(new TokenLedger(file, () => now).today('p'), 500, 'survives a restart');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['counts', 'day', 'version']);
  now = new Date(2026, 5, 2, 0, 5, 0);
  assert.equal(a.today('p'), 0);
});
