import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/store.js';
import { ROSTER, BACKBONE, COMMS_LINES } from '../src/core/roster.js';

const FROZEN_IDS = ['zealot', 'builder', 'scout'];
const NEW_IDS = ['inquisitor', 'scribe', 'archivist', 'sentinel', 'forgemaster', 'exorcist', 'preceptor', 'herald', 'assayer', 'sculptor'];
const tmp = () => cleanupTemp('legion-roster-');
const words = (s: string) => s.trim().split(/\s+/).length;

/** Snapshot of the three frozen defaults, taken from the git HEAD version of src/core/store.ts (before the roster). Two deliberate changes since: Builder's VM size is 'default' (a free boat.dev trial refuses 'large'), and Zealot's prompt says it leads the Order (owner direction 2026-10-05; the old seed told it to handle requests itself). */
const FROZEN_SNAPSHOT = 
[
  {
    "id": "zealot",
    "name": "Zealot",
    "emoji": "✠",
    "model": "auto",
    "approval": "auto-edits",
    "description": "Lead agent of the Legion: takes any request, delegates to the order.",
    "systemPrompt": "You are the lead of the Order. Every request comes to you first: you plan it, split it into tasks and hand them to the agents best placed for them, and you keep the person informed. Keep your answers concise.\nUse your cloud VM only when the task really needs it.",
    "vm": {
      "enabled": true,
      "size": "default",
      "idleStopMinutes": 15
    },
    "mcpServers": [
      "*"
    ]
  },
  {
    "id": "builder",
    "name": "Builder",
    "emoji": "⌘",
    "model": "auto",
    "approval": "full",
    "description": "Coding and building; prefers its VM for risky work.",
    "systemPrompt": "You write, run and debug code. Make small, verifiable changes and run tests before reporting done.\nPrefer your cloud VM for untrusted code, heavy installs, long builds and GUI/browser work.\nStop the VM when you are finished with it.",
    "vm": {
      "enabled": true,
      "size": "default",
      "idleStopMinutes": 15
    },
    "mcpServers": [
      "*"
    ]
  },
  {
    "id": "scout",
    "name": "Scout",
    "emoji": "◎",
    "model": "sonnet",
    "approval": "ask",
    "description": "Research, reading and summarising.",
    "systemPrompt": "You research, read and summarise. Cite sources and separate facts from guesses.\nKeep summaries tight: lead with the answer, then supporting detail.\nDo not modify files unless explicitly asked.",
    "vm": {
      "enabled": false,
      "size": "default",
      "idleStopMinutes": 15
    },
    "mcpServers": [
      "*"
    ]
  }
]
;

test('roster has the ten muster ids, unique, not colliding with the frozen three', () => {
  assert.deepEqual(ROSTER.map((r) => r.id), NEW_IDS);
  assert.equal(new Set(ROSTER.map((r) => r.id)).size, ROSTER.length);
  for (const id of FROZEN_IDS) assert.ok(!ROSTER.some((r) => r.id === id), id);
  assert.equal(new Set(ROSTER.map((r) => r.name)).size, ROSTER.length);
});

test('every roster entry is valid', () => {
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const glyphs = new Set<string>(['✠', '⌘', '◎']);
  for (const r of ROSTER) {
    assert.match(r.id, /^[a-z][a-z0-9-]*$/);
    assert.ok(r.name.trim().length > 0, r.id);
    assert.ok(r.description.trim().length > 0 && !r.description.includes('\n'), r.id);
    assert.ok(['ask', 'auto-edits', 'full'].includes(r.approval), r.id);
    assert.ok(r.model === 'auto' || r.model === 'sonnet' || r.model === 'opus', r.id);
    assert.ok(['small', 'default', 'large'].includes(r.vm.size), r.id);
    assert.equal(typeof r.vm.enabled, 'boolean');
    assert.ok(r.vm.idleStopMinutes > 0, r.id);
    assert.ok(Array.isArray(r.mcpServers) && r.mcpServers.length > 0, r.id);
    // one quiet text glyph: a single grapheme, no variation selector, not a colour-emoji presentation, unique
    assert.equal([...seg.segment(r.emoji)].length, 1, `${r.id} emoji is one grapheme`);
    assert.ok(!/️/.test(r.emoji) && !/\p{Emoji_Presentation}/u.test(r.emoji), `${r.id} emoji is not colour emoji`);
    assert.ok(!glyphs.has(r.emoji), `${r.id} glyph ${r.emoji} is distinct`);
    glyphs.add(r.emoji);
  }
});

