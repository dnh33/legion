// test/engine-web.test.ts: web reads ask per site in every mode but Bypass, through one guard pipeline in the decider and a PreToolUse hook (Task 17).
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatesRig, pause } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import type { GateRule } from '../src/shared/types.js';
import { webChecksApply } from '../src/core/approvals.js';
import { WebSession } from '../src/core/web-session.js';

type Opts = Parameters<typeof gatesRig>[0];
const using = async (o: Opts, body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};
const smart = (body: (r: GatesRig) => Promise<void>) => using({ preset: 'smart', follow: true }, body);
const url = (u: string) => ({ url: u });
let n = 0;
const rule = (then: GateRule['then'], when: GateRule['when']): GateRule => ({ id: `gr_ew${++n}`, enabled: true, then, label: `${then} rule`, source: 'user', when });
/** One call to the end: whether it raised a card; a card is answered no. */
const ran = (r: GatesRig, u: string) => r.run('WebFetch', url(u));
type HookFn = (i: Record<string, unknown>) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } } | undefined>;
/** The run's PreToolUse hooks for a tool, started without answering any card. Resolves to the last permission decision (undefined: let it through). */
const rawHook = async (r: GatesRig, toolName: string, input: Record<string, unknown>): Promise<string | undefined> => {
  const pre = ((r.calls[0]!.options as { hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: HookFn[] }> } }).hooks?.PreToolUse ?? [])
    .filter((h) => !h.matcher || new RegExp(`^(?:${h.matcher})$`).test(toolName));
  let decision: string | undefined;
  for (const h of pre) for (const fn of h.hooks) {
    const out = await fn({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: input, tool_use_id: `u${Math.random()}` });
    const d = out?.hookSpecificOutput?.permissionDecision; if (d) { decision = d; if (d === 'deny') return d; }
  }
  return decision;
};

test('webChecksApply: every mode but full, for WebFetch and WebSearch only', () => {
  for (const m of ['ask', 'auto-edits', 'smart', 'smart-edits'] as const) { assert.equal(webChecksApply(m, 'WebFetch'), true, m); assert.equal(webChecksApply(m, 'WebSearch'), true, m); assert.equal(webChecksApply(m, 'Bash'), false, m); }
  assert.equal(webChecksApply('full', 'WebFetch'), false); assert.equal(webChecksApply('full', 'WebSearch'), false);
});

test('WebSession: counts distinct paths per host; noteRead sets secretRead', () => {
  const s = new WebSession();
  s.noteFetch('a.com', '/x'); s.noteFetch('a.com', '/x'); s.noteFetch('a.com', '/y'); s.noteFetch('b.com', '/x');
  assert.equal(s.pathsSeen('a.com'), 2); assert.equal(s.pathsSeen('b.com'), 1); assert.equal(s.pathsSeen('c.com'), 0);
  assert.equal(s.secretRead, false); s.noteRead('/p/.env'); assert.equal(s.secretRead, true);
});

test('Smart: a built-in docs host runs with no card', () => smart(async (r) => {
  const d = await r.call('WebFetch', url('https://docs.python.org/3/')); assert.equal(d.allow, true); assert.equal(r.pending().length, 0);
}));

test('Smart: a new host raises one card with site.host and noRemember', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://example.com/a')); await r.tick();
  assert.equal(r.pending().length, 1); assert.equal(r.pending()[0]!.site?.host, 'example.com'); assert.equal(r.pending()[0]!.noRemember, true);
  r.answer(false); assert.equal((await p).allow, false);
}));

test('an old tool-wide WebFetch allow rule does not bypass the web check', () => smart(async (r) => {
  r.setRules([rule('allow', { tools: ['WebFetch'] })]);
  const x = await ran(r, 'https://example.com/'); assert.equal(x.card, true);
}));

