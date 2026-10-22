import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { registerSecret } from '../src/core/log/redact.js';
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
  /** The agent's model, when it is not the built-in entry. */
  model?: string;
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
    id: 'herm', name: 'Herm', emoji: '*', description: 'acts through Hermes', systemPrompt: '', model: o.model ?? 'acp:hermes',
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

test('R38: the tool wait is read when a run starts, from a function, so the setting Hermes holds reaches it', async () => {
  let ms = 900;
  const r = rig({ agentHost: { toolWaitMs: () => ms }, steps: [{ op: 'wait', ms: 4000 }, END()] });
  ms = 400;
  const t = await r.run();
  await until(() => r.tokens.length === 1 && findRunGrant(r.tokens[0]!.token)?.host() !== undefined);
  const host = findRunGrant(r.tokens[0]!.token)!.host()!;
  const decision = host.authorize('mcp__zzz__thing', { a: 1 });
  const c = await r.nextCard();
  const left = Date.parse(c.expiresAt ?? '') - Date.now();
  assert.ok(left > 0 && left <= 400, `deadline from the function (${left} ms)`);
  await decision;
  await r.done(t);
});

test('R58: a Hermes run start tells the core (so it can warm the detection in the background); a throwing hook does not stop the run', async () => {
  const started: string[] = [];
  const r = rig({ agentHost: { onRunStart: (e: { id: string }) => { started.push(e.id); throw new Error('hook failed'); } }, steps: [END()] });
  const t = await r.run();
  const end = await r.done(t);
  assert.deepEqual(started, ['hermes']);
  assert.notEqual(end.status, 'error');
});

// A tripwire on the wiring text (the behaviour is covered by the seam tests above and by acp-doctor.test.ts): it fails if the wiring is deleted, not if it is wrong.
test('R38: the core feeds both waits from the detection cache (wired in legion-core, Doctor and catalog get the agent host)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/bin/legion-core.ts', import.meta.url)), 'utf8');
  assert.match(src, /hostWaitSeams\(/);
  assert.match(src, /permissionWaitMs:\s*seams\.permissionWaitMs/);
  assert.match(src, /toolWaitMs:\s*seams\.toolWaitMs/);
  assert.match(src, /runDoctor\(\{[^}]*agentHost/);
  assert.match(src, /getCatalog\(\{[^}]*hosts:/);
  assert.match(src, /onRunStart:\s*\(e\) => warmHermes\(e, true\)/);
  assert.match(src, /warmHermes\(config\.acp\.entries\.find\([^\n]*\), false\)/, 'core start');
  assert.match(src, /probeAgents:\s*probeAgents === true/, 'the Doctor probes only when asked');
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

// ---------------------------------------------------------------- fix round 1 (review F1 to F12)

type Authorize = (name: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<{ allow: boolean; message?: string }>;
/** The run's tool decision, as the Legion tool route calls it. */
async function authorizeOf(r: ReturnType<typeof rig>): Promise<Authorize> {
  await until(() => r.tokens.length === 1 && findRunGrant(r.tokens[0]!.token)?.host() !== undefined);
  return findRunGrant(r.tokens[0]!.token)!.host()!.authorize as unknown as Authorize;
}
const BYPASS = { gate: (id: string) => (id === 'tool-cards' ? false : true), switchedOff: () => false };
const EDIT = (id: string, path: string): Step => ({ op: 'permission', id, title: 'write_file: x', kind: 'edit', rawInput: { tool: 'write_file', arguments: { path } } });
const THREE = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  { optionId: 'deny_always', name: 'Deny always', kind: 'reject_always' },
];

test('F1: the audit line says allowed only when the picked option allows; a no can name the reject option the owner picked, reject_always included', async () => {
  const bus = new EventBus();
  const broker = new ApprovalBroker(bus);
  const events: any[] = [];
  bus.on((e) => events.push(e));
  const ask = () => { const p = broker.requestAcp('t1', 'a1', { toolName: 'Bash', title: 'x', summary: 'ls', input: {}, options: THREE, waitMs: 60_000 }); return { p, id: broker.pending().at(-1)!.id }; };
  const allowedOf = (id: string) => events.filter((e) => e.type === 'approval.resolved' && e.approvalId === id).at(-1)?.allowed;

  const a = ask();
  assert.equal(broker.resolve(a.id, true, undefined, 'deny'), true);
  assert.deepEqual(await a.p, { kind: 'option', optionId: 'deny' });
  assert.equal(allowedOf(a.id), false, 'a reject option is never logged as allowed');

  const b = ask();
  broker.resolve(b.id, false, undefined, 'deny_always');
  assert.deepEqual(await b.p, { kind: 'option', optionId: 'deny_always' }, 'a no that names a shown reject option sends that option');
  assert.equal(allowedOf(b.id), false);

  const c = ask();
  assert.throws(() => broker.resolve(c.id, false, undefined, 'allow_once'), /allow/, 'a no cannot name an option that allows');
  assert.equal(broker.pending().length, 1, 'the card stays open after the refused answer');
  assert.throws(() => broker.resolve(c.id, false, undefined, 'not_on_the_card'), /not on this card/);
  broker.resolve(c.id, false);
  assert.deepEqual(await c.p, { kind: 'denied' });
  assert.equal(allowedOf(c.id), false);

  const d = ask();
  broker.resolve(d.id, true, undefined, 'allow_once');
  assert.deepEqual(await d.p, { kind: 'option', optionId: 'allow_once' });
  assert.equal(allowedOf(d.id), true);
});

test('F1: Hermes\'s reject_always goes back verbatim when the owner picks it on a no', async () => {
  const r = rig({ steps: [CMD('perm-check-1', 'ls', { options: THREE }), END()] });
  const t = await r.run();
  const c = await r.nextCard();
  assert.deepEqual(c.acpOptions?.map((o) => o.kind), ['allow_once', 'reject_once', 'reject_always']);
  r.broker.resolve(c.id, false, undefined, 'deny_always');
  await r.done(t);
  assert.deepEqual(outcomeOf(r.answersTo(9100)[0]!), { outcome: 'selected', optionId: 'deny_always' });
});

test('F2: a Claude run that stops at the spend limit still reads as the paused spend-limit card when the SDK sends error text (Claude behaviour is untouched)', async () => {
  const r = rig();
  const queryFn = ((_p: unknown) => {
    const gen = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's9' };
      yield { type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: ['Reached maximum budget ($1)'], total_cost_usd: 1, num_turns: 2, session_id: 's9' };
    })();
    return Object.assign(gen, { interrupt: async () => undefined, close: () => undefined });
  }) as unknown as QueryFn;
  const eng = new Engine({ store: r.store, bus: r.bus, vms: {} as any, approvals: r.broker, config: r.config, queryFn, boatConfigured: () => false });
  const end = await eng.waitFor(eng.startTask({ agentId: 'clau', prompt: 'x', source: 'ui' } as any).id, 10_000);
  assert.equal(end.status, 'error');
  assert.ok((end.error ?? '').startsWith(BUDGET_LIMIT_PREFIX), end.error);
});

