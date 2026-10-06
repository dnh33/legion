/**
 * POST /api/armory/import with dryRun: the review comes from the core, writes nothing, and says exactly what a real import then does.
 * The screen keeps no copy of these rules (test/armory-view.test.ts checks that), so this is where they are pinned.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ARMORY_LIMITS } from '../src/core/armory/files.js';
import { skillFolder } from '../src/core/armory/store.js';
import { armoryRig, own } from './armory-rig.js';

type F = { path: string; text: string } | { path: string; size: number; text: null };
const f = (path: string, text: string): F => ({ path, text });
const skillMd = (name: string, extra = ''): string => `---\nname: ${name}\ndescription: Does ${name}.\n${extra}---\n\nBody.\n`;

/** Every file under a folder with its bytes, so "writes nothing" is a comparison, not a hope. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else out[p] = `${statSync(p).size}:${readFileSync(p, 'utf8')}`;
    }
  };
  try { walk(dir); } catch { /* no folder yet */ }
  return out;
}
/** The skills the owner has in the Armory (the built-ins Claude Code ships are always listed and never count). */
const added = async (r: Awaited<ReturnType<typeof fresh>>): Promise<string[]> => (await r.call('GET', '/api/armory')).skills.filter((s: any) => s.source !== 'claude-builtin').map((s: any) => s.id);
const fresh = async () => {
  const r = armoryRig({ inherit: false });
  await r.call('GET', '/api/armory'); // the first read creates armory.json; after that a dry run has nothing of its own to create
  return r;
};

const accepted: Record<string, F[]> = {
  'a folder with references': [f('s/SKILL.md', skillMd('s')), f('s/references/a.md', 'a'), f('s/references/b.md', 'b')],
  'a lone SKILL.md': [f('SKILL.md', skillMd('lone'))],
  'scripts and images are dropped': [f('s/SKILL.md', skillMd('s')), f('s/run.sh', 'echo hi'), f('s/img.png', 'x'), f('s/notes.md', 'n')],
  'files outside the skill folder': [f('top/s/SKILL.md', skillMd('s')), f('top/other.md', 'o'), f('top/s/x.md', 'x')],
  'keys that pre-approve tools are stripped': [f('s/SKILL.md', skillMd('s', 'allowed-tools: Bash\nhooks:\n  a: b\ncontext: fork\nagent: x\nshell: bash\n'))],
  'a folder name stands in for a bad name': [f('My Skill/SKILL.md', '---\nname: Not Valid!\ndescription: d\n---\nb')],
  'a name from the header wins': [f('folder/SKILL.md', skillMd('from-header'))],
  'a windows path': [f('s\\SKILL.md', skillMd('s')), f('s\\r\\a.md', 'a')],
  'a file too big to keep': [f('s/SKILL.md', skillMd('s')), f('s/big.md', 'x'.repeat(ARMORY_LIMITS.maxFileBytes + 1))],
  'files the screen did not read': [f('s/SKILL.md', skillMd('s')), { path: 's/pic.png', size: 900_000_000, text: null }, { path: 's/huge.md', size: 900_000, text: null }, { path: 's/ref.md', size: 10, text: null }],
};
const refused: Record<string, F[]> = {
  'two SKILL.md': [f('a/SKILL.md', skillMd('a')), f('b/SKILL.md', skillMd('b'))],
  'no SKILL.md': [f('a/readme.md', 'x')],
  'no description': [f('s/SKILL.md', '---\nname: s\n---\nbody'), f('s/ref.md', 'r')],
  'a path that climbs': [f('s/SKILL.md', skillMd('s')), f('../evil.md', 'x')],
  'an absolute path': [f('/etc/x.md', 'x'), f('s/SKILL.md', skillMd('s'))],
  'shell on load (inline)': [f('s/SKILL.md', skillMd('s').replace('Body.', 'Run !`ls` now.')), f('s/x.png', 'p')],
  'shell on load (fenced)': [f('s/SKILL.md', skillMd('s').replace('Body.', '```!\nls\n```'))],
  'a name nothing can be made of': [f('SKILL.md', '---\nname: !!!\ndescription: d\n---\nb')],
  'a SKILL.md that was not sent': [{ path: 's/SKILL.md', size: 10, text: null }, f('s/a.md', 'a')],
  'a SKILL.md over the size limit': [f('s/SKILL.md', skillMd('s') + 'x'.repeat(ARMORY_LIMITS.maxFileBytes))],
  'too many files': [...Array.from({ length: ARMORY_LIMITS.maxFiles + 1 }, (_, i) => f(`s/${i}.md`, 'x')), f('s/SKILL.md', skillMd('s'))],
  'too many bytes': [f('s/SKILL.md', skillMd('s')), f('s/a.md', 'x'.repeat(600_000)), f('s/b.md', 'x'.repeat(600_000))],
  'text that is not a string': [{ path: 's/SKILL.md', text: 5 as unknown as string }],
  'nothing': [],
};

