import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providersExperimental } from '../src/core/providers/flag.js';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import { createProvidersModule } from '../src/core/providers/routes.js';
import { keyFileFor, ProviderKeys } from '../src/core/providers/secrets.js';
import { createProcessPort } from '../src/core/providers/proc.js';
import { providerChange } from '../src/electron/provider-ipc.js';
import { defaultConfig } from '../src/shared/config.js';
import { AUTH, makeFakes, start, TOKEN } from './helpers-c.js';
import { replyText, replyTools, startFake } from './providers-fakes.js';
import { mkAgent, run, setup } from './providers-harness.js';
import { repoRoot } from './ps-helpers.js';

const NATIVE = 'native-secret-0123456789abcdef0123456789';
const FAKE = join(repoRoot, 'test/fixtures/fake-cli.mjs');
const TREE = join(repoRoot, 'test/fixtures/fake-mcp-tree.mjs');

test('the flag is the boolean true in config.json and nothing else', () => {
  assert.equal(providersExperimental({ experimental: { providers: true } }), true);
  for (const v of [undefined, null, false, 'true', 1, {}, [], 'yes']) assert.equal(providersExperimental({ experimental: { providers: v } }), false, String(v));
  for (const c of [undefined, null, {}, { experimental: true }, { experimental: 'providers' }, { experimental: [] }]) assert.equal(providersExperimental(c), false);
});

// ---- routes and view, flag absent
const dir = mkdtempSync(join(tmpdir(), 'legion-prov-exp-'));
const configPath = join(dir, 'config.json');
writeFileSync(configPath, JSON.stringify({ port: 0, authToken: TOKEN }, null, 2));
const cfg: any = defaultConfig();
cfg.mcpServers = { tool: { command: process.execPath, args: ['x.js'] } };
cfg.providers.entries.crafted = { kind: 'cli', cli: 'codex', label: 'Crafted', baseUrl: '', enabled: true, executable: process.execPath, allowedAgents: ['a1'], sandbox: 'read-only', timeoutSeconds: 30 };
cfg.providers.leadChoices = { sub: ['openai:gpt-x'] };
const runtime = new ProviderRuntime({ config: cfg, keys: new ProviderKeys(keyFileFor(dir)) });
const f = makeFakes();
(f.ctx as any).modules = [createProvidersModule({ runtime, configPath, nativeSecret: NATIVE })];
let base = ''; let close: () => Promise<void>;
before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
after(async () => { await close(); });
const H = (extra: Record<string, string> = {}) => ({ ...AUTH, 'Content-Type': 'application/json', ...extra });
const call = (method: string, path: string, body?: unknown, headers = H({ 'X-Legion-Native': NATIVE })) => fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

test('flag off: the new routes answer 404 even with admin and the native secret, and the new provider fields are refused', async () => {
  assert.equal(runtime.experimental, false);
  assert.equal((await call('PUT', '/api/provider-mcp/tool', { allow: true })).status, 404);
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['openai:gpt-x'] })).status, 404);
  for (const body of [{ kind: 'cli', cli: 'codex', label: 'C', executable: process.execPath }, { trusted: true }, { tokenCapPerTask: 100 }, { tokenCapPerDay: 100 }, { leadSelectable: true }, { allowedAgents: ['a1'] }, { sandbox: 'workspace-write' }]) {
    assert.equal((await call('PUT', '/api/providers/mine', { baseUrl: 'https://x.example/v1', ...body })).status, 404, JSON.stringify(body));
  }
  assert.equal((await call('PUT', '/api/providers/crafted', { enabled: false })).status, 404, 'an entry of the new kind cannot be changed either');
  assert.equal((await call('PUT', '/api/providers/crafted/key', { key: 'sk-abcdefghijklmnop' })).status, 404);
  assert.deepEqual(cfg.providers.stdioMcpAllow, {}); assert.equal(cfg.providers.entries.mine, undefined);
  // the older fields keep working as before
  assert.equal((await call('PUT', '/api/providers/mine', { label: 'Mine', baseUrl: 'https://llm.example.com/v1', enabled: true })).status, 200);
});

