// test/claude-own-checks-fix.test.ts: fix round A+B for "Claude agents follow Claude's own permission checks" (0.3.6). Each test names the review finding
// it closes (F1..F9). The first file, claude-own-checks.test.ts, holds the rows of the feature itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { gatesRig } from './gates-rig.js';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import { ProjectStore } from '../src/core/projects/store.js';
import type { GatesRig } from './gates-rig.js';
import type { GateRule } from '../src/shared/types.js';
import { dataFolderTargets } from '../src/core/exec/canonical-path.js';

const using = async (o: Parameters<typeof gatesRig>[0], body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig(o);
  try { await body(r); } finally { r.stop(); }
};
const rule = (id: string, then: GateRule['then'], when: GateRule['when']): GateRule => ({ id, enabled: true, then, when, label: id, source: 'user' });
const lines = (r: GatesRig) => r.activityRead({ taskId: r.task.id }).map((l) => l.text);

// ------------------------------------------------------------------ F1: Legion's own web tools keep the new-site check

test('F1: Legion\'s own web tools card a new site for a Claude agent in every preset and in a ceiling run; Claude\'s own WebFetch is Claude\'s', async () => {
  const sets: Array<Parameters<typeof gatesRig>[0]> = [{ own: 'ask' }, { own: 'auto-edits' }, { app: 'smart', follow: true }, { own: 'ask', ceiling: 'ask', originAtStart: true }];
  for (const s of sets) {
    await using({ ...s, ownChecks: true }, async (r) => {
      const own = await r.hookAll('mcp__legion__web_read', { url: 'https://example.org/a' });
      assert.equal(own.cards, 1, `${JSON.stringify(s)} web_read`);
      const search = await r.hookAll('mcp__legion__web_search', { query: 'something new' });
      assert.ok(search.cards <= 1);
    });
  }
  await using({ own: 'ask', ownChecks: true }, async (r) => {
    const claude = await r.hookAll('WebFetch', { url: 'https://example.org/a' });
    assert.deepEqual([claude.cards, claude.decision], [0, undefined], 'Claude\'s own WebFetch is Claude\'s to judge');
  });
});

test('F1: Claude\'s own web tools leave a "Web: host" line in the activity log, and no card', async () => {
  await using({ own: 'ask', ownChecks: true }, async (r) => {
    const h = await r.hookAll('WebFetch', { url: 'https://example.org/a?x=1' });
    assert.equal(h.cards, 0);
    const web = lines(r).filter((t) => /^Web: /.test(t));
    assert.deepEqual(web, ['Web: WebFetch example.org']);
    assert.ok(!web.some((t) => /x=1|\/a/.test(t)), 'host only, never the address');
  });
});

// ------------------------------------------------------------------ F2 + F7: a Full run demoted mid-run

const DEMOTED_CALLS: Array<[string, string, Record<string, unknown>]> = [
  ['credentials file', 'Read', { file_path: `${homedir().replace(/\\/g, '/')}/.aws/credentials` }],
  ['new site (Claude\'s tool)', 'WebFetch', { url: 'https://example.org/a' }],
  ['new site (Legion\'s tool)', 'mcp__legion__web_read', { url: 'https://example.org/a' }],
];
test('F2: a Full run demoted to Ask or Smart decides credential reads and new sites by a card, as the switch off does', async () => {
  for (const to of ['ask', 'smart'] as const) {
    for (const [name, tool, input] of DEMOTED_CALLS) {
      const counts: number[] = [];
      for (const ownChecks of [false, true]) {
        await using({ preset: 'bypass', follow: true, ownChecks }, async (r) => {
          assert.equal(r.options().permissionMode, 'bypassPermissions');
          r.core.store.patchProject(r.project.id, { preset: to });
          const h = await r.hookAll(tool, input);
          counts.push(h.cards);
          assert.equal(h.decision, 'deny', `${to} ${name}: answered no`);
        });
      }
      assert.deepEqual(counts, [1, 1], `${to} ${name}: one card with the switch off and on`);
    }
  }
});

