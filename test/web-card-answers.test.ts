// test/web-card-answers.test.ts: a web card has four answers (Always allow, Allow for this goal, Allow once, Deny) (Task 20).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { gatesRig, noKeyStore } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { connectCdp } from '../src/core/browser/cdp.js';
import { BrowserManager } from '../src/core/browser/manager.js';
import { BrowserSession } from '../src/core/browser/session.js';
import { buildBrowserServer } from '../src/core/browser/tools.js';
import type { ModuleJob } from '../src/core/modules.js';
import type { SiteAnswer } from '../src/shared/types.js';
import { agent } from './blender-helpers.js';
import { fakeResolver, startFakeCdp } from './browser-fakes.js';
import { AUTH, makeFakes, start } from './helpers-c.js';

type Opts = Parameters<typeof gatesRig>[0];
const using = async (o: Opts, body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};
const smart = (body: (r: GatesRig) => Promise<void>) => using({ preset: 'smart', follow: true }, body);
const url = (u: string) => ({ url: u });
/** Answers the card the way the Allow buttons do: the broker's `resolve` with the site answer. */
const answer = (r: GatesRig, id: string, a: { allowed: boolean; site?: SiteAnswer }): boolean => r.approvals.resolve(id, a.allowed, a.site);
const allowedHosts = (r: GatesRig): string[] => r.core.store.app().allowedHosts ?? [];

test('Always allow adds that host to the signed site list; the next call runs with no card', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://example.com/a')); await r.tick();
  answer(r, r.pending()[0]!.id, { allowed: true, site: 'always' }); assert.equal((await p).allow, true);
  assert.deepEqual(allowedHosts(r), ['example.com']);
  await r.core.store.flush();
  assert.ok(existsSync(join(r.core.store.folder, 'app.json')), 'the list is written');
  assert.match(readFileSync(join(r.core.store.folder, 'app.json'), 'utf8'), /"sig"/, 'and signed');
  assert.equal(r.core.webLastUsed.get()['example.com']?.approvedAt !== undefined, true, 'with an approval date');
  assert.equal(r.pending().length, 0);
  const next = await r.call('WebFetch', url('https://example.com/b')); assert.equal(next.allow, true); assert.equal(r.pending().length, 0);
  assert.ok(r.activityRead({ kinds: ['gate-changed'] }).some((l) => /example\.com/.test(l.text)), 'the change is in the activity log');
  const other = await r.run('WebFetch', url('https://example.org/')); assert.equal(other.card, true, 'another site still asks');
}));

test('Always allow works in Ask and Accept edits too (the same card)', async () => {
  for (const preset of ['ask', 'accept-edits'] as const) {
    await using({ preset, follow: true }, async (r) => {
      const p = r.call('WebFetch', url('https://example.com/a')); await r.tick();
      answer(r, r.pending()[0]!.id, { allowed: true, site: 'always' }); await p;
      assert.deepEqual(allowedHosts(r), ['example.com'], preset);
    });
  }
});

test('Allow once allows one call; the next call to the same host cards again', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://example.com/a')); await r.tick();
  answer(r, r.pending()[0]!.id, { allowed: true, site: 'once' }); assert.equal((await p).allow, true);
  assert.deepEqual(allowedHosts(r), []);
  const q = await r.run('WebFetch', url('https://example.com/b')); assert.equal(q.card, true);
}));

test('a plain yes with no site answer is Allow once', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://example.com/a')); await r.tick(); answer(r, r.pending()[0]!.id, { allowed: true }); await p;
  assert.equal((await r.run('WebFetch', url('https://example.com/b'))).card, true);
}));

test('Allow for this goal opens that host for the rest of the run only; another host and another run still ask', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://example.com/a')); await r.tick();
  answer(r, r.pending()[0]!.id, { allowed: true, site: 'goal' }); assert.equal((await p).allow, true);
  assert.deepEqual(allowedHosts(r), [], 'not written to the site list');
  const again = await r.call('WebFetch', url('https://example.com/b')); assert.equal(again.allow, true); assert.equal(r.pending().length, 0);
  assert.equal((await r.run('WebFetch', url('https://example.org/'))).card, true);
  const other = await r.freshRun();
  const q = other.call('WebFetch', url('https://example.com/c')); await r.tick(); assert.equal(r.pending().length, 1, 'a second run asks again'); answer(r, r.pending()[0]!.id, { allowed: false }); await q;
  other.stop();
}));

test('trustHostForGoal opens a host for that run (the entry the goal list will use)', () => smart(async (r) => {
  (r.engine as unknown as { trustHostForGoal(t: string, h: string): void }).trustHostForGoal(r.task.id, 'example.com');
  assert.equal((await r.call('WebFetch', url('https://example.com/a'))).allow, true); assert.equal(r.pending().length, 0);
}));

