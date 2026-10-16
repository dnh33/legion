// test/gates-sign.test.ts: signed gate settings files (spec 4.1, gates PR 2 task 4)
import { tempDir as cleanupTemp } from './tmp-cleanup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESETS } from '../src/shared/gates-registry.js';
import { GatesError, GatesStore } from '../src/core/gates-settings/store.js';
import { makeSigner, canonicalize } from '../src/core/gates-settings/sign.js';

const key = Buffer.alloc(32, 7);
const P = 'proj_aaaaaaaaaaaa';
const mk = (k: Buffer | null = key) => {
  const dir = join(cleanupTemp('legion-gsign-'), 'gates');
  const signer = makeSigner(k ?? undefined);
  mkdirSync(dir, { recursive: true });
  return { dir, signer, open: () => new GatesStore(dir, { allowed: PRESETS, ...(signer ? { signer } : {}) }) };
};
const readJson = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
const key400 = (e: unknown): boolean => e instanceof GatesError && e.status === 400 && /key/i.test(e.message);

test('a signed file round-trips', async () => {
  const { open } = mk(); const s = open();
  s.patchProject(P, { preset: 'bypass' }); await s.flush();
  const t = open();
  assert.equal(t.project(P).preset, 'bypass');
  assert.deepEqual(t.changedOutside(), []);
});

test('the file on disk carries a hex signature next to the settings', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'smart' }); await s.flush();
  const j = readJson(join(dir, `${P}.json`));
  assert.equal(j.preset, 'smart');
  assert.match(String(j.sig), /^[0-9a-f]{64}$/);
});

test('an edited file is not applied: the project reads Ask and is listed as changed outside', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  const f = join(dir, `${P}.json`); const j = readJson(f); j.preset = 'bypass'; writeFileSync(f, JSON.stringify(j));
  const t = open();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [P]);
  assert.equal(readJson(f).preset, 'bypass', 'the edited file is left on disk until the owner chooses');
  assert.ok(!readdirSync(dir).some((n) => n.includes('.bad-')), 'it is not renamed aside');
});

test('an edited app file is not applied either: the app reads Ask and "app" is listed', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchApp({ preset: 'smart' }); await s.flush();
  const f = join(dir, 'app.json'); const j = readJson(f); j.preset = 'bypass'; writeFileSync(f, JSON.stringify(j));
  const t = open();
  assert.equal(t.app().preset, 'ask');
  assert.deepEqual(t.changedOutside(), ['app']);
});

test('adding an approved host to a signed file by hand is not applied', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchApp({ allowedHosts: ['docs.python.org'] }); await s.flush();
  const f = join(dir, 'app.json'); const j = readJson(f); j.allowedHosts = ['docs.python.org', 'evil.example']; writeFileSync(f, JSON.stringify(j));
  const t = open();
  assert.deepEqual(t.changedOutside(), ['app']);
  assert.equal(t.app().allowedHosts, undefined, 'the edited list is not used');
});

test('a file with no signature and a looser preset is not applied', () => {
  const { dir, open } = mk(); open();
  writeFileSync(join(dir, `${P}.json`), JSON.stringify({ version: 1, preset: 'smart' }));
  const t = open();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [P]);
});

test('a file with a signature field that is not a valid signature is not applied', () => {
  const { dir, open } = mk(); open();
  writeFileSync(join(dir, `${P}.json`), JSON.stringify({ version: 1, preset: 'bypass', sig: 'zz' }));
  const t = open();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [P]);
});

test('a PR 1 file (Ask project, blank app, no signature) stays valid and is not flagged', () => {
  const { dir, open } = mk(); open();
  writeFileSync(join(dir, `${P}.json`), JSON.stringify({ version: 1, preset: 'ask' }));
  writeFileSync(join(dir, 'app.json'), JSON.stringify({ version: 1 }));
  const t = open();
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), []);
});

test('Ask with the limit switched off is looser than Ask, so an unsigned file saying so is not applied', () => {
  const { dir, open } = mk(); open();
  writeFileSync(join(dir, `${P}.json`), JSON.stringify({ version: 1, preset: 'ask', limit: false }));
  const t = open();
  assert.deepEqual(t.changedOutside(), [P]);
  assert.equal(t.project(P).limit, undefined);
});

