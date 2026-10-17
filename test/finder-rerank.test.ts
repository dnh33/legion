/** The skill finder's Haiku rerank: when it runs, the warm session, how its answer is read, and what it costs. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RERANK_SYSTEM_PROMPT, RerankSession, buildRerankPrompt, isCloseMatch, parseRerankAnswer, readSpend, rerankScores, spendFilePath } from '../src/core/armory/finder/rerank.js';
import type { RerankQuery, RerankSessionOpts } from '../src/core/armory/finder/rerank.js';
import { tempDir } from './tmp-cleanup.js';
import { armoryRig, own } from './armory-rig.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const thisMonth = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-9;
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail('condition not met in time');
    await sleep(3);
  }
}

interface Reply { text?: string; cost?: number; afterMs?: number; never?: boolean; error?: boolean; throws?: boolean }
interface Made { options: any; messages: string[]; closed: boolean }

/**
 * A fake streaming query: it reads each user message as it arrives and answers it as `script` says. `cost` is what that turn cost;
 * a result's total_cost_usd is per turn on a streaming session, not a running total. Records every session it makes.
 */
function fakeSessions(script: (n: number, text: string, made: Made) => Reply = () => ({ text: '[]' })) {
  const made: Made[] = [];
  const queryFn: RerankQuery = (a) => {
    const rec: Made = { options: a.options, messages: [], closed: false };
    made.push(rec);
    let n = 0;
    const gen = (async function* () {
      for await (const m of a.prompt as AsyncIterable<any>) {
        if (rec.closed) return;
        const text = String(m.message.content);
        rec.messages.push(text);
        const r = script(n++, text, rec);
        if (r.never) await new Promise<void>(() => undefined);
        if (r.afterMs) await sleep(r.afterMs);
        if (r.throws) throw new Error('boom');
        yield { type: 'assistant', message: { content: [{ type: 'text', text: r.text ?? '' }] } };
        yield { type: 'result', subtype: r.error ? 'error_during_execution' : 'success', is_error: !!r.error, result: r.text ?? '', total_cost_usd: r.cost ?? 0 };
      }
    })();
    return Object.assign(gen, { close: () => { rec.closed = true; } });
  };
  return { queryFn, made };
}

const CANDS = [{ id: 'a', description: 'alpha skill' }, { id: 'b', description: 'beta skill' }, { id: 'c', description: 'gamma skill' }];
const ask = (extra: Record<string, unknown> = {}) => ({ text: 'please pick one', candidates: CANDS, k: 3, monthlyUsd: 1, ...extra });
const LAUNCH = () => ({ env: { PATH: 'x' }, settings: { disableClaudeAiConnectors: true } });

function sessionOf(dir: string, f: ReturnType<typeof fakeSessions>, extra: Partial<RerankSessionOpts> = {}) {
  const logs: string[] = [];
  const s = new RerankSession({ dataDir: dir, launch: LAUNCH, queryFn: f.queryFn, log: (m) => logs.push(m), deadlineMs: 2000, hardMs: 5000, warmMs: 2000, ...extra });
  return { s, logs };
}
/** Starts the session with one turn (that turn keeps the fused order) and waits until the warm-up has been answered. */
async function warmUp(s: RerankSession): Promise<void> {
  assert.equal(await s.pick(ask()), undefined, 'the turn that starts the session keeps the fused order');
  await until(() => s.state() === 'ready');
}

describe('rerank: when it runs', () => {
  it('runs when the top three are within the margin, and not when the best one stands clear', () => {
    assert.equal(isCloseMatch([1, 0.95, 0.9], 0.15), true, 'a 0.10 spread is close');
    assert.equal(isCloseMatch([1, 0.95, 0.7], 0.15), false, 'a 0.30 spread is clear');
    assert.equal(isCloseMatch([1], 0.15), false, 'one result has nothing to choose between');
    assert.equal(isCloseMatch([1, 0.9], 0.15), true, 'with two results the last one is compared');
  });

  it('normalises keyword scores by the best BM25 of the candidates, as the fused score does at weight 0', () => {
    const r = (id: string, bm25: number, boost = 1) => ({ id, score: bm25 * boost, bm25, matched: [], boost });
    assert.deepEqual(rerankScores([r('a', 6), r('b', 5.8), r('c', 5.5)], false, 6).map((x) => Math.round(x * 1000) / 1000), [1, 0.967, 0.917]);
    // Fused results are already on the 0..1 scale: their own score is the margin.
    assert.deepEqual(rerankScores([{ ...r('a', 0), score: 0.8 }, { ...r('b', 0), score: 0.7 }], true, 0), [0.8, 0.7]);
  });
});