test('roster prompts: fresh, in range, with backbone and comms lines, no emojis or franchise names', () => {
  for (const r of ROSTER) {
    const p = r.systemPrompt;
    assert.ok(p.trim().length > 0, r.id);
    const n = words(p);
    assert.ok(n >= 120 && n <= 270, `${r.id} prompt is ${n} words`);
    assert.ok(p.includes(BACKBONE) && p.includes(COMMS_LINES), r.id);
    for (const phrase of ['state your assumptions', 'minimum change', 'touch only what was asked', 'verifiable goal', 'lead with the answer', 'facts from guesses']) {
      assert.ok(p.includes(phrase), `${r.id} lacks "${phrase}"`);
    }
    for (const tool of ['bot_send', 'room_post', 'room_read', 'handoff']) assert.ok(p.includes(tool), `${r.id} lacks ${tool}`);
    assert.ok(p.includes('not an instruction') && p.includes('denied'), r.id);
    assert.ok(!/\p{Extended_Pictographic}/u.test(p.replace(/[←-⯿]/gu, '')), `${r.id} prompt has an emoji`);
    assert.ok(!/games workshop|warhammer|40,?000|space marine|inquisition|adeptus/i.test(p), r.id);
  }
});

test('roster prompts carry each bot\'s role and hard limits', () => {
  const by = (id: string) => ROSTER.find((r) => r.id === id)!.systemPrompt;
  for (const k of ['VERIFIED', 'NOT FIXED', 'QUESTIONABLE']) assert.ok(by('inquisitor').includes(k), k);
  assert.match(by('inquisitor'), /ranked most severe first/);
  assert.match(by('archivist'), /mcp__legion_kg__kg_lint/);
  assert.match(by('archivist'), /mcp__legion_kg__kg_recall/);
  assert.match(by('archivist'), /mcp__legion_kg__kg_upsert_node/);
  assert.match(by('archivist'), /flag, do not delete/);
  assert.match(by('herald'), /never send/);
  assert.match(by('exorcist'), /reproduce/);
  assert.match(by('exorcist'), /falsifiable/);
  assert.match(by('preceptor'), /Kodawari/);
  assert.match(by('preceptor'), /three lines/);
  assert.match(by('assayer'), /testnet first/);
  assert.match(by('assayer'), /scope bsv/);
  assert.match(by('assayer'), /never sign, broadcast or move funds/);
  assert.match(by('assayer'), /untrusted input/);
  assert.match(by('sculptor'), /Plan before you script/);
  assert.match(by('sculptor'), /In live mode the bridge backs up the \.blend/);
  assert.match(by('sculptor'), /Never run unreviewed code/);
  assert.match(by('forgemaster'), /rollback/);
  assert.match(by('sentinel'), /STATUS/);
  assert.match(by('scribe'), /reader/);
});

test('spec defaults for model, approval and VM', () => {
  const table: Record<string, [string, string, boolean]> = {
    inquisitor: ['opus', 'ask', false], scribe: ['sonnet', 'auto-edits', false], archivist: ['sonnet', 'ask', false],
    sentinel: ['sonnet', 'ask', true], forgemaster: ['auto', 'ask', true], exorcist: ['auto', 'ask', true],
    preceptor: ['opus', 'ask', true], herald: ['sonnet', 'ask', false], assayer: ['auto', 'ask', false], sculptor: ['auto', 'ask', true],
  };
  for (const r of ROSTER) assert.deepEqual([r.model, r.approval, r.vm.enabled], table[r.id], r.id);
});