test('the PreToolUse hook and canUseTool give one card for one call', () => smart(async (r) => {
  const a = rawHook(r, 'WebFetch', url('https://example.com/')); const b = r.call('WebFetch', url('https://example.com/'));
  await r.tick(60); assert.equal(r.pending().length, 1);
  r.answer(true); const [h, d] = await Promise.all([a, b]);
  assert.equal(h, 'allow'); assert.equal(d.allow, true); assert.equal(r.pending().length, 0);
}));

test('the hook alone: a new site cards and a deny answer denies; a built-in docs host passes with no card', () => smart(async (r) => {
  const a = rawHook(r, 'WebFetch', url('https://example.com/')); await r.tick(); assert.equal(r.pending().length, 1); r.answer(false); assert.equal(await a, 'deny');
  assert.equal(await rawHook(r, 'WebFetch', url('https://docs.python.org/3/')), undefined); assert.equal(r.pending().length, 0);
}));

test('a gate deny rule for a host wins over the web card (no card, denied) in the hook and the decider', () => smart(async (r) => {
  r.setRules([rule('deny', { hosts: ['example.com'] })]);
  const x = await ran(r, 'https://example.com/'); assert.equal(x.card, false); assert.equal(x.allow, false);
  // fail fast: with no deny the hook waits on an open card, so race it against a short timer and answer any card
  const hooked = rawHook(r, 'WebFetch', url('https://example.com/'));
  const first = await Promise.race([hooked, pause(2000).then(() => 'hung')]);
  if (first === 'hung') { for (const c of r.pending()) r.approvals.resolve(c.id, false); await hooked; }
  assert.equal(first, 'deny'); assert.equal(r.pending().length, 0);
}));

for (const preset of ['ask', 'accept-edits'] as const) {
  test(`${preset}: a new site cards, a built-in docs host runs, an allowedHosts host runs`, () => using({ preset, follow: true }, async (r) => {
    assert.equal((await ran(r, 'https://example.com/')).card, true);
    assert.equal((await ran(r, 'https://docs.python.org/3/')).card, false);
    r.core.store.patchApp({ allowedHosts: ['trusted.example'] });
    const t = await ran(r, 'https://trusted.example/a'); assert.equal(t.card, false); assert.equal(t.allow, true);
  }));
}

test('Bypass: no web card; a hosts deny rule still denies', () => using({ preset: 'bypass', follow: true }, async (r) => {
  const a = await ran(r, 'https://example.com/'); assert.equal(a.card, false); assert.equal(a.allow, true);
  r.setRules([rule('deny', { hosts: ['example.com'] })]);
  assert.equal((await ran(r, 'https://example.com/')).allow, false);
}));

test('Bypass demoted to Smart mid-run: the next call to a new host cards', () => using({ preset: 'bypass', follow: true }, async (r) => {
  assert.equal((await ran(r, 'https://example.com/')).card, false);
  r.core.store.patchProject(r.project.id, { preset: 'smart' });
  assert.equal((await ran(r, 'https://example.org/')).card, true);
}));

test('the web-reads gate switched off: no card in Smart', () => using({ preset: 'smart', follow: true, overrides: { 'web-reads': false } }, async (r) => {
  const x = await ran(r, 'https://example.com/'); assert.equal(x.card, false); assert.equal(x.allow, true);
}));

test('after a secret file was read in the run, a built-in docs host call cards with no Always allow', () => smart(async (r) => {
  (r.engine as unknown as { active: Map<string, { web: WebSession }> }).active.get(r.task.id)!.web.noteRead('C:/p/.env');
  const p = r.call('WebFetch', url('https://docs.python.org/3/')); await r.tick();
  assert.equal(r.pending().length, 1); assert.equal(r.pending()[0]!.site?.canAlways, false); r.answer(false); await p;
}));

test('the 11th distinct path on one approved host cards (budget)', () => smart(async (r) => {
  r.core.store.patchApp({ allowedHosts: ['trusted.example'] });
  for (let i = 0; i < 11; i++) assert.equal((await r.call('WebFetch', url(`https://trusted.example/p${i}`))).allow, true);
  assert.equal((await ran(r, 'https://trusted.example/p11')).card, true);
}));