test('Accept applies the disk value and re-signs it; Keep mine keeps what is in memory and re-signs it', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  const f = join(dir, `${P}.json`); const j = readJson(f); j.preset = 'accept-edits'; writeFileSync(f, JSON.stringify(j));
  const t = open();
  assert.equal(t.project(P).preset, 'ask');
  t.accept(P); await t.flush();
  assert.equal(t.project(P).preset, 'accept-edits', 'applied in memory at once');
  assert.deepEqual(t.changedOutside(), []);
  const after = open();
  assert.equal(after.project(P).preset, 'accept-edits', 'and it verifies after a restart');
  assert.deepEqual(after.changedOutside(), []);

  // edited again by hand: Keep mine keeps the in-memory Ask and writes it back signed
  const k = readJson(f); k.preset = 'bypass'; writeFileSync(f, JSON.stringify(k));
  const u = open();
  assert.deepEqual(u.changedOutside(), [P]);
  assert.equal(u.project(P).preset, 'ask');
  u.keepMine(P); await u.flush();
  assert.equal(u.project(P).preset, 'ask', 'the in-memory value is what was kept');
  assert.deepEqual(u.changedOutside(), []);
  const kept = open();
  assert.equal(kept.project(P).preset, 'ask');
  assert.deepEqual(kept.changedOutside(), []);
  assert.equal(readJson(f).preset, 'ask');
});

test('Accept and Keep mine refuse a name that was not changed outside (404)', () => {
  const s = mk().open();
  assert.throws(() => s.accept(P), (e: unknown) => e instanceof GatesError && e.status === 404);
  assert.throws(() => s.keepMine(P), (e: unknown) => e instanceof GatesError && e.status === 404);
});

test('Accept needs a key: with none, a changed-outside looser file cannot be re-signed or applied', async () => {
  const keyed = mk(); const w = keyed.open();
  w.patchProject(P, { preset: 'bypass' });
  await w.flush();
  const t = new GatesStore(keyed.dir, { allowed: PRESETS }); // same folder, but no key now
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [P]);
  assert.throws(() => t.accept(P), key400);
  assert.equal(t.project(P).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [P], 'still listed');
});

test('a later change made by the owner replaces the file and clears the changed-outside mark', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  const f = join(dir, `${P}.json`); const j = readJson(f); j.preset = 'bypass'; writeFileSync(f, JSON.stringify(j));
  const t = open();
  assert.deepEqual(t.changedOutside(), [P]);
  t.patchProject(P, { preset: 'accept-edits' }); await t.flush();
  assert.deepEqual(t.changedOutside(), []);
  assert.throws(() => t.accept(P), (e: unknown) => e instanceof GatesError && e.status === 404, 'the stale disk copy cannot be accepted any more');
  assert.equal(open().project(P).preset, 'accept-edits');
});

test('reload reads the files again and re-derives what changed outside', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  const f = join(dir, `${P}.json`); const j = readJson(f); j.preset = 'bypass'; writeFileSync(f, JSON.stringify(j));
  s.reload();
  assert.deepEqual(s.changedOutside(), [P]);
  s.reload();
  assert.deepEqual(s.changedOutside(), [P], 'a second reload does not duplicate or lose it');
  assert.equal(s.project(P).preset, 'ask');
});

test('with no key a looser preset is refused with a plain reason; Ask still works', () => {
  const { open, signer } = mk(null);
  assert.equal(signer, undefined);
  const s = open();
  assert.equal(s.canSign(), false);
  for (const preset of ['accept-edits', 'smart', 'bypass'] as const) assert.throws(() => s.patchProject(P, { preset }), key400, preset);
  assert.throws(() => s.patchProject(P, { limit: false }), key400);
  assert.throws(() => s.patchProject(P, { overrides: { 'github-write-card': false } }), key400);
  assert.throws(() => s.patchApp({ allowedHosts: ['docs.python.org'] }), key400);
  assert.throws(() => s.patchApp({ envKeep: ['AWS_PROFILE'] }), key400);
  assert.doesNotThrow(() => s.patchProject(P, { preset: 'ask' }));
  assert.equal(s.project(P).preset, 'ask');
});

test('with no key the Ask file is written plain (no signature), and tightening is allowed', async () => {
  const { dir, open } = mk(null); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  assert.equal('sig' in readJson(join(dir, `${P}.json`)), false);
  assert.equal(open().project(P).preset, 'ask');
});

