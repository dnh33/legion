/**
 * Restore plumbing for a later spend path (T1): unknown outcomes are rebuilt from the audit log and keep blocking, only a VERIFIED
 * `resolved` line can clear one, and the 24 h window counts a spend once. No wallet, no network: files in a temp dir and the pure engine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { AuditLog } from '../src/core/bsv/audit.js';
import type { AuditEntry } from '../src/core/bsv/audit.js';
import { TESTNET_DEFAULT_CAPS, ledgerFromAudit, PolicyEngine } from '../src/core/bsv/policy.js';
import type { SpendRequest } from '../src/core/bsv/policy.js';
import { buildBsvStatusServer, renderWalletStatus } from '../src/core/bsv/wallet-tool.js';
import { toWalletStatus } from '../src/core/bsv/wallet-probe.js';
import { mkAddr } from './bsv-net-helpers.js';

const ALICE = mkAddr(0x6f, 0x11);
const NOW = Date.parse('2026-10-02T12:00:00.000Z');

function logAt() {
  const d = mkdtempSync(join(tmpdir(), 'legion-restore-'));
  const file = join(d, 'bsv', 'audit.jsonl');
  let t = NOW - 3_600_000;
  return { file, mk: () => new AuditLog(file, { now: () => (t += 1000) }) };
}

/** What a restore does with the two readers: unknown = an `executing` line (lenient reader, may only ADD blocks) with no executed/failed/resolved line for its id
 *  (executed/failed from the lenient reader would also only free a block, so only the verified reader is trusted for ANY line that clears). */
function restoreUnknown(log: AuditLog): Array<{ requestId: string; agentId: string; totalSats: number }> {
  const started = log.entries((e) => e.tool === 'bsv_spend_request' && e.decision === 'executing');
  const cleared = new Set(log.verifiedEntries((e) => e.tool === 'bsv_spend_request' && ['executed', 'failed', 'resolved'].includes(e.decision)).map((e) => String(e.fields.requestId)));
  return started.filter((e) => !cleared.has(String(e.fields.requestId))).map((e) => ({ requestId: String(e.fields.requestId), agentId: e.agent, totalSats: Number(e.fields.totalSats) }));
}
const engineFrom = (unknown: ReturnType<typeof restoreUnknown>) => new PolicyEngine({ clock: { wall: () => NOW, mono: () => 1 }, sessionId: 's2', unknown, config: { caps: { ...TESTNET_DEFAULT_CAPS }, allowlist: [ALICE], frozen: null } });
const req = (id: string): SpendRequest => ({
  requestId: id, network: 'test', walletNetwork: 'test', agentId: 'assayer', taskId: 'task-1', reason: 'x', tainted: false,
  decoded: { inputSats: 4620, outputs: [{ recipient: ALICE, sats: 600 }, { recipient: mkAddr(0x6f, 0x44), sats: 4000, change: true }], feeSats: 20 },
});
const executing = (log: AuditLog, id: string, sats = 620) => log.append({ agent: 'assayer', task: 't1', tool: 'bsv_spend_request', decision: 'executing', fields: { requestId: id, totalSats: sats } });

test('restore: an executing line with no outcome seeds an unknown that keeps its reservation and blocks every spend after a restart', () => {
  const { mk } = logAt();
  executing(mk(), 'req-restore-01');
  const log2 = mk(); log2.open(); // a new process on the same directory
  const unknown = restoreUnknown(log2);
  assert.deepEqual(unknown, [{ requestId: 'req-restore-01', agentId: 'assayer', totalSats: 620 }]);
  const e = engineFrom(unknown);
  assert.equal(e.snapshot().usage.reservedSats, 620);
  const d = e.evaluate(req('req-restore-02'));
  assert.equal(d.verdict, 'deny');
  assert.match(d.reasons.join(' '), /unknown outcome/);
});

test('restore: a genuine resolved line in an intact chain clears the unknown, and spends work again', () => {
  const { mk } = logAt();
  const log = mk();
  executing(log, 'req-restore-03');
  log.append({ agent: 'owner', tool: 'bsv_spend_request', decision: 'resolved', fields: { requestId: 'req-restore-03', outcome: 'not-sent' } });
  const log2 = mk(); log2.open();
  assert.deepEqual(restoreUnknown(log2), []);
  assert.equal(engineFrom(restoreUnknown(log2)).evaluate(req('req-restore-04')).verdict, 'needs_approval');
});

