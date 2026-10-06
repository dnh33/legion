/** CI poller: the rate budget, with a pinned clock and the fake GitHub. No timers, no network, no real hour. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeGitHub } from '../src/core/ci/fake-github.js';
import { ANON_HOURLY_CAP, ANON_POLL_MS, CiPoller, CONNECTED_HOURLY_CAP, SWITCH_DEBOUNCE_MS, TICK_MS } from '../src/core/ci/poller.js';
import type { CiUpdateSummary } from '../src/shared/ci.js';
import { CI_WATCH_TTL_MS } from '../src/shared/ci.js';

const T0 = Date.parse('2026-10-07T10:00:00Z');
const REPO = { repo: { owner: 'dnh33', name: 'legion' }, branch: 'feat/x', source: 'remote' as const };

function rig(o: { auth?: 'anonymous' | 'pat'; running?: boolean; remaining?: number; branch?: string | null } = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const gh = new FakeGitHub(now);
  const connected = (o.auth ?? 'anonymous') === 'pat';
  gh.setConnection(connected
    ? { auth: 'pat', login: 'octo', permissions: { actions: 'write' }, rate: { limit: 5000, remaining: o.remaining ?? 5000, resetAt: new Date(T0 + 3_600_000).toISOString() } }
    : { auth: 'anonymous', rate: { limit: 60, remaining: o.remaining ?? 60, resetAt: new Date(T0 + 3_600_000).toISOString() } });
  gh.addRun({ id: 1, branch: 'feat/x', status: o.running ? 'in_progress' : 'completed', ageMin: 3 });
  gh.addRun({ id: 2, branch: 'main', ageMin: 60 });
  const events: CiUpdateSummary[] = [];
  const stamps: number[] = [];
  const origRequest = gh.request.bind(gh);
  gh.request = async (p, i) => { stamps.push(now()); return origRequest(p, i); };
  const poller = new CiPoller({
    github: gh, resolveRepo: () => ({ ...REPO, ...(o.branch !== undefined ? { branch: o.branch } : {}) }), emit: (e) => events.push(e), now, schedule: () => () => undefined,
  });
  const advance = (ms: number) => { clock.t += ms; };
  /** Runs the timer's ticks for `ms` of pinned time. */
  const run = async (ms: number, each?: (elapsed: number) => Promise<void>) => {
    for (let e = 0; e < ms; e += TICK_MS) { advance(TICK_MS); await poller.tick(); if (each) await each(e + TICK_MS); }
  };
  return { clock, gh, poller, events, stamps, advance, run };
}

describe('watching', () => {
  it('makes no request while nobody watches, and stops when the heartbeat goes stale', async () => {
    const r = rig({ auth: 'pat', running: true });
    await r.run(120_000);
    assert.equal(r.gh.calls.length, 0, 'no heartbeat, no request');
    r.poller.heartbeat('panel');
    await r.poller.refresh('open');
    const afterOpen = r.gh.calls.length;
    assert.ok(afterOpen > 0);
    r.advance(CI_WATCH_TTL_MS + 1000);
    assert.equal(await r.poller.tick(), 'idle');
    await r.run(120_000);
    assert.equal(r.gh.calls.length, afterOpen, 'a stale heartbeat means nobody watches');
  });
});

describe('connected polling', () => {
  it('polls every 10 s while a run is in progress and every 60 s when idle, with If-None-Match', async () => {
    const r = rig({ auth: 'pat', running: true });
    r.poller.heartbeat('chip');
    await r.poller.refresh('open');
    r.gh.calls.length = 0;
    // keep the heartbeat fresh the way the UI does
    await r.run(60_000, async (el) => { if (el % 30_000 === 0) r.poller.heartbeat('chip'); });
    const lists = r.gh.calls.filter((c) => c.path.includes('/actions/runs?'));
    assert.equal(lists.length, 6 * 2, 'six cycles in 60 s, two branches each');
    assert.ok(lists.every((c) => c.ifNoneMatch), 'every list call after the first sends If-None-Match');
    r.gh.finishRun(1);
    await r.run(10_000);
    r.gh.calls.length = 0;
    await r.run(240_000, async (el) => { if (el % 30_000 === 0) r.poller.heartbeat('chip'); });
    assert.equal(r.gh.calls.filter((c) => c.path.includes('/actions/runs?')).length, 4 * 2, 'idle: one cycle a minute');
  });

  it('a 304 costs nothing and does not re-render; a changed run does', async () => {
    const r = rig({ auth: 'pat', running: true });
    r.poller.heartbeat('panel');
    await r.poller.refresh('open');
    const events = r.events.length;
    const remaining = r.gh.conn.rate.remaining;
    r.advance(11_000);
    await r.poller.refresh('auto');
    assert.equal(r.events.length, events, 'identical answer, no ci.updated');
    assert.equal(r.gh.conn.rate.remaining, remaining, 'a 304 is free for a signed-in caller');
    r.gh.finishRun(1, 'failure');
    r.advance(11_000);
    await r.poller.refresh('auto');
    assert.equal(r.events.length, events + 1, 'a changed run emits once');
    assert.equal(r.events.at(-1)!.counts.failure, 1);
  });
});

