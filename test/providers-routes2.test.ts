import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRuntime } from '../src/core/providers/runtime.js';
import { createProvidersModule } from '../src/core/providers/routes.js';
import { keyFileFor, ProviderKeys } from '../src/core/providers/secrets.js';
import { isClientRoute } from '../src/core/admin.js';
import { stdioFingerprint } from '../src/core/providers/stdio-allow.js';
import { defaultConfig } from '../src/shared/config.js';
import { AUTH, asClient, makeFakes, start, TOKEN } from './helpers-c.js';

const NATIVE = 'native-secret-0123456789abcdef0123456789';
const dir = mkdtempSync(join(tmpdir(), 'legion-prov-routes2-'));
const configPath = join(dir, 'config.json');
writeFileSync(configPath, JSON.stringify({ port: 0, authToken: TOKEN, claude: { maxTurns: 7 } }, null, 2));
const cfg = defaultConfig();
cfg.mcpServers = { tool: { command: process.execPath, args: ['x.js'], env: { SECRET_ENV: 'value-1' } }, web: { type: 'http', url: 'https://x.example/mcp' } } as any;
const runtime = new ProviderRuntime({ config: cfg, keys: new ProviderKeys(keyFileFor(dir)) });
const f = makeFakes();
(f.ctx as any).modules = [createProvidersModule({ runtime, configPath, nativeSecret: NATIVE })];
let base = ''; let close: () => Promise<void>;
before(async () => { const s = await start(f.ctx); base = s.base; close = s.close; });
after(async () => { await close(); });
const H = (extra: Record<string, string> = {}) => ({ ...AUTH, 'Content-Type': 'application/json', ...extra });
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = H()) => fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const N = { 'X-Legion-Native': NATIVE };
const disk = () => JSON.parse(readFileSync(configPath, 'utf8')).providers;