describe('rerank: the answer', () => {
  it('keeps only candidate ids, drops a forged id, dedupes and cuts to k', () => {
    assert.deepEqual(parseRerankAnswer('["ghost","b","a"]', ['a', 'b', 'c'], 3), ['b', 'a']);
    assert.deepEqual(parseRerankAnswer('["a","a","b"]', ['a', 'b', 'c'], 3), ['a', 'b']);
    assert.deepEqual(parseRerankAnswer('["a","b","c"]', ['a', 'b', 'c'], 2), ['a', 'b']);
  });

  it('an answer of only forged ids keeps the fused order (undefined), but a genuine [] stays []', () => {
    assert.equal(parseRerankAnswer('["ghost","other"]', ['a', 'b'], 3), undefined);
    assert.deepEqual(parseRerankAnswer('[]', ['a'], 3), []);
    assert.deepEqual(parseRerankAnswer(' \n[] \n', ['a'], 3), []);
  });

  it('parses strictly: the trimmed text as a JSON array, or one fenced block, nothing else', () => {
    const ids = ['a', 'b', 'c'];
    assert.deepEqual(parseRerankAnswer('  ["c","a"]\n', ids, 3), ['c', 'a']);
    assert.deepEqual(parseRerankAnswer('```json\n["c","a"]\n```', ids, 3), ['c', 'a']);
    assert.deepEqual(parseRerankAnswer('```json\r\n["b"]\r\n```\n', ids, 3), ['b']);
    assert.deepEqual(parseRerankAnswer('```\n["b"]\n```', ids, 3), ['b']);
    assert.equal(parseRerankAnswer('Best first: ["c","a"]. Done.', ids, 3), undefined, 'prose around the array');
    assert.equal(parseRerankAnswer('["a"] and then ["b"]', ids, 3), undefined, 'two arrays');
    assert.equal(parseRerankAnswer('```json\n["a"]\n```\n```json\n["b"]\n```', ids, 3), undefined, 'two fenced blocks');
    assert.equal(parseRerankAnswer('Here you go:\n```json\n["a"]\n```', ids, 3), undefined, 'prose before the fence');
    assert.equal(parseRerankAnswer('[not json', ids, 3), undefined);
    assert.equal(parseRerankAnswer('[1, 2]', ids, 3), undefined, 'non-string items');
    assert.equal(parseRerankAnswer('{"ids":["a"]}', ids, 3), undefined);
    assert.equal(parseRerankAnswer('I think the best is a.', ids, 3), undefined);
    assert.equal(parseRerankAnswer('', ids, 3), undefined);
  });

  it('builds the prompt: the user text cut to 2000 characters, one line per candidate, then the instruction with k', () => {
    const p = buildRerankPrompt('x'.repeat(2500), [{ id: 'a', description: 'line one\nline two' }], 2);
    assert.equal(p.startsWith('x'.repeat(2000) + '\n'), true);
    assert.equal(p.includes('\na: line one line two\n'), true, 'one line per candidate');
    assert.match(p, /Return only the ids that clearly fit, best first, at most 2\. Return \[\] if none fit\. Ids only\.$/);
  });
});

