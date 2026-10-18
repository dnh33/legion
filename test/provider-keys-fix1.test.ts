import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyFileFor, keyStoreDoctor, keyStoreLine, ProviderKeys, sealedFileFor } from '../src/core/providers/secrets.js';
import { tempDir } from './tmp-cleanup.js';

// Made-up keys, written in two parts so the export scan (which refuses a whole key-shaped string) does not take them for real ones.
const K1 = 'sk-' + 'test-alpha-0123456789abcdef';
const K2 = 'sk-' + 'test-bravo-0123456789abcdef';
const K3 = 'web-test-charlie-0123456789';
const O1 = 'https://a.example';
const O2 = 'https://b.example';
const REFUSED = 'Your system key store did not unlock, so Legion cannot save keys safely right now. Restart Legion. If it keeps happening, start over with new keys in Settings.';
const dk = (): Buffer => randomBytes(32);

const setup = () => { const dir = tempDir('legion-pk-fix1-'); mkdirSync(join(dir, 'providers'), { recursive: true }); return { dir, plain: keyFileFor(dir), enc: sealedFileFor(dir) }; };
const aside = (dir: string, stem: string): string[] => readdirSync(join(dir, 'providers')).filter((n) => n.startsWith(`${stem}.unreadable-`));
const writePlain = (file: string, keys: Record<string, { key: string; origin: string }>) => {
  const k = new ProviderKeys(file); // a plain 0.3.4-style store writes the old file
  for (const [id, v] of Object.entries(keys)) k.set(id, v.key, v.origin);
};

// ------------------------------------------------------------------------------------------------ R2: a machine that can encrypt never saves plain

test('R2 key.bin did not unwrap (PKEY - unreadable): saves are refused with the plain words, nothing is written anywhere', () => {
  const { dir, plain, enc } = setup();
  const k = new ProviderKeys(plain, { noKey: 'unreadable' });
  assert.throws(() => k.set('openai', K1, O1), (e: Error) => e.message === REFUSED);
  assert.equal(k.has('openai'), false, 'the refused key is not held in memory either');
  assert.equal(existsSync(plain), false, 'no plain file');
  assert.equal(existsSync(enc), false);
  assert.deepEqual(readdirSync(join(dir, 'providers')), []);
  assert.equal(k.status().blocked, true);
  assert.equal(k.remove('openai'), false, 'removing what is not there is a no-op, not an error');
});

test('R2 keys.enc does not open with the key: reads show not set, saves are refused, keys.enc is byte for byte unchanged and not set aside', () => {
  for (const damage of ['wrong-key', 'truncated', 'garbage'] as const) {
    const { dir, plain, enc } = setup();
    const key = dk();
    new ProviderKeys(plain, { dataKey: key }).set('openai', K1, O1);
    if (damage === 'truncated') writeFileSync(enc, readFileSync(enc).subarray(0, 20));
    if (damage === 'garbage') writeFileSync(enc, Buffer.from('this is not a sealed file at all, nope'));
    const before = readFileSync(enc);
    const k = new ProviderKeys(plain, { dataKey: damage === 'wrong-key' ? dk() : key });
    assert.equal(k.has('openai'), false, damage);
    assert.equal(k.status().blocked, true, damage);
    assert.equal(k.status().locked, true, damage);
    assert.throws(() => k.set('openai', K2, O1), (e: Error) => e.message === REFUSED, damage);
    assert.deepEqual(readFileSync(enc), before, `${damage}: untouched`);
    assert.deepEqual(aside(dir, 'keys.enc'), [], `${damage}: nothing was set aside by a refused save`);
    assert.equal(existsSync(plain), false);
  }
});

test('R2 dropIfOriginDiffers cannot save either: it does nothing while blocked (the key stays bound to its old origin)', () => {
  const { plain } = setup();
  const k = new ProviderKeys(plain, { noKey: 'unreadable' });
  assert.equal(k.dropIfOriginDiffers('openai', O2), false);
});

test('R2 the plain fallback stays only for "no usable key store": unavailable and no line at all still save to keys.json', () => {
  for (const noKey of ['unavailable', undefined] as const) {
    const { plain } = setup();
    const k = new ProviderKeys(plain, noKey ? { noKey } : {});
    k.set('openai', K1, O1);
    assert.equal(JSON.parse(readFileSync(plain, 'utf8')).keys.openai.key, K1);
    assert.equal(k.status().blocked, undefined);
  }
});

test('R2 a bad keys.enc with a keep copy in keys.json still rebuilds from the copy (recovery, not a save): not blocked', () => {
  const { plain } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  new ProviderKeys(plain, { dataKey: dk(), committed: () => false });
  const k = new ProviderKeys(plain, { dataKey: dk(), committed: () => false });
  assert.equal(k.get('openai', O1), K1);
  assert.equal(k.status().blocked, undefined);
});