test('with no key a signed looser file (made when a key existed) is not applied', async () => {
  const keyed = mk(); const w = keyed.open();
  w.patchApp({ preset: 'bypass' }); await w.flush();
  const t = new GatesStore(keyed.dir, { allowed: PRESETS });
  assert.equal(t.app().preset, 'ask');
  assert.deepEqual(t.changedOutside(), ['app']);
});

test('a wrong key does not verify', async () => {
  const a = mk(Buffer.alloc(32, 1)); const s = a.open();
  s.patchProject(P, { preset: 'smart' }); await s.flush();
  const b = new GatesStore(a.dir, { allowed: PRESETS, signer: makeSigner(Buffer.alloc(32, 2))! });
  assert.equal(b.project(P).preset, 'ask');
  assert.deepEqual(b.changedOutside().sort(), ['app', P], 'the project file and the app file that lists it');
});

test('a signature for one name does not verify under another name', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'bypass' }); await s.flush();
  const other = 'proj_bbbbbbbbbbbb';
  writeFileSync(join(dir, `${other}.json`), readFileSync(join(dir, `${P}.json`)));
  const t = open();
  assert.equal(t.project(P).preset, 'bypass');
  assert.equal(t.project(other).preset, 'ask');
  assert.deepEqual(t.changedOutside(), [other]);
});

test('makeSigner: only a 32-byte key signs; verify rejects garbage and the wrong name', () => {
  assert.equal(makeSigner(undefined), undefined);
  assert.equal(makeSigner(Buffer.alloc(16, 1)), undefined);
  const g = makeSigner(key)!;
  const sig = g.sign('app', '{"a":1}');
  assert.equal(g.verify('app', '{"a":1}', sig), true);
  assert.equal(g.verify('app', '{"a":2}', sig), false);
  assert.equal(g.verify(P, '{"a":1}', sig), false);
  assert.equal(g.verify('app', '{"a":1}', 'nothex'), false);
  assert.equal(g.verify('app', '{"a":1}', sig.slice(2)), false);
});

test('isLoosening: a looser preset, limit false, a permission override false are loosenings; Ask, Per agent and turning a gate on are not', () => {
  const s = mk().open();
  assert.equal(s.isLoosening('app', { preset: 'bypass' }), true);
  assert.equal(s.isLoosening('app', { preset: 'accept-edits' }), true);
  assert.equal(s.isLoosening('app', { preset: 'ask' }), false);
  assert.equal(s.isLoosening(P, { limit: false }), true);
  assert.equal(s.isLoosening(P, { limit: true }), false);
  assert.equal(s.isLoosening(P, { overrides: { 'github-write-card': false } }), true);
  assert.equal(s.isLoosening(P, { overrides: { 'github-write-card': true } }), false);
  assert.equal(s.isLoosening(P, { preset: null }), false, '"Per agent" restores 0.3.0');
});

test('isLoosening: a tighter change from a looser state is not a loosening', () => {
  const s = mk().open();
  s.patchProject(P, { preset: 'bypass' });
  assert.equal(s.isLoosening(P, { preset: 'ask' }), false);
  assert.equal(s.isLoosening(P, { preset: 'smart' }), false);
  assert.equal(s.isLoosening(P, { preset: 'bypass' }), false, 'no change');
  assert.equal(s.isLoosening(P, { preset: null }), true, 'removing a cap is a loosening (fix round 1)');
});

test('isLoosening compares what a gate would be: dropping an override that held a gate on is a loosening', () => {
  const s = mk().open();
  s.patchProject(P, { preset: 'bypass' });
  s.patchProject(P, { overrides: { 'github-write-card': true } });
  assert.equal(s.isLoosening(P, { overrides: {} }), true, 'Bypass would turn the card off again');
  assert.equal(s.isLoosening(P, { overrides: { 'github-write-card': true } }), false);
});

test('isLoosening: a higher limit than the Ask default is a loosening, a lower one is not', () => {
  const s = mk().open();
  assert.equal(s.isLoosening(P, { overrides: { 'attempt-caps': { on: true, limit: 8 } } }), true);
  assert.equal(s.isLoosening(P, { overrides: { 'attempt-caps': { on: true, limit: 2 } } }), false);
});