describe('rerank: the warm session', () => {
  it('starts in the background on the first turn, then answers from the warm session', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => ({ text: n === 0 ? '[]' : '["c","a"]', cost: 0.001 }));
    const { s } = sessionOf(dir, f);
    assert.equal(s.state(), 'none');
    await warmUp(s);
    assert.equal(f.made.length, 1, 'one session');
    assert.equal(f.made[0]!.messages.length, 1, 'only the warm-up so far');
    assert.deepEqual(await s.pick(ask()), ['c', 'a']);
    assert.equal(f.made.length, 1, 'the same session served it');
    assert.match(f.made[0]!.messages[1]!, /a: alpha skill\nb: beta skill\nc: gamma skill/);
    s.close();
  });

  it('a turn that finds the session still warming keeps the fused order and starts nothing new', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => ({ text: '[]', afterMs: n === 0 ? 60 : 0 }));
    const { s } = sessionOf(dir, f);
    await s.pick(ask());
    await until(() => f.made[0]!.messages.length === 1);
    assert.equal(s.state(), 'warming');
    assert.equal(await s.pick(ask()), undefined);
    assert.equal(f.made.length, 1);
    assert.equal(f.made[0]!.messages.length, 1, 'no request was sent while warming');
    s.close();
  });

  it('the session carries no tools, its own short system prompt, and the isolation options', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions();
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    const o = f.made[0]!.options;
    assert.equal(o.model, 'haiku');
    assert.deepEqual(o.tools, []);
    assert.equal(o.systemPrompt, RERANK_SYSTEM_PROMPT);
    assert.equal(RERANK_SYSTEM_PROMPT, 'You rank skills for a request. Each message is a new request, unrelated to earlier ones. Answer with a JSON array of skill ids only.');
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.persistSession, false);
    assert.equal(o.settings.disableAllHooks, true);
    assert.equal(o.settings.disableClaudeAiConnectors, true);
    assert.deepEqual(o.env, { PATH: 'x' });
    assert.equal('mcpServers' in o, false);
    assert.ok(o.abortController instanceof AbortController);
    s.close();
  });

  it('serves one request at a time: a busy session leaves the second turn on the fused order, with no queue', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => ({ text: '["a"]', afterMs: n === 0 ? 0 : 80 }));
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    const first = s.pick(ask());
    assert.equal(await s.pick(ask()), undefined, 'busy: fused order');
    assert.deepEqual(await first, ['a']);
    assert.equal(f.made[0]!.messages.length, 2, 'the warm-up and one request, nothing queued');
    s.close();
  });

  it('a request that misses the deadline is abandoned: the turn goes on, the late answer is dropped, the session stays busy until it arrives', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => (n === 0 ? { text: '[]', cost: 0.001 } : n === 1 ? { text: '["a"]', afterMs: 80, cost: 0.0005 } : { text: '["b"]', cost: 0.001 }));
    const { s, logs } = sessionOf(dir, f, { deadlineMs: 20 });
    await warmUp(s);
    assert.equal(await s.pick(ask()), undefined, 'past the deadline: the fused order stands');
    assert.deepEqual(logs, ['finder: rerank skipped (timeout)']);
    assert.equal(await s.pick(ask()), undefined, 'still busy with the abandoned request');
    assert.equal(f.made[0]!.messages.length, 2);
    await sleep(120);
    assert.deepEqual(await s.pick(ask()), ['b'], 'the late answer ["a"] was dropped; the next request works');
    s.close();
  });

  it('an abandoned request that never answers is closed at the hard ceiling', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => (n === 0 ? { text: '[]' } : { never: true }));
    const { s } = sessionOf(dir, f, { deadlineMs: 10, hardMs: 60 });
    await warmUp(s);
    assert.equal(await s.pick(ask()), undefined);
    assert.equal(s.state(), 'ready');
    await until(() => s.state() === 'none');
    assert.equal(f.made[0]!.closed, true, 'the child was closed through its handle');
  });

  it('is recycled after 10 reranks: closed, and a later turn starts a new one', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions(() => ({ text: '["a"]' }));
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    for (let i = 0; i < 10; i++) assert.deepEqual(await s.pick(ask()), ['a'], `rerank ${i + 1}`);
    assert.equal(f.made[0]!.closed, true, 'closed after the 10th');
    assert.equal(s.state(), 'none');
    assert.equal(await s.pick(ask()), undefined, 'the next turn starts a new session and keeps the fused order');
    assert.equal(f.made.length, 2);
    await until(() => s.state() === 'ready');
    assert.deepEqual(await s.pick(ask()), ['a']);
    s.close();
  });

  it('is closed after the idle time', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions();
    const { s } = sessionOf(dir, f, { idleMs: 40 });
    await warmUp(s);
    assert.equal(f.made[0]!.closed, false);
    await until(() => s.state() === 'none');
    assert.equal(f.made[0]!.closed, true);
  });

  it('after dispose a turn never starts a CLI, and dispose closes the one that runs', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions();
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    s.dispose();
    assert.equal(f.made[0]!.closed, true);
    assert.equal(await s.pick(ask()), undefined);
    assert.equal(await s.pick(ask()), undefined);
    assert.equal(f.made.length, 1, 'no new session');
  });

  it('close() closes the child, and the next turn may start a new session', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions();
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    s.close();
    assert.equal(f.made[0]!.closed, true);
    assert.equal(s.state(), 'none');
    await s.pick(ask());
    assert.equal(f.made.length, 2);
    s.close();
  });

  it('backs off for 60 s after 3 failures in a row, then tries again', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions(() => ({ error: true }));
    let t = new Date(2026, 4, 10, 12, 0, 0).getTime();
    const { s, logs } = sessionOf(dir, f, { now: () => new Date(t) });
    for (let i = 0; i < 3; i++) {
      assert.equal(await s.pick(ask()), undefined);
      await until(() => s.state() === 'none');
    }
    assert.equal(f.made.length, 3, 'three sessions failed');
    assert.ok(logs.includes('finder: rerank skipped (paused after repeated failures)'));
    t += 30_000;
    await s.pick(ask());
    assert.equal(f.made.length, 3, 'no new session during the backoff');
    t += 31_000;
    await s.pick(ask());
    assert.equal(f.made.length, 4, 'a new session after 60 s');
    s.close();
  });

  it('a timeout is not a failure: four timeouts in a row never start the backoff', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => (n === 0 ? { text: '[]' } : { text: '["a"]', afterMs: 40 }));
    const { s, logs } = sessionOf(dir, f, { deadlineMs: 10 });
    await warmUp(s);
    for (let i = 0; i < 4; i++) {
      assert.equal(await s.pick(ask()), undefined);
      await sleep(70);
    }
    assert.equal(f.made.length, 1, 'the same session kept serving');
    assert.equal(f.made[0]!.messages.length, 5, 'the warm-up and four requests');
    assert.ok(!logs.some((l) => l.includes('paused')));
    s.close();
  });

  it('three invalid answers in a row start the backoff', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => ({ text: n === 0 ? '[]' : 'no array here' }));
    const { s, logs } = sessionOf(dir, f);
    await warmUp(s);
    for (let i = 0; i < 3; i++) assert.equal(await s.pick(ask()), undefined);
    assert.ok(logs.includes('finder: rerank skipped (paused after repeated failures)'));
    assert.equal(s.state(), 'none');
    await s.pick(ask());
    assert.equal(f.made.length, 1, 'no new session during the backoff');
  });

  it('a stream that throws, and a query that throws on creation, are failures that never reach the turn', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions(() => ({ throws: true }));
    const { s, logs } = sessionOf(dir, f);
    assert.equal(await s.pick(ask()), undefined);
    await until(() => s.state() === 'none');
    assert.deepEqual(logs, ['finder: rerank skipped (error)']);
    const bad = new RerankSession({ dataDir: dir, launch: LAUNCH, queryFn: () => { throw new Error('no cli'); } });
    assert.equal(await bad.pick(ask()), undefined);
    assert.equal(bad.state(), 'none');
  });

  it('no launch settings (no config) means no rerank: the full process environment is never used', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions();
    const s = new RerankSession({ dataDir: dir, launch: () => undefined, queryFn: f.queryFn });
    assert.equal(await s.pick(ask()), undefined);
    assert.equal(f.made.length, 0);
    assert.deepEqual(readSpend(dir), {});
  });

  it('a log line names the reason and never carries the prompt', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => (n === 0 ? { text: '[]' } : { text: 'no array here' }));
    const { s, logs } = sessionOf(dir, f);
    await warmUp(s);
    await s.pick(ask({ text: 'SECRET owner words about invoices' }));
    assert.deepEqual(logs, ['finder: rerank skipped (unusable answer)']);
    for (const l of logs) assert.doesNotMatch(l, /SECRET|invoices|alpha/);
    s.close();
  });

  it('an answer of only forged ids keeps the fused order; a genuine [] comes back as []', async () => {
    const dir = tempDir('legion-rerank-');
    const answers = ['[]', '["ghost"]', '[]'];
    const f = fakeSessions((n) => ({ text: answers[n] }));
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    assert.equal(await s.pick(ask()), undefined, 'forged only');
    assert.deepEqual(await s.pick(ask()), [], 'a real empty answer');
    s.close();
  });
});