test('F2: a demoted Full run after connector data raises one web card, not two', async () => {
  for (const ownChecks of [false, true]) {
    await using({ preset: 'bypass', follow: true, ownChecks }, async (r) => {
      r.core.store.patchProject(r.project.id, { preset: 'ask' });
      r.store.tasks.get(r.task.id)!.usedConnectors = true;
      (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
      const h = await r.hookAll('WebFetch', { url: 'https://example.org/a' }, { allow: true });
      assert.ok(h.cards >= 1 && h.cards <= 2, `ownChecks=${ownChecks}: ${h.cards}`);
      if (ownChecks) {
        const old = await using2({ preset: 'bypass', follow: true, ownChecks: false });
        assert.equal(h.cards, old, 'the same number of cards as the old path');
      }
    });
  }
});
async function using2(o: Parameters<typeof gatesRig>[0]): Promise<number> {
  const r = await gatesRig(o);
  try {
    r.core.store.patchProject(r.project.id, { preset: 'ask' });
    r.store.tasks.get(r.task.id)!.usedConnectors = true;
    (r.engine as unknown as { active: Map<string, { tainted: boolean }> }).active.get(r.task.id)!.tainted = true;
    return (await r.hookAll('WebFetch', { url: 'https://example.org/a' }, { allow: true })).cards;
  } finally { r.stop(); }
}

test('F7: a Full run demoted to Accept edits asks as Accept edits would: an in-folder edit runs, a command asks, a read is free', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    r.core.store.patchProject(r.project.id, { preset: 'accept-edits' });
    const w = await r.hookAll('Write', { file_path: `${r.projectDir()}/a.txt`, content: 'x' });
    assert.deepEqual([w.cards, w.decision], [0, undefined], 'Accept edits runs the edit');
    const b = await r.hookAll('Bash', { command: 'echo hi' });
    assert.equal(b.cards, 1, 'a command asks');
    assert.equal((await r.hookAll('Read', { file_path: `${r.projectDir()}/a.txt` })).cards, 0);
  });
});

// ------------------------------------------------------------------ F3: an app file that cannot be trusted reads as OFF

async function fileState(prep: (file: string) => void, restart = false): Promise<{ first: boolean; again: boolean; stored: boolean | undefined }> {
  const r = await gatesRig({ ownChecks: true });
  try {
    r.core.store.patchApp({ claudeOwnChecks: false });
    await r.core.store.flush();
    const file = join(r.core.store.folder, 'app.json');
    prep(file);
    if (!restart) r.core.store.reload();
    const engine = r.engine as unknown as { claudeOwnChecks(): boolean; gates?: unknown };
    // a restart with the key the first run made: the key is no longer new, so a missing or unsigned app file is a lost one
    if (restart) {
      const dir = dirname(r.core.store.folder);
      engine.gates = createGatesCore({ dataDir: dir, projects: new ProjectStore(dir, join(dir, 'ws')), keyring: { get: () => Buffer.alloc(32, 7), state: () => 'old' } as never });
    }
    const first = engine.claudeOwnChecks();
    // the store may write its own record back; a restart must still read OFF
    const live = (restart ? (engine.gates as typeof r.core).store : r.core.store);
    await live.flush();
    await new Promise((res) => setTimeout(res, 700));
    await live.flush();
    (restart ? (engine.gates as typeof r.core).store : r.core.store).reload();
    return { first, again: engine.claudeOwnChecks(), stored: r.core.store.app().claudeOwnChecks };
  } finally { r.stop(); }
}
const edit = (f: (j: Record<string, unknown>) => void) => (file: string) => { const j = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; f(j); writeFileSync(file, JSON.stringify(j)); };
const FILE_STATES: Array<[string, (file: string) => void, boolean?]> = [
  ['garbage', (f) => writeFileSync(f, '{not json')],
  ['empty', (f) => writeFileSync(f, '')],
  ['deleted', (f) => rmSync(f), true],
  ['edited outside, signature kept', edit((j) => { delete j.claudeOwnChecks; })],
  ['invalid value', edit((j) => { j.claudeOwnChecks = true; })],
  ['unsigned blank', (f) => writeFileSync(f, JSON.stringify({ version: 1 })), true],
  ['wrong version', (f) => writeFileSync(f, JSON.stringify({ version: 2 }))],
];
for (const [name, prep, restart] of FILE_STATES) {
  test(`F3: an app settings file that is ${name} reads as OFF now and after the store writes it back`, async () => {
    const s = await fileState(prep, restart === true);
    assert.equal(s.first, false, 'right away');
    assert.equal(s.again, false, 'after the store\'s own write and a reload');
  });
}
test('F3: a signing key that cannot be opened reads as OFF', async () => {
  await using({ ownChecks: true }, async (r) => {
    const engine = r.engine as unknown as { claudeOwnChecks(): boolean };
    assert.equal(engine.claudeOwnChecks(), true);
    const store = r.core.store as unknown as { view: (ids: string[]) => Record<string, unknown> };
    const real = store.view.bind(store);
    store.view = (ids) => ({ ...real(ids), keyUnreadable: true });
    assert.equal(engine.claudeOwnChecks(), false);
  });
});