test('R2 startOver sets keys.enc aside (renamed, never deleted), reads stay not set, and only works while blocked', () => {
  const { dir, plain, enc } = setup();
  const key = dk();
  new ProviderKeys(plain, { dataKey: key }).set('openai', K1, O1);
  const sealed = readFileSync(enc);
  const ok = new ProviderKeys(plain, { dataKey: key });
  assert.throws(() => ok.startOver(), /nothing to start over/i, 'not blocked: refused');
  assert.equal(existsSync(enc), true);
  const k = new ProviderKeys(plain, { dataKey: dk() }); // the key does not open it
  assert.equal(k.startOver(), true);
  assert.equal(existsSync(enc), false);
  const [name] = aside(dir, 'keys.enc');
  assert.match(name!, /^keys\.enc\.unreadable-\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(readFileSync(join(dir, 'providers', name!)), sealed, 'the old file is kept as it was');
  assert.equal(k.has('openai'), false);
  // a second round the same day does not overwrite the first
  writeFileSync(enc, Buffer.from('another unreadable file'));
  const again = new ProviderKeys(plain, { dataKey: dk() });
  assert.equal(again.startOver(), true);
  assert.equal(aside(dir, 'keys.enc').length, 2);
});

test('R2 after startOver the next start (a new data key, no keys.enc) is a fresh sealed store; saves work', () => {
  const { plain, enc } = setup();
  new ProviderKeys(plain, { dataKey: dk() }).set('openai', K1, O1);
  const stuck = new ProviderKeys(plain, { dataKey: dk() });
  stuck.startOver();
  const fresh = new ProviderKeys(plain, { dataKey: dk() });
  assert.equal(fresh.status().blocked, undefined);
  assert.deepEqual(fresh.status(), { mode: 'encrypted', locked: false });
  fresh.set('openai', K2, O1);
  assert.equal(existsSync(enc), true);
  assert.equal(fresh.get('openai', O1), K2);
});

test('R2 startOver when key.bin was the problem (no data key): keys.enc is set aside too, the next start with a new key is clean', () => {
  const { dir, plain, enc } = setup();
  new ProviderKeys(plain, { dataKey: dk() }).set('openai', K1, O1);
  const k = new ProviderKeys(plain, { noKey: 'unreadable' });
  assert.equal(k.status().blocked, true);
  assert.equal(k.startOver(), true);
  assert.equal(existsSync(enc), false);
  assert.equal(aside(dir, 'keys.enc').length, 1);
  const fresh = new ProviderKeys(plain, { dataKey: dk() });
  fresh.set('x', K2, O1);
  assert.equal(fresh.get('x', O1), K2);
});

test('R2 startOver with nothing to set aside (unreadable key.bin, no keys.enc) still succeeds, so a retry after a half-finished start over works', () => {
  const { plain } = setup();
  const k = new ProviderKeys(plain, { noKey: 'unreadable' });
  assert.equal(k.startOver(), true);
});

test('R2 words: the Settings line and the Doctor check say what is wrong and what to do; no em dash', () => {
  const s = { mode: 'encrypted' as const, locked: true, blocked: true as const };
  assert.equal(keyStoreLine(s), REFUSED);
  const d = keyStoreDoctor(s);
  assert.equal(d.ok, false);
  assert.match(d.detail, /did not unlock/i);
  assert.match(d.fix ?? '', /Restart Legion/);
  assert.doesNotMatch(`${keyStoreLine(s)}${d.detail}${d.fix}`, /[—–]/);
});

// ------------------------------------------------------------------------------------------------ R3: keys.json is the source of truth while it exists

test('R3 rollback, remove a key on 0.3.4, go forward: the removed key does not come back, the others stay, a key added on 0.3.4 is in', () => {
  const { plain, enc } = setup();
  writePlain(plain, { a: { key: K1, origin: O1 }, b: { key: K2, origin: O2 } });
  const key = dk();
  new ProviderKeys(plain, { dataKey: key, committed: () => false }); // 0.3.5 migrates and keeps keys.json
  // 0.3.4 (plain store, knows nothing of keys.enc): removes a, adds c
  const old = new ProviderKeys(plain);
  assert.equal(old.remove('a'), true);
  old.set('c', K3, O1);
  const fwd = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  assert.equal(fwd.has('a'), false, 'the key removed on 0.3.4 stays removed');
  assert.equal(fwd.get('b', O2), K2);
  assert.equal(fwd.get('c', O1), K3);
  const reread = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  assert.deepEqual([...reread.all()].sort(), [K2, K3].sort(), 'and keys.enc itself no longer holds a');
  assert.equal(existsSync(enc), true);
});

test('R3 0.3.4 removed every key: keys.json says so and keys.enc follows', () => {
  const { plain } = setup();
  writePlain(plain, { a: { key: K1, origin: O1 } });
  const key = dk();
  new ProviderKeys(plain, { dataKey: key, committed: () => false });
  new ProviderKeys(plain).remove('a');
  const fwd = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  assert.equal(fwd.all().length, 0);
  assert.equal(new ProviderKeys(plain, { dataKey: key, committed: () => false }).all().length, 0);
});

test('R3 a keys.json that cannot be read does not wipe keys.enc (it says nothing)', () => {
  const { plain } = setup();
  writePlain(plain, { a: { key: K1, origin: O1 } });
  const key = dk();
  new ProviderKeys(plain, { dataKey: key, committed: () => false });
  writeFileSync(plain, '{ not json');
  const k = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  assert.equal(k.get('a', O1), K1);
});

test('R3 keys.json made on 0.3.4 AFTER the copy was retired (keys.enc had no copy to compare): both sets are kept, nothing could have been removed', () => {
  const { plain } = setup();
  const key = dk();
  new ProviderKeys(plain, { dataKey: key }).set('a', K1, O1); // keys.enc only, no keys.json
  writePlain(plain, { c: { key: K3, origin: O2 } }); // a downgrade: 0.3.4 knows only its own file
  const fwd = new ProviderKeys(plain, { dataKey: key, committed: () => false });
  assert.equal(fwd.get('a', O1), K1);
  assert.equal(fwd.get('c', O2), K3);
});