describe('rerank: spend', () => {
  it('reserves an estimate before each request and replaces it with the cost difference between results', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => (n === 0 ? { text: '[]', cost: 0.0012 } : { text: '["a"]', cost: 0.0007, afterMs: 60 }));
    const { s } = sessionOf(dir, f);
    await s.pick(ask());
    assert.ok(near(readSpend(dir)[thisMonth()], 0.002), 'the warm-up is reserved at once');
    await until(() => s.state() === 'ready');
    assert.ok(near(readSpend(dir)[thisMonth()], 0.0012), 'then replaced by its cost');
    const p = s.pick(ask());
    await sleep(15);
    assert.ok(near(readSpend(dir)[thisMonth()], 0.0012 + 0.002), 'the request holds its reservation while it runs');
    await p;
    assert.ok(near(readSpend(dir)[thisMonth()], 0.0012 + 0.0007), 'the month adds the difference between the two cumulative totals');
    s.close();
  });

  it('books each result as the cost of that turn alone, so growing per-turn costs reach the cap at the right time', async () => {
    const dir = tempDir('legion-rerank-');
    const costs = [0.00055, 0.00087, 0.00093, 0.00099];
    const f = fakeSessions((n) => ({ text: '["a"]', cost: costs[n] }));
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    for (let i = 1; i < 4; i++) assert.deepEqual(await s.pick(ask()), ['a']);
    assert.ok(near(readSpend(dir)[thisMonth()], costs.reduce((a, b) => a + b, 0)), 'the sum of the four turns, not a sum of running totals');
    // 0.00334 spent: a request fits a cap of 0.0054 (0.00334 + 0.002) but not 0.0053.
    assert.equal(await s.pick(ask({ monthlyUsd: 0.0053 })), undefined);
    assert.deepEqual(await s.pick(ask({ monthlyUsd: 0.0054 })), ['a']);
    s.close();
  });

  it('a result cheaper than its reservation refunds the difference', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions(() => ({ text: '[]', cost: 0.0004 }));
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    assert.ok(near(readSpend(dir)[thisMonth()], 0.0004));
    s.close();
  });

  it('an abandoned request keeps its reservation', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => (n === 0 ? { text: '[]', cost: 0.001 } : { text: '["a"]', cost: 0.0004, afterMs: 60 }));
    const { s } = sessionOf(dir, f, { deadlineMs: 15 });
    await warmUp(s);
    assert.equal(await s.pick(ask()), undefined);
    await sleep(100);
    assert.ok(near(readSpend(dir)[thisMonth()], 0.001 + 0.002), 'the cost 0.0004 did not replace the 0.002');
    s.close();
  });

  it('a killed request keeps its reservation', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => (n === 0 ? { text: '[]', cost: 0.001 } : { never: true }));
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    const p = s.pick(ask());
    await sleep(15);
    s.close();
    assert.equal(await p, undefined);
    assert.ok(near(readSpend(dir)[thisMonth()], 0.003));
  });

  it('refuses when the spend plus the reservation would pass the cap, and makes no session or request', async () => {
    const dir = tempDir('legion-rerank-');
    mkdirSync(join(dir, 'skill-finder'), { recursive: true });
    writeFileSync(spendFilePath(dir), JSON.stringify({ [thisMonth()]: 0.9985 }));
    const f = fakeSessions();
    const { s, logs } = sessionOf(dir, f);
    assert.equal(await s.pick(ask({ monthlyUsd: 1 })), undefined);
    assert.equal(f.made.length, 0, 'the cap stops the session from starting');
    assert.deepEqual(logs, ['finder: rerank skipped (monthly cap)']);
    assert.ok(near(readSpend(dir)[thisMonth()], 0.9985), 'nothing booked');
  });

  it('refuses a request when the cap is reached while the session is warm, and a cap of 0 never calls', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeSessions((n) => ({ text: '["a"]', cost: n === 0 ? 0.0015 : 0 }));
    const { s } = sessionOf(dir, f);
    await warmUp(s);
    assert.equal(await s.pick(ask({ monthlyUsd: 0.003 })), undefined, '0.0015 + 0.002 passes 0.003');
    assert.equal(f.made[0]!.messages.length, 1, 'no request was sent');
    assert.deepEqual(await s.pick(ask({ monthlyUsd: 0.0035 })), ['a'], '0.0015 + 0.002 fits 0.0035');
    s.close();
    const g = fakeSessions();
    const zero = sessionOf(tempDir('legion-rerank-'), g).s;
    assert.equal(await zero.pick(ask({ monthlyUsd: 0 })), undefined);
    assert.equal(g.made.length, 0);
  });

  it('rolls over with the month: last month\'s spend does not count, and the new month starts its own total', async () => {
    const dir = tempDir('legion-rerank-');
    mkdirSync(join(dir, 'skill-finder'), { recursive: true });
    writeFileSync(spendFilePath(dir), JSON.stringify({ '2026-01': 1 }));
    const f = fakeSessions((n) => ({ text: '[]', cost: 0.001 }));
    let when = new Date(2026, 0, 31, 23, 59, 0);
    const { s } = sessionOf(dir, f, { now: () => when });
    assert.equal(await s.pick(ask({ monthlyUsd: 1 })), undefined);
    assert.equal(f.made.length, 0, 'January is at the cap');
    when = new Date(2026, 1, 1, 0, 1, 0);
    await s.pick(ask({ monthlyUsd: 1 }));
    await until(() => s.state() === 'ready');
    const spent = readSpend(dir);
    assert.equal(spent['2026-01'], 1, 'January is untouched');
    assert.ok(near(spent['2026-02'], 0.001), 'February has its own total');
    s.close();
  });
});

