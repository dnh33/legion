import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFake, FAKE_KEY } from './providers-fakes.js';
import { mkAgent, run, setup, until } from './providers-harness.js';
import { repoRoot } from './ps-helpers.js';
import { createProcessPort } from '../src/core/providers/proc.js';
import { buildCliPlan, checkCliFolder, cleanCliText, cliEnv, cliEnvAllow, FORBIDDEN_CLI_TOKENS, CLI_MAX_PROMPT_CHARS } from '../src/core/providers/cli.js';
import type { ProviderEntry } from '../src/core/providers/types.js';

const FAKE = join(repoRoot, 'test/fixtures/fake-cli.mjs');
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidsOf = (file: string): Record<string, number> => Object.fromEntries(readFileSync(file, 'utf8').trim().split('\n').map((l) => { const [k, v] = l.split(' '); return [k!, Number(v)]; }));

const cliEntry = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({ kind: 'cli', cli: 'codex', label: 'Codex CLI', baseUrl: '', enabled: true, executable: process.execPath, sandbox: 'read-only', allowedAgents: ['a1'], timeoutSeconds: 30, ...over });

async function cliSetup(o: { entry?: Partial<ProviderEntry>; agent?: Record<string, unknown>; approval?: 'ask' | 'full' } = {}) {
  const f = await startFake(() => undefined);
  const tmp = mkdtempSync(join(tmpdir(), 'legion-cli-'));
  const record = join(tmp, 'record.json');
  const home = join(tmp, 'home'); mkdirSync(home, { recursive: true });
  const h = setup(f, { noEntry: true, agent: { model: 'cli:default', approval: o.approval ?? 'full', ...o.agent }, runtimeDeps: { cliPort: createProcessPort({ prefixArgs: [FAKE, record] }), home, dataDir: join(tmp, 'data'), appRoots: [repoRoot] } });
  h.config.providers.entries.cli = cliEntry(o.entry);
  const rec = () => JSON.parse(readFileSync(record, 'utf8'));
  return { h, f, tmp, record, home, rec, done: () => f.close() };
}
const start = (h: ReturnType<typeof setup>, prompt: string, extra: Record<string, unknown> = {}) => h.engine.startTask({ agentId: 'a1', prompt, source: 'ui', ...extra } as any);
const card = async (h: ReturnType<typeof setup>) => { await until(() => h.approvals.pending().length === 1, 10000); return h.approvals.pending()[0]!; };