test('Deny: allow false, and the message does not name another route', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://example.com/')); await r.tick(); answer(r, r.pending()[0]!.id, { allowed: false, site: 'always' });
  const d = await p;
  assert.equal(d.allow, false); assert.doesNotMatch(d.message ?? '', /instead|try .*curl|another/i);
  assert.deepEqual(allowedHosts(r), [], 'a site answer on a No means nothing');
}));

test('canAlways false (IP, loopback, metadata, shortener) hides Always allow and the broker refuses site always', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://127.0.0.1/')); await r.tick(); assert.equal(r.pending()[0]!.site?.canAlways, false);
  assert.throws(() => answer(r, r.pending()[0]!.id, { allowed: true, site: 'always' }), /always/i);
  assert.equal(r.pending().length, 1, 'the card is still open after the refusal');
  answer(r, r.pending()[0]!.id, { allowed: false }); await p;
  assert.deepEqual(allowedHosts(r), []);
}));

test('no keystore: site always is refused with the keystore reason, once still works', () => smart(async (r) => {
  (r.engine as unknown as { gates: unknown }).gates = noKeyStore();
  const p = r.call('WebFetch', url('https://example.com/')); await r.tick();
  assert.equal(r.pending()[0]!.site?.canAlways, false);
  assert.throws(() => answer(r, r.pending()[0]!.id, { allowed: true, site: 'always' }), /key/i);
  answer(r, r.pending()[0]!.id, { allowed: true, site: 'once' }); assert.equal((await p).allow, true);
}));

test('answering a closed card is a no-op, and a site answer that is not one of the three is refused', () => smart(async (r) => {
  const p = r.call('WebFetch', url('https://example.com/')); await r.tick(); const id = r.pending()[0]!.id;
  assert.throws(() => r.approvals.resolve(id, true, 'forever' as never), /site/i);
  answer(r, id, { allowed: false }); await p;
  assert.doesNotThrow(() => answer(r, id, { allowed: true, site: 'always' })); assert.equal(answer(r, id, { allowed: true, site: 'always' }), false);
  assert.deepEqual(allowedHosts(r), []);
}));

test('three new hosts raised together come as one card "3 new sites: a.com, b.com, c.com"; one answer covers all three', () => smart(async (r) => {
  const ps = ['a.com', 'b.com', 'c.com'].map((h) => r.call('WebFetch', url(`https://${h}/`))); await r.tick(60);
  assert.equal(r.pending().length, 1); assert.match(r.pending()[0]!.summary, /3 new sites: a\.com, b\.com, c\.com/);
  assert.equal(r.pending()[0]!.site?.canAlways, true);
  answer(r, r.pending()[0]!.id, { allowed: true, site: 'always' });
  assert.deepEqual((await Promise.all(ps)).map((d) => d.allow), [true, true, true]);
  assert.deepEqual(allowedHosts(r).sort(), ['a.com', 'b.com', 'c.com']);
}));

test('a batch with one host that cannot be allowed for good offers no Always allow, and a deny denies all', () => smart(async (r) => {
  const ps = ['a.com', 'r.jina.ai'].map((h) => r.call('WebFetch', url(`https://${h}/`))); await r.tick(60);
  assert.equal(r.pending().length, 1); assert.equal(r.pending()[0]!.site?.canAlways, false);
  answer(r, r.pending()[0]!.id, { allowed: false });
  assert.deepEqual((await Promise.all(ps)).map((d) => d.allow), [false, false]);
}));

test('two calls to the same new host together give one card and one answer for both', () => smart(async (r) => {
  const ps = [r.call('WebFetch', url('https://example.com/a')), r.call('WebFetch', url('https://example.com/b'))]; await r.tick(60);
  assert.equal(r.pending().length, 1); assert.doesNotMatch(r.pending()[0]!.summary, /new sites/);
  answer(r, r.pending()[0]!.id, { allowed: true, site: 'once' });
  assert.deepEqual((await Promise.all(ps)).map((d) => d.allow), [true, true]);
}));

test('a card the owner never answers is logged as "Waited for you on <host>"', () => using({ preset: 'smart', follow: true, approvalTimeoutMs: 120 }, async (r) => {
  const p = r.call('WebFetch', url('https://example.com/')); await r.tick(); await r.advanceApprovalTimeout();
  const d = await p; assert.equal(d.allow, false); assert.match(d.message ?? '', /No one answered/);
  assert.ok(r.activityRead({ kinds: ['note'] }).some((l) => /Waited for you on example\.com/.test(l.text)));
}));

