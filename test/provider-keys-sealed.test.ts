import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { readLaunchSecrets } from '../src/core/admin.js';
import { ProviderKeyring } from '../src/core/providers/keyring.js';
import { keyFileFor, keyStoreDoctor, keyStoreLine, ProviderKeys, sealedFileFor } from '../src/core/providers/secrets.js';
import { updateCommitted } from '../src/core/updater/committed.js';
import { runDoctor } from '../src/core/doctor.js';
import { defaultConfig, VERSION } from '../src/shared/config.js';
import { clearRegisteredSecrets, redact } from '../src/core/log/redact.js';
import { sealBlob } from '../src/core/connectors/store.js';
import { tempDir } from './tmp-cleanup.js';

// Made-up keys, written in two parts so the export scan (which refuses a whole key-shaped string) does not take them for real ones.
const K1 = 'sk-' + 'test-alpha-0123456789abcdef';
const K2 = 'sk-' + 'test-bravo-0123456789abcdef';
const K3 = 'web-test-charlie-0123456789';
const O1 = 'https://a.example';
const O2 = 'https://b.example';
const dk = (): Buffer => randomBytes(32);

const setup = () => { const dir = tempDir('legion-pk-sealed-'); mkdirSync(join(dir, 'providers'), { recursive: true }); return { dir, plain: keyFileFor(dir), enc: sealedFileFor(dir) }; };
const allText = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else out.push(readFileSync(p).toString('latin1')); } };
  walk(dir);
  return out.join('\n');
};
const writePlain = (file: string, keys: Record<string, { key: string; origin: string }>) => {
  const k = new ProviderKeys(file); // a plain 0.3.4-style store writes the old file
  for (const [id, v] of Object.entries(keys)) k.set(id, v.key, v.origin);
};

// ------------------------------------------------------------------------------------------------ sealed store

test('with a data key a saved key is in keys.enc only: not in keys.json, not as text anywhere under the data folder', () => {
  const { dir, plain, enc } = setup();
  const k = new ProviderKeys(plain, { dataKey: dk() });
  k.set('openai', K1, O1);
  k.set('web:exa', K3, O2);
  assert.equal(existsSync(enc), true);
  assert.equal(existsSync(plain), false, 'no plain file is made');
  const text = allText(dir);
  for (const v of [K1, K3]) assert.equal(text.includes(v), false);
  assert.equal(text.includes('openai'), false, 'not even the ids are readable');
  assert.deepEqual(k.status(), { mode: 'encrypted', locked: false });
  if (process.platform !== 'win32') assert.equal(statSync(enc).mode & 0o077, 0, 'owner only');
});

test('the public interface is unchanged with a data key: get, origin binding, has, hint, all, remove, dropIfOriginDiffers, restart', () => {
  const { plain } = setup();
  const key = dk();
  const k = new ProviderKeys(plain, { dataKey: key });
  assert.throws(() => k.set('openai', 'short', O1), /characters/);
  k.set('openai', K1, O1);
  k.set('web:exa', K3, O2);
  assert.equal(k.get('openai', O1), K1);
  assert.equal(k.get('openai', O2), undefined);
  assert.equal(k.hint('openai'), '…' + K1.slice(-4));
  assert.deepEqual(k.all().sort(), [K1, K3].sort(), 'redaction still covers every key');
  const again = new ProviderKeys(plain, { dataKey: key });
  assert.equal(again.get('openai', O1), K1, 'survives a restart');
  assert.equal(again.get('web:exa', O2), K3);
  assert.equal(again.dropIfOriginDiffers('openai', 'https://evil.example'), true);
  assert.equal(new ProviderKeys(plain, { dataKey: key }).has('openai'), false);
  assert.equal(again.remove('web:exa'), true);
  assert.equal(new ProviderKeys(plain, { dataKey: key }).all().length, 0);
});

test('redaction: the exact-value list the runtime uses (keys.all()) holds every sealed key', () => {
  const { plain } = setup();
  const k = new ProviderKeys(plain, { dataKey: dk() });
  k.set('a', K1, O1); k.set('b', K2, O1); k.set('web:tavily', K3, O2);
  assert.deepEqual(new Set(k.all()), new Set([K1, K2, K3]));
});

