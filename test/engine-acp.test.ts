import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './tmp-cleanup.js';
import { AUTH, makeFakes, start } from './helpers-c.js';
import { ApprovalBroker, ACP_CLOSED_NOTE, ACP_LATE_NOTE } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { Engine } from '../src/core/engine.js';
import type { QueryFn } from '../src/core/engine.js';
import { Store } from '../src/core/store.js';
import { defaultConfig } from '../src/shared/config.js';
import { TURN_LIMIT_PREFIX, BUDGET_LIMIT_PREFIX } from '../src/shared/continue.js';
import type { AcpEntry, AcpSwitches } from '../src/shared/acp-view.js';
import type { AgentProfile, ApprovalMode, ApprovalRequest, ChatMessage, Task } from '../src/shared/types.js';
import { forgetLegionSecrets, registerLegionSecrets } from '../src/core/acp/process.js';
import { findRunGrant, issueRunToken, revokeAllRunTokens } from '../src/core/acp/run-tokens.js';
import type { RunToken } from '../src/core/acp/run-tokens.js';
import { HERMES_CWD_TEXT, HERMES_WATCHDOG_TEXT } from '../src/core/acp/texts.js';

// The engine's Hermes runtime against the scripted fake agent (test/acp-fake-agent.ts, mode `script`) and the real approval broker, which the tests answer.
// ACP wire shapes: https://agentclientprotocol.com (prompt-turn, tool-calls, session-setup). Hermes side: permissions.py (options, 300 s self-deny).
const FAKE = fileURLToPath(new URL('./acp-fake-agent.js', import.meta.url));
registerLegionSecrets(['test-bearer-token-0123456789']);
const reports: string[] = [];
/** The pid the fake agent wrote at start (it writes the file in one go, but the file can exist a moment before it is complete). */
const agentPid = (reportFile: string): number | undefined => { try { const n = (JSON.parse(readFileSync(reportFile, 'utf8')) as { pid?: number }).pid; return typeof n === 'number' ? n : undefined; } catch { return undefined; } };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
after(() => {
  revokeAllRunTokens(); forgetLegionSecrets();
  for (const f of reports) { const pid = agentPid(f); if (pid !== undefined && alive(pid)) { try { process.kill(pid); } catch { /* gone */ } } } // only agents these tests started
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('until timed out'); await sleep(15); }
}

type Step = Record<string, unknown>;
const CMD = (id: string, command: string, extra: Step = {}): Step => ({ op: 'permission', id, title: `run it: ${command}`, kind: 'execute', rawInput: { command, description: 'run it' }, ...extra });
const END = (usage?: { inputTokens: number; outputTokens: number }, stopReason = 'end_turn'): Step => ({ op: 'end', stopReason, ...(usage ? { usage } : {}) });

interface RigOpts {
  steps?: Step[];
  switches?: Partial<AcpSwitches>;
  approval?: ApprovalMode;
  entry?: Partial<AcpEntry>;
  /** undefined: a good folder; null: the agent has no folder of its own (the default workspace is used); a path: that folder */
  cwd?: string | null;
  agentHost?: Record<string, unknown>;
  gates?: Record<string, unknown>;
  fakeArgs?: string[];
  tokens?: RunToken[];
}

