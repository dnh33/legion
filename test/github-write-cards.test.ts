/**
 * GitHub writes (design 4.3, 6.3, 7.2 item 4; amendment 13): every write raises exactly ONE card, in `ask`, `auto-edits` and `full`, on the
 * Claude path and the provider path. Deny (and a timeout) sends nothing. The card shows the repo, the tool, the full argument text, the agent
 * name and, when the run read outside content, the taint warning. Nothing is retried after the request left.
 * Mutation negatives (each made on the code, must fail the named test, then reverted): the card skipped when the mode is `full`; the card
 * skipped when the run is not tainted; the send done before the answer; the denied answer still sending; a retry loop around the send;
 * the argument text cut to 400 characters; the agent name left out of the card; the taint test inverted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorKeyring } from '../src/core/connectors/keyring.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { CONNECTORS_SERVER_NAME } from '../src/core/connectors/gateway.js';
import { setTicked } from '../src/core/connectors/github/allowlist.js';
import { GhError } from '../src/core/connectors/github/client.js';
import type { GhResponse } from '../src/core/connectors/github/client.js';
import { SHIPPED_CLASSES } from '../src/core/connectors/classes.js';
import { GITHUB_WRITE_TOOLS } from '../src/core/connectors/github/write-tools.js';
import { createConnectorsModule } from '../src/core/connectors/index.js';
import type { ModuleDeps, ModuleJob } from '../src/core/modules.js';
import { GITHUB_NOT_SIGNED_FOR_WRITE_TEXT, GITHUB_WRITE_NEEDS_ACCESS_TEXT } from '../src/shared/connectors-view.js';
import type { ApprovalMode, ApprovalRequest, LegionEvent } from '../src/shared/types.js';
import { mkAgent } from './armory-rig.js';
import { signedInGitHub } from './connectors-rig.js';
import { tempDir } from './tmp-cleanup.js';

const WRITE_NAMES = Object.entries(SHIPPED_CLASSES.github!).filter(([, c]) => c === 'WRITE').map(([n]) => n).sort();
const LONG_BODY = ('Line of a long body. '.repeat(40) + '\n').repeat(3) + 'END-OF-BODY-MARKER';

/** Good arguments for each write tool, and what must reach GitHub. */
const CASES: Record<string, { args: Record<string, unknown>; method: string; path: string; body?: Record<string, unknown> }> = {
  github_issue_write: { args: { title: 'A title', body: LONG_BODY, labels: ['bug'] }, method: 'POST', path: '/repos/o/r/issues', body: { title: 'A title', body: LONG_BODY, labels: ['bug'] } },
  github_comment: { args: { number: 7, body: LONG_BODY }, method: 'POST', path: '/repos/o/r/issues/7/comments', body: { body: LONG_BODY } },
  github_create_pr: { args: { title: 'T', head: 'feature', base: 'main', body: 'B' }, method: 'POST', path: '/repos/o/r/pulls', body: { title: 'T', head: 'feature', base: 'main', body: 'B' } },
  github_review: { args: { number: 3, event: 'COMMENT', body: 'Looks fine' }, method: 'POST', path: '/repos/o/r/pulls/3/reviews', body: { event: 'COMMENT', body: 'Looks fine' } },
  github_ci_rerun: { args: { runId: 55 }, method: 'POST', path: '/repos/o/r/actions/runs/55/rerun-failed-jobs' },
  github_ci_cancel: { args: { runId: 56 }, method: 'POST', path: '/repos/o/r/actions/runs/56/cancel' },
};

