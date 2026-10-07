/**
 * Soul Codex v1 (plan claude/plan-fascia.md 6.2): Zealot, Builder and Scout get the shared soul shape.
 * The maintainer retired "persona text stays byte-identical" on 2026-10-07, on one condition: every soul stays true to
 * its bot's core and its role in Legion. These tests pin that condition (the core lines survive), the shape (each soul
 * says when it is done, whom it hands work to, its hard limits, its output contract and one worked example), and the
 * upgrade (a stored soul changes only while it is still the old seed; the owner's own text is never touched).
 * They check shape and contract, not exact wording: a reworded soul still passes, a soul that drops a part fails.
 */
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Store, SOUL_SEEDS_V0 } from '../src/core/store.js';

const SOULS = ['zealot', 'builder', 'scout'] as const;

function seeded(): Store {
  const d = cleanupTemp('soul-codex-');
  const s = new Store(d);
  s.seedDefaults(join(d, 'ws'));
  return s;
}
const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

test('soul codex: each of the three souls keeps its core (the maintainer\'s condition)', () => {
  const s = seeded();
  const t = (id: string) => s.getAgent(id)!.systemPrompt;
  // Zealot: the lead of the Order, every request first, plans and delegates, keeps the person informed, concise, VM only when needed
  for (const re of [/lead of the Order/, /Every request comes to you first/, /hand them to the agents best placed/, /keep the person informed/, /concise/, /cloud VM only when the task really needs it/]) assert.match(t('zealot'), re);
  // Builder: writes, runs and debugs code; small verifiable changes; runs tests before done; VM for risky work; stops the VM
  for (const re of [/write, run and debug code/, /small, verifiable changes/, /Run the tests/, /cloud VM for untrusted code, heavy installs, long builds and GUI or browser work/, /stop it when you are finished/]) assert.match(t('builder'), re);
  // Scout: researches, reads and summarises; cites sources; facts vs guesses; answer first; no file changes unless asked
  for (const re of [/research, read and summarise/, /source/i, /Separate facts from guesses/, /lead with the answer/, /Do not modify files unless explicitly asked/]) assert.match(t('scout'), re);
});

test('soul codex: every soul has the shape: done condition, hand-offs, hard limits, output contract, one example', () => {
  const s = seeded();
  for (const id of SOULS) {
    const p = s.getAgent(id)!.systemPrompt;
    assert.match(p, /^Done when: /m, `${id}: says when it is done`);
    assert.match(p, /^(Hand off|Who does what): /m, `${id}: names whom it hands work to`);
    assert.match(p, /^Hard limits: /m, `${id}: states its hard limits`);
    assert.match(p, /^Output shape: the first line is /m, `${id}: states its output contract`);
    assert.match(p, /^Example: /m, `${id}: shows one worked example`);
  }
});

test('soul codex: each example answers in the soul\'s own output contract', () => {
  const s = seeded();
  for (const id of SOULS) {
    const p = s.getAgent(id)!.systemPrompt;
    const contract = /^Output shape: the first line is ([^.]+?)(?:\.| \(|,? then)/m.exec(p)?.[1] ?? '';
    const verdicts = contract.split(/,| or /).map((v) => v.trim()).filter(Boolean);
    assert.ok(verdicts.length >= 2, `${id}: the contract names its first-line verdicts (got "${contract}")`);
    const reply = /you reply:\n([^\n]+)/.exec(p)?.[1] ?? '';
    assert.ok(verdicts.some((v) => reply.startsWith(v)), `${id}: the example's first line "${reply}" is one of ${verdicts.join(' / ')}`);
  }
});

test('soul codex: hand-offs name only agents that exist in the Order, and no soul stores a tool name', () => {
  const s = seeded();
  const names = new Set(s.listAgents().map((a) => a.name));
  for (const id of SOULS) {
    const p = s.getAgent(id)!.systemPrompt;
    const block = /^(?:Hand off|Who does what): (.+)$/m.exec(p)?.[1] ?? '';
    // every agent is named as "the <Name>": each one must be a bot in the Order (a made-up or renamed bot fails)
    const named = [...block.matchAll(/\bthe ([A-Z][a-z]+)\b/g)].map((m) => m[1]!);
    assert.ok(named.length > 0, `${id}: hand-offs name at least one agent`);
    for (const n of named) assert.ok(names.has(n), `${id}: hands work to ${n}, which is not in the Order`);
    assert.doesNotMatch(p, /mcp__/, `${id}: tool names are capability facts, generated per run, never stored in a soul`);
    assert.doesNotMatch(p, /\bAssayer\b/, `${id}: the Assayer exists only in BSV mode, so a soul never routes to it`);
  }
});

test('soul codex: souls stay lean (the bloat rule: a system prompt is paid for on every run)', () => {
  const s = seeded();
  for (const id of SOULS) {
    const n = words(s.getAgent(id)!.systemPrompt);
    assert.ok(n <= 300, `${id}: ${n} words; keep a soul at 300 or less (the roster bots run 230 to 270)`);
  }
});

test('soul codex: an install still on the old seeds is upgraded once; the owner\'s own text is never touched', async () => {
  const dir = cleanupTemp('soul-codex-mig-');
  const fresh = seeded();
  const agents = fresh.listAgents().map((a) => {
    if (a.id === 'builder') return { ...a, systemPrompt: SOUL_SEEDS_V0.builder };
    if (a.id === 'scout') return { ...a, systemPrompt: 'My own Scout. My words.' };
    if (a.id === 'zealot') return { ...a, systemPrompt: SOUL_SEEDS_V0.zealot };
    return a;
  });
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ agents, tasks: [], vms: [], migrations: ['builder-vm-size-default-v1', 'zealot-lead-prompt-v1'] }));
  const s = new Store(dir);
  assert.equal(s.getAgent('builder')!.systemPrompt, fresh.getAgent('builder')!.systemPrompt, 'an old Builder seed gets the new soul');
  assert.equal(s.getAgent('zealot')!.systemPrompt, fresh.getAgent('zealot')!.systemPrompt, 'an old Zealot seed gets the new soul');
  assert.equal(s.getAgent('scout')!.systemPrompt, 'My own Scout. My words.', 'a soul the owner wrote is never touched');
  await s.flush();
  const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { migrations: string[] };
  assert.ok(onDisk.migrations.includes('souls-codex-v1'));
  // it never runs again: the owner puts the old text back on purpose, and it stays
  const s2 = new Store(dir);
  s2.upsertAgent({ ...s2.getAgent('builder')!, systemPrompt: SOUL_SEEDS_V0.builder });
  await s2.flush();
  assert.equal(new Store(dir).getAgent('builder')!.systemPrompt, SOUL_SEEDS_V0.builder, 'a later manual choice survives');
});
