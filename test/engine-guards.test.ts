// test/engine-guards.test.ts: Smart asks for build and test commands once an agent changed a build or script file in the project (Task 27).
// The flag is per project, survives a restart, and clears only when the owner allows one such card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { createGatesCore } from '../src/core/gates-settings/index.js';
import type { GateRule } from '../src/shared/types.js';

const using = async (body: (r: GatesRig) => Promise<void>) => {
  const r = await gatesRig({ preset: 'smart', follow: true });
  try { await body(r); } finally { r.stop(); }
};
const WHY = /changed a build or script file/;
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