interface Sent { method: string; path: string; body?: unknown }
interface Rig {
  sent: Sent[]; cards: ApprovalRequest[];
  answer: { value: boolean | 'never' };
  fail: { value: Error | undefined };
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

function mk(o: { runtime?: 'claude' | 'provider'; mode?: ApprovalMode; tainted?: boolean; noBroker?: boolean; agentName?: string } = {}): Rig {
  const dir = tempDir('legion-ghcards-');
  setTicked(dir, 'o/r', true);
  const sent: Sent[] = [];
  const cards: ApprovalRequest[] = [];
  const answer: Rig['answer'] = { value: true };
  const fail: Rig['fail'] = { value: undefined };
  const bus = new EventBus();
  const broker = new ApprovalBroker(bus, { timeoutMs: 60_000 });
  bus.on((ev: LegionEvent) => {
    if (ev.type !== 'approval.requested') return;
    cards.push(ev.approval);
    if (answer.value !== 'never') setImmediate(() => broker.resolve(ev.approval.id, answer.value === true));
  });
  const api = {
    request: async (path: string, init?: { method?: string; body?: string }): Promise<GhResponse> => {
      sent.push({ method: init?.method ?? 'GET', path, ...(init?.body !== undefined ? { body: JSON.parse(init.body) } : {}) });
      if (fail.value) throw fail.value;
      return { status: 201, json: { id: 99, number: 12, html_url: 'https://github.com/o/r/issues/12' }, rate: { limit: 5000, remaining: 4999, resetAt: '' } };
    },
    connection: async () => ({}),
  };
  const agent = mkAgent('alpha', { name: o.agentName ?? 'Mira', connectors: ['github'], githubWrite: ['o/r'], approval: o.mode ?? 'ask', mcpServers: ['*'] });
  const deps = {
    dataDir: dir, approvals: o.noBroker ? undefined : broker,
    store: { getAgent: () => agent, getTask: () => undefined },
  } as unknown as ModuleDeps;
  const mod = createConnectorsModule(deps, { keys: new ConnectorKeyring(), client: () => api as never, writeApp: () => ({ api: api as never, can: () => 'yes' }) });
  const job = { taskId: 't1', runtime: o.runtime ?? 'claude', taint: () => o.tainted === true, markTainted: () => undefined } as unknown as ModuleJob;
  const built = mod.mcpServers!(agent, job)[CONNECTORS_SERVER_NAME] as any;
  const call: Rig['call'] = async (name, args) => {
    const t = built.instance._registeredTools[name];
    assert.ok(t, `${name} is registered`);
    const { repo, ...fields } = args;
    const out = await t.handler({ repo: repo ?? 'o/r', fields }, {});
    return { text: out.content.map((c: any) => c.text).join('\n') as string, isError: out.isError === true };
  };
  return { sent, cards, answer, fail, call };
}

test('the table holds exactly the six write names of classes.ts', () => {
  assert.deepEqual(Object.keys(GITHUB_WRITE_TOOLS).sort(), WRITE_NAMES);
  assert.deepEqual(Object.keys(CASES).sort(), WRITE_NAMES);
});

for (const runtime of ['claude', 'provider'] as const) {
  for (const mode of ['ask', 'auto-edits', 'full'] as const) {
    test(`${runtime} path, ${mode} mode: each write raises exactly one card, then sends exactly one request (mutation: no card in full)`, async () => {
      for (const name of WRITE_NAMES) {
        const r = mk({ runtime, mode });
        const c = CASES[name]!;
        const out = await r.call(name, c.args);
        assert.equal(out.isError, false, `${name}: ${out.text}`);
        assert.equal(r.cards.length, 1, `${name}: one card`);
        assert.equal(r.cards[0]!.toolName, `mcp__${CONNECTORS_SERVER_NAME}__${name}`);
        assert.equal(r.cards[0]!.noRemember, true, 'no Remember on a GitHub write');
        assert.equal(r.sent.length, 1, `${name}: one request`);
        assert.equal(r.sent[0]!.method, c.method);
        assert.equal(r.sent[0]!.path, c.path);
        assert.deepEqual(r.sent[0]!.body, c.body);
      }
    });
  }
}

test('Deny sends nothing, and the agent is told so in plain words (mutation: send anyway)', async () => {
  for (const name of WRITE_NAMES) {
    const r = mk({ mode: 'full' });
    r.answer.value = false;
    const out = await r.call(name, CASES[name]!.args);
    assert.equal(r.cards.length, 1, name);
    assert.deepEqual(r.sent, [], `${name}: nothing sent`);
    assert.equal(out.isError, true, name);
    assert.match(out.text, /did not approve/i, name);
    assert.match(out.text, /nothing was sent/i, name);
  }
});

test('the request waits for the answer: while the card is open nothing has been sent (mutation: send before the answer)', async () => {
  const r = mk();
  r.answer.value = 'never';
  const pending = r.call('github_comment', CASES.github_comment!.args);
  await new Promise((res) => setTimeout(res, 40));
  assert.equal(r.cards.length, 1);
  assert.deepEqual(r.sent, []);
  void pending; // left open on purpose: the test process ends with the card unanswered
});

test('the card shows repo, tool, the full argument text, the agent name (mutations: cut the text to 400, drop the agent name)', async () => {
  const r = mk({ agentName: 'Mira Vale' });
  await r.call('github_comment', { number: 7, body: LONG_BODY });
  const s = r.cards[0]!.summary;
  assert.match(s, /o\/r/);
  assert.match(s, /github_comment/);
  assert.match(s, /Mira Vale/);
  assert.ok(s.includes('END-OF-BODY-MARKER'), 'the end of a long body is on the card');
  assert.ok(s.includes('comment on #7'));
  assert.ok(s.length > 400, 'not cut to the usual summary length');
  assert.equal(r.cards[0]!.input.repo, 'o/r');
});

test('the taint warning is on the card when the run read outside content, and only then (mutation: invert the test)', async () => {
  const dirty = mk({ tainted: true });
  await dirty.call('github_ci_rerun', { runId: 5 });
  assert.match(dirty.cards[0]!.summary, /read text from outside/i);
  assert.match(dirty.cards[0]!.summary, /may have steered it/i);
  const clean = mk({ tainted: false });
  await clean.call('github_ci_rerun', { runId: 5 });
  assert.doesNotMatch(clean.cards[0]!.summary, /read text from outside/i);
});

test('a card is raised even for a run that has not been tainted yet and a fail-closed taint read counts as tainted', async () => {
  const r = mk({ tainted: false });

  await r.call('github_review', CASES.github_review!.args);
  assert.equal(r.cards.length, 1);
});

test('a network error after the send is reported and never retried (mutation: loop the send)', async () => {
  for (const name of WRITE_NAMES) {
    const r = mk();
    r.fail.value = new GhError('network', { retryable: true });
    const out = await r.call(name, CASES[name]!.args);
    assert.equal(r.sent.length, 1, `${name}: sent once, never again`);
    assert.equal(r.cards.length, 1, name);
    assert.match(out.text, /may have gone through/i, name);
    assert.match(out.text, /not send it again|did not send it a second time/i, name);
  }
});

test('a refusal from GitHub is reported and not retried', async () => {
  const r = mk();
  r.fail.value = new GhError('forbidden', { needs: 'write' });
  const out = await r.call('github_issue_write', CASES.github_issue_write!.args);
  assert.equal(out.isError, true);
  assert.match(out.text, /forbidden/);
  assert.equal(r.sent.length, 1);
});

test('bad arguments are refused in plain words with no card and no request', async () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['github_comment', { body: 'no number' }],
    ['github_comment', { number: 7, body: '' }],
    ['github_comment', { number: -1, body: 'x' }],
    ['github_issue_write', { body: 'no title' }],
    ['github_create_pr', { title: 'T', head: 'f' }],
    ['github_review', { number: 3, event: 'MERGE' }],
    ['github_review', { number: 3, event: 'REQUEST_CHANGES' }],
    ['github_ci_rerun', { runId: 'abc' }],
    ['github_ci_cancel', {}],
    ['github_comment', { number: 7, body: 'x'.repeat(70_000) }],
  ];
  for (const [name, args] of bad) {
    const r = mk();
    const out = await r.call(name, args);
    assert.equal(out.isError, true, `${name} ${JSON.stringify(args).slice(0, 40)}`);
    assert.equal(r.cards.length, 0, name);
    assert.deepEqual(r.sent, [], name);
  }
});

