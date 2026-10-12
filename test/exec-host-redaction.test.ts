/**
 * Secret redaction on the agent shell (Workstream B, W4): what a host tool returns to the model — shell output,
 * read_file text, the spilled full output and error text — never carries a secret Legion holds. The secrets are the
 * live config values (Legion's own token, the Claude and boat keys, MCP headers/env) and the provider keys, plus
 * the common credential shapes scrubSecrets already knows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// built at run time so no test file holds a credential-shaped literal
const AUTH = ['legion', 'auth', 'value', '42xy'].join('-');
const CLAUDE_KEY = ['claude', 'key', 'value', '77zz'].join('_');
const PROVIDER_KEY = ['prov', 'key', 'value', '99qq'].join('.');

function hostServer(rootDir: string) {
  const bus = new EventBus();
  const config = { workspaceDir: rootDir, mcpServers: {}, authToken: AUTH, claude: { apiKey: CLAUDE_KEY } } as never;
  const providers = { secretValues: () => [PROVIDER_KEY] } as never;
  const engine = new Engine({
    store: {} as never, bus, vms: { touch() {}, ensureRunning: async () => ({}) } as never,
    approvals: new ApprovalBroker(bus), config, queryFn: (async () => []) as never, boatConfigured: () => false, providers,
  });
  const agent = {
    id: 'dev', name: 'Dev', emoji: 'D', description: '', systemPrompt: '', model: 'sonnet',
    approval: 'ask', mcpServers: [], vm: { enabled: false, size: 'default', idleStopMinutes: 15 },
    host: { enabled: true, rootDir },
  } as never;
  const out = (engine as never as { buildMcpServers: (a: unknown, j: unknown, act: unknown, r: string) => Record<string, any> })
    .buildMcpServers(agent, { taskId: 'redact' }, { tainted: false }, 'claude');
  return out.host;
}

async function call(srv: any, name: string, args: Record<string, unknown>) {
  const out = await srv.instance._registeredTools[name].handler(args, {});
  return { text: out.content.map((c: any) => c.text).join('\n'), isError: out.isError === true };
}

const noSecret = (text: string) => {
  for (const s of [AUTH, CLAUDE_KEY, PROVIDER_KEY]) assert.ok(!text.includes(s), `a secret reached the model: ${s}`);
};

test('shell output never carries a secret Legion holds: config values and provider keys are redacted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-redact-'));
  const srv = hostServer(root);
  const r = await call(srv, 'shell', { command: `echo ${AUTH} ${CLAUDE_KEY} ${PROVIDER_KEY} plain-words` });
  noSecret(r.text);
  assert.match(r.text, /\[redacted-secret\]/);
  assert.match(r.text, /plain-words/, 'ordinary output is kept');
});

test('read_file text is redacted too: a config file read with the tool shows no key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-redact-'));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ authToken: AUTH, claude: { apiKey: CLAUDE_KEY }, provider: PROVIDER_KEY, name: 'kept' }));
  const r = await call(hostServer(root), 'read_file', { path: 'config.json' });
  noSecret(r.text);
  assert.match(r.text, /kept/);
});

test('long output: the window AND the spilled full file are redacted, so read_file of the spill cannot bring a key back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-redact-'));
  const srv = hostServer(root);
  writeFileSync(join(root, 'big.txt'), `${AUTH}\n${'x'.repeat(60_000)}\n${CLAUDE_KEY}\n`);
  const r = await call(srv, 'read_file', { path: 'big.txt' });
  noSecret(r.text);
  const spillDir = join(root, '.legion-output');
  const files = readdirSync(spillDir);
  assert.equal(files.length, 1);
  const full = readFileSync(join(spillDir, files[0]!), 'utf8');
  noSecret(full);
  assert.ok(full.includes('x'.repeat(60_000)), 'everything else in the spill is kept');
});

test('error text is redacted: a failing call whose message names a secret does not leak it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-redact-'));
  const r = await call(hostServer(root), 'read_file', { path: `missing-${AUTH}.txt` });
  assert.equal(r.isError, true);
  noSecret(r.text);
});

test('ordinary project text round-trips unchanged: a token-shaped fixture and a sha256 are not rewritten, so read then write cannot corrupt a file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'legion-redact-'));
  const fixture = [
    `const token = '${['abc', 'def', '123', '456'].join('')}';`,
    `const key = '${'s' + 'k-'}${'test'.repeat(5)}';`,
    `password: ${'hunter2'.repeat(2)}`,
    `${'a1b2c3d4'.repeat(8)}  dist.zip`,
  ].join('\n');
  writeFileSync(join(root, 'fixture.ts'), fixture);
  const srv = hostServer(root);
  const r = await call(srv, 'read_file', { path: 'fixture.ts' });
  assert.equal(r.text, fixture, 'the file comes back byte for byte');
  const s = await call(srv, 'shell', { command: 'echo a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4' });
  assert.match(s.text, /a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4/, 'a checksum in output is kept');
});
