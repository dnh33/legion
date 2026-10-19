// test/env-scrub-notice.test.ts: the env scrub is no longer silent (final review I2). The run's preamble and the activity log name the variables
// held back (names only, never values), and say where to keep one. Nothing is said when nothing was held back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gatesRig } from './gates-rig.js';
import type { GatesRig } from './gates-rig.js';
import { heldBackNames } from '../src/core/env-scrub.js';
import { ENV_KEEP_LABEL, GATES } from '../src/shared/gates-registry.js';

const MARK = 'ZZ-MARKER-VALUE-8c1f';
const prompt = (r: GatesRig): string => ((r.options().systemPrompt as { append?: string }).append) ?? '';

/** Runs `fn` with exactly this process environment, and puts the real one back. */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = process.env;
  process.env = { ...env } as NodeJS.ProcessEnv;
  try { return await fn(); } finally { process.env = saved; }
}
const BASE = { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' };

test('heldBackNames: names only, sorted, for secret-looking names and settings that load code; kept and never-stripped names are not listed', () => {
  const env = { PATH: '/bin', HOME: '/h', GH_TOKEN: MARK, NPM_TOKEN: MARK, AWS_SECRET_ACCESS_KEY: MARK, PYTHONPATH: MARK, NODE_OPTIONS: MARK, LD_LIBRARY_PATH: MARK, EDITOR: 'vim', DATABASE_URL: `postgres://u:${MARK}@h/db`, KEPT_TOKEN: MARK };
  const names = heldBackNames(env, { keep: ['KEPT_*'] });
  assert.deepEqual(names, ['AWS_SECRET_ACCESS_KEY', 'DATABASE_URL', 'GH_TOKEN', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'NPM_TOKEN', 'PYTHONPATH']);
  assert.equal(JSON.stringify(names).includes(MARK), false);
  assert.deepEqual(heldBackNames({ PATH: '/bin', EDITOR: 'vim' }), []);
});

test('I2: the preamble names the variables held back and where to keep one; no value is in it', async () => {
  await withEnv({ ...BASE, NPM_TOKEN: MARK, PYTHONPATH: `/x/${MARK}`, NODE_OPTIONS: MARK, EDITOR: 'vim' }, async () => {
    const r = await gatesRig({ own: 'ask' });
    try {
      const p = prompt(r);
      const line = p.split('\n').find((l) => l.includes('held back'));
      assert.ok(line, 'one line about held-back variables');
      for (const n of ['NODE_OPTIONS', 'NPM_TOKEN', 'PYTHONPATH']) assert.ok(line.includes(n), n);
      assert.doesNotMatch(line, /EDITOR/);
      assert.match(line, /Settings, Gates/);
      assert.match(line, /tell the user which one and why/);
      assert.ok(line.includes(`keep that one variable in Settings, Gates, Fine tuning, "${ENV_KEEP_LABEL}"`), 'names the per-variable editor by its label');
      assert.match(line, /Keep keys and passwords out of commands/, 'in a project the all-at-once switch is still named');
      assert.match(line, /for this project in Settings, Gates\. That passes all of them, not only one\./);
      assert.equal(p.includes(MARK), false, 'no value anywhere in the preamble');
      assert.equal(p.split('\n').filter((l) => l.includes('held back')).length, 1, 'one line');
    } finally { r.stop(); }
  });
});

test('I2: the activity log gets the same names once per run, with no value', async () => {
  await withEnv({ ...BASE, NPM_TOKEN: MARK, PYTHONPATH: `/x/${MARK}` }, async () => {
    const r = await gatesRig({ own: 'ask' });
    try {
      const lines = r.activityRead({ kinds: ['note'] }).filter((l) => /held back/i.test(l.text));
      assert.equal(lines.length, 1);
      assert.match(lines[0]!.text, /NPM_TOKEN/); assert.match(lines[0]!.text, /PYTHONPATH/);
      assert.equal(JSON.stringify(r.activityRead()).includes(MARK), false, 'no value anywhere in the activity log');
    } finally { r.stop(); }
  });
});

test('I2: nothing held back, nothing said', async () => {
  await withEnv({ ...BASE, EDITOR: 'vim' }, async () => {
    const r = await gatesRig({ own: 'ask' });
    try {
      assert.equal(prompt(r).includes('held back'), false);
      assert.equal(r.activityRead({ kinds: ['note'] }).some((l) => /held back/i.test(l.text)), false);
    } finally { r.stop(); }
  });
});

test('I2: the env-scrub switch off: nothing is announced; a name on the keep list is not announced', async () => {
  await withEnv({ ...BASE, NPM_TOKEN: MARK, GH_TOKEN: MARK }, async () => {
    const off = await gatesRig({ own: 'ask', overrides: { 'env-scrub': false } });
    try { assert.equal(prompt(off).includes('held back'), false); } finally { off.stop(); }
    const kept = await gatesRig({ own: 'ask', keep: ['GH_TOKEN'] });
    try {
      const line = prompt(kept).split('\n').find((l) => l.includes('held back'))!;
      assert.ok(line.includes('NPM_TOKEN')); assert.equal(line.includes('GH_TOKEN'), false);
    } finally { kept.stop(); }
  });
});

test('I2: the gate text says it also holds back settings that make a program load other code', () => {
  const g = GATES.find((x) => x.id === 'env-scrub')!;
  assert.match(g.protects, /PYTHONPATH/); assert.match(g.protects, /NODE_OPTIONS/); assert.match(g.protects, /LD_LIBRARY_PATH/);
  assert.match(g.protects, /load other code/);
});

test('N1: outside a project the line points to the per-variable editor and names no switch (there is none outside a project)', async () => {
  await withEnv({ ...BASE, NPM_TOKEN: MARK }, async () => {
    const r = await gatesRig({ own: 'ask' });
    try {
      const eng = r.engine as unknown as { heldBackNote(job: unknown, agent: unknown, act: unknown, consumers: { child: boolean; host: boolean }): string; active: Map<string, unknown> };
      const outside = eng.heldBackNote({ ...(r.job as object), projectAtStart: undefined }, r.agent, eng.active.get(r.task.id), { child: true, host: false });
      assert.equal(outside, `Legion held back these environment variables from your commands: NPM_TOKEN. They look like keys, tokens or passwords, or they make a program load other code. If a command needs one, tell the user which one and why, and say they can keep that one variable in Settings, Gates, Fine tuning, "${ENV_KEEP_LABEL}".`);
      assert.doesNotMatch(outside, /Keep keys and passwords out of commands/, 'no project, no switch to name');
      assert.doesNotMatch(outside, /stay held back/, 'the old dead end is gone');
      assert.equal(outside.includes(MARK), false);
    } finally { r.stop(); }
  });
});

test('N1b: in a project the line gives both ways: keep one variable, or turn the switch off for all of them (and says it passes all)', async () => {
  await withEnv({ ...BASE, NPM_TOKEN: MARK, PYTHONPATH: `/x/${MARK}` }, async () => {
    const r = await gatesRig({ own: 'ask' });
    try {
      const eng = r.engine as unknown as { heldBackNote(job: unknown, agent: unknown, act: unknown, consumers: { child: boolean; host: boolean }): string; active: Map<string, unknown> };
      const inside = eng.heldBackNote({ ...(r.job as object), projectAtStart: r.project.id }, r.agent, eng.active.get(r.task.id), { child: true, host: false });
      assert.equal(inside, `Legion held back these environment variables from your commands: NPM_TOKEN, PYTHONPATH. They look like keys, tokens or passwords, or they make a program load other code. If a command needs one, tell the user which one and why, and say they can keep that one variable in Settings, Gates, Fine tuning, "${ENV_KEEP_LABEL}". To pass every held-back variable at once, they can turn off "Keep keys and passwords out of commands" for this project in Settings, Gates. That passes all of them, not only one.`);
      assert.equal(inside.includes(MARK), false, 'no value, ever');
    } finally { r.stop(); }
  });
});

test('N1c: a variable on the keep list is not in the line, and no value of any held-back variable is', async () => {
  await withEnv({ ...BASE, NPM_TOKEN: MARK, GH_TOKEN: MARK }, async () => {
    const r = await gatesRig({ own: 'ask', keep: ['GH_TOKEN'] });
    try {
      const eng = r.engine as unknown as { heldBackNote(job: unknown, agent: unknown, act: unknown, consumers: { child: boolean; host: boolean }): string; active: Map<string, unknown> };
      for (const projectAtStart of [undefined, r.project.id]) {
        const note = eng.heldBackNote({ ...(r.job as object), projectAtStart }, r.agent, eng.active.get(r.task.id), { child: true, host: true });
        assert.match(note, /: NPM_TOKEN\./);
        assert.equal(note.includes('GH_TOKEN'), false);
        assert.equal(note.includes(MARK), false);
      }
    } finally { r.stop(); }
  });
});

test('N3: the names are worked out for each consumer: on a machine set up for a cloud login the host shell still holds the cloud login back', async () => {
  const env = { ...BASE, CLAUDE_CODE_USE_BEDROCK: '1', AWS_SECRET_ACCESS_KEY: MARK, NPM_TOKEN: MARK };
  await withEnv(env, async () => {
    const withHost = await gatesRig({ own: 'ask', host: true });
    try {
      const line = prompt(withHost).split('\n').find((l) => l.includes('held back'))!;
      assert.ok(line.includes('AWS_SECRET_ACCESS_KEY'), 'the host shell holds it back');
      assert.ok(line.includes('NPM_TOKEN'));
      assert.equal(line.includes(MARK), false);
    } finally { withHost.stop(); }
    const noHost = await gatesRig({ own: 'ask' });
    try {
      const line = prompt(noHost).split('\n').find((l) => l.includes('held back'))!;
      assert.equal(line.includes('AWS_SECRET_ACCESS_KEY'), false, 'the Claude child keeps the cloud login it needs, so it is not listed without the host shell');
      assert.ok(line.includes('NPM_TOKEN'));
    } finally { noHost.stop(); }
  });
});
