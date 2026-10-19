// test/engine-guards.test.ts: Smart asks for build and test commands once an agent changed a build or script file in the project (Task 27).
// The flag is per project, survives a restart, and clears only when the owner allows one such card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { tempDir } from './tmp-cleanup.js';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import type { GateRule } from '../src/shared/types.js';

const using = async (body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig({ preset: 'smart', follow: true });
  try { await body(r); } finally { r.stop(); }
};
const WHY = /a build or script file here changed since you last allowed one/;
/** The call is decided; a card (if any) is answered. Returns whether one was raised. */
const decide = async (r: GatesRig, command: string, allowed: boolean) => {
  const p = r.call('Bash', { command }); await r.tick();
  const card = r.pending()[0];
  if (card) r.answer(allowed);
  return { card, d: await p };
};

test('Smart: npm test runs, then after a Write to package.json it cards; the card says why', async () => {
  await using(async (r) => {
    assert.equal((await r.call('Bash', { command: 'npm test' })).allow, true); assert.equal(r.pending().length, 0);
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    const p = r.call('Bash', { command: 'npm test' }); await r.tick();
    assert.equal(r.pending().length, 1); assert.match(r.pending()[0]!.summary, WHY); assert.match(r.pending()[0]!.summary, /npm test/);
    assert.equal(r.pending()[0]!.noRemember, true);
    r.answer(true); assert.equal((await p).allow, true);
  });
});

test('Smart: a shell command that rewrites a script file sets the flag; editing src/a.ts does not', async () => {
  await using(async (r) => {
    r.noteUse('Write', { file_path: `${r.projectDir()}/src/a.ts`, content: 'x' });
    assert.equal((await r.call('Bash', { command: 'npm run build' })).allow, true); assert.equal(r.pending().length, 0);
    r.noteUse('Bash', { command: 'sed -i s/a/b/ scripts/build.sh' });
    const { card, d } = await decide(r, 'npm run build', false);
    assert.ok(card, 'the next build cards'); assert.equal(d.allow, false);
  });
});

test('a read-only look at a build file does not set the flag', async () => {
  await using(async (r) => {
    r.noteUse('Bash', { command: 'cat package.json' });
    r.noteUse('Read', { file_path: `${r.projectDir()}/package.json` });
    assert.equal((await decide(r, 'npm test', false)).card, undefined);
  });
});

test('a fresh run in the same project still cards npm test after a Makefile write in an earlier run', async () => {
  await using(async (r) => {
    r.noteUse('Write', { file_path: `${r.projectDir()}/Makefile`, content: 'x' });
    const run2 = await r.freshRun();
    try {
      const p = run2.call('Bash', { command: 'npm test' }); await r.tick();
      assert.equal(r.pending().length, 1); assert.match(r.pending()[0]!.summary, WHY); r.answer(false); await p;
    } finally { run2.stop(); }
  });
});

test('allowing one build-flag card clears the flag: the next npm test in that project runs with no card', async () => {
  await using(async (r) => {
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    assert.equal((await decide(r, 'npm test', true)).d.allow, true);
    assert.equal(r.core.buildEdited.has(r.project.id), false);
    const next = await r.call('Bash', { command: 'npm test' }); assert.equal(next.allow, true); assert.equal(r.pending().length, 0);
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{"a":1}' });
    assert.ok((await decide(r, 'npm test', false)).card, 'a later build-file edit flags the project again');
  });
});

test('denying the card keeps the flag', async () => {
  await using(async (r) => {
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    assert.equal((await decide(r, 'npm test', false)).d.allow, false);
    assert.equal(r.core.buildEdited.has(r.project.id), true);
    assert.ok((await decide(r, 'npm run build', false)).card, 'asked again');
  });
});

test('a card the flag did not cause does not clear it', async () => {
  await using(async (r) => {
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    const { card, d } = await decide(r, 'git push origin main', true);
    assert.ok(card); assert.equal(d.allow, true);
    assert.doesNotMatch(card!.summary, WHY, 'a level 3 card keeps its own text');
    assert.equal(r.core.buildEdited.has(r.project.id), true);
  });
});