test('the web card keeps the egress card separate: after connector data a web call raises the egress card first', () => smart(async (r) => {
  r.store.tasks.set(r.task.id, { ...(r.store.getTask(r.task.id) as object), usedConnectors: true } as never);
  (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
  const p = r.call('WebFetch', url('https://docs.python.org/3/')); await r.tick();
  assert.equal(r.pending().length, 1); assert.match(r.pending()[0]!.summary, /connector/i); assert.equal(r.pending()[0]!.site, undefined);
  answer(r, r.pending()[0]!.id, { allowed: false }); await p;
}));

// ---- the broker -------------------------------------------------------------------------------------------------

test('broker: resolve stores the site answer and takeSite hands it over once', async () => {
  const b = new ApprovalBroker(new EventBus());
  const p = b.request('t', 'a', 'WebFetch', { url: 'https://x.com/' }, undefined, { site: { host: 'x.com', canAlways: true }, noRemember: true });
  const id = b.pending()[0]!.id;
  assert.equal(b.resolve(id, true, 'goal'), true); assert.equal(await p, true);
  assert.equal(b.takeSite(id), 'goal'); assert.equal(b.takeSite(id), undefined);
});

test('broker: a card without a site refuses a site answer', async () => {
  const b = new ApprovalBroker(new EventBus());
  const p = b.request('t', 'a', 'Bash', { command: 'echo' }); const id = b.pending()[0]!.id;
  assert.throws(() => b.resolve(id, true, 'once'), /web card/i);
  b.resolve(id, false); assert.equal(await p, false);
});

// ---- the route --------------------------------------------------------------------------------------------------

test('POST /api/approvals/:id passes site on; a bad site or a refused one is a 400', async () => {
  const f = makeFakes();
  const seen: unknown[][] = [];
  (f.ctx.approvals as unknown as Record<string, unknown>).resolve = (id: string, allow: boolean, site?: string) => { seen.push([id, allow, site]); if (site === 'always') throw new Error('Always allow is not offered for this site.'); return true; };
  const s = await start(f.ctx);
  try {
    const post = (body: unknown) => fetch(`${s.base}/api/approvals/apr_1`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ allow: true, site: 'once' })).status, 200);
    assert.equal((await post({ allow: true })).status, 200);
    assert.equal((await post({ allow: true, site: 'forever' })).status, 400);
    assert.equal((await post({ allow: true, site: 5 })).status, 400);
    const refused = await post({ allow: true, site: 'always' }); assert.equal(refused.status, 400); assert.match(await refused.text(), /Always allow/);
    assert.equal((await post({ site: 'once' })).status, 400, 'allow is still required');
    assert.deepEqual(seen, [['apr_1', true, 'once'], ['apr_1', true, undefined], ['apr_1', true, 'always']]);
  } finally { await s.close(); }
});

// ---- browser_open -----------------------------------------------------------------------------------------------

test('browser_open: a built-in docs host skips the first-page card in Smart; a new host asks as today; Ask keeps its card', async () => {
  const DNS = fakeResolver({ 'docs.python.org': ['93.184.216.34'], 'example.com': ['93.184.216.35'] });
  const fake = await startFakeCdp({ pages: { 'https://docs.python.org/3/': { title: 'Docs', text: 'hello' }, 'https://example.com/': { title: 'Ex', text: 'hello' } } });
  const results: Record<string, boolean> = {};
  try {
    for (const preset of ['smart', 'ask'] as const) {
      for (const target of ['https://docs.python.org/3/', 'https://example.com/']) {
        await using({ preset, follow: true }, async (r) => {
          const bus = new EventBus(); const approvals = new ApprovalBroker(bus); let cards = 0;
          bus.on((e) => { if (e.type === 'approval.requested') { cards++; setImmediate(() => approvals.resolve(e.approval.id, true)); } });
          const manager: BrowserManager = new BrowserManager(() => new BrowserSession({
            guard: () => ({}), resolve: DNS, approveOrigin: async () => true,
            async launch() { const cdp = await connectCdp(`ws://127.0.0.1:${fake.port}`); return { cdp, pid: undefined, port: fake.port, args: [], exited: new Promise(() => undefined), stop: async () => { cdp.close(); } }; },
          }));
          const job: ModuleJob = { taskId: r.task.id, taint: () => false, markTainted: () => undefined };
          const eng = r.engine as unknown as { runModeOf(a: string, t?: string): never; webReadAllows(t: string | undefined, a: string, u: string): boolean };
          const cfg = buildBrowserServer(agent('a1', { approval: 'ask' }), job, {
            manager, guard: () => ({}), resolve: DNS, approvals, secrets: () => [], statusLine: () => '',
            modeOf: (id, tid) => eng.runModeOf(id, tid), webAllows: (t, a, u) => eng.webReadAllows(t, a, u),
          });
          const [ct, st] = InMemoryTransport.createLinkedPair(); await cfg.instance.connect(st);
          const client = new Client({ name: 'wc', version: '0' }); await client.connect(ct);
          try { await client.callTool({ name: 'browser_open', arguments: { url: target } }); } finally { await manager.disposeAll(); await client.close(); }
          results[`${preset} ${target}`] = cards > 0;
        });
      }
    }
  } finally { await fake.close(); }
  assert.deepEqual(results, {
    'smart https://docs.python.org/3/': false, 'smart https://example.com/': true,
    'ask https://docs.python.org/3/': true, 'ask https://example.com/': true,
  });
});