test('A1 allowing a stdio server for provider runs needs admin AND the native secret; the fingerprint is computed from the server entry, never taken from the request; stopping needs admin only', async () => {
  assert.equal(runtime.stdioServers().find((s) => s.name === 'tool')!.allowed, false, 'default OFF');
  assert.equal((await call('PUT', '/api/provider-mcp/tool', { allow: true })).status, 403);
  assert.equal((await call('PUT', '/api/provider-mcp/tool', { allow: true }, H({ 'X-Legion-Native': 'wrong' }))).status, 403);
  assert.equal((await call('PUT', '/api/provider-mcp/tool', { allow: true, fingerprint: 'a'.repeat(64) }, H(N))).status, 200);
  assert.equal(cfg.providers.stdioMcpAllow.tool, stdioFingerprint(cfg.mcpServers.tool as any));
  assert.equal(disk().stdioMcpAllow.tool, stdioFingerprint(cfg.mcpServers.tool as any));
  const v: any = await (await call('GET', '/api/providers')).json();
  const row = v.stdioServers.find((s: any) => s.name === 'tool');
  assert.equal(row.allowed, true); assert.match(row.commandLine, /x\.js/); assert.match(row.commandLine, /env: SECRET_ENV/); assert.equal(JSON.stringify(v).includes('value-1'), false, 'env values never leave');
  // Settings edits the command: the approval no longer matches
  (cfg.mcpServers.tool as any).args = ['evil.js'];
  assert.equal(runtime.stdioAllowed('tool', cfg.mcpServers.tool as any), false);
  assert.equal(runtime.stdioServers().find((s) => s.name === 'tool')!.changedSinceAllowed, true);
  (cfg.mcpServers.tool as any).args = ['x.js'];
  assert.equal(runtime.stdioAllowed('tool', cfg.mcpServers.tool as any), true);
  // an http server and an unknown name cannot be allowed
  assert.equal((await call('PUT', '/api/provider-mcp/web', { allow: true }, H(N))).status, 404);
  assert.equal((await call('PUT', '/api/provider-mcp/nope', { allow: true }, H(N))).status, 404);
  // stopping: admin only
  assert.equal((await call('PUT', '/api/provider-mcp/tool', { allow: false })).status, 200);
  assert.equal(runtime.stdioAllowed('tool', cfg.mcpServers.tool as any), false);
  assert.equal('tool' in disk().stdioMcpAllow, false);
  // the token client reaches nothing here
  for (const [m, p] of [['PUT', '/api/provider-mcp/tool'], ['PUT', '/api/provider-lead/sub']] as const) {
    assert.equal(isClientRoute(m, p), false);
    assert.equal((await fetch(base + p, { method: m, headers: { ...asClient, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, `${m} ${p} with the token only`);
  }
});

test('A3 relaxing the taint of a custom endpoint, and A4 caps: relaxing needs native, caps and tightening need admin only', async () => {
  const mk = { label: 'Mine', baseUrl: 'https://llm.example.com/v1', enabled: true };
  assert.equal((await call('PUT', '/api/providers/mine', mk, H(N))).status, 200);
  let v: any = await (await call('GET', '/api/providers')).json();
  assert.equal(v.providers.find((p: any) => p.id === 'mine').startsWith, undefined);
  assert.equal(v.providers.find((p: any) => p.id === 'mine').startsTainted, true, 'a custom remote endpoint starts tainted by default');
  assert.equal(v.providers.find((p: any) => p.id === 'openai').startsTainted, false);
  assert.equal(v.providers.find((p: any) => p.id === 'ollama').startsTainted, false);
  assert.equal((await call('PUT', '/api/providers/mine', { trusted: true })).status, 403, 'relaxing without native');
  assert.equal((await call('PUT', '/api/providers/mine', { trusted: true }, H({ 'X-Legion-Native': 'wrong' }))).status, 403);
  assert.equal(cfg.providers.entries.mine!.trusted, undefined);
  assert.equal((await call('PUT', '/api/providers/mine', { trusted: true }, H(N))).status, 200);
  v = await (await call('GET', '/api/providers')).json();
  assert.equal(v.providers.find((p: any) => p.id === 'mine').startsTainted, false);
  assert.equal((await call('PUT', '/api/providers/mine', { trusted: false })).status, 200, 'tightening is admin only');
  assert.equal(cfg.providers.entries.mine!.trusted, undefined);
  // caps: admin only, validated, cleared with null
  assert.equal((await call('PUT', '/api/providers/mine', { tokenCapPerTask: 5000, tokenCapPerDay: 100000 })).status, 200);
  assert.equal(cfg.providers.entries.mine!.tokenCapPerTask, 5000);
  assert.equal(disk().entries.mine.tokenCapPerDay, 100000);
  assert.equal((await call('PUT', '/api/providers/mine', { tokenCapPerTask: -3 })).status, 200, 'an invalid cap is dropped, not stored');
  assert.equal(cfg.providers.entries.mine!.tokenCapPerTask, undefined);
  assert.equal((await call('PUT', '/api/providers/mine', { tokenCapPerDay: null })).status, 200);
  assert.equal(cfg.providers.entries.mine!.tokenCapPerDay, undefined);
  // a preset repointed to another host is a custom endpoint: address change already needs native
  assert.equal((await call('PUT', '/api/providers/openai', { baseUrl: 'https://evil.example.net/v1' })).status, 403);
});

test('B2 any change to a CLI entry needs the native secret (except turning it off); it starts disabled, takes no key, and a bare name or a special-character path is refused', async () => {
  const exe = process.execPath;
  const mk = { kind: 'cli', cli: 'codex', label: 'Codex', executable: exe };
  assert.equal((await call('PUT', '/api/providers/codexcli', mk)).status, 403, 'creating without native');
  assert.equal((await call('PUT', '/api/providers/codexcli', { ...mk, enabled: true }, H(N))).status, 400, 'a new CLI cannot be created already enabled');
  assert.equal((await call('PUT', '/api/providers/codexcli', { ...mk, executable: 'codex' }, H(N))).status, 400, 'a bare name is not looked up on PATH');
  assert.equal((await call('PUT', '/api/providers/codexcli', { ...mk, executable: '/bin/x;rm -rf' }, H(N))).status, 400);
  assert.equal((await call('PUT', '/api/providers/codexcli', { ...mk, cli: 'bash' }, H(N))).status, 400);
  assert.equal((await call('PUT', '/api/providers/codexcli', mk, H(N))).status, 200);
  assert.equal(cfg.providers.entries.codexcli!.enabled, false); assert.deepEqual(cfg.providers.entries.codexcli!.allowedAgents, []);
  // enabling for an agent, changing the sandbox, the program: native each time
  for (const patch of [{ enabled: true }, { allowedAgents: ['a1'] }, { sandbox: 'workspace-write' }, { executable: exe + '2' }]) {
    assert.equal((await call('PUT', '/api/providers/codexcli', patch)).status, 403, JSON.stringify(patch));
  }
  assert.equal((await call('PUT', '/api/providers/codexcli', { enabled: true, allowedAgents: ['a1'], sandbox: 'workspace-write' }, H(N))).status, 200);
  assert.equal(cfg.providers.entries.codexcli!.enabled, true); assert.deepEqual(cfg.providers.entries.codexcli!.allowedAgents, ['a1']);
  assert.equal((await call('PUT', '/api/providers/codexcli', { kind: 'openai-compat', baseUrl: 'https://x.example/v1' }, H(N))).status, 400, 'a provider keeps its kind');
  assert.equal((await call('PUT', '/api/providers/codexcli/key', { key: 'sk-abcdefghijklmnop' }, H(N))).status, 400, 'no key for a CLI');
  assert.equal((await call('POST', '/api/providers/codexcli/models')).status, 400);
  // turning it off is admin only (the safe direction)
  assert.equal((await call('PUT', '/api/providers/codexcli', { enabled: false })).status, 200);
  assert.equal(cfg.providers.entries.codexcli!.enabled, false);
  assert.equal((await call('PUT', '/api/providers/codexcli', { enabled: false, allowedAgents: ['a1', 'a2'] })).status, 403, 'turning off while widening the list is not "only off"');
  // a CLI can never be lead-selectable
  assert.equal((await call('PUT', '/api/providers/codexcli', { leadSelectable: true }, H(N))).status, 200);
  assert.equal(cfg.providers.entries.codexcli!.leadSelectable, undefined);
});

test('C the lead-choices list: adding a value needs admin AND native; only provider:model values of real endpoint providers; removing needs admin only; no token client', async () => {
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['openai:gpt-x'] })).status, 403);
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['openai:gpt-x'] }, H({ 'X-Legion-Native': 'wrong' }))).status, 403);
  assert.deepEqual(cfg.providers.leadChoices, {});
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['sonnet'] }, H(N))).status, 400);
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['nosuch:m'] }, H(N))).status, 400);
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['codexcli:default'] }, H(N))).status, 400, 'a CLI is never on the list');
  assert.equal((await call('PUT', '/api/provider-lead/bad id', { choices: [] }, H(N))).status, 400);
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['openai:gpt-x', 'openai:gpt-y'] }, H(N))).status, 200);
  assert.deepEqual(cfg.providers.leadChoices.sub, ['openai:gpt-x', 'openai:gpt-y']);
  assert.deepEqual(disk().leadChoices.sub, ['openai:gpt-x', 'openai:gpt-y']);
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['openai:gpt-y'] })).status, 200, 'removing a value is admin only');
  assert.deepEqual(cfg.providers.leadChoices.sub, ['openai:gpt-y']);
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: ['openai:gpt-y', 'openai:gpt-z'] })).status, 403, 'adding one is not');
  assert.equal((await call('PUT', '/api/provider-lead/sub', { choices: [] })).status, 200);
  assert.deepEqual(cfg.providers.leadChoices, {});
});
