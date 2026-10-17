/** The skill finder's Haiku rerank: when it runs, what the call carries, how its answer is read, and what it costs. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildRerankPrompt, isCloseMatch, parseRerankAnswer, readSpend, rerankPick, rerankScores, spendFilePath } from '../src/core/armory/finder/rerank.js';
import type { RerankQuery } from '../src/core/armory/finder/rerank.js';
import { tempDir } from './tmp-cleanup.js';
import { armoryRig, md, own } from './armory-rig.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const thisMonth = (d = new Date()): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const BUILT_INS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'TodoWrite', 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];

interface Reply { text?: string; cost?: number; afterMs?: number; never?: boolean }

/** A fake query: it reads the one prompt message, then answers as asked. Records every call and every close. */
function fakeQuery(reply: Reply = {}) {
  const calls: { prompt: string; options: any }[] = [];
  let closes = 0;
  const queryFn: RerankQuery = (a) => {
    const call = { prompt: '', options: a.options as any };
    calls.push(call);
    const gen = (async function* () {
      for await (const m of a.prompt as AsyncIterable<any>) call.prompt += String(m.message.content);
      if (reply.never) await new Promise<void>(() => undefined);
      if (reply.afterMs) await sleep(reply.afterMs);
      yield { type: 'assistant', message: { content: [{ type: 'text', text: reply.text ?? '' }] } };
      yield { type: 'result', subtype: 'success', is_error: false, result: reply.text ?? '', total_cost_usd: reply.cost ?? 0 };
    })();
    return Object.assign(gen, { close: () => { closes++; } });
  };
  return { queryFn, calls, closes: () => closes };
}

const CANDS = [{ id: 'a', description: 'alpha skill' }, { id: 'b', description: 'beta skill' }, { id: 'c', description: 'gamma skill' }];
const base = (dataDir: string, queryFn: RerankQuery, extra: Record<string, unknown> = {}) => ({
  dataDir, text: 'please pick one', candidates: CANDS, k: 3, monthlyUsd: 1, queryFn, deadlineMs: 2000, hardMs: 5000, ...extra,
});

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

  it('takes the first JSON array in the text, even with prose around it', () => {
    assert.deepEqual(parseRerankAnswer('Best first: ["c","a"]. Done.', ['a', 'b', 'c'], 3), ['c', 'a']);
  });

  it('gives [] for an empty array, which means no note', () => {
    assert.deepEqual(parseRerankAnswer('[]', ['a'], 3), []);
  });

  it('gives undefined (keep the fused order) for invalid JSON, prose with no array, or non-string items', () => {
    assert.equal(parseRerankAnswer('I think the best is a.', ['a'], 3), undefined);
    assert.equal(parseRerankAnswer('[not json', ['a'], 3), undefined);
    assert.equal(parseRerankAnswer('[1, 2]', ['a'], 3), undefined);
    assert.equal(parseRerankAnswer('', ['a'], 3), undefined);
  });

  it('builds the prompt: the user text cut to 2000 characters, one line per candidate, then the instruction with k', () => {
    const p = buildRerankPrompt('x'.repeat(2500), [{ id: 'a', description: 'line one\nline two' }], 2);
    assert.equal(p.startsWith('x'.repeat(2000) + '\n'), true);
    assert.equal(p.includes('\na: line one line two\n'), true, 'one line per candidate');
    assert.match(p, /Return a JSON array of up to 2 skill ids from the list that fit this request, best first\. Return \[\] if none fit\. Ids only\./);
  });
});

describe('rerank: the call', () => {
  it('runs one Haiku turn with no tools, no settings from disk and no hooks', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeQuery({ text: '["a"]' });
    await rerankPick(base(dir, f.queryFn, { env: { PATH: 'x' }, settings: { disableClaudeAiConnectors: true } }));
    const o = f.calls[0]!.options;
    assert.equal(o.model, 'haiku');
    assert.equal(o.maxTurns, 1);
    assert.deepEqual(o.tools, []);
    assert.deepEqual(o.allowedTools, []);
    for (const name of BUILT_INS) assert.ok(o.disallowedTools.includes(name), `${name} is disallowed`);
    assert.deepEqual(o.settingSources, []);
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.persistSession, false);
    assert.equal(o.permissionMode, 'default');
    assert.equal(o.settings.disableAllHooks, true);
    assert.equal(o.settings.disableClaudeAiConnectors, true);
    assert.deepEqual(o.env, { PATH: 'x' });
    assert.equal('mcpServers' in o, false);
    assert.ok(o.abortController instanceof AbortController);
  });

  it('returns the ids the answer names, and the prompt it sent carries the candidates', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeQuery({ text: '["c","a"]' });
    const out = await rerankPick(base(dir, f.queryFn));
    assert.deepEqual(out.ids, ['c', 'a']);
    assert.match(f.calls[0]!.prompt, /a: alpha skill\nb: beta skill\nc: gamma skill/);
  });

  it('adds total_cost_usd to the month, and adds again on the next call', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeQuery({ text: '["a"]', cost: 0.002 });
    await (await rerankPick(base(dir, f.queryFn))).done;
    assert.equal(readSpend(dir)[thisMonth()], 0.002);
    await (await rerankPick(base(dir, f.queryFn))).done;
    assert.ok(Math.abs(readSpend(dir)[thisMonth()]! - 0.004) < 1e-9);
    assert.equal(existsSync(spendFilePath(dir)), true);
  });

  it('records the cost even when the answer is not usable', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeQuery({ text: 'no array here', cost: 0.01 });
    const out = await rerankPick(base(dir, f.queryFn));
    assert.equal(out.ids, undefined, 'invalid answer: the fused order stands');
    await out.done;
    assert.equal(readSpend(dir)[thisMonth()], 0.01);
  });

  it('skips the call and records nothing once the month is at or over the cap', async () => {
    const dir = tempDir('legion-rerank-');
    mkdirSync(join(dir, 'skill-finder'), { recursive: true });
    const before = JSON.stringify({ [thisMonth()]: 1 });
    writeFileSync(spendFilePath(dir), before);
    const f = fakeQuery({ text: '["a"]', cost: 0.5 });
    const out = await rerankPick(base(dir, f.queryFn, { monthlyUsd: 1 }));
    assert.equal(f.calls.length, 0, 'no call');
    assert.equal(out.ids, undefined);
    await out.done;
    assert.equal(readFileSync(spendFilePath(dir), 'utf8'), before, 'nothing recorded');
  });

  it('a cap of zero never calls', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeQuery({ text: '["a"]' });
    await rerankPick(base(dir, f.queryFn, { monthlyUsd: 0 }));
    assert.equal(f.calls.length, 0);
  });

  it('a call that does not answer in time keeps the fused order, aborts at the hard ceiling and closes', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeQuery({ never: true });
    const out = await rerankPick(base(dir, f.queryFn, { deadlineMs: 20, hardMs: 80 }));
    assert.equal(out.ids, undefined);
    await out.done;
    assert.equal(f.closes(), 1, 'the call was closed');
  });

  it('a late answer is ignored, but its cost is still recorded', async () => {
    const dir = tempDir('legion-rerank-');
    const f = fakeQuery({ text: '["a"]', cost: 0.02, afterMs: 60 });
    const out = await rerankPick(base(dir, f.queryFn, { deadlineMs: 10, hardMs: 2000 }));
    assert.equal(out.ids, undefined, 'past the deadline the fused order stands');
    await out.done;
    assert.equal(readSpend(dir)[thisMonth()], 0.02);
  });
});