// ------------------------------------------------------------------------------------------------ K1 migration

test('K1 a start with a data key seals keys.json into keys.enc, verified by reading it back, and keeps keys.json', () => {
  const { plain, enc } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 }, other: { key: K2, origin: O2 } });
  const before = readFileSync(plain, 'utf8');
  const key = dk();
  const k = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  assert.equal(k.get('openai', O1), K1);
  assert.equal(k.get('other', O2), K2);
  assert.equal(existsSync(enc), true);
  assert.equal(readFileSync(plain, 'utf8'), before, 'keys.json is untouched at the migration');
  assert.equal(readFileSync(enc).toString('latin1').includes(K1), false);
  // opens again with the same key and holds exactly the same entries
  const reopened = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  assert.deepEqual([reopened.all().sort(), reopened.originOf('other')], [[K1, K2].sort(), O2]);
});

test('K1 a migration whose read-back fails keeps keys.json readable, removes the bad keys.enc, refuses saves (F3: a data key never writes plain); nothing is lost', () => {
  const { plain, enc } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  // a data key of the wrong length cannot seal: the read-back can never succeed
  const k = new ProviderKeys(plain, { dataKey: Buffer.alloc(5), committed: () => true });
  assert.equal(k.get('openai', O1), K1);
  assert.equal(existsSync(enc), false);
  assert.equal(existsSync(plain), true);
  assert.deepEqual(k.status(), { mode: 'plain', locked: false, reason: 'sealing-failed', blocked: true });
  assert.throws(() => k.set('x', K2, O1), /did not unlock/);
  assert.equal(JSON.parse(readFileSync(plain, 'utf8')).keys.x, undefined, 'no plain save on a machine with a data key');
});

test('K1 keep-copy window: a save writes BOTH files while keys.json is kept', () => {
  const { plain, enc } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  const key = dk();
  const k = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  k.set('late', K2, O2);
  assert.equal(JSON.parse(readFileSync(plain, 'utf8')).keys.late.key, K2, 'a rollback to 0.3.4 now still finds the newest key');
  assert.equal(new ProviderKeys(plain, { dataKey: key, committed: () => false }).get('late', O2), K2);
  k.remove('openai');
  assert.equal(JSON.parse(readFileSync(plain, 'utf8')).keys.openai, undefined);
  assert.equal(existsSync(enc), true);
});

test('K1 keys.json is retired only after the update is committed AND a later start opened keys.enc', () => {
  const { dir, plain, enc } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  const key = dk();
  let committed = false;
  const open = () => new ProviderKeys(plain, { dataKey: key, committed: () => committed });
  open(); // start 1: migrates
  assert.equal(existsSync(plain), true);
  open(); // start 2, update not committed yet
  assert.equal(existsSync(plain), true, 'not committed: kept');
  committed = true;
  const k = open(); // start 3: committed, and an earlier start already migrated
  assert.equal(existsSync(plain), false, 'retired');
  assert.equal(k.get('openai', O1), K1);
  assert.equal(allText(dir).includes(K1), false, 'no copy of the key in clear is left');
  assert.equal(open().get('openai', O1), K1);
  assert.equal(existsSync(enc), true);
  k.set('after', K2, O1);
  assert.equal(existsSync(plain), false, 'after retirement a save writes keys.enc only');
});

test('K1 the migrating start itself never retires keys.json, even when already committed (a dev run, a fresh update)', () => {
  const { plain } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  const key = dk();
  new ProviderKeys(plain, { dataKey: key, committed: () => true });
  assert.equal(existsSync(plain), true);
  new ProviderKeys(plain, { dataKey: key, committed: () => true });
  assert.equal(existsSync(plain), false);
});