describe('anonymous polling', () => {
  it('makes no idle requests at all: an hour with nothing running costs only the opening load', async () => {
    const r = rig({ auth: 'anonymous', running: false });
    r.poller.heartbeat('panel');
    await r.poller.refresh('open');
    const opened = r.gh.calls.length;
    assert.equal(opened, 1, 'one request opens the panel');
    await r.run(3_600_000, async (el) => { if (el % 30_000 === 0) r.poller.heartbeat('panel'); });
    assert.equal(r.gh.calls.length, opened);
  });

  it('while a run is in progress and the panel is open, polls no faster than once a minute', async () => {
    const r = rig({ auth: 'anonymous', running: true });
    r.poller.heartbeat('panel');
    await r.poller.refresh('open');
    await r.run(900_000, async (el) => { if (el % 30_000 === 0) r.poller.heartbeat('panel'); });
    assert.ok(r.stamps.length >= 8, `it does poll (${r.stamps.length})`);
    for (let i = 1; i < r.stamps.length; i++) assert.ok(r.stamps[i]! - r.stamps[i - 1]! >= 60_000, `gap ${r.stamps[i]! - r.stamps[i - 1]!}`);
    assert.ok(ANON_POLL_MS >= 60_000);
  });

  it('a simulated hour with the panel open and the Refresh button pressed every 20 s stays under 60 requests', async () => {
    const r = rig({ auth: 'anonymous', running: true });
    r.poller.heartbeat('panel');
    await r.run(3_600_000, async (el) => {
      if (el % 30_000 === 0) r.poller.heartbeat('panel');
      if (el % 20_000 === 0) await r.poller.refresh('manual');
      // the window's budget really drains: the fake counts 1 per request and the reset is one hour away
    });
    assert.ok(r.gh.calls.length > 20, `not vacuous (${r.gh.calls.length})`);
    assert.ok(r.gh.calls.length < 60, `${r.gh.calls.length} requests in the hour`);
    assert.ok(r.gh.calls.length <= ANON_HOURLY_CAP);
  });

  it('chip-only anonymous watching never polls a running run (only the panel does)', async () => {
    const r = rig({ auth: 'anonymous', running: true });
    r.poller.heartbeat('chip');
    await r.poller.refresh('open');
    const opened = r.gh.calls.length;
    await r.run(600_000, async (el) => { if (el % 30_000 === 0) r.poller.heartbeat('chip'); });
    assert.equal(r.gh.calls.length, opened);
  });

  it('uses one list request, never an If-None-Match (a 304 would still cost one)', async () => {
    const r = rig({ auth: 'anonymous', running: true });
    r.poller.heartbeat('panel');
    await r.poller.refresh('open');
    r.advance(80_000);
    await r.poller.refresh('manual');
    assert.equal(r.gh.calls.length, 2);
    assert.ok(r.gh.calls.every((c) => !c.ifNoneMatch));
  });

  it('stops under the reserve and says when the window resets', async () => {
    const r = rig({ auth: 'anonymous', running: true, remaining: 9 });
    r.poller.heartbeat('panel');
    await r.poller.refresh('open');
    assert.equal(r.gh.calls.length, 0);
    const runs = await r.poller.runsView();
    assert.equal(runs.problem?.kind, 'budget');
    assert.ok(runs.problem?.resetAt);
    r.advance(3_700_000);
    await r.poller.refresh('manual');
    assert.equal(r.gh.calls.length, 1, 'the new window is open again');
  });
});