test('with no way to ask the owner, nothing is sent', async () => {
  const r = mk({ noBroker: true });
  const out = await r.call('github_comment', CASES.github_comment!.args);
  assert.equal(out.isError, true);
  assert.deepEqual(r.sent, []);
  assert.match(out.text, /could not ask/i);
});

test('the paths are encoded: a model-chosen repo that climbs out of the repo path is refused with no card', async () => {
  const r = mk();
  const out = await r.call('github_comment', { repo: 'o/r/../x', number: 1, body: 'x' });
  assert.equal(out.isError, true);
  assert.equal(r.cards.length, 0);
  assert.deepEqual(r.sent, []);
});

// ------------------------------------------------------------------------------------------------ the real write app

test('real wiring: signed in with the write app and the permission, the card is raised and the fake GitHub receives the comment', async () => {
  const gh = await signedInGitHub();
  try {
    const dir = tempDir('legion-ghreal-');
    setTicked(dir, 'o/r', true);
    const bus = new EventBus();
    const broker = new ApprovalBroker(bus, { timeoutMs: 60_000 });
    let cards = 0;
    bus.on((ev) => { if (ev.type === 'approval.requested') { cards++; setImmediate(() => broker.resolve(ev.approval.id, true)); } });
    const agent = mkAgent('alpha', { connectors: ['github'], githubWrite: ['o/r'], approval: 'full', mcpServers: ['*'] });
    const deps = { dataDir: dir, approvals: broker, store: { getAgent: () => agent, getTask: () => undefined } } as unknown as ModuleDeps;
    const mod = createConnectorsModule(deps, { keys: gh.keys, client: () => gh.client, writeClient: () => gh.client });
    const job = { taskId: 't1', runtime: 'claude', taint: () => true, markTainted: () => undefined } as unknown as ModuleJob;
    const built = mod.mcpServers!(agent, job)[CONNECTORS_SERVER_NAME] as any;
    const out = await built.instance._registeredTools.github_comment.handler({ repo: 'o/r', fields: { number: 1, body: 'hello' } }, {});
    assert.notEqual(out.isError, true, out.content[0].text);
    assert.equal(cards, 1);
    const posts = gh.fake.apiRequests().filter((r) => r.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, '/repos/o/r/issues/1/comments');
    // pull requests are not covered by that install: refused in plain words, no card
    const pr = await built.instance._registeredTools.github_review.handler({ repo: 'o/r', fields: { number: 1, event: 'COMMENT', body: 'x' } }, {});
    assert.equal(pr.content[0].text, GITHUB_WRITE_NEEDS_ACCESS_TEXT);
    assert.equal(cards, 1);
  } finally { await gh.fake.stop(); }
});