test('K1 with both files in step but no record of an earlier start, the start records it and keeps keys.json', () => {
  const { dir, plain } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  const key = dk();
  new ProviderKeys(plain, { dataKey: key, committed: () => true });
  rmSync(join(dir, 'providers', 'keys-keep.json'));
  new ProviderKeys(plain, { dataKey: key, committed: () => true });
  assert.equal(existsSync(plain), true);
  new ProviderKeys(plain, { dataKey: key, committed: () => true });
  assert.equal(existsSync(plain), false);
});

test('K1 rollback inside the window: 0.3.4 re-saves keys.json; the next start takes its changes in, loses nothing, and waits again before retiring', () => {
  const { plain } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 }, web: { key: K3, origin: O2 } });
  const key = dk();
  new ProviderKeys(plain, { dataKey: key, committed: () => true }); // migrates
  // 0.3.4 runs: it changes a key in keys.json and knows nothing of keys.enc
  const old = JSON.parse(readFileSync(plain, 'utf8'));
  old.keys.openai = { key: K2, origin: O1 };
  writeFileSync(plain, JSON.stringify(old, null, 2));
  const k = new ProviderKeys(plain, { dataKey: key, committed: () => true });
  assert.equal(k.get('openai', O1), K2, 'the newer key from the rolled-back run wins');
  assert.equal(k.get('web', O2), K3);
  assert.equal(existsSync(plain), true, 'a start that took changes in does not retire');
  assert.equal(new ProviderKeys(plain, { dataKey: key, committed: () => true }).get('openai', O1), K2);
  assert.equal(existsSync(plain), false, 'retired on the next committed start');
});

test('K1 a keys.json written while keys.enc is unreadable (wrong key) is used to rebuild keys.enc, the old file is kept aside', () => {
  const { dir, plain, enc } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  new ProviderKeys(plain, { dataKey: dk(), committed: () => false }); // sealed under a key that is then lost
  const k = new ProviderKeys(plain, { dataKey: dk(), committed: () => false });
  assert.equal(k.get('openai', O1), K1, 'recovered from the keep copy');
  assert.deepEqual(k.status(), { mode: 'encrypted', locked: false, keepCopy: true }, 'the keep copy is still there');
  assert.ok(readdirSync(join(dir, 'providers')).some((n) => n.startsWith('keys.enc.unreadable-')), 'the unreadable file is renamed, not deleted');
  assert.equal(existsSync(enc), true);
});

// ------------------------------------------------------------------------------------------------ K3 lost key store

test('K3 wrong key, truncated file, garbage: keys read as not set, no crash, nothing deleted; a save is refused (R2) and the file is left where it is', () => {
  for (const damage of ['wrong-key', 'truncated', 'garbage', 'empty'] as const) {
    const { dir, plain, enc } = setup();
    const key = dk();
    new ProviderKeys(plain, { dataKey: key }).set('openai', K1, O1);
    const good = readFileSync(enc);
    if (damage === 'truncated') writeFileSync(enc, good.subarray(0, 20));
    if (damage === 'garbage') writeFileSync(enc, Buffer.from('this is not a sealed file at all, nope'));
    if (damage === 'empty') writeFileSync(enc, Buffer.alloc(0));
    const k = new ProviderKeys(plain, { dataKey: damage === 'wrong-key' ? dk() : key });
    assert.equal(k.has('openai'), false, damage);
    assert.deepEqual(k.status(), { mode: 'encrypted', locked: true, blocked: true }, damage);
    const kept = readFileSync(enc);
    assert.equal(existsSync(enc), true, 'not deleted by a read');
    assert.throws(() => k.set('openai', K2, O1), /did not unlock/, damage);
    assert.deepEqual(readFileSync(enc), kept, `${damage}: a refused save changes nothing`);
    assert.equal(readdirSync(join(dir, 'providers')).filter((n) => n.startsWith('keys.enc.unreadable-')).length, 0, `${damage}: nothing set aside without the owner's start over`);
  }
});

test('K3 a file sealed by a different version byte or tampered is unreadable, never a crash', () => {
  const { plain, enc } = setup();
  const key = dk();
  writeFileSync(enc, Buffer.concat([Buffer.from([9]), sealBlob(key, Buffer.from('{}')).subarray(1)]));
  const k = new ProviderKeys(plain, { dataKey: key });
  assert.equal(k.status().locked, true);
  assert.equal(k.all().length, 0);
});

