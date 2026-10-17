/** The skill finder on the Claude path: the UserPromptSubmit and SubagentStart hooks, armory_find, slim listing, turn records. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isLegionTool } from '../src/core/approvals.js';
import { createUsageStore } from '../src/core/armory/finder/usage.js';
import { init, ok, setup, toolUse, waitDone } from './library-fakes.js';
import { armoryRig, md, own } from './armory-rig.js';
import type { CcFixture } from './armory-rig.js';

const CC: CcFixture = { plugins: [{ key: 'sp@m', name: 'sp', skills: { 'invoice-audit': md('invoice-audit', 'SECRETDESC audit invoices export pdf accounting') } }] };
const PROMPT = 'please export the invoices to pdf for accounting';

async function rigWith(prep?: (r: ReturnType<typeof armoryRig>) => Promise<void>) {
  const rig = armoryRig({ cc: CC });
  await own(rig, { name: 'invoice-pdf-export', description: 'Export invoices to PDF documents for accounting', body: 'b' });
  for (const n of ['garden-notes', 'travel-plan', 'recipe-card', 'budget-sheet']) await own(rig, { name: n, description: `Helps with ${n} things`, body: 'b' });
  await rig.call('POST', '/api/armory/state', { id: 'sp:invoice-audit', state: 'on' });
  const man = await rig.call('POST', '/api/armory/skill', { name: 'manual-invoice-export', description: 'Export invoices to PDF for accounting', body: 'b' });
  await rig.call('POST', '/api/armory/state', { id: man.id, state: 'manual' });
  await rig.call('POST', '/api/armory/skill', { name: 'off-invoice-export', description: 'Export invoices to PDF for accounting', body: 'b' });
  await rig.call('POST', '/api/armory/finder', { threshold: 'eager' });
  await prep?.(rig);
  return rig;
}

type Opts = any;
const fire = (o: Opts, event: string, input: Record<string, unknown>, i = 0) =>
  o.hooks[event][i].hooks[0]({ hook_event_name: event, session_id: 's', transcript_path: '', cwd: '', ...input }, undefined, { signal: new AbortController().signal });
const ctxOf = (out: any): string | undefined => out?.hookSpecificOutput?.additionalContext;

async function drive(rig: ReturnType<typeof armoryRig>, prompt: string, body: (o: Opts) => Promise<void>, tail: unknown[] = []) {
  const s = setup((c) => (async function* () { yield init('s' + c.n); await body(c.options); for (const t of tail) yield t; yield ok('done', 's' + c.n); })(), { modules: [rig.mod] });
  const t = await waitDone(s, s.engine.startTask({ agentId: 'alpha', prompt, source: 'ui' }));
  return { s, task: s.store.getTask(t.id)! };
}

describe('finder on the Claude path', () => {
  it('has the hooks only when suggest is on (and the subagent hooks only when subagents is on)', async () => {
    const rig = await rigWith();
    let seen: Opts;
    await drive(rig, PROMPT, async (o) => { seen = o; });
    assert.ok(seen.hooks.UserPromptSubmit && seen.hooks.SubagentStart);
    assert.ok(seen.hooks.PreToolUse.some((h: any) => h.matcher === 'Agent|Task'));
    await rig.call('POST', '/api/armory/finder', { subagents: false });
    await drive(rig, PROMPT, async (o) => { seen = o; });
    assert.ok(seen.hooks.UserPromptSubmit && !seen.hooks.SubagentStart);
    assert.ok(!seen.hooks.PreToolUse.some((h: any) => h.matcher === 'Agent|Task'));
    await rig.call('POST', '/api/armory/finder', { suggest: false });
    await drive(rig, PROMPT, async (o) => { seen = o; });
    assert.ok(!seen.hooks.UserPromptSubmit && !seen.hooks.SubagentStart);
  });

  it('names a matching on-skill and never an off or manual one; third-party shows no description', async () => {
    const rig = await rigWith();
    let text: string | undefined;
    const { task } = await drive(rig, PROMPT, async (o) => { text = ctxOf(await fire(o, 'UserPromptSubmit', { prompt: 'HEADER' })); });
    assert.ok(text, 'a note');
    assert.match(text!, /legion-armory:invoice-pdf-export/);
    assert.match(text!, /Load one with the Skill tool/);
    assert.doesNotMatch(text!, /manual-invoice|off-invoice/);
    assert.match(text!, /sp:invoice-audit \(third-party\)/);
    assert.doesNotMatch(text!, /SECRETDESC/);
    assert.equal(task.skillTurns?.length, 1);
    assert.ok(task.skillTurns![0]!.suggested.includes('legion-armory:invoice-pdf-export'));
  });

  it('ranks the task text, not the first-fire prompt (the header); a later fire ranks its own prompt', async () => {
    const rig = await rigWith();
    const outs: (string | undefined)[] = [];
    await drive(rig, 'zebra quantum yodel nonsense', async (o) => {
      outs.push(ctxOf(await fire(o, 'UserPromptSubmit', { prompt: `HEADER ${PROMPT}` })));
      outs.push(ctxOf(await fire(o, 'UserPromptSubmit', { prompt: PROMPT })));
    });
    assert.equal(outs[0], undefined);
    assert.match(outs[1]!, /invoice-pdf-export/);
  });

  it('skips prompts with fewer than 3 words', async () => {
    const rig = await rigWith();
    let out: unknown;
    await drive(rig, 'invoices pdf', async (o) => { out = await fire(o, 'UserPromptSubmit', { prompt: 'x' }); });
    assert.deepEqual(out, { continue: true });
  });

  it('keeps the system prompt append byte-identical with the finder on and off', async () => {
    const rig = await rigWith();
    let on = ''; let off = '';
    await drive(rig, PROMPT, async (o) => { on = o.systemPrompt.append; });
    await rig.call('POST', '/api/armory/finder', { suggest: false, searchTool: false, slimListing: false });
    await drive(rig, PROMPT, async (o) => { off = o.systemPrompt.append; });
    assert.ok(on.length > 0);
    assert.equal(on, off);
  });

  it('adds the slim listing keys only when slimListing is on', async () => {
    const rig = await rigWith();
    let o1: Opts; let o2: Opts;
    await drive(rig, PROMPT, async (o) => { o1 = o; });
    assert.ok(!('skillListingBudgetFraction' in o1.settings) && !('skillListingMaxDescChars' in o1.settings));
    await rig.call('POST', '/api/armory/finder', { slimListing: true });
    await drive(rig, PROMPT, async (o) => { o2 = o; });
    assert.equal(o2.settings.skillListingBudgetFraction, 0.002);
    assert.equal(o2.settings.skillListingMaxDescChars, 120);
  });

  it('SubagentStart ranks the subagent prompt captured from the Agent tool call (FIFO by type), else the task text', async () => {
    const rig = await rigWith();
    const outs: (string | undefined)[] = [];
    await drive(rig, 'zebra quantum yodel nonsense', async (o) => {
      await fire(o, 'PreToolUse', { tool_name: 'Agent', tool_use_id: 'a1', tool_input: { subagent_type: 'reviewer', prompt: PROMPT } }, o.hooks.PreToolUse.findIndex((h: any) => h.matcher === 'Agent|Task'));
      outs.push(ctxOf(await fire(o, 'SubagentStart', { agent_id: 'x', agent_type: 'reviewer' })));
      outs.push(ctxOf(await fire(o, 'SubagentStart', { agent_id: 'y', agent_type: 'reviewer' })));
    });
    assert.match(outs[0]!, /invoice-pdf-export/);
    assert.equal(outs[1], undefined, 'entry consumed; falls back to the task text, which matches nothing');
  });

  it('armory_find: only on skills, third-party without text, never taints; Claude gets only armory_find', async () => {
    const rig = await rigWith();
    let res = ''; let names: string[] = [];
    const { task } = await drive(rig, PROMPT, async (o) => {
      const srv = o.mcpServers.legion_armory.instance._registeredTools;
      names = Object.keys(srv);
      const r = await srv.armory_find.handler({ query: 'export invoices pdf accounting', limit: 10 }, {});
      res = r.content[0].text;
    });
    assert.deepEqual(names, ['armory_find']);
    assert.match(res, /legion-armory:invoice-pdf-export \(\d/);
    assert.match(res, /sp:invoice-audit \(third-party\)/);
    assert.doesNotMatch(res, /manual-invoice|off-invoice|SECRETDESC/);
    assert.notEqual(task.tainted, true);
    assert.ok(isLegionTool('mcp__legion_armory__armory_find'));
  });

  it('armory_find is gated by searchTool', async () => {
    const rig = await rigWith();
    await rig.call('POST', '/api/armory/finder', { searchTool: false });
    let o1: Opts;
    await drive(rig, PROMPT, async (o) => { o1 = o; });
    assert.ok(!o1.mcpServers.legion_armory);
  });

  it('records skillTurns (capped at 50), the load, and ignored skills at run end', async () => {
    const rig = await rigWith();
    const { task } = await drive(rig, PROMPT, async (o) => {
      for (let i = 0; i < 55; i++) await fire(o, 'UserPromptSubmit', { prompt: 'x' }).catch(() => undefined);
      for (let i = 0; i < 54; i++) await fire(o, 'UserPromptSubmit', { prompt: PROMPT });
    }, [toolUse('Skill', 'tu_load', { skill: 'legion-armory:invoice-pdf-export' })]);
    assert.equal(task.skillTurns!.length, 50);
    const last = task.skillTurns!.at(-1)!;
    assert.deepEqual(last.loaded, ['legion-armory:invoice-pdf-export']);
    const boost = createUsageStore(rig.dataDir).boostFor('alpha');
    assert.ok(boost('legion-armory:invoice-pdf-export') > 1, 'load boosts');
    assert.ok(boost('sp:invoice-audit') < 1, 'suggested and not loaded counts as ignored');
  });
});