test('flag off: the view carries nothing of the new surfaces (no CLI rows, no local-MCP list, no lead list, no warnings, no taint or cap fields)', async () => {
  const v: any = await (await call('GET', '/api/providers')).json();
  assert.equal(v.experimental, false);
  assert.deepEqual(v.stdioServers, []); assert.deepEqual(v.leadChoices, {}); assert.equal(v.cliWarning, ''); assert.equal(v.roomBudgetNote, '');
  assert.equal(v.providers.some((p: any) => p.id === 'crafted'), false);
  for (const p of v.providers) for (const k of ['kind', 'trusted', 'startsTainted', 'leadSelectable', 'tokensToday', 'tokenCapPerTask', 'cli', 'executable', 'allowedAgents']) assert.equal(k in p, false, `${p.id}.${k}`);
  cfg.experimental = { providers: true };
  const on: any = await (await call('GET', '/api/providers')).json();
  assert.equal(on.experimental, true); assert.equal(on.providers.some((p: any) => p.id === 'crafted'), true); assert.equal(on.stdioServers.length, 1);
  cfg.experimental = { providers: 'true' };
  assert.equal(((await (await call('GET', '/api/providers')).json()) as any).experimental, false, 'a string is not the flag');
  delete cfg.experimental;
});

// ---- the engine
test('flag off: vm_cli is not offered, the per-task model parameter stays the plain list, a configured CLI will not run, a lead cannot pick a provider, delegate-only does nothing', async () => {
  let n = 0;
  const f2 = await startFake((_r, res) => { n++; replyText(res, 'plain'); });
  try {
    const h = setup(f2, { vm: true, experimental: false, agent: { approval: 'full' } });
    await run(h);
    const tools = f2.requests[0]!.body.tools as any[];
    const names = tools.map((t) => t.function.name);
    assert.equal(names.includes('mcp__legion__vm_cli'), false);
    assert.ok(names.includes('mcp__legion__vm_exec'), 'the older VM tools are unchanged');
    const ask = tools.find((t) => t.function.name === 'mcp__legion__ask').function.parameters.properties.model;
    assert.deepEqual(ask.enum, ['sonnet', 'opus', 'haiku', 'auto']); assert.equal('anyOf' in ask, false);
    // with the flag on the same tool list does offer it (so the checks above are not vacuous)
    const on = setup(f2, { vm: true, agent: { approval: 'full' } });
    await run(on);
    assert.ok((f2.requests.at(-1)!.body.tools as any[]).some((t) => t.function.name === 'mcp__legion__vm_cli'));
    assert.ok(n >= 2);
  } finally { await f2.close(); }

  // a CLI entry that was written into config.json by hand
  const f3 = await startFake(() => undefined);
  try {
    const tmp = mkdtempSync(join(tmpdir(), 'legion-exp-cli-'));
    const record = join(tmp, 'rec.json');
    const h = setup(f3, { noEntry: true, experimental: false, agent: { model: 'cli:default', approval: 'full' }, runtimeDeps: { cliPort: createProcessPort({ prefixArgs: [FAKE, record] }), home: join(tmp, 'home'), dataDir: join(tmp, 'data'), appRoots: [repoRoot] } });
    h.config.providers.entries.cli = { kind: 'cli', cli: 'codex', label: 'Codex', baseUrl: '', enabled: true, executable: process.execPath, allowedAgents: ['a1'], sandbox: 'read-only', timeoutSeconds: 30 };
    const d = await run(h, 'go');
    assert.equal(d.status, 'error'); assert.match(d.error ?? '', /CLI providers are not available/);
    assert.equal(h.approvals.pending().length, 0); assert.equal(existsSync(record), false);
  } finally { await f3.close(); }

  const f4 = await startFake((_r, res) => replyText(res, 'x'));
  try {
    const h = setup(f4, { experimental: false, agent: { id: 'sub', name: 'Sub', model: 'sonnet', approval: 'full' } });
    h.store.agents.set('lead', mkAgent({ id: 'lead', name: 'Lead', model: 'sonnet' }));
    h.store.tasks.set('lt', { id: 'lt', agentId: 'lead', title: 't', status: 'running', source: 'ui', requestedModel: 'sonnet', createdAt: '', updatedAt: '' } as any);
    h.config.providers.leadChoices.sub = ['fake:m1'];
    h.config.providers.entries.fake!.leadSelectable = true;
    assert.throws(() => h.engine.bridge.tell('lt', 'sub', 'do it', { model: 'fake:m1' }), /not available in this version/);
    assert.throws(() => (h.engine as any).startTask({ agentId: 'sub', prompt: 'x', source: 'bot', model: 'fake:m1', modelOverrideBy: 'lead', bridge: { fromAgentId: 'lead', hop: 1 } }), /not available in this version/);
    // delegate-only is ignored
    const d = setup(f4, { experimental: false, agent: { model: 'sonnet', delegateOnly: true } });
    await run(d);
    assert.equal((d.claudeCalls[0].options.disallowedTools as string[]).includes('Bash'), false);
  } finally { await f4.close(); }
});