test('F3: in Bypass with disasterStop on, a command Legion cannot judge (too long, a path built at run time) or one that touches Legion\'s settings gets a card; a plain command still does not', async () => {
  const r = rig({ approval: 'full', gates: BYPASS, switches: { modeMap: true, disasterStop: true } });
  r.setScript([CMD('perm-check-1', `echo ${'a'.repeat(10_050)}`), CMD('perm-check-2', 'rm -rf "$X/gates"'), EDIT('edit-approval-3', join(r.dataDir, 'config.json')), CMD('perm-check-4', 'ls'), END()]);
  const t = await r.run();
  const seen: ApprovalRequest[] = [];
  for (let i = 0; i < 3; i++) { const c = await r.nextCard(); seen.push(c); r.broker.resolve(c.id, false); }
  const end = await r.done(t);
  assert.equal(end.status, 'done');
  assert.match(seen[0]!.summary, /cannot tell/, 'a command too long to read says why it asks');
  assert.match(seen[1]!.summary, /cannot tell/, 'a path built at run time says why it asks');
  assert.match(seen[2]!.summary, /Legion's own settings: config\.json/);
  for (const id of [9100, 9101, 9102]) assert.deepEqual(outcomeOf(r.answersTo(id)[0]!), { outcome: 'selected', optionId: 'deny' }, `request ${id} was answered by the owner`);
  assert.deepEqual(outcomeOf(r.answersTo(9103)[0]!), { outcome: 'selected', optionId: 'allow_once' }, 'a plain command is still answered without a card');
});

test('F3: in Bypass a request that touches Legion\'s settings gets a card even with disasterStop off (the Bypass text promises it)', async () => {
  const r = rig({ approval: 'full', gates: BYPASS, switches: { modeMap: true } });
  r.setScript([EDIT('edit-approval-1', join(r.dataDir, 'gates', 'rules.json')), CMD('perm-check-2', 'ls'), END()]);
  const t = await r.run();
  const c = await r.nextCard();
  assert.match(c.summary, /Legion's own settings: gates/);
  r.broker.resolve(c.id, false);
  await r.done(t);
  assert.deepEqual(outcomeOf(r.answersTo(9101)[0]!), { outcome: 'selected', optionId: 'allow_once' });
});

test('F4: a custom entry (not tested) never runs Full or Bypass: Ask mode, a card for every request, and the thread says why once', async () => {
  const r = rig({ approval: 'full', gates: BYPASS, switches: { modeMap: true }, entry: { tested: false }, steps: [CMD('perm-check-1', 'ls'), END()] });
  const t = await r.run();
  const c = await r.nextCard();
  assert.match(c.summary, /ls/, 'Bypass did not answer for it');
  r.broker.resolve(c.id, true);
  const end = await r.done(t);
  assert.equal(end.status, 'done');
  assert.deepEqual(r.msgs().filter((m) => m.method === 'session/set_mode').map((m) => m.params.modeId), ['default']);
  const notes = r.rows(t.id).filter((m) => m.role === 'system' && /not tested/.test(m.text));
  assert.equal(notes.length, 1, 'said once');
  assert.match(notes[0]!.text, /Hermes/);
  assert.doesNotMatch(notes[0]!.text, new RegExp(String.fromCharCode(0x2013) + "|" + String.fromCharCode(0x2014)));
});

test('F5: a call the host cancels closes its own card at once, and nothing reads as a refusal by the owner', async () => {
  const r = rig({ steps: [{ op: 'wait', ms: 6000 }, END()] });
  const t = await r.run();
  const authorize = await authorizeOf(r);
  const ac = new AbortController();
  const decision = authorize('mcp__zzz__thing', { a: 1 }, ac.signal);
  const c = await r.nextCard();
  ac.abort();
  const d = await decision;
  assert.equal(d.allow, false);
  assert.doesNotMatch(d.message ?? '', /user denied/i);
  assert.equal(r.broker.pending().length, 0, 'the card is gone');
  const closed = r.events.find((e) => e.type === 'approval.resolved' && e.approvalId === c.id);
  assert.equal(closed.note, ACP_CLOSED_NOTE);
  assert.equal(r.broker.resolve(c.id, true), false);
  assert.equal(r.broker.lateNote(c.id), ACP_LATE_NOTE);
  r.engine.cancel(t.id);
  await r.done(t);
});

test('F5: overlapping calls each keep their own deadline', async () => {
  const r = rig({ agentHost: { toolWaitMs: 900 }, steps: [{ op: 'wait', ms: 8000 }, END()] });
  const t = await r.run();
  const authorize = await authorizeOf(r);
  const first = authorize('mcp__zzz__one', {});
  const c1 = await r.nextCard();
  await sleep(450);
  const second = authorize('mcp__zzz__two', {});
  await until(() => r.broker.pending().length === 2);
  const c2 = r.broker.pending().find((p) => p.id !== c1.id)!;
  const left = Date.parse(c2.expiresAt ?? '') - Date.now();
  assert.ok(left > 700, `the second call's card has its own 900 ms from its own start (${left} ms left), not the first call's deadline`);
  assert.equal((await first).allow, false);
  assert.ok(r.broker.pending().some((p) => p.id === c2.id), 'the second card is still open when the first closed');
  r.broker.resolve(c2.id, true);
  assert.equal((await second).allow, true);
  r.engine.cancel(t.id);
  await r.done(t);
});

test('F5: at the deadline the call is told no one answered, never "The user denied this action"', async () => {
  const r = rig({ agentHost: { toolWaitMs: 300 }, steps: [{ op: 'wait', ms: 4000 }, END()] });
  const t = await r.run();
  const authorize = await authorizeOf(r);
  const d = await authorize('mcp__zzz__thing', {});
  assert.equal(d.allow, false);
  assert.match(d.message ?? '', /No one answered/);
  assert.doesNotMatch(d.message ?? '', /user denied/i);
  r.engine.cancel(t.id);
  await r.done(t);
});

test('F6: a resume that fails for a passing reason keeps the stored conversation and starts nothing new', async () => {
  const r = rig({ fakeArgs: ['--fail-resume', 'timed out waiting for the background helper'], steps: [END()] });
  const old = r.store.upsertTask({ id: 'old6', agentId: 'herm', title: 'old', status: 'done', source: 'ui', requestedModel: 'auto', model: 'acp:hermes', acp: { entryId: 'hermes', sessionId: 'sess_fake_1', cumulative: { input: 5, output: 5 } }, createdAt: '', updatedAt: '' } as Task);
  const end = await r.done(r.engine.startTask({ agentId: 'herm', prompt: 'again', source: 'ui', continueTaskId: old.id } as any));
  assert.equal(end.status, 'error');
  assert.equal(r.store.getTask(end.id)?.acp?.sessionId, 'sess_fake_1', 'the conversation is still the task\'s');
  assert.equal(r.rows(end.id).filter((m) => /new one|new conversation/.test(m.text)).length, 0, 'nothing says a new conversation began');
});

test('F7: a cancel while the agent is still starting stops its process at once', async () => {
  const r = rig({ fakeArgs: ['--init-delay', '5000'], steps: [END()] });
  const t = await r.run();
  await until(() => agentPid(r.reportFile) !== undefined);
  const pid = agentPid(r.reportFile)!;
  r.engine.cancel(t.id);
  await until(() => !alive(pid), 2500).catch(() => assert.fail('the agent process was left running while it started'));
  assert.equal((await r.done(t)).status, 'cancelled');
});

test('F8: the card deadline comes from one function the owner\'s Hermes setting can feed, read at each request', async () => {
  let ms = 300;
  const r = rig({ agentHost: { permissionWaitMs: () => ms }, steps: [CMD('perm-check-1', 'ls'), CMD('perm-check-2', 'ls'), END()] });
  const t = await r.run();
  const c1 = await r.nextCard();
  const left1 = Date.parse(c1.expiresAt ?? '') - Date.now();
  assert.ok(left1 > 0 && left1 <= 300, `first card ${left1} ms`);
  ms = 5000;
  r.broker.resolve(c1.id, true);
  const c2 = await (async () => { await until(() => r.broker.pending().length === 1 && r.broker.pending()[0]!.id !== c1.id); return r.broker.pending()[0]!; })();
  const left2 = Date.parse(c2.expiresAt ?? '') - Date.now();
  assert.ok(left2 > 1000, `second card ${left2} ms: the new value was read`);
  r.broker.resolve(c2.id, true);
  await r.done(t);
});

test('F9: the cwd rule holds for case, a trailing separator, a relative path, a link into the data folder and an administrative share', async () => {
  const BS = String.fromCharCode(92);
  const picks: Array<(r: ReturnType<typeof rig>) => string> = [
    (r) => r.dataDir.toUpperCase(),
    (r) => r.dataDir + (process.platform === 'win32' ? BS : '/'),
    (r) => join(r.dataDir, '..', 'data', 'x'),
    (r) => { const link = join(r.work, 'link'); symlinkSync(r.dataDir, link, 'junction'); return link; },
  ];
  if (process.platform === 'win32') picks.push((r) => `${BS}${BS}localhost${BS}${r.dataDir.slice(0, 1)}$${r.dataDir.slice(2)}`);
  for (const pick of picks) {
    const r = rig();
    r.store.upsertAgent({ ...r.hermes, cwd: pick(r) });
    const end = await r.done(await r.run());
    assert.equal(end.error, HERMES_CWD_TEXT, pick.toString());
    assert.equal(existsSync(r.logFile), false, 'the agent was never started');
  }
});

test('F11: a command that only shares a word with a protected folder (data, the Hermes home name) does not say it touches Legion\'s settings; a real touch of the agent\'s own home says so in its own words', async () => {
  const r = rig();
  r.setScript([CMD('perm-check-1', 'cat data.txt && echo hermes-home'), CMD('perm-check-2', `type ${join(r.hermesHome, 'config.yaml')}`), END()]);
  const t = await r.run();
  const c1 = await r.nextCard();
  assert.doesNotMatch(c1.summary, /own settings/);
  r.broker.resolve(c1.id, true);
  await until(() => r.broker.pending().length === 1 && r.broker.pending()[0]!.id !== c1.id);
  const c2 = r.broker.pending()[0]!;
  assert.match(c2.summary, /This touches Hermes's own settings/);
  assert.doesNotMatch(c2.summary, /Legion's own settings/);
  r.broker.resolve(c2.id, true);
  await r.done(t);
});

test('F12: an error from the agent is redacted before it reaches the task or the thread, and the runtime is named by its entry', async () => {
  registerSecret('secret-value-12345');
  const r = rig({ entry: { id: 'acme', label: 'Acme Agent', tested: false }, model: 'acp:acme', fakeArgs: ['--fail-new', 'boom secret-value-12345 done'] });
  const end = await r.done(await r.run());
  assert.equal(end.status, 'error');
  assert.match(end.error ?? '', /^Acme Agent failed\./);
  assert.doesNotMatch(end.error ?? '', /secret-value-12345|Hermes/);
  assert.ok(!r.rows(end.id).some((m) => m.text.includes('secret-value-12345')), 'nor in the thread');

  const dog = rig({ entry: { id: 'acme', label: 'Acme Agent', tested: false }, model: 'acp:acme', agentHost: { watchdogMs: 300 }, steps: [{ op: 'wait', ms: 30_000 }, END()] });
  assert.match((await dog.done(await dog.run())).error ?? '', /^Acme Agent stopped answering/);

  const gone = rig({ entry: { id: 'acme', label: 'Acme Agent', tested: false, command: join(tempDir('legion-nocmd-'), 'no-such-program') }, model: 'acp:acme' });
  assert.match((await gone.done(await gone.run())).error ?? '', /^Acme Agent was not found/);
});

// ---------------------------------------------------------------- fix round 2 (re-review F3, F9, F8, F6, F13; R45, R46)

const BS = String.fromCharCode(92);
const patchOf = (...files: string[]): string => ['*** Begin Patch', ...files.map((f) => `*** Update File: ${f}`), '*** End Patch'].join('\n');
/** A V4A patch request the way Hermes sends it: the paths joined with ", " into one display string (edit_approval.py:106-126), the patch itself as the diff text. */
const V4A = (id: string, display: string, body?: string): Step => ({
  op: 'permission', id, title: `Approve edit: ${display}`, kind: 'edit',
  rawInput: { tool: 'patch', arguments: { mode: 'patch', ...(body !== undefined ? { patch: body } : {}) } },
  content: [{ type: 'diff', path: display, oldText: null, newText: body ?? 'x' }],
});
const NOPATH = (id: string): Step => ({ op: 'permission', id, title: 'patch', kind: 'edit', rawInput: { tool: 'patch', arguments: { mode: 'patch' } } });
const bypassRig = (switches: Partial<AcpSwitches> = {}, extra: RigOpts = {}) => rig({ approval: 'full', gates: BYPASS, switches: { modeMap: true, ...switches }, ...extra });

test('F3 round 2: a multi-file patch is split and EVERY path is checked; a path Legion cannot read gets a card, never an auto-allow', async () => {
  const r = bypassRig();
  const gates = join(r.dataDir, 'gates', 'rules.json');
  const homeFile = join(r.hermesHome, 'config.yaml');
  r.setScript([
    V4A('edit-approval-1', `a.txt, ${gates}`, patchOf('a.txt', gates)),
    V4A('edit-approval-2', `a.txt, ${homeFile}`),
    V4A('edit-approval-3', 'a.txt, b.txt', patchOf('a.txt', homeFile)),
    NOPATH('edit-approval-4'),
    EDIT('edit-approval-5', 'a\u0000b'),
    V4A('edit-approval-6', 'a.txt, b.txt', patchOf('a.txt', 'b.txt')),
    END(),
  ]);
  const t = await r.run();
  const seen: ApprovalRequest[] = [];
  for (let i = 0; i < 5; i++) { const c = await r.nextCard(); seen.push(c); r.broker.resolve(c.id, false); }
  const end = await r.done(t);
  assert.equal(end.status, 'done');
  assert.match(seen[0]!.summary, /Legion's own settings: gates/, 'the second path of the join is the protected one');
  assert.match(seen[1]!.summary, /Hermes's own settings: hermes-home/, 'split from the display string alone');
  assert.match(seen[2]!.summary, /Hermes's own settings/, 'the patch text names a file the display string hides');
  assert.match(seen[3]!.summary, /cannot tell/, 'a patch with no path at all');
  assert.match(seen[4]!.summary, /cannot tell/, 'a path with a character no file name has');
  assert.deepEqual(outcomeOf(r.answersTo(9105)[0]!), { outcome: 'selected', optionId: 'allow_once' }, 'a plain multi-file patch inside the folder is still answered without a card');
});

test('F3 round 2: a network or device spelling of a file path gets a card in Bypass (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const r = bypassRig();
  const drive = r.dataDir.slice(0, 1);
  r.setScript([
    EDIT('edit-approval-1', `${BS}${BS}localhost${BS}${drive}$${r.dataDir.slice(2)}${BS}gates${BS}x`),
    EDIT('edit-approval-2', `${BS}${BS}?${BS}${join(r.dataDir, 'gates', 'x')}`),
    EDIT('edit-approval-3', `${BS}${BS}?${BS}Volume{00000000-0000-0000-0000-000000000000}${BS}x`),
    END(),
  ]);
  const t = await r.run();
  for (let i = 0; i < 3; i++) { const c = await r.nextCard(); assert.match(c.summary, /cannot tell|own settings/, `request ${i}`); r.broker.resolve(c.id, false); }
  assert.equal((await r.done(t)).status, 'done');
});

test('F3 round 2: when the reader of a command fails, Bypass asks (fail closed); with disasterStop on the request is refused, never allowed', async () => {
  for (const disasterStop of [false, true]) {
    const r = bypassRig({ disasterStop });
    (r.engine as any).acpFolderRead = () => { throw new Error('reader broke'); };
    r.setScript([CMD('perm-check-1', 'ls'), END()]);
    const t = await r.run();
    if (disasterStop) {
      await r.done(t);
      assert.equal(r.broker.pending().length, 0, 'refused, no card');
    } else {
      const c = await r.nextCard();
      assert.match(c.summary, /cannot tell/);
      r.broker.resolve(c.id, false);
      await r.done(t);
    }
    assert.deepEqual(outcomeOf(r.answersTo(9100)[0]!), { outcome: 'selected', optionId: 'deny' }, `disasterStop ${disasterStop}: nothing auto-allowed`);
  }
});

test('R45: in Bypass a request that touches Legion\'s settings or the Hermes home gets a card with disasterStop off too; only the card for a command Legion cannot judge stays tied to it', async () => {
  const r = bypassRig({ disasterStop: false });
  const gates = join(r.dataDir, 'gates', 'rules.json');
  r.setScript([
    CMD('perm-check-1', `echo ${'a'.repeat(10_050)} > ${gates}`),
    CMD('perm-check-2', `type ${join(r.hermesHome, 'config.yaml')}`),
    EDIT('edit-approval-3', join(r.hermesHome, '.env')),
    CMD('perm-check-4', 'rm -rf "$X/gates"'),
    END(),
  ]);
  const t = await r.run();
  for (let i = 0; i < 3; i++) { const c = await r.nextCard(); assert.match(c.summary, /own settings/, `request ${i}`); r.broker.resolve(c.id, false); }
  assert.equal((await r.done(t)).status, 'done');
  assert.deepEqual(outcomeOf(r.answersTo(9103)[0]!), { outcome: 'selected', optionId: 'allow_once' }, 'a path built at run time is the unjudged class: tied to disasterStop, which is off');
});

test('F9 round 2: the cwd rule reads Windows long-path and device spellings of a folder (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const drive = (r: ReturnType<typeof rig>) => r.dataDir.slice(0, 1);
  const picks: Array<[string, (r: ReturnType<typeof rig>) => string]> = [
    ['long path', (r) => `${BS}${BS}?${BS}${r.dataDir}`],
    ['long path, inside', (r) => `${BS}${BS}?${BS}${join(r.dataDir, 'sub')}`],
    ['long path UNC admin share', (r) => `${BS}${BS}?${BS}UNC${BS}localhost${BS}${drive(r)}$${r.dataDir.slice(2)}`],
    ['device path', (r) => `${BS}${BS}.${BS}${r.dataDir}`],
    ['NT object path', (r) => `${BS}??${BS}${r.dataDir}`],
    ['the Hermes home as a long path', (r) => `${BS}${BS}?${BS}${r.hermesHome}`],
    ['a volume name Legion cannot read', () => `${BS}${BS}?${BS}Volume{00000000-0000-0000-0000-000000000000}${BS}x`],
  ];
  for (const [name, pick] of picks) {
    const r = rig();
    r.store.upsertAgent({ ...r.hermes, cwd: pick(r) });
    const end = await r.done(await r.run());
    assert.equal(end.error, HERMES_CWD_TEXT, name);
    assert.equal(existsSync(r.logFile), false, `${name}: the agent was never started`);
  }
});

test('F8 round 2: a huge card wait is clamped, so the timer never fires early and the card stays open', async () => {
  const r = rig({ agentHost: { permissionWaitMs: 3_000_000_000 }, steps: [CMD('perm-check-1', 'ls'), END()] });
  const t = await r.run();
  const c = await r.nextCard();
  await sleep(250);
  assert.equal(r.broker.pending().length, 1, 'the card is still open (a timer past 2^31-1 ms fires after 1 ms)');
  const left = Date.parse(c.expiresAt ?? '') - Date.now();
  assert.ok(left > 1_000_000 && left < 2 ** 31, `${left} ms left`);
  r.broker.resolve(c.id, true);
  await r.done(t);
});

test('R46: a resume that Hermes refuses for its tool list (unavailable or conflict) keeps the stored conversation; only a conversation that is gone clears it', async () => {
  for (const code of ['acp_mcp_policy_unavailable', 'acp_mcp_policy_conflict']) {
    const r = rig({ fakeArgs: ['--fail-resume', code], steps: [END()] });
    const old = r.store.upsertTask({ id: 'old46', agentId: 'herm', title: 'old', status: 'done', source: 'ui', requestedModel: 'auto', model: 'acp:hermes', acp: { entryId: 'hermes', sessionId: 'sess_fake_1' }, createdAt: '', updatedAt: '' } as Task);
    const end = await r.done(r.engine.startTask({ agentId: 'herm', prompt: 'again', source: 'ui', continueTaskId: old.id } as any));
    assert.equal(end.status, 'error', code);
    assert.match(end.error ?? '', /tool list|Legion's tools/, code);
    assert.equal(r.store.getTask(end.id)?.acp?.sessionId, 'sess_fake_1', `${code}: the conversation is still the task's`);
    assert.equal(r.rows(end.id).filter((m) => /next message starts a new/.test(m.text)).length, 0, code);
  }
  const gone = rig({ steps: [END()] });
  const old = gone.store.upsertTask({ id: 'old47', agentId: 'herm', title: 'old', status: 'done', source: 'ui', requestedModel: 'auto', model: 'acp:hermes', acp: { entryId: 'hermes', sessionId: 'sess_missing' }, createdAt: '', updatedAt: '' } as Task);
  const end = await gone.done(gone.engine.startTask({ agentId: 'herm', prompt: 'again', source: 'ui', continueTaskId: old.id } as any));
  assert.equal(end.status, 'done', 'a conversation that is gone starts a new one');
});

test('F13: Bypass never answers for a run another agent or app started with a cap or a taint', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['capped (ask)', { roomId: 'agent-bridge', fromAgentId: 'clau', hop: 1, approvalCeiling: 'ask' }],
    ['tainted but uncapped (full)', { roomId: 'agent-bridge', fromAgentId: 'clau', hop: 1, approvalCeiling: 'full', tainted: true }],
    ['capped and tainted', { roomId: 'agent-bridge', fromAgentId: 'clau', hop: 1, approvalCeiling: 'ask', tainted: true }],
  ];
  for (const [name, origin] of cases) {
    const r = bypassRig({}, { steps: [CMD('perm-check-1', 'ls'), END()] });
    const t = await r.run('hi', { origin });
    const first = await r.nextCard();
    assert.match(first.summary, /Another agent or app asked Hermes/, `${name}: the hand-off card comes first`);
    r.broker.resolve(first.id, true);
    await until(() => r.broker.pending().some((p) => p.id !== first.id));
    const c = r.broker.pending()[0]!;
    assert.match(c.summary, /ls/, `${name}: the command itself is a card, not an auto-answer`);
    r.broker.resolve(c.id, false);
    await r.done(t);
    assert.deepEqual(outcomeOf(r.answersTo(9100)[0]!), { outcome: 'selected', optionId: 'deny' }, name);
  }
  const owner = bypassRig({}, { steps: [CMD('perm-check-1', 'ls'), END()] });
  assert.equal((await owner.done(await owner.run())).status, 'done');
  assert.deepEqual(outcomeOf(owner.answersTo(9100)[0]!), { outcome: 'selected', optionId: 'allow_once' }, 'control: the owner\'s own Bypass run is answered without a card');
});