describe('rerank: the note', () => {
  // Three skills with the same words: their keyword scores tie, so the margin is 0 and the rerank runs.
  const TIE = 'export invoices to pdf for accounting please';
  async function tiedRig(query: RerankQuery | undefined, settings: Record<string, unknown> = { rerank: true, rerankMonthlyUsd: 5, threshold: 'eager' }) {
    const rig = armoryRig({ modOpts: query ? { rerankQuery: query } : {} });
    for (const n of ['invoice-pdf-a', 'invoice-pdf-b', 'invoice-pdf-c']) await own(rig, { name: n, description: 'Export invoices to PDF documents for accounting', body: 'b' });
    await rig.call('POST', '/api/armory/finder', settings);
    return rig;
  }
  const turn = (rig: Awaited<ReturnType<typeof tiedRig>>, prompt = TIE) =>
    rig.mod.turnNote!(rig.agents.get('alpha')!, { prompt, taskId: 't1', runtime: 'claude' });

  it('when the top scores tie, one call picks the skills and the note lists them in that order', async () => {
    const f = fakeQuery({ text: '["legion-armory:invoice-pdf-b","legion-armory:invoice-pdf-a"]', cost: 0.001 });
    const rig = await tiedRig(f.queryFn);
    const note = await turn(rig);
    assert.equal(f.calls.length, 1, 'one call');
    assert.ok(note, 'a note');
    assert.deepEqual(note!.suggested, ['legion-armory:invoice-pdf-b', 'legion-armory:invoice-pdf-a']);
    assert.match(note!.text, /legion-armory:invoice-pdf-b[\s\S]*legion-armory:invoice-pdf-a/);
    assert.doesNotMatch(note!.text, /invoice-pdf-c/);
  });

  it('a tie with the rerank off makes no call', async () => {
    const f = fakeQuery({ text: '["invoice-pdf-b"]' });
    const rig = await tiedRig(f.queryFn, { rerank: false, threshold: 'eager' });
    assert.ok(await turn(rig));
    assert.equal(f.calls.length, 0);
  });

  it('an empty answer gives no note', async () => {
    const f = fakeQuery({ text: '[]' });
    const rig = await tiedRig(f.queryFn);
    assert.equal(await turn(rig), undefined);
    assert.equal(f.calls.length, 1);
  });

  it('a clear winner makes no call', async () => {
    const f = fakeQuery({ text: '["legion-armory:invoice-pdf-export"]' });
    const rig = armoryRig({ modOpts: { rerankQuery: f.queryFn } });
    await own(rig, { name: 'invoice-pdf-export', description: 'Export invoices to PDF documents for accounting', body: 'b' });
    await own(rig, { name: 'invoice-notes', description: 'Notes about bills', body: 'b' });
    await own(rig, { name: 'garden-notes', description: 'Helps with garden things', body: 'b' });
    await rig.call('POST', '/api/armory/finder', { rerank: true, rerankMonthlyUsd: 5, threshold: 'eager' });
    const note = await turn(rig, 'export invoices to pdf for accounting');
    assert.ok(note);
    assert.equal(note!.suggested[0], 'legion-armory:invoice-pdf-export');
    assert.equal(f.calls.length, 0, 'the top score stands clear of the rest');
  });

  it('finderWiring reports the rerank switch exactly as the setting has it', async () => {
    const rig = await tiedRig(undefined, { rerank: false });
    assert.equal(rig.mod.finderWiring!(rig.agents.get('alpha')!).rerank, false);
    await rig.call('POST', '/api/armory/finder', { rerank: true });
    assert.equal(rig.mod.finderWiring!(rig.agents.get('alpha')!).rerank, true);
  });
});