test('K3 a sealed document of the wrong shape is unreadable too', () => {
  const { plain, enc } = setup();
  const key = dk();
  writeFileSync(enc, sealBlob(key, Buffer.from('[1,2,3]')));
  assert.equal(new ProviderKeys(plain, { dataKey: key }).status().locked, true);
});

// ------------------------------------------------------------------------------------------------ K2 fallback

test('K2 no data key: exactly today (keys.json, owner only, atomic); the status says why', () => {
  for (const noKey of [undefined, 'unavailable', 'headless'] as const) {
    const { plain, enc } = setup();
    const k = new ProviderKeys(plain, noKey ? { noKey } : {});
    k.set('openai', K1, O1);
    assert.equal(JSON.parse(readFileSync(plain, 'utf8')).keys.openai.key, K1);
    assert.equal(existsSync(enc), false);
    assert.deepEqual(k.status(), { mode: 'plain', locked: false, reason: noKey ?? 'headless' });
    if (process.platform !== 'win32') assert.equal(statSync(plain).mode & 0o077, 0);
    assert.equal(new ProviderKeys(plain, noKey ? { noKey } : {}).get('openai', O1), K1);
  }
});

test('K2/F4 no usable key store with an existing keys.enc: blocked, keys.enc untouched, saves refused (never plain); when the key store works again the keys are all there', () => {
  const { plain, enc } = setup();
  const key = dk();
  new ProviderKeys(plain, { dataKey: key }).set('openai', K1, O1);
  const sealed = readFileSync(enc);
  const k = new ProviderKeys(plain, { noKey: 'unavailable' });
  assert.deepEqual(k.status(), { mode: 'plain', locked: true, reason: 'unavailable', blocked: true });
  assert.equal(k.has('openai'), false);
  assert.throws(() => k.set('new', K2, O1), /did not unlock/);
  assert.deepEqual(readFileSync(enc), sealed, 'keys.enc is not changed');
  assert.equal(existsSync(plain), false);
  const back = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  assert.equal(back.get('openai', O1), K1);
});

test('R2 a wrapped key that does not unwrap (PKEY - unreadable) leaves keys.enc alone, reports locked and blocked, and refuses a save', () => {
  const { plain, enc } = setup();
  new ProviderKeys(plain, { dataKey: dk() }).set('openai', K1, O1);
  const sealed = readFileSync(enc);
  const k = new ProviderKeys(plain, { noKey: 'unreadable' });
  assert.deepEqual(k.status(), { mode: 'plain', locked: true, reason: 'unreadable', blocked: true });
  assert.equal(k.has('openai'), false);
  assert.throws(() => k.set('new', K2, O1), /did not unlock/);
  assert.deepEqual(readFileSync(enc), sealed);
  assert.equal(existsSync(plain), false, 'no plain file is made on a machine that can encrypt');
});

test('an unparseable keys.json is read as empty and not touched at a start (as before)', () => {
  const { plain } = setup();
  writeFileSync(plain, '{ not json');
  const k = new ProviderKeys(plain, { dataKey: dk() });
  assert.equal(k.all().length, 0);
  assert.equal(readFileSync(plain, 'utf8'), '{ not json');
});

// ------------------------------------------------------------------------------------------------ text for Settings and Doctor (K4, K5)

test('K4 the Settings line is short, plain, honest per mode, and has no em dash', () => {
  const lines = [
    keyStoreLine({ mode: 'encrypted', locked: false }),
    keyStoreLine({ mode: 'plain', locked: false, reason: 'unavailable' }),
    keyStoreLine({ mode: 'plain', locked: false, reason: 'headless' }),
    keyStoreLine({ mode: 'encrypted', locked: true }),
    keyStoreLine({ mode: 'plain', locked: true, reason: 'unreadable' }),
  ];
  assert.match(lines[0]!, /encrypted/i);
  assert.match(lines[0]!, /anyone who copies/i);
  assert.match(lines[0]!, /command running as you/i);
  assert.match(lines[1]!, /not encrypted|unencrypted/i);
  assert.match(lines[3]!, /could not be unlocked on this system\. Paste them again\./);
  assert.match(lines[4]!, /could not be unlocked on this system\. Paste them again\./);
  for (const l of lines) { assert.ok(l.length < 330, l); assert.doesNotMatch(l, /[—–]/); }
});