test('a standing allow rule runs the command and does not clear the flag', async () => {
  await using(async (r) => {
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    const allow: GateRule = { id: 'gr_allow', enabled: true, then: 'allow', when: { tools: ['Bash'] }, label: 'allow', source: 'user' };
    r.setRules([allow]);
    assert.equal((await r.call('Bash', { command: 'npm test' })).allow, true); assert.equal(r.pending().length, 0);
    assert.equal(r.core.buildEdited.has(r.project.id), true);
  });
});

test('the flag survives a restart: a new core on the same dataDir still cards', async () => {
  await using(async (r) => {
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    const core2 = createGatesCore({ dataDir: dirname(r.core.store.folder), projects: r.projects, keyring: { get: () => Buffer.alloc(32, 7) } as never });
    (r.engine as unknown as { gates: unknown }).gates = core2;
    assert.equal(core2.buildEdited.has(r.project.id), true);
    const run2 = await r.freshRun();
    try {
      const p = run2.call('Bash', { command: 'npm test' }); await r.tick();
      assert.equal(r.pending().length, 1); assert.match(r.pending()[0]!.summary, WHY); r.answer(true); await p;
      assert.equal(core2.buildEdited.has(r.project.id), false);
    } finally { run2.stop(); }
  });
});

test('another project is not affected', async () => {
  await using(async (r) => {
    const other = r.projects.create({ name: 'Other', instructions: '' });
    r.core.store.patchProject(other.id, { preset: 'smart' });
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    const run2 = await r.freshRun({ projectId: other.id });
    try {
      assert.equal((await run2.call('Bash', { command: 'npm test' })).allow, true); assert.equal(r.pending().length, 0);
    } finally { run2.stop(); }
  });
});

test('Ask mode is unchanged: every command still cards, with the ordinary text', async () => {
  const r = await gatesRig({});
  try {
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    const { card } = await decide(r, 'npm test', false);
    assert.ok(card); assert.doesNotMatch(card!.summary, WHY);
  } finally { r.stop(); }
});