// ------------------------------------------------------------------ F6: a run woken by an outside app or another bot keeps Legion's full guards

test('F6: a ceiling run cards a secret-file read and a new site for a Claude agent, as the switch off does', async () => {
  for (const ownChecks of [false, true]) {
    await using({ own: 'ask', ceiling: 'ask', originAtStart: true, ownChecks }, async (r) => {
      const env = await r.hookAll('Read', { file_path: `${r.projectDir()}/.env` });
      assert.equal(env.cards, 1, `ownChecks=${ownChecks} .env`);
      const aws = await r.hookAll('Read', { file_path: `${homedir().replace(/\\/g, '/')}/.aws/credentials` });
      assert.equal(aws.cards, 1, `ownChecks=${ownChecks} credentials`);
      const web = await r.hookAll('WebFetch', { url: 'https://example.org/a' });
      assert.equal(web.cards, 1, `ownChecks=${ownChecks} new site`);
    });
  }
});

// ------------------------------------------------------------------ F4: the owner's "Ask before tools run" switch

test('F4: with "Ask before tools run" off, Claude\'s prompt for a Claude tool is answered without a card and logged; the brake, an outside ceiling and a Block rule still hold', async () => {
  await using({ own: 'auto-edits', ownChecks: true }, async (r) => {
    r.setGateOverride('tool-cards', false);
    const c = await r.canUse('Bash', { command: 'git commit -m x' }, 'f4a');
    assert.deepEqual([c.cards, c.behavior], [0, 'allow']);
    assert.ok(lines(r).some((t) => /Ask before tools run/i.test(t) || /would have asked/i.test(t)), lines(r).join(' | '));
    const brake = await r.canUse('Bash', { command: 'cat x' }, 'f4b', false, { decisionReason: '3 consecutive actions were blocked. Please review the transcript before continuing.' });
    assert.deepEqual([brake.cards, brake.behavior], [1, 'deny'], 'the denial brake still reaches the owner');
    r.setRules([rule('gr_block', 'deny', { tools: ['Bash'], commands: ['rm *'] })]);
    assert.deepEqual([(await r.hookAll('Bash', { command: 'rm foo' })).cards, (await r.hookAll('Bash', { command: 'rm foo' })).decision], [0, 'deny']);
  });
  await using({ own: 'ask', ceiling: 'ask', originAtStart: true, ownChecks: true }, async (r) => {
    r.setGateOverride('tool-cards', false);
    const c = await r.canUse('Bash', { command: 'git commit -m x' }, 'f4c');
    assert.equal(c.cards, 1, 'a run an outside app woke keeps its cards');
  });
  await using({ own: 'auto-edits', ownChecks: true }, async (r) => {
    const c = await r.canUse('Bash', { command: 'git commit -m x' }, 'f4d');
    assert.equal(c.cards, 1, 'switch on: Claude\'s prompt is a card');
  });
});

// ------------------------------------------------------------------ F5: the data-folder card only for a path that resolves into Legion's folder