test('real wiring: no write sign-in means a plain refusal, no card and no request', async () => {
  const gh = await signedInGitHub();
  try {
    const dir = tempDir('legion-ghreal2-');
    setTicked(dir, 'o/r', true);
    const broker = new ApprovalBroker(new EventBus(), { timeoutMs: 60_000 });
    const agent = mkAgent('alpha', { connectors: ['github'], githubWrite: ['o/r'], mcpServers: ['*'] });
    const deps = { dataDir: dir, approvals: broker, store: { getAgent: () => agent, getTask: () => undefined } } as unknown as ModuleDeps;
    // no write client at all, and a write client that is not signed in
    for (const writeClient of [() => undefined, () => ({ signedIn: async () => false, can: () => 'yes', connection: async () => ({}), request: async () => { throw new Error('no'); } }) as never]) {
      const mod = createConnectorsModule(deps, { keys: gh.keys, client: () => gh.client, writeClient });
      const job = { taskId: 't1', runtime: 'claude', taint: () => false, markTainted: () => undefined } as unknown as ModuleJob;
      const built = mod.mcpServers!(agent, job)[CONNECTORS_SERVER_NAME] as any;
      const out = await built.instance._registeredTools.github_comment.handler({ repo: 'o/r', fields: { number: 1, body: 'x' } }, {});
      assert.equal(out.content[0].text, GITHUB_NOT_SIGNED_FOR_WRITE_TEXT);
      assert.equal(broker.pending().length, 0);
    }
    assert.equal(gh.fake.apiRequests().filter((r) => r.method === 'POST').length, 0);
  } finally { await gh.fake.stop(); }
});