describe('import dryRun: the review', () => {
  for (const [label, files] of Object.entries(accepted)) {
    it(`reports exactly what the real import then does, and writes nothing itself: ${label}`, async () => {
      const dry = await fresh();
      const before = snapshot(dry.dataDir);
      const review = await dry.call('POST', '/api/armory/import', { files, dryRun: true });
      assert.deepEqual(snapshot(dry.dataDir), before, 'a dry run leaves the data folder exactly as it was');
      assert.equal(review.ok, true, review.refusal);
      assert.equal(review.refusal, '');

      const real = await fresh();
      const done = await real.call('POST', '/api/armory/import', { files });
      assert.equal(review.name, done.name);
      assert.equal(review.id, done.id);
      assert.deepEqual(review.kept, done.kept);
      assert.deepEqual(review.dropped, done.dropped);
      assert.deepEqual(review.stripped, done.stripped);
      // the preview is the file that gets written
      assert.equal(review.skillText, readFileSync(join(skillFolder(real.dataDir, done.name), 'SKILL.md'), 'utf8'));
      assert.equal(review.description, /^description: (.*)$/m.exec(review.skillText)![1], 'the parsed description is the one in the file');
      assert.ok(!(await real.call('POST', '/api/armory/import', { files, dryRun: true })).ok, 'once it is in, the dry run says it is already there');
    });
  }

  for (const [label, files] of Object.entries(refused)) {
    it(`refuses what the real import refuses, in the same words, and writes nothing: ${label}`, async () => {
      const dry = await fresh();
      const before = snapshot(dry.dataDir);
      const review = await dry.call('POST', '/api/armory/import', { files, dryRun: true });
      assert.deepEqual(snapshot(dry.dataDir), before);
      assert.equal(review.ok, false);
      assert.ok(review.refusal.length > 10, review.refusal);
      assert.deepEqual([review.kept, review.stripped, review.name, review.skillText], [[], [], '', '']);

      const real = await fresh();
      const beforeReal = snapshot(real.dataDir);
      const err = await real.call('POST', '/api/armory/import', { files }).then(() => null, (e) => e);
      assert.equal(err?.status, 400);
      assert.equal(review.refusal, err.message, 'the same words');
      assert.deepEqual(snapshot(real.dataDir), beforeReal);
      assert.deepEqual(await added(real), [], 'nothing was added');
    });
  }

  it('the review names the keys that would be removed, and the preview is without them', async () => {
    const r = await fresh();
    const review = await r.call('POST', '/api/armory/import', { files: accepted['keys that pre-approve tools are stripped'], dryRun: true });
    assert.deepEqual(review.stripped, ['allowed-tools', 'hooks', 'context', 'agent', 'shell']);
    assert.ok(!/allowed-tools|hooks|context:|agent:|shell:/.test(review.skillText), review.skillText);
    assert.match(review.skillText, /description: Does s\./);
    assert.equal(review.id, 'legion-armory:s');
    const files = [f('s/SKILL.md', skillMd('s')), f('s/run.sh', 'x'), f('s/ref.md', 'r')];
    const plain = await r.call('POST', '/api/armory/import', { files, dryRun: true });
    assert.deepEqual(plain.kept, ['SKILL.md', 'ref.md']);
    assert.deepEqual(plain.dropped, [{ path: 's/run.sh', reason: 'not a .md file (Legion never runs scripts)' }]);
    assert.deepEqual(plain.stripped, []);
  });

  it('words for the limits match the old screen: files, bytes, and a path that is not plain', async () => {
    const r = await fresh();
    const many = refused['too many files']!;
    assert.equal((await r.call('POST', '/api/armory/import', { files: many, dryRun: true })).refusal, `That is ${many.length} files; the limit is ${ARMORY_LIMITS.maxFiles}.`);
    assert.match((await r.call('POST', '/api/armory/import', { files: refused['too many bytes'], dryRun: true })).refusal, /over 1000000 bytes in total/);
    assert.match((await r.call('POST', '/api/armory/import', { files: refused['a path that climbs'], dryRun: true })).refusal, /plain relative path/);
  });

  it('a refusal after the files were sorted still lists what was left out', async () => {
    const r = await fresh();
    const review = await r.call('POST', '/api/armory/import', { files: [f('s/SKILL.md', '---\nname: s\n---\nb'), f('s/run.sh', 'x'), f('other/y.md', 'y')], dryRun: true });
    assert.equal(review.ok, false);
    assert.deepEqual(review.dropped.map((d: any) => d.path).sort(), ['other/y.md', 's/run.sh']);
  });

  it('a name that is already in the Armory is refused in the review, as the real import refuses it (409)', async () => {
    const r = await fresh();
    await r.call('POST', '/api/armory/import', { files: accepted['a lone SKILL.md'] });
    const review = await r.call('POST', '/api/armory/import', { files: accepted['a lone SKILL.md'], dryRun: true });
    assert.equal(review.ok, false);
    assert.equal(review.id, 'legion-armory:lone');
    const err = await r.call('POST', '/api/armory/import', { files: accepted['a lone SKILL.md'] }).then(() => null, (e) => e);
    assert.equal(err.status, 409);
    assert.equal(review.refusal, err.message);
  });

  it('only dryRun: true is a dry run; anything else imports for real', async () => {
    const r = await fresh();
    for (const dryRun of ['true', 1, 'yes']) {
      const out = await r.call('POST', '/api/armory/import', { files: [f(`s${String(dryRun)}/SKILL.md`, skillMd(`s${String(dryRun)}`))], dryRun });
      assert.equal(out.source, 'imported', `dryRun ${JSON.stringify(dryRun)} is not a yes`);
    }
    assert.equal((await added(r)).length, 3);
  });

  it('a dry run does not leave a temp folder, change the catalog cache, or touch an existing skill', async () => {
    const r = await fresh();
    await own(r, { name: 'mine', description: 'Mine.', body: 'B.' });
    const before = snapshot(r.dataDir);
    await r.call('POST', '/api/armory/import', { files: accepted['a folder with references'], dryRun: true });
    await r.call('POST', '/api/armory/import', { files: refused['no description'], dryRun: true });
    assert.deepEqual(snapshot(r.dataDir), before);
    assert.deepEqual(await added(r), ['legion-armory:mine']);
  });
});