test('flag off: the security fixes of the first pass still hold (a local MCP server is not started for a provider run; custom endpoints start tainted)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'legion-exp-tree-')); const pidFile = join(tmp, 'pids');
  const f5 = await startFake((_r, res) => replyText(res, 'fine'));
  try {
    const h = setup(f5, { experimental: false, agent: { approval: 'full', mcpServers: ['tree'] } });
    h.config.mcpServers = { tree: { command: process.execPath, args: [TREE], env: { PID_FILE: pidFile } } };
    assert.equal((await run(h)).status, 'done');
    assert.equal(existsSync(pidFile), false);
    assert.equal(h.providers.startsTainted({ providerId: 'mine', model: 'm', entry: { kind: 'openai-compat', label: 'M', baseUrl: 'https://llm.example.com/v1', enabled: true } }), true);
  } finally { await f5.close(); }
});

// ---- the native dialog and the UI
test('flag off: the app\'s native dialogs refuse the new kinds before any dialog is shown', async () => {
  const dialogs: unknown[] = [];
  const calls: string[] = [];
  const d = {
    async call(method: string, route: string) { calls.push(`${method} ${route}`); return { status: 200, json: { experimental: false, providers: [{ id: 'mine', label: 'Mine', baseUrl: 'https://llm.example.com/v1' }], stdioServers: [] } }; },
    async confirm(o: unknown) { dialogs.push(o); return true; },
  } as any;
  for (const ch of [{ kind: 'mcp-stdio', name: 'tool' }, { kind: 'lead', agentId: 'sub', choices: ['mine:m'] }, { kind: 'entry', id: 'mine', patch: { trusted: true } }, { kind: 'entry', id: 'new', patch: { kind: 'cli', cli: 'codex', executable: '/x' } }, { kind: 'entry', id: 'mine', patch: { leadSelectable: true } }]) {
    const r = await providerChange(ch, d);
    assert.equal(r.ok, false, JSON.stringify(ch)); assert.match(r.error ?? '', /not available in this version/);
  }
  assert.equal(dialogs.length, 0); assert.equal(calls.some((c) => c.startsWith('PUT')), false);
});

test('flag off: every new Settings, model-picker, agent and room element is behind the flag in the UI source', () => {
  const sec = readFileSync(join(repoRoot, 'ui/src/providers/ProvidersSection.tsx'), 'utf8');
  assert.match(sec, /view\.experimental && <><AddCli \/><StdioServers \/><LeadChoices \/><\/>/);
  assert.match(sec, /\{exp && <>\n\s+<p className="prov-status" data-testid=\{`taint-/);
  assert.match(sec, /Token limit per task/); assert.ok(sec.indexOf('{exp && <>') < sec.indexOf('Token limit per task') && sec.indexOf('Token limit per task') < sec.indexOf('      </>}'), 'the caps sit inside the guarded block');
  assert.match(sec, /p\.kind === 'cli' \? <CliCard/);
  assert.match(readFileSync(join(repoRoot, 'ui/src/components/AgentEditor.tsx'), 'utf8'), /provView\?\.experimental === true && <label className="check-row"><input type="checkbox" checked=\{delegateOnly\}/);
  assert.match(readFileSync(join(repoRoot, 'ui/src/rooms/RoomHeader.tsx'), 'utf8'), /providersOn && g\.budgetUsd !== null/);
  mkdirSync(dir, { recursive: true });
});