test('isLoosening: an invalid body counts as a loosening (fail closed), and the patch itself then says why', () => {
  const s = mk().open();
  assert.equal(s.isLoosening(P, { preset: 'nonsense' }), true);
  assert.throws(() => s.patchProject(P, { preset: 'nonsense' }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('isLoosening: a new approved host or kept variable is a loosening, removing one is not', () => {
  const s = mk().open();
  assert.equal(s.isLoosening('app', { allowedHosts: ['docs.python.org'] }), true);
  assert.equal(s.isLoosening('app', { envKeep: ['AWS_PROFILE'] }), true);
  s.patchApp({ allowedHosts: ['docs.python.org', 'developer.mozilla.org'], envKeep: ['AWS_PROFILE'] });
  assert.equal(s.isLoosening('app', { allowedHosts: ['docs.python.org'] }), false, 'a shorter list');
  assert.equal(s.isLoosening('app', { allowedHosts: ['docs.python.org', 'developer.mozilla.org'] }), false, 'the same list');
  assert.equal(s.isLoosening('app', { allowedHosts: ['docs.python.org', 'example.org'] }), true, 'one new entry');
  assert.equal(s.isLoosening('app', { envKeep: [] }), false);
});

test('allowedHosts: signed round trip, lower-cased and de-duplicated; the cap is 200; bad entries and project files are refused', async () => {
  const { open } = mk(); const s = open();
  s.patchApp({ allowedHosts: ['Docs.Python.org', 'docs.python.org', 'developer.mozilla.org.'] });
  assert.deepEqual(s.app().allowedHosts, ['docs.python.org', 'developer.mozilla.org']);
  await s.flush();
  assert.deepEqual(open().app().allowedHosts, ['docs.python.org', 'developer.mozilla.org']);
  const many = Array.from({ length: 201 }, (_, i) => `h${i}.example.org`);
  assert.throws(() => s.patchApp({ allowedHosts: many }), (e: unknown) => e instanceof GatesError && e.status === 400);
  assert.doesNotThrow(() => s.patchApp({ allowedHosts: many.slice(0, 200) }));
  for (const bad of ['https://example.org', 'a b.org', 'exa/mple.org', '', 7, '*.org']) {
    assert.throws(() => s.patchApp({ allowedHosts: [bad] }), (e: unknown) => e instanceof GatesError && e.status === 400, String(bad));
  }
  assert.throws(() => s.patchApp({ allowedHosts: 'docs.python.org' }), (e: unknown) => e instanceof GatesError && e.status === 400);
  assert.throws(() => s.patchProject(P, { allowedHosts: ['docs.python.org'] }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('envKeep: signed round trip; the cap is 50; a bad name is refused; NAME* prefixes are allowed; the app file only', async () => {
  const { open } = mk(); const s = open();
  s.patchApp({ envKeep: ['AWS_PROFILE', 'MYAPP_*', 'AWS_PROFILE'] });
  assert.deepEqual(s.app().envKeep, ['AWS_PROFILE', 'MYAPP_*']);
  await s.flush();
  assert.deepEqual(open().app().envKeep, ['AWS_PROFILE', 'MYAPP_*']);
  assert.throws(() => s.patchApp({ envKeep: Array.from({ length: 51 }, (_, i) => `V${i}`) }), (e: unknown) => e instanceof GatesError && e.status === 400);
  for (const bad of ['1BAD', 'HAS SPACE', 'A=B', '*', 'A**', '']) {
    assert.throws(() => s.patchApp({ envKeep: [bad] }), (e: unknown) => e instanceof GatesError && e.status === 400, bad);
  }
  assert.throws(() => s.patchProject(P, { envKeep: ['AWS_PROFILE'] }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('overrides: a permission gate may be turned off or capped, signed; unknown gates, rails and bad values are refused', async () => {
  const { open } = mk(); const s = open();
  s.patchProject(P, { overrides: { 'github-write-card': false, 'attempt-caps': { on: true, limit: 6 } } });
  await s.flush();
  assert.deepEqual(open().project(P).overrides, { 'github-write-card': false, 'attempt-caps': { on: true, limit: 6 } });
  for (const bad of [{ 'no-such-gate': false }, { 'rail-ceiling': false }, { 'qa-evidence': false }, { 'github-write-card': 'no' }, { 'attempt-caps': { on: true, limit: 0 } }, { 'attempt-caps': { on: true, limit: 101 } }, { 'attempt-caps': { on: true, limit: 2.5 } }, { 'attempt-caps': { on: false, limit: 3 } }]) {
    assert.throws(() => s.patchProject(P, { overrides: bad }), (e: unknown) => e instanceof GatesError && e.status === 400, JSON.stringify(bad));
  }
  assert.throws(() => s.patchProject(P, { overrides: [] }), (e: unknown) => e instanceof GatesError && e.status === 400);
});

test('the shell floor has no switch: a patch that names shellFloorOff is refused', () => {
  const s = mk().open();
  assert.throws(() => s.patchApp({ shellFloorOff: true } as never), /no switch/);
  assert.throws(() => s.patchProject(P, { shellFloorOff: false } as never), /no switch/);
  assert.equal('shellFloorOff' in s.app(), false);
});

test('an old signed file that holds shellFloorOff is read, the field is dropped, and the next save writes it signed without it', async () => {
  const { dir, open, signer } = mk();
  const old = { version: 1, preset: 'smart', shellFloorOff: true };
  const f = join(dir, 'app.json');
  open(); // make sure the folder exists
  writeFileSync(f, JSON.stringify({ ...old, sig: signer!.sign('app', canonicalize(old as never)) }));
  const t = open();
  assert.equal(t.app().preset, 'smart', 'the signature was valid, so the rest applies');
  assert.equal('shellFloorOff' in t.app(), false, 'the field is dropped on load');
  assert.deepEqual(t.changedOutside(), []);
  await t.flush();
  const disk = readJson(f);
  assert.equal('shellFloorOff' in disk, false, 'rewritten without it');
  assert.equal(disk.preset, 'smart');
  assert.deepEqual(open().changedOutside(), [], 'and the rewritten file verifies');
  assert.equal(open().app().preset, 'smart');
});

test('an unsigned Ask file that still holds shellFloorOff is read as plain Ask and the field is gone after the next save', async () => {
  const { dir, open } = mk(); open();
  const f = join(dir, 'app.json');
  writeFileSync(f, JSON.stringify({ version: 1, preset: 'ask', shellFloorOff: true }));
  const t = open();
  assert.deepEqual(t.app(), { version: 1, preset: 'ask' });
  assert.deepEqual(t.changedOutside(), []);
  await t.flush();
  assert.equal('shellFloorOff' in readJson(f), false);
});

test('canonicalize ignores key order, also in nested values', () => {
  assert.equal(canonicalize({ version: 1, preset: 'ask', limit: true }), canonicalize({ limit: true, version: 1, preset: 'ask' }));
  assert.equal(
    canonicalize({ version: 1, overrides: { 'github-write-card': false, 'attempt-caps': { on: true, limit: 4 } } }),
    canonicalize({ overrides: { 'attempt-caps': { limit: 4, on: true }, 'github-write-card': false }, version: 1 }),
  );
  assert.notEqual(canonicalize({ version: 1, preset: 'ask' }), canonicalize({ version: 1, preset: 'bypass' }));
});

test('prune removes the file of a project that no longer exists, signed or not, and its changed-outside mark', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'bypass' }); await s.flush();
  assert.equal(existsSync(join(dir, `${P}.json`)), true);
  s.prune(['proj_cccccccccccc']); await s.flush();
  assert.equal(existsSync(join(dir, `${P}.json`)), false);
  const f = join(dir, `${P}.json`);
  writeFileSync(f, JSON.stringify({ version: 1, preset: 'bypass', sig: 'ab' }));
  const t = open();
  assert.deepEqual(t.changedOutside(), [P]);
  t.prune(['proj_cccccccccccc']); await t.flush();
  assert.deepEqual(t.changedOutside(), []);
  assert.equal(existsSync(f), false);
});

test('view() reports what changed outside and whether the core can sign', async () => {
  const { dir, open } = mk(); const s = open();
  s.patchProject(P, { preset: 'ask' }); await s.flush();
  const f = join(dir, `${P}.json`); const j = readJson(f); j.preset = 'bypass'; writeFileSync(f, JSON.stringify(j));
  const v = open().view([P]);
  assert.deepEqual(v.changedOutside, [P]);
  assert.equal(v.canSign, true);
  assert.equal(mk(null).open().view([]).canSign, false);
});