test('K5 the Doctor strings', () => {
  assert.deepEqual(keyStoreDoctor({ mode: 'encrypted', locked: false }), { ok: true, detail: 'Encrypted with your system key store' });
  const plainOne = keyStoreDoctor({ mode: 'plain', locked: false, reason: 'unavailable' });
  assert.equal(plainOne.ok, true);
  assert.match(plainOne.detail, /^Stored unencrypted on this system: .+/);
  const locked = keyStoreDoctor({ mode: 'encrypted', locked: true });
  assert.equal(locked.ok, false);
  assert.equal(locked.detail, 'Could not be unlocked: paste them again');
  assert.equal(keyStoreDoctor({ mode: 'plain', locked: true, reason: 'unreadable' }).ok, false);
  for (const s of [plainOne, locked]) assert.doesNotMatch(JSON.stringify(s), /[—–]/);
});

test('K5 runDoctor adds the provider-keys check when it is given the key store, and the check holds no key value', async () => {
  const { plain } = setup();
  const k = new ProviderKeys(plain, { dataKey: dk() });
  k.set('openai', K1, O1);
  const cfg = defaultConfig();
  const checks = await runDoctor({ config: cfg, getBoat: () => null, keys: k, queryFn: (() => { throw new Error('no'); }) as never });
  const c = checks.find((x) => x.id === 'provider-keys')!;
  assert.equal(c.label, 'Provider keys');
  assert.equal(c.ok, true);
  assert.equal(c.detail, 'Encrypted with your system key store');
  assert.equal(JSON.stringify(checks).includes(K1), false);
  const none = await runDoctor({ config: cfg, getBoat: () => null, queryFn: (() => { throw new Error('no'); }) as never });
  assert.equal(none.some((x) => x.id === 'provider-keys'), false, 'no key store given: no check (nothing else changes)');
});

// ------------------------------------------------------------------------------------------------ launch line

const HEX = randomBytes(32).toString('hex');
test('the PKEY line: only the documented forms count; the first key wins; a key beats a later "no key" and a no-key does not beat a key', () => {
  const kr = new ProviderKeyring();
  for (const bad of [`PKEY ${HEX.slice(1)}`, `PKEYS ${HEX}`, `pkey ${HEX}`, `PKEY ${HEX.toUpperCase()}`, `KEY ${HEX}`, `PKEY ${HEX} x`, `PKEY - other`, 'x'.repeat(500)]) assert.equal(kr.installLine(bad), false, bad);
  assert.equal(kr.has(), false);
  assert.equal(kr.noKey(), undefined);
  assert.equal(kr.installLine(`PKEY ${HEX}`), true);
  assert.deepEqual(kr.get(), Buffer.from(HEX, 'hex'));
  assert.equal(kr.installLine(`PKEY ${randomBytes(32).toString('hex')}`), false);
  assert.equal(kr.installLine('PKEY - unavailable'), false);
  assert.equal(String(kr), '[ProviderKeyring]');
  assert.equal(JSON.stringify(kr), '"[ProviderKeyring]"');
  const none = new ProviderKeyring();
  assert.equal(none.installLine('PKEY - unreadable'), true);
  assert.equal(none.noKey(), 'unreadable');
  assert.equal(none.installLine(`PKEY ${HEX}`), false);
  assert.equal(none.get(), undefined);
});

test('the key is registered with the log redactor from the moment the core holds it', () => {
  clearRegisteredSecrets();
  const kr = new ProviderKeyring();
  kr.installLine(`PKEY ${HEX}`);
  assert.equal(redact(`oops ${HEX} oops`).includes(HEX), false);
});