describe('rate limit and errors', () => {
  it('after a rate-limit error nothing is requested until resetAt, then it resumes', async () => {
    const r = rig({ auth: 'pat', running: true });
    r.poller.heartbeat('panel');
    const resetAt = new Date(T0 + 600_000).toISOString();
    r.gh.failNext = { error: { kind: 'rate-limited', resetAt }, count: 1 };
    await r.poller.refresh('open');
    const afterError = r.gh.calls.length;
    assert.equal((await r.poller.stateView()).problem?.kind, 'rate-limited');
    await r.run(500_000, async (el) => { if (el % 30_000 === 0) r.poller.heartbeat('panel'); await r.poller.refresh('manual'); });
    assert.equal(r.gh.calls.length, afterError, 'paused, even for manual refreshes');
    r.advance(200_000);
    await r.poller.refresh('manual');
    assert.ok(r.gh.calls.length > afterError, 'resumes after the reset');
    assert.equal((await r.poller.stateView()).problem, null);
  });

  it('keeps showing the last rows, marked stale, when a later poll fails', async () => {
    const r = rig({ auth: 'pat', running: true });
    r.poller.heartbeat('panel');
    await r.poller.refresh('open');
    r.gh.failNext = { error: { kind: 'network', retryable: true }, count: 1 };
    r.advance(11_000);
    await r.poller.refresh('auto');
    const v = await r.poller.runsView();
    assert.equal(v.stale, true);
    assert.equal(v.problem?.kind, 'network');
    assert.ok(v.runs.length > 0);
  });

  it('a private repo with no connection is a state (not-connected), not an exception', async () => {
    const r = rig({ auth: 'anonymous' });
    r.gh.privateRepos.add('dnh33/legion');
    const v = await r.poller.runsView();
    assert.equal(v.problem?.kind, 'not-connected');
    assert.deepEqual(v.runs, []);
  });
});