function rig(o: RigOpts = {}) {
  const root = tempDir('legion-eacp-');
  const dataDir = join(root, 'data');
  const work = join(root, 'work');
  const hermesHome = join(root, 'hermes-home');
  for (const d of [dataDir, work, hermesHome]) mkdirSync(d, { recursive: true });
  const scriptFile = join(root, 'script.json');
  const logFile = join(root, 'in.log');
  const reportFile = join(root, 'report.json');
  reports.push(reportFile);
  const setScript = (steps: Step[]) => writeFileSync(scriptFile, JSON.stringify(steps));
  setScript(o.steps ?? [{ op: 'text', text: 'hello ' }, { op: 'text', text: 'world' }, END()]);
  const store = new Store(join(root, 'store'));
  const bus = new EventBus();
  const broker = new ApprovalBroker(bus);
  const config = defaultConfig();
  config.workspaceDir = join(root, 'workspaces');
  const entry: AcpEntry = { id: 'hermes', label: 'Hermes', command: process.execPath, args: [FAKE, '--mode', 'script', '--script', scriptFile, '--log', logFile, '--report', reportFile, ...(o.fakeArgs ?? [])], tested: true, enabled: true, ...o.entry };
  config.acp = { ...config.acp, entries: [entry], switches: { disasterStop: false, modeMap: false, stripSkipFlags: false, answerOnce: false, ...o.switches } };
  const hermes: AgentProfile = {
    id: 'herm', name: 'Herm', emoji: '*', description: 'acts through Hermes', systemPrompt: '', model: 'acp:hermes',
    vm: { enabled: false, size: 'default', idleStopMinutes: 15 }, approval: o.approval ?? 'ask', mcpServers: [], createdAt: '', updatedAt: '',
    ...(o.cwd === null ? {} : { cwd: o.cwd ?? work }),
  };
  const claude: AgentProfile = { ...hermes, id: 'clau', name: 'Clau', model: 'sonnet', approval: 'full', cwd: work };
  store.upsertAgent(hermes); store.upsertAgent(claude);
  const claudeRuns: Array<{ prompt: unknown }> = [];
  const queryFn = ((p: any) => {
    claudeRuns.push({ prompt: p.prompt });
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0, num_turns: 1, session_id: 's1' };
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const tokens = o.tokens ?? [];
  const engine = new Engine({
    store, bus, vms: {} as any, approvals: broker, config, queryFn, boatConfigured: () => false, ...(o.gates ? { gates: o.gates as any } : {}),
    agentHost: { dataDir, port: 41999, hermesHome, cancelGraceMs: 400, issueRunToken: (t: string, a: string) => { const k = issueRunToken(t, a); tokens.push(k); return k; }, ...o.agentHost },
  });
  engine.setModules([{ protectedPaths: () => [join(dataDir, 'config.json'), join(dataDir, 'gates')] } as any]);
  const events: any[] = [];
  bus.on((e) => events.push(e));
  const msgs = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : []);
  const run = async (prompt = 'do it', over: Record<string, unknown> = {}) => {
    const t = engine.startTask({ agentId: 'herm', prompt, source: 'ui', ...over } as any);
    return t;
  };
  const done = (t: Task, ms = 20_000) => engine.waitFor(t.id, ms);
  const nextCard = async (): Promise<ApprovalRequest> => { await until(() => broker.pending().length > 0); return broker.pending()[0]!; };
  const rows = (id: string): ChatMessage[] => store.listMessages(id);
  const answersTo = (rid: number) => msgs().filter((m) => m.id === rid && m.method === undefined && m.result !== undefined);
  return { root, dataDir, work, hermesHome, store, bus, broker, config, engine, events, msgs, run, done, nextCard, rows, answersTo, setScript, tokens, claudeRuns, logFile, reportFile, hermes, claude };
}

const outcomeOf = (m: Record<string, any>) => m.result?.outcome as { outcome: string; optionId?: string };

// ---------------------------------------------------------------- the engine runs Hermes

test('without an agent host setup the engine still fails in plain words and never reaches Claude or a provider', async () => {
  const r = rig();
  const bare = new Engine({ store: r.store, bus: r.bus, vms: {} as any, approvals: r.broker, config: r.config, queryFn: (() => { throw new Error('Claude must not run'); }) as unknown as QueryFn, boatConfigured: () => false });
  const t = bare.startTask({ agentId: 'herm', prompt: 'x', source: 'ui' } as any);
  const end = await bare.waitFor(t.id, 5000);
  assert.equal(end.status, 'error');
  assert.match(end.error ?? '', /cannot run Hermes agents/);
});

test('pass-through: ONE card per request with Hermes\'s title and its own option names; the chosen optionId goes back verbatim (allow_always included); nothing is remembered', async () => {
  const r = rig({ steps: [CMD('perm-check-1', 'ls -la'), CMD('perm-check-2', 'ls -la'), END()] });
  const t = await r.run();
  const c1 = await r.nextCard();
  assert.equal(r.broker.pending().length, 1, 'one card for one request');
  assert.equal(c1.acpTitle, 'run it: ls -la');
  assert.deepEqual(c1.acpOptions?.map((o) => o.name), ['Allow once', 'Allow for session', 'Allow always', 'Deny']);
  assert.match(c1.summary, /ls -la/);
  assert.equal(c1.noRemember, true, 'Legion stores nothing for always');
  assert.equal(r.broker.resolve(c1.id, true, undefined, 'allow_always'), true, 'an allow_always option is allowed and sent as is');
  await until(() => r.answersTo(9100).length === 1);
  assert.deepEqual(outcomeOf(r.answersTo(9100)[0]!), { outcome: 'selected', optionId: 'allow_always' });
  const c2 = await r.nextCard();
  assert.notEqual(c2.id, c1.id, 'the same command asked again is a new card: nothing was remembered');
  r.broker.resolve(c2.id, false);
  const end = await r.done(t);
  assert.equal(end.status, 'done');
  assert.deepEqual(outcomeOf(r.answersTo(9101)[0]!), { outcome: 'selected', optionId: 'deny' }, 'a deny sends Hermes\'s own reject_once option, not a cancel');
});

test('answerOnce: allow_always options are not shown, and a hidden option id is refused when sent anyway', async () => {
  const r = rig({ switches: { answerOnce: true }, steps: [CMD('perm-check-1', 'ls'), END()] });
  const t = await r.run();
  const c = await r.nextCard();
  assert.deepEqual(c.acpOptions?.map((o) => o.kind), ['allow_once', 'reject_once']);
  assert.throws(() => r.broker.resolve(c.id, true, undefined, 'allow_always'), /not on this card/);
  assert.equal(r.broker.pending().length, 1, 'the card stays open after a refused answer');
  r.broker.resolve(c.id, true); // an allow with no option sends allow_once, never allow_always
  await r.done(t);
  assert.deepEqual(outcomeOf(r.answersTo(9100)[0]!), { outcome: 'selected', optionId: 'allow_once' });
});