test('restore: a forged resolved line in a broken-chain file does NOT clear the unknown (the lenient reader may only add blocks)', () => {
  const { file, mk } = logAt();
  executing(mk(), 'req-restore-05');
  const forged = { v: 1, seq: 1, ts: new Date(NOW).toISOString(), prev: 'a'.repeat(64), agent: 'owner', task: null, tool: 'bsv_spend_request', decision: 'resolved', reason: null, fields: { requestId: 'req-restore-05', outcome: 'not-sent' }, hash: 'b'.repeat(64) };
  appendFileSync(file, JSON.stringify(forged) + '\n');
  const log2 = mk();
  assert.equal(log2.open().ok, false, 'the break is detected');
  assert.equal(log2.entries((e) => e.decision === 'resolved').length, 1, 'the forged line is readable');
  const unknown = restoreUnknown(log2);
  assert.deepEqual(unknown.map((u) => u.requestId), ['req-restore-05'], 'still unknown');
  assert.equal(engineFrom(unknown).evaluate(req('req-restore-06')).verdict, 'deny', 'and still blocking');
});

test('restore: duplicate executed lines for one request count once in the 24 h window', () => {
  const { mk } = logAt();
  const log = mk();
  for (let i = 0; i < 3; i++) log.append({ agent: 'legion', tool: 'spend-policy', decision: 'executed', fields: { requestId: 'req-restore-07', sats: 600 } });
  log.append({ agent: 'legion', tool: 'spend-policy', decision: 'executed', fields: { requestId: 'req-restore-08', sats: 400 } });
  const rec = ledgerFromAudit(log.entries((e: AuditEntry) => e.decision === 'executed'));
  assert.equal(rec.reduce((a, r) => a + r.sats, 0), 1000);
  const e = new PolicyEngine({ clock: { wall: () => NOW, mono: () => 1 }, ledger: rec, config: { caps: { ...TESTNET_DEFAULT_CAPS }, allowlist: [ALICE], frozen: null } });
  assert.equal(e.snapshot().usage.last24hSats, 1000);
});

// ---------------------------------------------------------------- the status server takes extra tools, and its wording is scoped

async function client(server: ReturnType<typeof buildBsvStatusServer>) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' });
  await Promise.all([server.instance.connect(b), c.connect(a)]);
  return c;
}

test('buildBsvStatusServer: extraTools join the same server; without them there is exactly the one status tool; wording is scoped', async () => {
  const extra = tool('extra_plain_tool', 'A harmless test tool.', {}, async () => ({ content: [{ type: 'text' as const, text: 'extra-ok' }] }));
  const deps = { agent: { id: 'assayer', requires: 'bsv' }, state: { enabled: true }, policy: { isFrozen: false }, probe: { check: async () => toWalletStatus(null, '', 'off', false) }, audit: { append: () => undefined }, calls: new Map<string, number>() } as never;
  const plain = await client(buildBsvStatusServer(deps));
  assert.deepEqual((await plain.listTools()).tools.map((t) => t.name), ['bsv_status']);
  const withExtra = await client(buildBsvStatusServer({ ...(deps as object), extraTools: [extra] } as never));
  const listed = await withExtra.listTools();
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), ['bsv_status', 'extra_plain_tool']);
  const r: any = await withExtra.callTool({ name: 'extra_plain_tool', arguments: {} });
  assert.equal(r.content[0].text, 'extra-ok');
  const desc = listed.tools.find((t) => t.name === 'bsv_status')!.description ?? '';
  assert.match(desc, /Legion's own status tool cannot/);
  assert.doesNotMatch(desc, /nothing in Legion can/);
  const line = renderWalletStatus(toWalletStatus(null, '', 'off', false));
  assert.match(line, /Legion's own status tool is read-only/);
  assert.doesNotMatch(line, /^Legion has no tool/m);
  assert.ok(createSdkMcpServer);
});