describe('repo and jobs', () => {
  it('forgets the cache when the repo changes', async () => {
    const r = rig({ auth: 'pat' });
    let repo = { owner: 'dnh33', name: 'legion' };
    const p = new CiPoller({ github: r.gh, resolveRepo: () => ({ repo, branch: null, source: 'manual' }), emit: () => undefined, now: () => r.clock.t, schedule: () => () => undefined });
    assert.ok((await p.runsView()).runs.length > 0);
    r.advance(SWITCH_DEBOUNCE_MS + 1000); // a switch right after the first one is held back (see 'repo switches' below)
    repo = { owner: 'other', name: 'thing' };
    r.gh.missingRepos.add('other/thing');
    const v = await p.runsView();
    assert.deepEqual(v.runs, []);
    assert.equal(v.problem?.kind, 'not-found');
  });

  it('jobs of a finished run are fetched once; the summary lists failed jobs', async () => {
    const r = rig({ auth: 'pat' });
    r.gh.addRun({ id: 7, branch: 'feat/x', conclusion: 'failure', jobs: [{ name: 'ok' }, { name: 'bad', conclusion: 'failure' }] });
    await r.poller.runsView();
    const a = await r.poller.jobsView(7);
    const b = await r.poller.jobsView(7);
    assert.equal(r.gh.calls.filter((c) => c.path.endsWith('/7/jobs?per_page=100') || c.path.includes('/7/jobs')).length, 1);
    assert.deepEqual(a.summary?.failedJobs.map((j) => j.name), ['bad']);
    assert.deepEqual(b.jobs.map((j) => j.name), ['ok', 'bad']);
  });

  it('logs refused is a state, not an error; log text is masked', async () => {
    const r = rig({ auth: 'pat' });
    await r.poller.runsView();
    assert.deepEqual(await r.poller.logView(5), { available: false, reason: 'logs-unavailable' });
    assert.ok(r.gh.calls.some((c) => c.path === 'logs:5:dnh33/legion'), 'logs(jobId, repo) always gets the repo');
    r.gh.logsMode = 'ok';
    r.gh.logText.set(5, 'boom token=' + 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789' + ' <b>x</b>');
    const ok = await r.poller.logView(5);
    assert.equal(ok.available, true);
    if (ok.available) { assert.ok(!ok.text.includes('ghp_abcdef')); assert.ok(ok.text.includes('<b>x</b>')); assert.equal(ok.masked, true); }
    r.gh.logsMode = 'expired';
    assert.deepEqual(await r.poller.logView(5), { available: false, reason: 'expired' });
  });
});

describe('repo switches and the account budget', () => {
  const flipper = (r: ReturnType<typeof rig>) => {
    let which = 0;
    const repos = [{ owner: 'dnh33', name: 'legion' }, { owner: 'dnh33', name: 'other' }];
    const p = new CiPoller({ github: r.gh, resolveRepo: () => ({ repo: repos[which]!, branch: null, source: 'remote' }), emit: () => undefined, now: () => r.clock.t, schedule: () => () => undefined });
    return { p, flip: () => { which = 1 - which; }, repos };
  };
  it('a project-filter switch inside 10 s of the last one is ignored; the owner typing a repo is not', async () => {
    const r = rig({ auth: 'pat' });
    const f = flipper(r);
    assert.equal((await f.p.stateView()).repo?.name, 'legion');
    for (let i = 0; i < 9; i++) { r.advance(1000); f.flip(); assert.equal((await f.p.stateView()).repo?.name, 'legion', `second ${i + 1}: no flip`); }
    r.advance(2000); // nine flips so far: 'other' is what the project filter wants now
    assert.equal((await f.p.stateView()).repo?.name, 'other', 'after the 10 s the switch is taken');
    // explicit: taken at once, even right after a switch
    f.flip();
    assert.equal((await f.p.stateView()).repo?.name, 'other', 'held back right after a switch');
    f.p.switchNow();
    assert.equal((await f.p.stateView()).repo?.name, 'legion', 'the owner repo is taken at once');
  });

  it('a rate-limit pause and the fetch debounce belong to the account: they survive a repo switch', async () => {
    const r = rig({ auth: 'pat' });
    const f = flipper(r);
    f.p.heartbeat('panel');
    const resetAt = new Date(T0 + 600_000).toISOString();
    r.gh.failNext = { error: { kind: 'rate-limited', resetAt }, count: 1 };
    await f.p.refresh('open');
    const calls = r.gh.calls.length;
    r.advance(SWITCH_DEBOUNCE_MS + 1000);
    f.flip();
    await f.p.refresh('manual');
    await f.p.refresh('write');
    assert.equal(r.gh.calls.length, calls, 'still paused on the other repo');
    const v = await f.p.runsView();
    assert.equal(v.problem?.kind, 'rate-limited', 'and still said as a rate limit, not as a generic budget');
    r.advance(700_000);
    await f.p.refresh('manual');
    assert.ok(r.gh.calls.length > calls, 'resumes after the reset');
  });

  it('a manual refresh right after another repo was fetched is still debounced', async () => {
    const r = rig({ auth: 'pat' });
    const f = flipper(r);
    await f.p.stateView(); // first resolution: the switch clock starts here
    r.advance(SWITCH_DEBOUNCE_MS);
    await f.p.refresh('open');
    const calls = r.gh.calls.length;
    r.advance(1000);
    f.flip(); // allowed now (10 s since the last switch), but the last fetch was 1 s ago
    await f.p.refresh('manual');
    assert.equal((await f.p.stateView()).repo?.name, 'other', 'the switch itself was taken');
    assert.equal(r.gh.calls.length, calls, 'inside the 5 s fetch debounce, whatever the repo');
  });

  it('a connected account has an hourly backstop too', async () => {
    const r = rig({ auth: 'pat' });
    r.gh.setRate({ remaining: 1_000_000, limit: 1_000_000 });
    r.poller.heartbeat('panel');
    for (let i = 0; i < 2000; i++) { r.advance(1000); await r.poller.refresh('write'); r.gh.setRate({ remaining: 1_000_000 }); }
    assert.ok(r.gh.calls.length > 1000, `not vacuous (${r.gh.calls.length})`);
    assert.ok(r.gh.calls.length <= CONNECTED_HOURLY_CAP, `${r.gh.calls.length} requests in an hour`);
  });
});