test('disasterStop on: a catastrophic command and a command on Legion\'s settings folder are answered with reject_once and no card, in every mode; off: a card', async () => {
  for (const approval of ['ask', 'full'] as const) {
    const r = rig({ approval, switches: { disasterStop: true }, steps: [CMD('perm-check-1', 'rm -rf /'), CMD('perm-check-2', 'ls'), END()] });
    const cmd2 = `rm ${join(r.dataDir, 'config.json')}`;
    r.setScript([CMD('perm-check-1', 'rm -rf /'), CMD('perm-check-2', cmd2), CMD('perm-check-3', 'ls'), END()]);
    const t = await r.run();
    const c = await r.nextCard();
    assert.match(c.summary, /ls/, `${approval}: only the harmless command reached a card`);
    assert.deepEqual(outcomeOf(r.answersTo(9100)[0]!), { outcome: 'selected', optionId: 'deny' });
    assert.deepEqual(outcomeOf(r.answersTo(9101)[0]!), { outcome: 'selected', optionId: 'deny' });
    r.broker.resolve(c.id, true);
    await r.done(t);
    assert.ok(r.rows(t.id).some((m) => m.role === 'system' && /refused/i.test(m.text)), 'a thread notice says Legion refused it');
  }
  const off = rig({ steps: [CMD('perm-check-1', 'rm -rf /'), END()] });
  const t = await off.run();
  const c = await off.nextCard();
  assert.match(c.summary, /rm -rf \//, 'with the switch off a catastrophic request is a card (pass-through)');
  off.broker.resolve(c.id, false);
  await off.done(t);
});

test('R19: a request that names a Legion protected file says so on the card, and still asks', async () => {
  const r = rig({ steps: [CMD('perm-check-1', 'cat gates/rules.json'), { op: 'permission', id: 'edit-approval-1', title: 'write_file: x', kind: 'edit', rawInput: { tool: 'write_file', arguments: { path: 'PLACEHOLDER' } } }, END()] });
  r.setScript([CMD('perm-check-1', `type ${join(r.dataDir, 'config.json')}`), { op: 'permission', id: 'edit-approval-1', title: 'write_file: x', kind: 'edit', rawInput: { tool: 'write_file', arguments: { path: join(r.dataDir, 'gates', 'rules.json') } } }, CMD('perm-check-3', 'ls'), END()]);
  const t = await r.run();
  const c1 = await r.nextCard();
  assert.match(c1.summary, /This touches Legion's own settings: config\.json/);
  r.broker.resolve(c1.id, true);
  await until(() => r.broker.pending().length === 1 && r.broker.pending()[0]!.id !== c1.id);
  const c2 = r.broker.pending()[0]!;
  assert.match(c2.summary, /This touches Legion's own settings: gates/);
  r.broker.resolve(c2.id, true);
  const c3 = await (async () => { await until(() => r.broker.pending().length === 1 && r.broker.pending()[0]!.id !== c2.id); return r.broker.pending()[0]!; })();
  assert.doesNotMatch(c3.summary, /Legion's own settings/);
  r.broker.resolve(c3.id, true);
  await r.done(t);
});

test('modeMap: Ask -> default, Accept edits -> accept_edits, Full -> dont_ask (commands still card); switch off: Legion sets no mode', async () => {
  const modes = async (approval: ApprovalMode, on: boolean) => {
    const r = rig({ approval, switches: { modeMap: on }, steps: [CMD('perm-check-1', 'ls'), END()] });
    const t = await r.run();
    const c = await r.nextCard();
    if (on && approval === 'full') assert.ok(c, 'Full: Hermes\'s own command prompt still becomes a card');
    r.broker.resolve(c.id, true);
    await r.done(t);
    return r.msgs().filter((m) => m.method === 'session/set_mode').map((m) => m.params.modeId);
  };
  assert.deepEqual(await modes('ask', true), ['default']);
  assert.deepEqual(await modes('auto-edits', true), ['accept_edits']);
  assert.deepEqual(await modes('full', true), ['dont_ask']);
  assert.deepEqual(await modes('full', false), [], 'with the switch off Legion sets no mode');
});

test('modeMap with Bypass: dont_ask and every request is answered allow_once without a card, except a disasterStop refusal', async () => {
  const bypass = { gate: (id: string) => (id === 'tool-cards' ? false : true), switchedOff: () => false };
  const r = rig({ approval: 'full', gates: bypass, switches: { modeMap: true, disasterStop: true }, steps: [CMD('perm-check-1', 'ls'), CMD('perm-check-2', 'rm -rf /'), END()] });
  const t = await r.run();
  const end = await r.done(t);
  assert.equal(end.status, 'done');
  assert.equal(r.broker.pending().length, 0, 'no card at all');
  assert.deepEqual(r.msgs().filter((m) => m.method === 'session/set_mode').map((m) => m.params.modeId), ['dont_ask']);
  assert.deepEqual(outcomeOf(r.answersTo(9100)[0]!), { outcome: 'selected', optionId: 'allow_once' });
  assert.deepEqual(outcomeOf(r.answersTo(9101)[0]!), { outcome: 'selected', optionId: 'deny' });
});

test('R36 and Review Focus 3: the card shows when it closes, closes itself when Hermes stops waiting, and a late answer is not sent', async () => {
  const r = rig({ agentHost: { permissionWaitMs: 500 }, steps: [CMD('perm-check-1', 'ls'), END()] });
  const t = await r.run();
  const c = await r.nextCard();
  const left = Date.parse(c.expiresAt ?? '') - Date.now();
  assert.ok(left > 0 && left <= 500, `the card carries its deadline (${left} ms left)`);
  await until(() => r.events.some((e) => e.type === 'approval.resolved' && e.approvalId === c.id));
  const closed = r.events.find((e) => e.type === 'approval.resolved' && e.approvalId === c.id);
  assert.equal(closed.allowed, false);
  assert.equal(closed.note, ACP_CLOSED_NOTE);
  assert.equal(ACP_CLOSED_NOTE, 'The agent stopped waiting');
  await until(() => r.answersTo(9100).length === 1, 5000); // the closing reply (cancelled) is the only one
  const before = r.msgs().filter((m) => m.id === 9100).length;
  assert.equal(r.broker.resolve(c.id, true, undefined, 'allow_once'), false, 'a late answer is not accepted');
  assert.equal(r.broker.lateNote(c.id), 'Hermes had already stopped waiting, so nothing was run.');
  assert.equal(ACP_LATE_NOTE, 'Hermes had already stopped waiting, so nothing was run.');
  await r.done(t);
  assert.equal(r.msgs().filter((m) => m.id === 9100 && m.result?.outcome?.optionId === 'allow_once').length, 0, 'no allow went to Hermes');
  assert.equal(r.msgs().filter((m) => m.id === 9100).length, before, 'the late answer added no reply on the wire');
  assert.equal(r.answersTo(9100).filter((m) => outcomeOf(m).outcome === 'selected').length, 0);
});

test('a card answered after the turn ended or the task was cancelled reads as late too', async () => {
  const r = rig({ steps: [CMD('perm-check-1', 'ls'), { op: 'waitCancel' }, END()] });
  const t = await r.run();
  const c = await r.nextCard();
  r.engine.cancel(t.id);
  await r.done(t);
  await until(() => r.answersTo(9100).length === 1, 5000); // the cancel marks the task at once; the wire follows
  assert.equal(r.broker.resolve(c.id, true, undefined, 'allow_once'), false);
  assert.equal(r.broker.lateNote(c.id), ACP_LATE_NOTE);
  assert.equal(r.answersTo(9100).filter((m) => outcomeOf(m).outcome === 'selected').length, 0);
  assert.deepEqual(r.answersTo(9100).map((m) => outcomeOf(m).outcome), ['cancelled'], 'Legion-side cancel answers the open request with the spec\'s cancelled outcome (R22)');
});

test('thread: chunks stream as message.delta, one assistant row at the end, tool rows with title and clipped content, plan to progress.todos, thought only to progress.thinking', async () => {
  const r = rig({ steps: [
    { op: 'thought', text: 'secret plan' }, { op: 'text', text: 'hello ' },
    { op: 'plan', entries: [{ content: 'read it', priority: 'medium', status: 'completed' }, { content: 'fix it', priority: 'medium', status: 'in_progress' }] },
    { op: 'tool', id: 'call_1', title: 'terminal: ls', kind: 'execute', rawInput: { command: 'ls' } },
    { op: 'toolUpdate', id: 'call_1', status: 'completed', content: 'a.txt\nb.txt' },
    { op: 'text', text: 'world' }, END(),
  ] });
  const t = await r.run();
  const end = await r.done(t);
  assert.equal(end.status, 'done');
  assert.deepEqual(r.events.filter((e) => e.type === 'message.delta').map((e) => e.text), ['hello ', 'world']);
  const rows = r.rows(t.id);
  const assistants = rows.filter((m) => m.role === 'assistant');
  assert.deepEqual(assistants.map((m) => m.text), ['hello world']);
  assert.ok(!rows.some((m) => m.text.includes('secret plan')), 'a thought is never a row');
  const tool = rows.find((m) => m.role === 'tool' && m.toolUseId === 'call_1');
  assert.ok(tool && tool.text.includes('terminal: ls') && tool.toolName === 'Bash', JSON.stringify(tool));
  assert.ok(rows.some((m) => m.resultFor === 'call_1' && m.text.includes('a.txt')), 'the result row carries the content');
  const prog = r.events.filter((e) => e.type === 'task.progress').map((e) => e.progress);
  assert.ok(prog.some((p) => p.thinking === true), 'thought shows as thinking');
  assert.ok(prog.some((p) => p.todos?.length === 2 && p.todos[1].status === 'in_progress'), 'plan is the checklist');
});

test('R34: tool calls on the Legion route (mcp__editor_legion_<tag>__<tool>) get no second row; other tools do', async () => {
  const r = rig({ steps: [
    { op: 'tool', id: 'c1', title: 'mcp__editor_legion_ab12cd34__ask: hi', kind: 'other', rawInput: { agent: 'x' } },
    { op: 'tool', id: 'c2', title: 'mcp__editor_other_ab12cd34__ask: hi', kind: 'other', rawInput: {} }, END(),
  ] });
  const t = await r.run();
  await r.done(t);
  const tools = r.rows(t.id).filter((m) => m.role === 'tool' && !m.resultFor).map((m) => m.toolUseId);
  assert.deepEqual(tools, ['c2']);
});

test('usage: token deltas into tokenUsage, costUsd unset and costUnknown true; with prices the cost is recorded', async () => {
  const r = rig({ steps: [{ op: 'text', text: 'x' }, END({ inputTokens: 100, outputTokens: 20 })] });
  const t = await r.run();
  const end = await r.done(t);
  assert.deepEqual({ i: end.tokenUsage?.inputTokens, o: end.tokenUsage?.outputTokens }, { i: 100, o: 20 });
  assert.equal(end.costUsd, undefined);
  assert.equal(end.costUnknown, true);
  const p = rig({ entry: { prices: { inputPerMTok: 10, outputPerMTok: 20 } }, steps: [END({ inputTokens: 1_000_000, outputTokens: 500_000 })] });
  const t2 = await p.run();
  const e2 = await p.done(t2);
  assert.equal(e2.costUsd, 20);
  assert.notEqual(e2.costUnknown, true);
});

test('R20: a second turn on the same task resumes the session and counts only the new tokens', async () => {
  const r = rig({ steps: [{ op: 'text', text: 'one' }, END({ inputTokens: 100, outputTokens: 20 })] });
  const t = await r.run();
  await r.done(t);
  r.setScript([{ op: 'text', text: 'two' }, END({ inputTokens: 250, outputTokens: 60 })]);
  const t2 = r.engine.startTask({ agentId: 'herm', prompt: 'again', source: 'ui', continueTaskId: t.id } as any);
  const end = await r.done(t2);
  assert.equal(end.status, 'done');
  assert.ok(r.msgs().some((m) => m.method === 'session/resume' && m.params.sessionId === 'sess_fake_1'), 'the stored session is resumed');
  const resume = r.msgs().find((m) => m.method === 'session/resume')!;
  assert.equal(resume.params.mcpServers.length, 1, 'the route is resent on resume');
  assert.deepEqual({ i: end.tokenUsage?.inputTokens, o: end.tokenUsage?.outputTokens }, { i: 250, o: 60 }, '100+150 and 20+40, not 350/80');
});

test('R20: a resumed task with no stored baseline counts 0 for its first turn and says so', async () => {
  const r = rig({ steps: [END({ inputTokens: 500, outputTokens: 50 })] });
  const old = r.store.upsertTask({ id: 'old1', agentId: 'herm', title: 'old', status: 'done', source: 'ui', requestedModel: 'auto', model: 'acp:hermes', acp: { entryId: 'hermes', sessionId: 'sess_fake_1' }, createdAt: '', updatedAt: '' } as Task);
  const t2 = r.engine.startTask({ agentId: 'herm', prompt: 'again', source: 'ui', continueTaskId: old.id } as any);
  const end = await r.done(t2);
  assert.equal(end.tokenUsage?.inputTokens ?? 0, 0);
  assert.ok(r.rows(t2.id).some((m) => m.role === 'system' && /not counted/.test(m.text)), 'the thread says the first turn is not counted');
});

// ---------------------------------------------------------------- outcomes

test('outcomes: end_turn done; max_turn_requests the paused turn-limit card; Hermes cancelled; watchdog the plain stopped-answering error', async () => {
  const done = rig({ steps: [END()] });
  assert.equal((await done.done(await done.run())).status, 'done');

  const max = rig({ steps: [END(undefined, 'max_turn_requests')] });
  const m = await max.done(await max.run());
  assert.equal(m.status, 'error');
  assert.ok((m.error ?? '').startsWith(TURN_LIMIT_PREFIX), m.error);

  const can = rig({ steps: [END(undefined, 'cancelled')] });
  assert.equal((await can.done(await can.run())).status, 'cancelled');

  const dog = rig({ agentHost: { watchdogMs: 300 }, steps: [{ op: 'wait', ms: 30_000 }, END()] });
  const w = await dog.done(await dog.run());
  assert.equal(w.status, 'error');
  assert.equal(w.error, HERMES_WATCHDOG_TEXT);
  assert.equal(HERMES_WATCHDOG_TEXT, 'Hermes stopped answering, so Legion stopped this task. Try again, or check Hermes in Doctor.');
});

test('refusals are plain words per reason (never the agent\'s raw text alone)', async () => {
  const cases: Array<[string[], RegExp]> = [
    [['--fail-new', 'acp_policy_unavailable'], /Hermes/],
    [['--fail-new', 'windows_breakaway_unavailable'], /background helper/],
    [['--fail-new', 'acp_mcp_policy_unavailable'], /update Hermes/i],
    [['--fail-new', 'acp_mcp_policy_conflict'], /Legion's tools/],
    [['--fail-new', 'Gateway protocol mismatch; update/restart required'], /update/i],
  ];
  for (const [fakeArgs, re] of cases) {
    const r = rig({ fakeArgs });
    const end = await r.done(await r.run());
    assert.equal(end.status, 'error', fakeArgs.join(' '));
    assert.match(end.error ?? '', re, fakeArgs.join(' '));
    assert.doesNotMatch(end.error ?? '', /Claude|[\u2013\u2014]/);
  }
  const bad = rig({ fakeArgs: [] });
  bad.config.acp.entries[0]!.args = [FAKE, '--mode', 'bad-version'];
  assert.match((await bad.done(await bad.run())).error ?? '', /ACP|protocol|version/i);
});

test('a session the agent no longer has is not a Claude resume: the thread starts a new Hermes conversation and says so', async () => {
  const r = rig({ steps: [{ op: 'text', text: 'fresh' }, END()] });
  const old = r.store.upsertTask({ id: 'old2', agentId: 'herm', title: 'old', status: 'done', source: 'ui', requestedModel: 'auto', model: 'acp:hermes', acp: { entryId: 'hermes', sessionId: 'sess_missing', cumulative: { input: 5, output: 5 } }, createdAt: '', updatedAt: '' } as Task);
  const end = await r.done(r.engine.startTask({ agentId: 'herm', prompt: 'again', source: 'ui', continueTaskId: old.id } as any));
  assert.equal(end.status, 'done');
  assert.ok(r.rows(end.id).some((m) => m.role === 'system' && /Hermes no longer has/.test(m.text) && !/Claude/.test(m.text)));
  assert.equal(r.claudeRuns.length, 0);
});

// ---------------------------------------------------------------- limits (Task 3b)

test('maxSteps: the call after the limit cancels the turn and the task pauses on the turn-limit card; maxTokensPerTask pauses on the spend-limit card', async () => {
  const tool = (i: number): Step => ({ op: 'tool', id: `c${i}`, title: `terminal: ls ${i}`, kind: 'execute', rawInput: { command: 'ls' } });
  const r = rig({ entry: { maxSteps: 2 }, steps: [tool(1), tool(2), tool(3), { op: 'waitCancel' }, END()] });
  const end = await r.done(await r.run());
  assert.equal(end.status, 'error');
  assert.ok((end.error ?? '').startsWith(TURN_LIMIT_PREFIX) && /2 steps/.test(end.error ?? ''), end.error);
  assert.ok(r.msgs().some((m) => m.method === 'session/cancel'));
  const tk = rig({ entry: { maxTokensPerTask: 1000 }, steps: [END({ inputTokens: 800, outputTokens: 400 })] });
  const e2 = await tk.done(await tk.run());
  assert.equal(e2.status, 'error');
  assert.ok((e2.error ?? '').startsWith(BUDGET_LIMIT_PREFIX) && /1,?200 tokens|1000 tokens/.test(e2.error ?? ''), e2.error);
});

// ---------------------------------------------------------------- before the process starts

test('cwd rule: a folder inside or above Legion\'s data folder or the Hermes home fails before the agent is started', async () => {
  for (const pick of [(r: ReturnType<typeof rig>) => r.dataDir, (r: ReturnType<typeof rig>) => join(r.dataDir, 'sub'), (r: ReturnType<typeof rig>) => dirname(r.dataDir), (r: ReturnType<typeof rig>) => join(r.hermesHome, 'profiles', 'legion')]) {
    const r = rig();
    r.store.upsertAgent({ ...r.hermes, cwd: pick(r) });
    const end = await r.done(await r.run());
    assert.equal(end.status, 'error');
    assert.equal(end.error, HERMES_CWD_TEXT);
    assert.equal(HERMES_CWD_TEXT, 'Hermes agents need a project folder outside Legion\'s data folder. Choose a folder for this agent.');
    assert.equal(existsSync(r.logFile), false, 'the agent was never started');
    assert.equal(r.tokens.length, 0, 'and no key was issued');
  }
  const none = rig({ cwd: null });
  none.config.workspaceDir = join(none.dataDir, 'workspaces');
  assert.equal((await none.done(await none.run())).error, HERMES_CWD_TEXT, 'the default workspace is inside the data folder, so an agent with no folder of its own is refused too');
});

test('R26: the child gets the same environment cleaning as a Claude child: keys scrubbed, the keep list passes, the env-scrub gate off passes them', async () => {
  const saved = process.env.ACPTEST_SECRET_KEY;
  process.env.ACPTEST_SECRET_KEY = 'plain-value-123';
  try {
    const envOf = async (gates?: Record<string, unknown>) => {
      const r = rig({ ...(gates ? { gates } : {}), steps: [END()] });
      await r.done(await r.run());
      return JSON.parse(readFileSync(r.reportFile, 'utf8')).env as Record<string, string>;
    };
    assert.equal((await envOf()).ACPTEST_SECRET_KEY, undefined, 'scrubbed by default');
    assert.equal((await envOf({ gate: () => true, switchedOff: () => false, envKeep: () => ['ACPTEST_SECRET_KEY'] })).ACPTEST_SECRET_KEY, 'plain-value-123', 'the keep list passes it');
    assert.equal((await envOf({ gate: (id: string) => id !== 'env-scrub', switchedOff: () => false, envKeep: () => [] })).ACPTEST_SECRET_KEY, 'plain-value-123', 'the gate off passes it');
    assert.equal((await envOf({ gate: (id: string) => id !== 'env-scrub', switchedOff: () => false, envKeep: () => [] })).LEGION_HOME, undefined, 'LEGION_* never passes');
  } finally {
    if (saved === undefined) delete process.env.ACPTEST_SECRET_KEY; else process.env.ACPTEST_SECRET_KEY = saved;
  }
});

// ---------------------------------------------------------------- the run key (R33, R34)

test('R34: the run key is bound while the run lives and revoked on success, watchdog end, cancel and spawn failure', async () => {
  const ended = async (r: ReturnType<typeof rig>) => {
    assert.equal(r.tokens.length, 1, 'one key per run');
    await until(() => findRunGrant(r.tokens[0]!.token) === undefined, 8000).catch(() => assert.fail('the key is still alive'));
  };

  const ok = rig({ steps: [{ op: 'wait', ms: 300 }, END()] });
  const t = await ok.run();
  await until(() => ok.tokens.length === 1 && findRunGrant(ok.tokens[0]!.token)?.host() !== undefined);
  const grant = findRunGrant(ok.tokens[0]!.token)!;
  assert.equal(grant.taskId, t.id);
  assert.equal(grant.agentId, 'herm');
  await until(() => ok.msgs().some((m) => m.method === 'session/new'));
  const sent = ok.msgs().find((m) => m.method === 'session/new')!.params.mcpServers as Array<{ name: string; env: Array<{ name: string; value: string }> }>;
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.name, 'legion');
  assert.equal(sent[0]!.env.find((e) => e.name === 'LEGION_RUN_TOKEN')?.value, ok.tokens[0]!.token);
  await ok.done(t);
  await ended(ok);
  const pid = agentPid(ok.reportFile)!;
  await until(() => !alive(pid), 8000).catch(() => assert.fail('the agent process was left running after the run'));

  const dog = rig({ agentHost: { watchdogMs: 300 }, steps: [{ op: 'wait', ms: 30_000 }, END()] });
  await dog.done(await dog.run());
  await ended(dog);

  const can = rig({ steps: [{ op: 'waitCancel' }, END()] });
  const tc = await can.run();
  await until(() => can.msgs().some((m) => m.method === 'session/prompt'));
  can.engine.cancel(tc.id);
  await can.done(tc);
  await ended(can);

  const bad = rig({ entry: { command: join(tempDir('legion-nocmd-'), 'no-such-program') } });
  const end = await bad.done(await bad.run());
  assert.equal(end.status, 'error');
  await ended(bad);
});

test('the approvals route: an optionId reaches the card, a hidden or malformed one is a 400, and a closed card says why nothing happened', async () => {
  const f = makeFakes();
  const broker = new ApprovalBroker(f.bus);
  (f.ctx as { approvals: ApprovalBroker }).approvals = broker;
  const s = await start(f.ctx);
  try {
    const post = (id: string, body: unknown) => fetch(`${s.base}/api/approvals/${id}`, { method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const options = [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }];
    const open = broker.requestAcp('t1', 'a1', { toolName: 'Bash', title: 'x', summary: 'ls', input: {}, options, waitMs: 60_000 });
    const id = broker.pending()[0]!.id;
    assert.equal((await post(id, { allow: true, optionId: 7 })).status, 400);
    assert.equal((await post(id, { allow: true, optionId: 'allow_always' })).status, 400, 'an option the card does not show');
    assert.equal(broker.pending().length, 1, 'still open after the refused answers');
    assert.deepEqual(await (await post(id, { allow: true, optionId: 'allow_once' })).json(), { ok: true });
    assert.deepEqual(await open, { kind: 'option', optionId: 'allow_once' });
    const closed = broker.requestAcp('t1', 'a1', { toolName: 'Bash', title: 'x', summary: 'ls', input: {}, options, waitMs: 40 });
    const id2 = broker.pending()[0]!.id;
    assert.equal((await closed).kind, 'closed');
    assert.deepEqual(await (await post(id2, { allow: true, optionId: 'allow_once' })).json(), { ok: false, note: ACP_LATE_NOTE });
  } finally { await s.close(); }
});

test('R34: the core revokes every run key at shutdown (wired in legion-core)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/bin/legion-core.ts', import.meta.url)), 'utf8');
  assert.match(src, /revokeAllRunTokens\(\)/);
  assert.match(src, /agentHost:\s*\{/);
});

test('R37 and R34: a card raised inside a Hermes tool call counts against the 270 s budget, shows its deadline and closes itself with "The agent stopped waiting"', async () => {
  const r = rig({ agentHost: { toolWaitMs: 400 }, steps: [{ op: 'wait', ms: 4000 }, END()] });
  const t = await r.run();
  await until(() => r.tokens.length === 1 && findRunGrant(r.tokens[0]!.token)?.host() !== undefined);
  const host = findRunGrant(r.tokens[0]!.token)!.host()!;
  const decision = host.authorize('mcp__zzz__thing', { a: 1 }); // a tool that is not Legion's own: a card in Ask
  const c = await r.nextCard();
  const left = Date.parse(c.expiresAt ?? '') - Date.now();
  assert.ok(left > 0 && left <= 400, `deadline shown (${left} ms)`);
  const d = await decision;
  assert.equal(d.allow, false);
  const closed = r.events.find((e) => e.type === 'approval.resolved' && e.approvalId === c.id);
  assert.equal(closed.note, ACP_CLOSED_NOTE);
  assert.equal(r.broker.resolve(c.id, true), false, 'a late answer does nothing');
  await r.done(t);
});

test('R34: a card raised by authorize is withdrawn when the run key is revoked (the host stopped waiting)', async () => {
  const r = rig({ steps: [{ op: 'wait', ms: 4000 }, END()] });
  const t = await r.run();
  await until(() => r.tokens.length === 1 && findRunGrant(r.tokens[0]!.token)?.host() !== undefined);
  const host = findRunGrant(r.tokens[0]!.token)!.host()!;
  const decision = host.authorize('mcp__zzz__thing', {});
  await r.nextCard();
  r.engine.cancel(t.id);
  assert.equal((await decision).allow, false);
  assert.equal(r.broker.pending().length, 0);
});

// ---------------------------------------------------------------- confused deputy

test('a run Legion starts marks itself tainted from the start', async () => {
  const r = rig({ steps: [{ op: 'wait', ms: 300 }, END()] });
  const t = await r.run();
  await until(() => r.msgs().some((m) => m.method === 'session/prompt'));
  assert.equal(r.engine.isTainted(t.id), true, 'tainted while it runs');
  const end = await r.done(t);
  assert.equal(end.tainted, true, 'and kept on the task');
  assert.equal(end.runtime, 'Hermes', 'the thread badge label');
});

test('confused deputy: a Claude task started by a Hermes agent\'s tell gets approvalCeiling ask and tainted, even when the Hermes agent is Full', async () => {
  const r = rig({ approval: 'full', steps: [END()] });
  const caller = await r.done(await r.run());
  const child = r.engine.startTask({ agentId: 'clau', prompt: 'from hermes', source: 'agent', bridge: { fromAgentId: 'herm', parentTaskId: caller.id, hop: 1 } } as any);
  const stored = r.store.getTask(child.id)!;
  assert.equal(stored.origin?.approvalCeiling, 'ask');
  assert.equal(stored.origin?.tainted, true);
  await r.engine.waitFor(child.id, 5000);
});

test('confused deputy: a capped or tainted caller that tells a Hermes agent raises a card first; denying it means the agent is never started', async () => {
  const r = rig({ steps: [END()] });
  const origin = { roomId: 'agent-bridge', fromAgentId: 'clau', hop: 1, approvalCeiling: 'ask', tainted: true };
  const t = await r.run('hi', { origin });
  const c = await r.nextCard();
  assert.match(c.summary, /Hermes/);
  assert.equal(existsSync(r.logFile), false, 'nothing runs before the answer');
  r.broker.resolve(c.id, false);
  const end = await r.done(t);
  assert.equal(end.status, 'error');
  assert.equal(existsSync(r.logFile), false);
  const ok = rig({ steps: [END()] });
  const t2 = await ok.run('hi', { origin });
  const c2 = await ok.nextCard();
  ok.broker.resolve(c2.id, true);
  assert.equal((await ok.done(t2)).status, 'done');
  const plain = rig({ steps: [END()] });
  assert.equal((await plain.done(await plain.run())).status, 'done', 'a task the owner starts needs no such card');
});

// ---------------------------------------------------------------- cancel

test('cancel(taskId): session.cancel then stop; open cards are denied; the task is cancelled; no agent process is left', async () => {
  const r = rig({ steps: [CMD('perm-check-1', 'ls'), END()] });
  const t = await r.run();
  const c = await r.nextCard();
  await until(() => agentPid(r.reportFile) !== undefined);
  const pid = agentPid(r.reportFile)!;
  assert.equal(r.engine.cancel(t.id), true);
  assert.equal(r.broker.pending().length, 0, 'the open card is denied at once');
  const end = await r.done(t);
  assert.equal(end.status, 'cancelled');
  await until(() => r.msgs().some((m) => m.method === 'session/cancel'), 5000); // the task is marked at once; the wire follows
  await until(() => !alive(pid), 8000);
  assert.ok(c.id);
});