const DATA = join(homedir(), '.legion-ownchecks');
const fwd = DATA.replace(/\\/g, '/');
const dataModule = { id: 'dataguard', protectedPaths: () => dataFolderTargets(DATA) } as never;
test('F5: everyday commands with $VARIABLES raise no data-folder card for a Claude agent; a path that resolves into Legion\'s folder still does', async () => {
  const everyday = ['rm -rf "$TMPDIR/build"', 'mkdir -p "$OUT/dist"', 'cp a.txt $DEST/', 'cd $PROJECT && make', 'git checkout -b feature/$NAME', 'python $SCRIPT --out $OUT'];
  await using({ own: 'auto-edits', ownChecks: true }, async (r) => {
    r.engine.setModules([dataModule]);
    for (const command of everyday) assert.equal((await r.hookAll('Bash', { command })).cards, 0, command);
    assert.equal((await r.hookAll('Bash', { command: `rm -rf ${fwd}/gates` })).cards, 1, 'names Legion\'s folder');
  });
  await using({ own: 'auto-edits', ownChecks: false }, async (r) => {
    r.engine.setModules([dataModule]);
    assert.ok((await r.hookAll('Bash', { command: 'rm -rf "$TMPDIR/build"' })).cards >= 1, 'the old path keeps asking');
  });
});

// ------------------------------------------------------------------ F8: the floor fails closed for a Claude agent

test('F8: a floor that throws refuses the command for a Claude agent; a command nested too deep to read is refused', async () => {
  await using({ own: 'ask', ownChecks: true }, async (r) => {
    (r.engine as unknown as { dataFolderCard: () => never }).dataFolderCard = () => { throw new Error('boom'); };
    const h = await r.hookAll('Bash', { command: 'echo hi' });
    assert.deepEqual([h.cards, h.decision], [0, 'deny']);
  });
  await using({ own: 'ask', ownChecks: true }, async (r) => {
    const deep = `${'$('.repeat(300)}rm -rf /${')'.repeat(300)}`;
    const h = await r.hookAll('Bash', { command: deep });
    assert.deepEqual([h.cards, h.decision], [0, 'deny']);
  });
});

// ------------------------------------------------------------------ Rulings: Full for a Claude agent

test('Full for a Claude agent: only the catastrophic floor and the card for Legion\'s own settings; an unjudgeable command is not refused', async () => {
  await using({ preset: 'bypass', follow: true, ownChecks: true }, async (r) => {
    r.engine.setModules([dataModule]);
    const x = await r.hookAll('Bash', { command: 'x=ls; $x' });
    assert.deepEqual([x.cards, x.decision], [0, undefined], 'not refused as unjudgeable');
    assert.equal((await r.hookAll('Bash', { command: 'rm -rf /' })).decision, 'deny');
    assert.deepEqual([(await r.hookAll('Bash', { command: `rm -rf ${fwd}/gates` })).cards], [1]);
  });
  await using({ preset: 'bypass', follow: true, ownChecks: false }, async (r) => {
    assert.equal((await r.hookAll('Bash', { command: 'x=ls; $x' })).decision, 'deny', 'the old path refuses it');
  });
});

// ------------------------------------------------------------------ F9: no "Claude denied" line after the owner's own No

test('F9: Claude\'s "permission denied" for a call the owner said No to is not logged a second time; another one is', async () => {
  await using({ own: 'ask', ownChecks: true }, async (r) => {
    const no = await r.canUse('Bash', { command: 'git commit -m x' }, 'f9a', false);
    assert.equal(no.behavior, 'deny');
    r.stream({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'f9a', decision_reason_type: 'other', decision_reason: 'denied by the prompt', message: 'x' });
    assert.equal(lines(r).filter((t) => /Claude denied/.test(t)).length, 0);
    r.stream({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'f9b', decision_reason_type: 'rule', decision_reason: 'Bash(rm:*) is denied by your settings', message: 'x' });
    assert.equal(lines(r).filter((t) => /Claude denied/.test(t)).length, 1);
  });
});