test('the PKEY line arrives on the launch pipe in the same chunk as the other lines', async () => {
  const ADMIN = 'a'.repeat(64); const NATIVE = 'b'.repeat(64);
  const kr = new ProviderKeyring();
  const s = new PassThrough();
  const p = readLaunchSecrets({ LEGION_ADMIN_STDIN: '1' }, s, (l) => { kr.installLine(l); });
  s.write(`${ADMIN}\n${NATIVE}\nGATESKEY - unreadable\nPKEY ${HEX}\nKEY ${randomBytes(32).toString('hex')}\n`);
  s.end();
  assert.deepEqual(await p, { admin: ADMIN, native: NATIVE });
  assert.deepEqual(kr.get(), Buffer.from(HEX, 'hex'));
});

// ------------------------------------------------------------------------------------------------ "committed" from the updater's own files

test('committed: no update folder is a non-updater start; the journal and the live marker decide otherwise', () => {
  const dir = tempDir('legion-commit-');
  assert.equal(updateCommitted(dir), true, 'a fresh install or a dev run');
  const up = join(dir, '.update');
  const journal = (state: string) => { writeFileSync(join(up, 'journal.json'), JSON.stringify({ state, from: '0.3.4', to: '0.3.5', entries: ['dist'], stagedDir: 'x', at: 1, heartbeat: 1 })); };
  mkdirSync(up, { recursive: true });
  for (const [state, want] of [['swapping', false], ['awaiting-health', false], ['committed', true], ['rolled-back', true]] as const) { journal(state); assert.equal(updateCommitted(dir, '0.3.5'), want, state); }
  journal('committed');
  writeFileSync(join(up, 'update-in-progress.json'), '{}');
  assert.equal(updateCommitted(dir, '0.3.5'), false, 'a live update marker');
  writeFileSync(join(up, 'journal.json'), '{ not json');
  assert.equal(updateCommitted(dir), false, 'the marker still holds');
  rmSync(join(up, 'update-in-progress.json'));
  assert.equal(updateCommitted(dir), false, 'an unreadable journal is never counted as committed');
});

test('C-L1: a committed journal counts only when its target is the version that is running', () => {
  const dir = tempDir('legion-commit-ver-');
  const up = join(dir, '.update');
  mkdirSync(up, { recursive: true });
  const journal = (to: string) => { writeFileSync(join(up, 'journal.json'), JSON.stringify({ state: 'committed', from: '0.3.3', to, entries: [], stagedDir: 'x', at: 1, heartbeat: 1 })); };
  journal('0.3.5');
  assert.equal(updateCommitted(dir, '0.3.5'), true, 'this update committed');
  journal('0.3.4'); // an earlier update, then a manual reinstall of 0.3.5 into the same folder
  assert.equal(updateCommitted(dir, '0.3.5'), false, 'a stale committed journal from the update before');
  journal('0.0.1');
  assert.equal(updateCommitted(dir, '0.3.5'), false, 'a committed journal for a version this tree is not');
  journal(VERSION);
  assert.equal(updateCommitted(dir), true, 'with no version given, the running VERSION is the one that counts');
});


test('N2: while a plain copy stays next to keys.enc, the status says so and the Settings line says why it is there', () => {
  const { plain } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  const k = new ProviderKeys(plain, { dataKey: dk() });
  assert.equal(existsSync(plain), true, 'the migration keeps the plain copy');
  const st = k.status();
  assert.equal(st.mode, 'encrypted');
  assert.equal(st.keepCopy, true);
  const line = keyStoreLine(st);
  assert.match(line, /Until this update is final, a plain copy stays next to them so you can go back to 0\.3\.4\./);
  assert.doesNotMatch(line, /[—–]/);
  assert.ok(line.length < 330, String(line.length));
  // no plain copy: no sentence about one, and the status stays as it was
  const fresh = setup();
  const k2 = new ProviderKeys(fresh.plain, { dataKey: dk() });
  k2.set('openai', K1, O1);
  assert.deepEqual(k2.status(), { mode: 'encrypted', locked: false });
  assert.doesNotMatch(keyStoreLine(k2.status()), /plain copy/);
});