/** Plays the effect of a shell command on disk (the rig does not run the shell). */
const write = (r: GatesRig, rel: string, text: string): void => { const f = join(r.projectDir(), rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };

for (const [name, rel] of [
  ['cd scripts && echo x > build.js', 'scripts/build.js'],
  ['echo x > "pack""age.json"', 'package.json'],
  ['Set-Content -Path:package.json x', 'package.json'],
] as Array<[string, string]>) {
  test(`a shell command the words cannot reveal still flags the project by its files: ${name}`, async () => {
    await using(async (r) => {
      assert.equal((await r.call('Bash', { command: 'npm test' })).allow, true); assert.equal(r.pending().length, 0, 'baseline taken, no card');
      write(r, rel, `changed by ${name}`);
      const { card } = await decide(r, 'npm test', false);
      assert.ok(card, 'the next npm test cards'); assert.match(card!.summary, WHY);
    });
  });
}

test('a project first seen with an existing package.json does not card', async () => {
  await using(async (r) => {
    write(r, 'package.json', '{}'); write(r, 'scripts/a.js', 'x');
    assert.equal((await r.call('Bash', { command: 'npm test' })).allow, true); assert.equal(r.pending().length, 0);
  });
});

test('a file edited while the flag card is open keeps the project flagged after the owner allows', async () => {
  await using(async (r) => {
    await r.call('Bash', { command: 'npm test' }); // baseline
    write(r, 'Makefile', 'one');
    const p = r.call('Bash', { command: 'npm test' }); await r.tick();
    assert.equal(r.pending().length, 1);
    write(r, 'scripts/late.js', 'during the card'); // not named by any tool call: only the files show it
    r.answer(true); assert.equal((await p).allow, true);
    assert.ok((await decide(r, 'npm test', false)).card, 'still asks');
  });
});

test('a build file named by a tool while the card is open keeps the flag too', async () => {
  await using(async (r) => {
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{}' });
    const p = r.call('Bash', { command: 'npm test' }); await r.tick();
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json`, content: '{"a":1}' });
    r.answer(true); await p;
    assert.ok((await decide(r, 'npm test', false)).card);
  });
});

test('the host write_file tool and Windows spellings set the flag', async () => {
  await using(async (r) => {
    r.noteUse('mcp__host__write_file', { path: 'scripts/x.js', content: 'x' });
    assert.ok((await decide(r, 'npm test', true)).card, 'write_file into scripts');
    r.noteUse('Write', { file_path: `${r.projectDir()}/package.json.`, content: 'x' });
    assert.ok((await decide(r, 'npm test', false)).card, 'a trailing dot');
  });
});

// ---- Task 24: reading password and key files asks by default, with one switch ----
test('Ask, Accept edits, Smart: Reading .env cards with no Remember; Bypass does not', async () => {
  const rigs: Array<[string, () => Promise<GatesRig>]> = [
    ['ask', () => gatesRig({ own: 'ask' })],
    ['auto-edits', () => gatesRig({ own: 'auto-edits' })],
    ['smart', () => gatesRig({ preset: 'smart', follow: true })],
  ];
  for (const [m, make] of rigs) {
    const r = await make();
    try {
      const p = r.call('Read', { file_path: `${r.projectDir()}/.env` }); await r.tick();
      assert.equal(r.pending().length, 1, m); assert.equal(r.pending()[0]!.noRemember, true);
      assert.match(r.pending()[0]!.summary, /^Legion wants to read .*[\\/]\.env\. It may hold passwords or keys\.$/);
      r.answer(false); assert.equal((await p).allow, false);
    } finally { r.stop(); }
  }
  const f = await gatesRig({ own: 'full' });
  try { assert.equal((await f.call('Read', { file_path: `${f.projectDir()}/.env` })).allow, true); assert.equal(f.pending().length, 0); } finally { f.stop(); }
});
test('a shell cat of .env cards in Smart', async () => {
  await using(async (r) => {
    const p = r.call('Bash', { command: 'cat .env' }); await r.tick();
    assert.equal(r.pending().length, 1); r.answer(false); await p;
  });
});
test('the same Read twice in a moment raises one card (memo covers the secret guard)', async () => {
  await using(async (r) => {
    const input = { file_path: `${r.projectDir()}/.env` };
    const a = r.call('Read', input); const b = r.call('Read', input); await r.tick();
    assert.equal(r.pending().length, 1); r.answer(false); await Promise.all([a, b]);
  });
});
test('secret-file-reads off: no read card, but web calls still ask for the rest of the run', async () => {
  await using(async (r) => {
    r.setGateOverride('secret-file-reads', false);
    r.noteUse('Read', { file_path: `${r.projectDir()}/.env` });
    assert.equal((await r.call('Read', { file_path: `${r.projectDir()}/.env` })).allow, true); assert.equal(r.pending().length, 0);
    const p = r.call('WebFetch', { url: 'https://docs.python.org/3/' }); await r.tick(); assert.equal(r.pending().length, 1); r.answer(false); await p;
  });
});
test('a normal read and .env.example never card', async () => {
  const r = await gatesRig({ own: 'ask' });
  try {
    for (const f of ['src/a.ts', '.env.example']) assert.equal((await r.call('Read', { file_path: `${r.projectDir()}/${f}` })).allow, true);
    assert.equal(r.pending().length, 0);
  } finally { r.stop(); }
});

// ---- Task 23: writes to Git internals, hooks, editor/agent settings, shell startup and package manager files always ask ----
test('Smart: a Write to .git/hooks cards even with a Gates allow rule; a Write to src runs', async () => {
  await using(async (r) => {
    r.setRules([{ id: 'gr_a', enabled: true, then: 'allow', when: { tools: ['Write'] }, label: 'Allow Write', source: 'user' } as GateRule]);
    const p = r.call('Write', { file_path: `${r.projectDir()}/.git/hooks/pre-commit`, content: 'x' }); await r.tick();
    assert.equal(r.pending().length, 1); assert.equal(r.pending()[0]!.noRemember, true);
    assert.equal(r.pending()[0]!.summary, 'Legion wants to change .git. A change there can run code the next time you use Git, or change what an agent may do.');
    r.answer(false);
    const d = await p; assert.equal(d.allow, false); assert.doesNotMatch(d.message ?? '', /instead/i); // the shared guard wording says "another way" only to forbid it
    assert.equal((await r.call('Write', { file_path: `${r.projectDir()}/src/a.ts`, content: 'x' })).allow, true); assert.equal(r.pending().length, 0);
  });
});
test('Ask, Accept edits and Smart all card a protected write; Bypass does not', async () => {
  const rigs: Array<[string, () => Promise<GatesRig>]> = [
    ['ask', () => gatesRig({ own: 'ask' })],
    ['auto-edits', () => gatesRig({ own: 'auto-edits' })],
    ['smart', () => gatesRig({ preset: 'smart', follow: true })],
  ];
  for (const [m, make] of rigs) {
    const r = await make();
    try {
      const p = r.call('Edit', { file_path: `${r.projectDir()}/.claude/settings.json` }); await r.tick();
      assert.equal(r.pending().length, 1, m); assert.equal(r.pending()[0]!.noRemember, true, m); r.answer(false); assert.equal((await p).allow, false, m);
    } finally { r.stop(); }
  }
  const f = await gatesRig({ own: 'full' });
  try { assert.equal((await f.call('Edit', { file_path: `${f.projectDir()}/.claude/settings.json` })).allow, true); assert.equal(f.pending().length, 0); } finally { f.stop(); }
});
test('Smart: a shell command that copies into .git/hooks cards; git status does not', async () => {
  await using(async (r) => {
    const p = r.call('Bash', { command: 'cp x .git/hooks/pre-commit' }); await r.tick(); assert.equal(r.pending().length, 1); r.answer(false); await p;
    assert.equal((await r.call('Bash', { command: 'git status' })).allow, true); assert.equal(r.pending().length, 0);
  });
});
test('Smart: git config core.hooksPath cards at any level', async () => {
  await using(async (r) => {
    const p = r.call('Bash', { command: 'git config core.hooksPath .evil' }); await r.tick(); assert.equal(r.pending().length, 1); r.answer(false); await p;
  });
});
test('a relative target is resolved against the agent folder; a path outside the folder is tested in full', async () => {
  await using(async (r) => {
    r.agent.cwd = r.projectDir();
    const p = r.call('Write', { file_path: '.git/hooks/pre-commit', content: 'x' }); await r.tick(); assert.equal(r.pending().length, 1); r.answer(false); await p;
    const q = r.call('Write', { file_path: join(homedir(), '.bashrc'), content: 'x' }); await r.tick(); assert.equal(r.pending().length, 1);
    assert.match(r.pending()[0]!.summary, /^Legion wants to change \.bashrc\./); r.answer(false); await q;
    // a relative path that hits nothing protected raises no protected-path card (the ordinary Smart card for a relative path may still show)
    const s = r.call('Write', { file_path: 'src/b.ts', content: 'x' }); await r.tick();
    assert.ok(!r.pending().some((c) => /^Legion wants to change/.test(c.summary))); while (r.pending().length) r.answer(true); assert.equal((await s).allow, true);
  });
});
test('a project that itself lives under a protected folder name does not card every write', async () => {
  const r = await gatesRig({ own: 'ask' });
  try {
    const inner = join(tempDir('legion-prot-'), '.config', 'git', 'proj');
    mkdirSync(inner, { recursive: true });
    r.projects.setFolder(r.project.id, inner); r.agent.cwd = inner;
    // the folder sits under .config/git: a write inside it is tested relative to it, so it raises only the ordinary Ask card
    const ok = r.call('Write', { file_path: join(inner, 'src', 'a.ts'), content: 'x' }); await r.tick();
    assert.ok(!r.pending().some((c) => /change \.config\/git/.test(c.summary)), 'no protected-path card for the folder the project lives in');
    while (r.pending().length) r.answer(true);
    await ok;
    const p = r.call('Write', { file_path: join(inner, '.git', 'hooks', 'x'), content: 'x' }); await r.tick();
    assert.ok(r.pending().some((c) => /change \.git\./.test(c.summary)), 'a protected name inside the project still cards'); while (r.pending().length) r.answer(false); await p;
  } finally { r.stop(); }
});
test('protected-path-cards off in a Smart project: no guard card', async () => {
  await using(async (r) => {
    r.setGateOverride('protected-path-cards', false);
    assert.equal((await r.call('Write', { file_path: `${r.projectDir()}/.git/hooks/pre-commit`, content: 'x' })).allow, true); assert.equal(r.pending().length, 0);
  });
});