test('B2 happy path: start card on every run even when the agent is on full access; Codex gets the strictest sandbox, no widening flag, a scrubbed environment, the agent\'s own folder; the run is tainted and its text is the message', async () => {
  process.env.OPENAI_API_KEY = 'k-' + 'should-not-reach-the-cli'; process.env.LEGION_TEST_SECRET = 'core-secret'; process.env.CODEX_HOME = '/own/codex/home';
  const c = await cliSetup({ approval: 'full' });
  try {
    const t = start(c.h, 'please summarise');
    const cd = await card(c.h);
    assert.equal(cd.toolName, 'LegionCliStart');
    const input = cd.input as Record<string, any>;
    assert.equal(input.folder, realpathSync(join(c.h.config.workspaceDir, 'a1')));
    assert.equal(input.sandbox, 'read-only'); assert.match(input.command, /exec --sandbox read-only --skip-git-repo-check --ephemeral/); assert.match(input.warning, /cannot see or stop/);
    assert.equal(existsSync(c.record), false, 'nothing runs before the card is answered');
    c.h.approvals.resolve(cd.id, true);
    const d = await c.h.engine.waitFor(t.id, 15000);
    assert.equal(d.status, 'done'); assert.equal(d.tainted, true); assert.equal(d.provider, 'cli');
    assert.match(d.result ?? '', /^answer: please summarise/);
    assert.equal(d.tokenUsage?.unknown, true, 'usage unknown: the CLI printed none');
    const r = c.rec();
    assert.deepEqual(r.argv, ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--color', 'never', '-']);
    assert.equal(r.stdin, 'please summarise');
    assert.equal(realpathSync(r.cwd), input.folder);
    assert.ok(!r.envNames.includes('OPENAI_API_KEY') && !r.envNames.includes('LEGION_TEST_SECRET'), `env: ${r.envNames.join(',')}`);
    assert.equal(r.env.CODEX_HOME, '/own/codex/home', 'the CLI\'s own config home reaches it so it can find its own login');
    assert.ok(r.envNames.every((n: string) => cliEnvAllow('codex').includes(n)), `only allowed names: ${r.envNames}`);
    for (const a of r.argv) assert.equal(FORBIDDEN_CLI_TOKENS.includes(a), false, a);
    // a second run asks again
    const t2 = start(c.h, 'again', { continueTaskId: t.id });
    const cd2 = await card(c.h); assert.notEqual(cd2.id, cd.id);
    c.h.approvals.resolve(cd2.id, true);
    assert.equal((await c.h.engine.waitFor(t2.id, 15000)).status, 'done');
  } finally { delete process.env.OPENAI_API_KEY; delete process.env.LEGION_TEST_SECRET; delete process.env.CODEX_HOME; await c.done(); }
});

test('B2 denying the card (or no answer) starts nothing', async () => {
  const c = await cliSetup();
  try {
    const t = start(c.h, 'go');
    const cd = await card(c.h);
    c.h.approvals.resolve(cd.id, false);
    const d = await c.h.engine.waitFor(t.id, 15000);
    assert.equal(d.status, 'error'); assert.match(d.error ?? '', /did not approve/);
    assert.equal(existsSync(c.record), false);
  } finally { await c.done(); }
});

test('B2 only the owner in the app can start it: a token client, a room or bot wake, ask/tell and a bridge reply are refused before any card or process', async () => {
  const c = await cliSetup();
  try {
    c.h.store.agents.set('lead', mkAgent({ id: 'lead', name: 'Lead', model: 'sonnet' }));
    const cases: Array<Record<string, unknown>> = [
      { source: 'mcp' },
      { source: 'bot', origin: { roomId: 'r1', fromAgentId: 'x', hop: 1, approvalCeiling: 'full' } },
      { source: 'bot', bridge: { fromAgentId: 'lead', parentTaskId: 'p', hop: 1 } },
      { source: 'bot', bridge: { fromAgentId: 'lead', fromTaskId: 'p', reply: true, hop: 1 } },
    ];
    for (const extra of cases) {
      const t = c.h.engine.startTask({ agentId: 'a1', prompt: 'go', ...extra } as any);
      const d = await c.h.engine.waitFor(t.id, 8000);
      assert.equal(d.status, 'error', JSON.stringify(extra)); assert.match(d.error ?? '', /only you can start it/);
    }
    assert.equal(c.h.approvals.pending().length, 0); assert.equal(existsSync(c.record), false);
  } finally { await c.done(); }
});

test('B2 refused when the agent is not on the provider\'s list, when the provider is off, or when the program path is missing', async () => {
  for (const [entry, re] of [[{ allowedAgents: [] }, /not enabled for this agent/], [{ enabled: false }, /turned off/], [{ executable: join(tmpdir(), 'no-such-cli-legion') }, /was not found/]] as Array<[Partial<ProviderEntry>, RegExp]>) {
    const c = await cliSetup({ entry });
    try {
      const d = await run(c.h, 'go');
      assert.equal(d.status, 'error'); assert.match(d.error ?? '', re);
      assert.equal(c.h.approvals.pending().length, 0); assert.equal(existsSync(c.record), false);
    } finally { await c.done(); }
  }
});

test('B2 working folder: the home folder, a filesystem root, Legion\'s data folder and the Legion repo are refused; the agent\'s own workspace is fine', async () => {
  const c = await cliSetup();
  try {
    const ctx = { home: c.home, workspaceDir: join(c.tmp, 'data', 'workspaces'), dataDir: join(c.tmp, 'data'), appRoots: [repoRoot] };
    mkdirSync(join(ctx.workspaceDir, 'a1'), { recursive: true });
    assert.equal(checkCliFolder(c.home, ctx).ok, false, 'home');
    assert.equal(checkCliFolder(tmpdir(), ctx).ok, false, 'a folder that contains home');
    assert.equal(checkCliFolder('/', ctx).ok, false, 'root');
    assert.equal(checkCliFolder(join(c.tmp, 'data'), ctx).ok, false, 'the data folder');
    assert.equal(checkCliFolder(ctx.workspaceDir, ctx).ok, false, 'the workspaces folder itself');
    mkdirSync(join(c.tmp, 'data', 'providers'), { recursive: true });
    assert.equal(checkCliFolder(join(c.tmp, 'data', 'providers'), ctx).ok, false, 'inside data but not a workspace');
    assert.equal(checkCliFolder(repoRoot, ctx).ok, false, 'the repo');
    assert.equal(checkCliFolder(join(repoRoot, 'src'), ctx).ok, false, 'inside the repo');
    assert.equal(checkCliFolder(join(c.tmp, 'nope'), ctx).ok, false, 'missing');
    const ok = checkCliFolder(join(ctx.workspaceDir, 'a1'), ctx);
    assert.ok(ok.ok);
    // through the engine: an agent whose folder is the home folder is refused before any card
    const c2 = await cliSetup({ agent: { cwd: undefined } });
    try {
      c2.h.store.agents.get('a1')!.cwd = c2.home;
      const d = await run(c2.h, 'go');
      assert.equal(d.status, 'error'); assert.match(d.error ?? '', /home folder/);
      assert.equal(c2.h.approvals.pending().length, 0); assert.equal(existsSync(c2.record), false);
    } finally { await c2.done(); }
  } finally { await c.done(); }
});

test('B2 a hung program is stopped at its time limit with everything it started; cancel does the same by PID', async () => {
  for (const mode of ['timeout', 'cancel'] as const) {
    const c = await cliSetup({ entry: { timeoutSeconds: mode === 'timeout' ? 2 : 60 } });
    try {
      const t = start(c.h, 'SLEEP now');
      c.h.approvals.resolve((await card(c.h)).id, true);
      await until(() => existsSync(c.record + '.pids') && readFileSync(c.record + '.pids', 'utf8').includes('grandchild'), 15000);
      const p = pidsOf(c.record + '.pids');
      assert.ok(alive(p.main!) && alive(p.grandchild!));
      if (mode === 'cancel') c.h.engine.cancel(t.id);
      const d = await c.h.engine.waitFor(t.id, 20000);
      if (mode === 'timeout') { assert.equal(d.status, 'error'); assert.match(d.error ?? '', /ran past its 2 second limit/); } else assert.equal(d.status, 'cancelled');
      await until(() => !alive(p.main!) && !alive(p.grandchild!), 8000);
    } finally { await c.done(); }
  }
});

test('B2 output over the cap ends the program and its tree; the error says so', async () => {
  const c = await cliSetup();
  try {
    const t = start(c.h, 'FLOOD it');
    c.h.approvals.resolve((await card(c.h)).id, true);
    const d = await c.h.engine.waitFor(t.id, 20000);
    assert.equal(d.status, 'error'); assert.match(d.error ?? '', /printed more than 1048576 bytes/);
    await until(() => !alive(pidsOf(c.record + '.pids').main!), 8000);
  } finally { await c.done(); }
});

test('B2 a failing program: exit code and a redacted stderr tail; terminal escapes and control characters are stripped from what it printed', async () => {
  const c = await cliSetup();
  try {
    c.h.keys.set('fake', FAKE_KEY, 'http://127.0.0.1:1');
    const t = start(c.h, 'FAIL please');
    c.h.approvals.resolve((await card(c.h)).id, true);
    const d = await c.h.engine.waitFor(t.id, 15000);
    assert.equal(d.status, 'error'); assert.match(d.error ?? '', /exit 2/);
    assert.equal((d.error ?? '').includes(FAKE_KEY), false); assert.match(d.error ?? '', /redacted/);
    const t2 = start(c.h, 'ANSI test', { continueTaskId: t.id });
    c.h.approvals.resolve((await card(c.h)).id, true);
    const d2 = await c.h.engine.waitFor(t2.id, 15000);
    assert.equal(d2.status, 'done'); assert.equal(d2.result, 'red okend');
  } finally { await c.done(); }
});

test('B2 OpenCode: its permission config is passed inline (edit and shell denied for read-only), the folder is its --dir, no auto-approve flag', async () => {
  const c = await cliSetup({ entry: { cli: 'opencode' } });
  try {
    const t = start(c.h, 'list the files', {});
    const cd = await card(c.h);
    c.h.approvals.resolve(cd.id, true);
    const d = await c.h.engine.waitFor(t.id, 15000);
    assert.equal(d.status, 'done');
    const r = c.rec();
    assert.deepEqual(r.argv.slice(0, 2), ['run', '--dir']);
    assert.deepEqual(JSON.parse(r.env.OPENCODE_PERMISSION), { edit: 'deny', bash: 'deny', webfetch: 'deny', external_directory: 'deny' });
    assert.equal(r.argv.includes('--auto'), false);
    assert.equal(r.argv.at(-1), 'list the files');
  } finally { await c.done(); }
});

test('B2 command building never widens: no bypass, auto, search, config override, extra directory or approval flag for any sandbox or model; bad models and long or dash prompts are refused', () => {
  for (const cli of ['codex', 'opencode'] as const) for (const sandbox of ['read-only', 'workspace-write'] as const) for (const model of ['default', 'gpt-5', 'openai/gpt-5.1:high']) {
    const p = buildCliPlan(cliEntry({ cli, sandbox }), model, 'do a thing', '/w/a1');
    for (const a of p.args) assert.equal(FORBIDDEN_CLI_TOKENS.includes(a), false, `${cli} ${sandbox}: ${a}`);
    assert.doesNotMatch(p.display, /danger|full-auto|--search|network/i);
    if (cli === 'codex') assert.ok(p.args.includes(sandbox)); else assert.equal(JSON.parse(p.envExtra.OPENCODE_PERMISSION!).bash, 'deny');
  }
  assert.throws(() => buildCliPlan(cliEntry(), '--dangerously-bypass-approvals-and-sandbox', 'x', '/w'), /not allowed/);
  assert.throws(() => buildCliPlan(cliEntry(), 'a b', 'x', '/w'), /not allowed/);
  assert.throws(() => buildCliPlan(cliEntry(), 'default', 'x'.repeat(CLI_MAX_PROMPT_CHARS + 1), '/w'), /longer than/);
  assert.throws(() => buildCliPlan(cliEntry({ cli: 'opencode' }), 'default', '--auto', '/w'), /dash/);
  assert.throws(() => buildCliPlan(cliEntry(), 'default', '  ', '/w'), /empty/);
  // the sandbox value of an entry can only be one of the two; anything else is read-only
  assert.ok(buildCliPlan(cliEntry({ sandbox: 'danger-full-access' as any }), 'default', 'x', '/w').args.includes('read-only'));
});

test('B2 environment: only allowed names, never a key or token, the CLI\'s own config home only for that CLI, Path/PATH case on Windows', () => {
  const src = { PATH: '/bin', HOME: '/h', CODEX_HOME: '/c', XDG_CONFIG_HOME: '/x', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', LEGION_ADMIN: 'a', OPENCODE_CONFIG: '/oc', HTTPS_PROXY: 'p' };
  assert.deepEqual(Object.keys(cliEnv('codex', {}, src, 'linux')).sort(), ['CODEX_HOME', 'HOME', 'PATH', 'XDG_CONFIG_HOME']);
  assert.deepEqual(Object.keys(cliEnv('opencode', { OPENCODE_PERMISSION: '{}' }, src, 'linux')).sort(), ['HOME', 'OPENCODE_PERMISSION', 'PATH', 'XDG_CONFIG_HOME']);
  const w = cliEnv('codex', {}, { Path: 'C:\\bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\u', OPENAI_API_KEY: 'k', codex_home: 'C:\\c' }, 'win32');
  assert.deepEqual(Object.keys(w).sort(), ['Path', 'SystemRoot', 'USERPROFILE', 'codex_home']);
  for (const k of [...cliEnvAllow('codex'), ...cliEnvAllow('opencode'), ...cliEnvAllow('codex', 'win32')]) assert.doesNotMatch(k, /KEY|TOKEN|SECRET|PASSWORD|AUTH/i);
  assert.equal(cleanCliText('\u001b[1mbold\u001b[0m\r\n\u202etext'), 'bold\ntext');
});

test('B2 Legion never reads, copies or names a CLI\'s credential store: no provider source file mentions one', () => {
  const dir = join(repoRoot, 'src/core/providers');
  for (const n of ['cli.ts', 'runtime.ts', 'proc.ts', 'routes.ts', 'engine.ts']) {
    const p = n === 'engine.ts' ? join(repoRoot, 'src/core/engine.ts') : join(dir, n);
    const t = readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(t, /auth\.json|\.codex\b|credentials\.json|\.local\/share\/opencode|readFileSync\([^)]*(?:codex|opencode)/i, n);
  }
});

test('B2 the view carries the plain warning, says the run starts tainted, and a CLI has no key or model list', async () => {
  const c = await cliSetup();
  try {
    const v = c.h.providers.view();
    const row = v.providers.find((p) => p.id === 'cli')!;
    assert.equal(row.kind, 'cli'); assert.equal(row.startsTainted, true); assert.deepEqual(row.allowedAgents, ['a1']);
    assert.match(v.cliWarning, /cannot see or stop/); assert.match(v.cliWarning, /outside Legion/);
    await assert.rejects(() => c.h.providers.refreshModels('cli'), /no model list/);
  } finally { await c.done(); }
});