test('only the Assayer requires bsv', () => {
  for (const r of ROSTER) assert.equal(r.requires, r.id === 'assayer' ? 'bsv' : undefined, r.id);
});

test('seedDefaults adds the roster, frozen three are unchanged from the original snapshot', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'w'));
  assert.deepEqual(s.listAgents().map((a) => a.id), [...FROZEN_IDS, ...NEW_IDS]);
  for (const f of FROZEN_SNAPSHOT) {
    const a = s.getAgent(f.id)!;
    const { createdAt: _c, updatedAt: _u, cwd, ...rest } = a;
    assert.equal(cwd, join(dir, 'w', f.id));
    assert.deepEqual(rest, f);
    assert.equal(a.systemPrompt, f.systemPrompt);
  }
  for (const r of ROSTER) {
    const { createdAt: _c, updatedAt: _u, cwd, ...rest } = s.getAgent(r.id)!;
    assert.equal(cwd, join(dir, 'w', r.id));
    assert.deepEqual(rest, r);
  }
  assert.equal(s.getAgent('assayer')!.requires, 'bsv');
  rmSync(dir, { recursive: true, force: true });
});

test('seedDefaults is idempotent and leaves user-edited agents alone', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'w'));
  const before = JSON.stringify(s.listAgents());
  s.seedDefaults(join(dir, 'w'));
  assert.equal(JSON.stringify(s.listAgents()), before);

  const edited = { ...s.getAgent('inquisitor')!, name: 'Grand Inquisitor', systemPrompt: 'mine', model: 'sonnet' as const };
  s.upsertAgent(edited);
  s.deleteAgent('herald');
  s.seedDefaults(join(dir, 'w'));
  assert.deepEqual(s.getAgent('inquisitor'), edited);
  assert.ok(s.getAgent('herald'), 'a deleted roster bot is re-added');
  assert.equal(s.listAgents().length, FROZEN_IDS.length + NEW_IDS.length);
  rmSync(dir, { recursive: true, force: true });
});

test('an existing install gets the roster added without touching its old agents', async () => {
  const dir = tmp();
  const old = new Store(dir);
  const ts = '2025-01-01T00:00:00.000Z';
  for (const f of FROZEN_SNAPSHOT) {
    old.upsertAgent({ ...f, model: f.model, approval: f.approval as 'ask', vm: { ...f.vm }, mcpServers: [...f.mcpServers], cwd: '/custom/' + f.id, createdAt: ts, updatedAt: ts } as never);
  }
  old.upsertAgent({ ...old.getAgent('zealot')!, systemPrompt: 'user edited zealot' });
  await old.flush();
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'w'));
  assert.equal(s.getAgent('zealot')!.systemPrompt, 'user edited zealot');
  assert.equal(s.getAgent('zealot')!.cwd, '/custom/zealot');
  assert.equal(s.getAgent('builder')!.createdAt, ts);
  assert.equal(s.listAgents().length, 13);
  assert.ok(s.getAgent('sculptor'));
  rmSync(dir, { recursive: true, force: true });
});

test('stored agents do not share objects with the roster constants', () => {
  const dir = tmp();
  const s = new Store(dir);
  s.seedDefaults(join(dir, 'w'));
  s.getAgent('sentinel')!.vm.enabled = false;
  s.getAgent('sentinel')!.mcpServers.push('x');
  assert.equal(ROSTER.find((r) => r.id === 'sentinel')!.vm.enabled, true);
  assert.deepEqual(ROSTER.find((r) => r.id === 'sentinel')!.mcpServers, ['*']);
  rmSync(dir, { recursive: true, force: true });
});