test('WebSearch: a short query runs, a very long one cards', () => smart(async (r) => {
  assert.equal((await r.call('WebSearch', { query: 'node test runner' })).allow, true); assert.equal(r.pending().length, 0);
  assert.equal((await r.run('WebSearch', { query: 'x'.repeat(400) })).card, true);
}));

test('an allowed read is noted in the activity log', () => smart(async (r) => {
  await r.call('WebFetch', url('https://docs.python.org/3/')); await pause(10);
  const lines = r.activityRead({ kinds: ['note'] });
  assert.ok(lines.some((l) => /Web: WebFetch docs\.python\.org/.test(l.text)));
}));

test('the hook path: after connector data a new site raises the site card, then the connector egress card, and a no on the second denies', () => smart(async (r) => {
  r.store.tasks.set(r.task.id, { ...(r.store.getTask(r.task.id) as object), usedConnectors: true } as never);
  (r.config as { taint?: unknown }).taint = { shell: 'strict', outsideFiles: true, noticeSeen: true };
  (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
  const hooked = rawHook(r, 'WebFetch', url('https://example.com/'));
  await r.tick(); assert.equal(r.pending().length, 1); assert.ok(r.pending()[0]!.site, 'the site card first');
  r.answer(true); await r.tick(60);
  assert.equal(r.pending().length, 1, 'the egress card follows'); assert.match(r.pending()[0]!.summary, /connector/i); assert.equal(r.pending()[0]!.site, undefined);
  r.answer(false); assert.equal(await Promise.race([hooked, pause(2000).then(() => 'hung')]), 'deny');
}));

test('the activity log keeps no query from a web card, and the card still holds the full address in its input', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://example.com/a?token=SECRETVALUE#frag')); await r.tick(60);
  const card = r.pending()[0]!;
  assert.match(card.summary, /example\.com\/a\?\.\.\./); assert.ok(!card.summary.includes('SECRETVALUE'));
  assert.equal(card.input.url, 'https://example.com/a?token=SECRETVALUE#frag');
  r.answer(false); await p; await pause(20);
  const logged = JSON.stringify(r.activityRead({}));
  assert.ok(logged.includes('example.com'), 'the card is logged'); assert.ok(!logged.includes('SECRETVALUE'));
}));

test('a search card keeps the query out of the summary (and so out of the log)', () => smart(async (r) => {
  const p = r.call('WebSearch', { query: 'SECRETVALUE'.repeat(40) }); await r.tick(60);
  assert.ok(!r.pending()[0]!.summary.includes('SECRETVALUE')); r.answer(false); await p;
}));

test('the decider: after connector data a gate deny rule for the host wins before the egress card (no card, denied)', () => smart(async (r) => {
  r.store.tasks.set(r.task.id, { ...(r.store.getTask(r.task.id) as object), usedConnectors: true } as never);
  (r.config as { taint?: unknown }).taint = { shell: 'strict', outsideFiles: true, noticeSeen: true };
  (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
  r.setRules([rule('deny', { hosts: ['example.com'] })]);
  const p = r.call('WebFetch', url('https://example.com/'));
  const first = await Promise.race([p, pause(2000).then(() => 'hung' as const)]);
  if (first === 'hung') { for (const c of r.pending()) r.approvals.resolve(c.id, false); await p; }
  assert.notEqual(first, 'hung', 'no card may open: the deny rule decides'); assert.equal((first as { allow: boolean }).allow, false);
}));

test('default mode: after connector data a web call raises no egress card (only the site card, if one is due); Strict keeps it', () => smart(async (r) => {
  r.store.tasks.set(r.task.id, { ...(r.store.getTask(r.task.id) as object), usedConnectors: true } as never);
  (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
  const hooked = rawHook(r, 'WebFetch', url('https://docs.python.org/3/'));
  assert.notEqual(await Promise.race([hooked, pause(500).then(() => 'hung')]), 'hung', 'no card, so the hook answers at once');
  assert.equal(r.pending().length, 0);
}));
