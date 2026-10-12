import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core/engine.js';
import { ApprovalBroker } from '../src/core/approvals.js';
import { EventBus } from '../src/core/bus.js';

// A minimal Engine: enough to drive buildMcpServers, which is where the agent shell is gated on host.enabled.
function rig() {
  const bus = new EventBus();
  const store = {} as never;
  const config = { workspaceDir: '/tmp/legion-ws', mcpServers: {} } as never;
  const engine = new Engine({
    store, bus,
    vms: { touch() {}, ensureRunning: async () => ({}) } as never,
    approvals: new ApprovalBroker(bus),
    config,
    queryFn: (async () => []) as never,
    boatConfigured: () => false,
  });
  return engine;
}

const baseAgent: Record<string, unknown> = {
  id: 'dev', name: 'Dev', emoji: '⚒', description: 'builds', systemPrompt: '',
  model: 'sonnet', approval: 'ask', mcpServers: [], vm: { enabled: false, size: 'default', idleStopMinutes: 15 },
};

function build(engine: Engine, agent: Record<string, unknown>): Record<string, unknown> {
  return (engine as never as { buildMcpServers: (a: unknown, j: unknown, act: unknown, r: string) => Record<string, unknown> })
    .buildMcpServers(agent, { taskId: 't1' }, { tainted: false }, 'claude');
}

test('host.enabled=true registers the host tools server', () => {
  const out = build(rig(), { ...baseAgent, host: { enabled: true } });
  assert.ok(out.host, 'the host server is registered for an opted-in agent');
});

test('an absent host registers no host tools (opt-in gate)', () => {
  const out = build(rig(), { ...baseAgent });
  assert.equal(out.host, undefined, 'no host server when host is absent');
});

test('host.enabled=false registers no host tools', () => {
  const out = build(rig(), { ...baseAgent, host: { enabled: false } });
  assert.equal(out.host, undefined, 'no host server when host is explicitly off');
});

test('the legion server is still registered either way', () => {
  assert.ok(build(rig(), { ...baseAgent, host: { enabled: true } }).legion);
  assert.ok(build(rig(), { ...baseAgent }).legion);
});