describe('rerank: the note', () => {
  // Three skills with the same words: their keyword scores tie, so the margin is 0 and the rerank runs.
  const TIE = 'export invoices to pdf for accounting please';
  const SETTINGS = { rerank: true, rerankMonthlyUsd: 5, threshold: 'eager' };
  async function tiedRig(f: ReturnType<typeof fakeSessions> | undefined, settings: Record<string, unknown> = SETTINGS, tuning: Partial<RerankSessionOpts> = {}) {
    const rig = armoryRig({ modOpts: { ...(f ? { rerankQuery: f.queryFn } : {}), rerankTuning: tuning } });
    for (const n of ['invoice-pdf-a', 'invoice-pdf-b', 'invoice-pdf-c']) await own(rig, { name: n, description: 'Export invoices to PDF documents for accounting', body: 'b' });
    await rig.call('POST', '/api/armory/finder', settings);
    return rig;
  }
  const turn = (rig: Awaited<ReturnType<typeof tiedRig>>, prompt = TIE, runtime: 'claude' | 'provider' = 'claude') =>
    rig.mod.turnNote!(rig.agents.get('alpha')!, { prompt, taskId: 't1', runtime });
  /** The first tied turn starts the session and keeps the fused order; this waits until the warm-up is answered. */
  async function warmed(f: ReturnType<typeof fakeSessions>, rig: Awaited<ReturnType<typeof tiedRig>>): Promise<void> {
    const first = await turn(rig);
    assert.ok(first, 'the first turn still has its fused note');
    await until(() => (f.made[0]?.messages.length ?? 0) >= 1);
    await sleep(20);
  }
  const B = 'legion-armory:invoice-pdf-b';
  const A = 'legion-armory:invoice-pdf-a';

  it('the first tied turn keeps the fused order; later ones list the skills in the order the session picks', async () => {
    const f = fakeSessions((n) => ({ text: n === 0 ? '[]' : `["${B}","${A}"]`, cost: 0.001 }));
    const rig = await tiedRig(f);
    const fused = await turn(rig);
    assert.ok(fused);
    assert.equal(f.made.length, 1, 'the session started in the background');
    await until(() => (f.made[0]!.messages.length >= 1));
    await sleep(20);
    const note = await turn(rig);
    assert.ok(note, 'a note');
    assert.deepEqual(note!.suggested, [B, A]);
    assert.match(note!.text, /legion-armory:invoice-pdf-b[\s\S]*legion-armory:invoice-pdf-a/);
    assert.doesNotMatch(note!.text, /invoice-pdf-c/);
    await rig.mod.dispose?.();
  });

  it('an answer of only forged ids keeps the fused order and the note (the if (ids) branch is skipped)', async () => {
    const f = fakeSessions((n) => ({ text: n === 0 ? '[]' : '["legion-armory:ghost"]' }));
    const rig = await tiedRig(f);
    await warmed(f, rig);
    const fusedOrder = (await tiedRig(undefined, { rerank: false, threshold: 'eager' }).then((r) => turn(r)))!.suggested;
    const note = await turn(rig);
    assert.ok(note, 'a note, not []');
    assert.deepEqual(note!.suggested, fusedOrder, 'the same order as with the rerank off');
    assert.equal(f.made[0]!.messages.length, 2, 'the request was sent');
    await rig.mod.dispose?.();
  });

  it('a genuine [] answer gives no note', async () => {
    const f = fakeSessions(() => ({ text: '[]' }));
    const rig = await tiedRig(f);
    await warmed(f, rig);
    assert.equal(await turn(rig), undefined);
    assert.equal(f.made[0]!.messages.length, 2);
    await rig.mod.dispose?.();
  });

  it('a provider-runtime agent never reranks: no session starts and no prompt goes out', async () => {
    const f = fakeSessions();
    const rig = await tiedRig(f);
    for (let i = 0; i < 3; i++) assert.ok(await turn(rig, TIE, 'provider'), 'it still gets its fused note');
    assert.equal(f.made.length, 0);
    assert.deepEqual(readSpend(rig.dataDir), {});
  });

  it('a tie with the rerank off makes no session', async () => {
    const f = fakeSessions();
    const rig = await tiedRig(f, { rerank: false, threshold: 'eager' });
    assert.ok(await turn(rig));
    assert.equal(f.made.length, 0);
  });

  it('a clear winner makes no session', async () => {
    const f = fakeSessions();
    const rig = armoryRig({ modOpts: { rerankQuery: f.queryFn } });
    await own(rig, { name: 'invoice-pdf-export', description: 'Export invoices to PDF documents for accounting', body: 'b' });
    await own(rig, { name: 'invoice-notes', description: 'Notes about bills', body: 'b' });
    await own(rig, { name: 'garden-notes', description: 'Helps with garden things', body: 'b' });
    await rig.call('POST', '/api/armory/finder', SETTINGS);
    const note = await turn(rig, 'export invoices to pdf for accounting');
    assert.ok(note);
    assert.equal(note!.suggested[0], 'legion-armory:invoice-pdf-export');
    assert.equal(f.made.length, 0, 'the top score stands clear of the rest');
  });

  it('dispose closes the session', async () => {
    const f = fakeSessions();
    const rig = await tiedRig(f);
    await warmed(f, rig);
    assert.equal(f.made[0]!.closed, false);
    await rig.mod.dispose?.();
    assert.equal(f.made[0]!.closed, true);
  });

  it('switching the rerank off closes the session', async () => {
    const f = fakeSessions();
    const rig = await tiedRig(f);
    await warmed(f, rig);
    await rig.call('POST', '/api/armory/finder', { rerank: false });
    assert.equal(f.made[0]!.closed, true);
  });

  it('a failing session never fails the turn', async () => {
    const f = fakeSessions(() => ({ error: true }));
    const rig = await tiedRig(f);
    for (let i = 0; i < 3; i++) assert.ok(await turn(rig), 'a note each time');
    await rig.mod.dispose?.();
  });

  it('finderWiring reports the rerank switch exactly as the setting has it', async () => {
    const rig = await tiedRig(undefined, { rerank: false });
    assert.equal(rig.mod.finderWiring!(rig.agents.get('alpha')!).rerank, false);
    await rig.call('POST', '/api/armory/finder', { rerank: true });
    assert.equal(rig.mod.finderWiring!(rig.agents.get('alpha')!).rerank, true);
  });
});
