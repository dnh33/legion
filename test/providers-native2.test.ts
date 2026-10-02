import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProviderChange, providerChange } from '../src/electron/provider-ipc.js';
import type { ProviderIpcDeps } from '../src/electron/provider-ipc.js';

const VIEW = {
  experimental: true,
  providers: [{ id: 'mine', label: 'Mine', baseUrl: 'https://old.example.com/v1', kind: 'openai-compat' }, { id: 'codexcli', label: 'Codex CLI', baseUrl: '', kind: 'cli', executable: '/usr/bin/codex', sandbox: 'read-only' }],
  stdioServers: [{ name: 'tool', commandLine: '/usr/bin/tool --flag "a b"    (env: TOKEN_NAME)', allowed: false }],
};
const STATE = { agents: [{ id: 'sub', name: 'Sub Agent' }] };
function deps(over: { confirm?: boolean } = {}) {
  const calls: Array<{ method: string; route: string; body?: unknown; native?: boolean }> = [];
  const dialogs: Array<{ title: string; message: string; detail: string; confirmLabel: string }> = [];
  const d: ProviderIpcDeps = {
    async call(method, route, body, native) { calls.push({ method, route, body, native }); if (method === 'GET') return { status: 200, json: route === '/api/state' ? STATE : VIEW }; return { status: 200, json: { ok: true } }; },
    async confirm(o) { dialogs.push(o); return over.confirm !== false; },
  };
  return { d, calls, dialogs };
}

test('A1 the dialog for allowing a stdio MCP server shows the exact command line (from the core, not the window), and only Confirm calls the core with the native secret', async () => {
  const { d, calls, dialogs } = deps();
  const r = await providerChange({ kind: 'mcp-stdio', name: 'tool', commandLine: 'harmless (sent by a compromised window)' }, d);
  assert.equal(r.ok, true);
  assert.match(dialogs[0]!.detail, /\/usr\/bin\/tool --flag "a b"/); assert.match(dialogs[0]!.detail, /env: TOKEN_NAME/);
  assert.equal(dialogs[0]!.detail.includes('harmless'), false);
  const put = calls.find((c) => c.method === 'PUT')!;
  assert.equal(put.route, '/api/provider-mcp/tool'); assert.equal(put.native, true); assert.deepEqual(put.body, { allow: true });
  const none = deps({ confirm: false });
  assert.equal((await providerChange({ kind: 'mcp-stdio', name: 'tool' }, none.d)).cancelled, true);
  assert.equal(none.calls.some((c) => c.method === 'PUT'), false);
  assert.equal((await providerChange({ kind: 'mcp-stdio', name: 'nope' }, deps().d)).ok, false);
  assert.equal(parseProviderChange({ kind: 'mcp-stdio', name: '../x' }), undefined);
});

test('B2 the CLI dialog carries the plain warning, the program path, the sandbox flag and the agents; cancel changes nothing; a new CLI can be added (the core validates it)', async () => {
  const { d, calls, dialogs } = deps();
  const r = await providerChange({ kind: 'entry', id: 'codexcli', patch: { enabled: true, allowedAgents: ['sub'], sandbox: 'workspace-write' } }, d);
  assert.equal(r.ok, true);
  const t = dialogs[0]!.detail;
  assert.match(t, /cannot see or stop its individual actions/); assert.match(t, /outside Legion's per-tool approvals and taint tracking/); assert.match(t, /Sign in to it yourself, outside Legion/);
  assert.match(t, /Program: \/usr\/bin\/codex/); assert.match(t, /workspace-write/); assert.match(t, /Enabled for agent ids: sub/); assert.match(t, /approve every single start/);
  assert.equal(calls.find((c) => c.method === 'PUT')!.native, true);
  const c = deps({ confirm: false });
  assert.equal((await providerChange({ kind: 'entry', id: 'codexcli', patch: { enabled: true } }, c.d)).cancelled, true);
  assert.equal(c.calls.some((x) => x.method === 'PUT'), false);
  const n = deps();
  const added = await providerChange({ kind: 'entry', id: 'newcli', patch: { kind: 'cli', cli: 'opencode', label: 'OC', executable: '/opt/oc' } }, n.d);
  assert.equal(added.ok, true); assert.match(n.dialogs[0]!.detail, /Program: \/opt\/oc/);
});

test('pass 1 fix: adding a new custom endpoint reaches the dialog (before, a provider that did not exist yet was refused as "Unknown provider")', async () => {
  const { d, calls, dialogs } = deps();
  const r = await providerChange({ kind: 'entry', id: 'brandnew', patch: { label: 'New', baseUrl: 'https://llm.example.com/v1', enabled: true } }, d);
  assert.equal(r.ok, true); assert.match(dialogs[0]!.detail, /llm\.example\.com/);
  assert.doesNotMatch(dialogs[0]!.detail, /address changes from/);
  assert.equal(calls.find((c) => c.method === 'PUT')!.route, '/api/providers/brandnew');
  assert.equal((await providerChange({ kind: 'entry', id: 'ghost', patch: { enabled: true } }, deps().d)).ok, false, 'an unknown provider with no address is still refused');
});

test('the trusted and lead-selectable dialogs say what they relax; the lead-choices dialog names the agent and every value', async () => {
  const a = deps();
  await providerChange({ kind: 'entry', id: 'mine', patch: { trusted: true } }, a.d);
  assert.match(a.dialogs[0]!.detail, /no longer start marked as touching outside content/);
  const b = deps();
  await providerChange({ kind: 'entry', id: 'mine', patch: { leadSelectable: true } }, b.d);
  assert.match(b.dialogs[0]!.detail, /Lead agents will be able to run any agent on any model/);
  const c = deps();
  const r = await providerChange({ kind: 'lead', agentId: 'sub', choices: ['mine:m1', 'mine:m2'] }, c.d);
  assert.equal(r.ok, true);
  assert.match(c.dialogs[0]!.message, /Sub Agent/); assert.match(c.dialogs[0]!.detail, /mine:m1\nmine:m2/);
  const put = c.calls.find((x) => x.method === 'PUT')!; assert.equal(put.route, '/api/provider-lead/sub'); assert.equal(put.native, true);
  assert.equal(parseProviderChange({ kind: 'lead', agentId: 'sub', choices: ['sonnet'] }), undefined);
  assert.equal(parseProviderChange({ kind: 'lead', agentId: 'sub', choices: 'x' }), undefined);
});
