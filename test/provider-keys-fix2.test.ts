import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyFileFor, keyStoreDoctor, keyStoreLine, ProviderKeys, sealedFileFor, KEYS_BLOCKED_MESSAGE } from '../src/core/providers/secrets.js';
import { providerChange } from '../src/electron/provider-ipc.js';
import type { ProviderIpcDeps } from '../src/electron/provider-ipc.js';
import { ensureProviderKey, providerKeyLaunchLine, providerKeyUnlocks, type SafeStorageLike } from '../src/electron/connector-key.js';
import { renameWithRetry } from '../src/shared/rename-retry.js';
import { repoRoot } from './ps-helpers.js';
import { tempDir } from './tmp-cleanup.js';

const K1 = 'sk-test-alpha-0123456789abcdef';
const K2 = 'sk-test-bravo-0123456789abcdef';
const K3 = 'web-test-charlie-0123456789';
const O1 = 'https://a.example';
const O2 = 'https://b.example';
const dk = (): Buffer => randomBytes(32);

const setup = () => { const dir = tempDir('legion-pk-fix2-'); mkdirSync(join(dir, 'providers'), { recursive: true }); return { dir, plain: keyFileFor(dir), enc: sealedFileFor(dir), keyBin: join(dir, 'providers', 'key.bin') }; };
const writePlain = (file: string, keys: Record<string, { key: string; origin: string }>) => {
  const k = new ProviderKeys(file);
  for (const [id, v] of Object.entries(keys)) k.set(id, v.key, v.origin);
};

// ------------------------------------------------------------------------------------------------ F1

test('F1 retire rewrites keys.enc without the digest: retire, downgrade to 0.3.4 (one key pasted), upgrade: every key is there', () => {
  const { plain, enc } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 }, other: { key: K2, origin: O2 } });
  const key = dk();
  let committed = false;
  const open = () => new ProviderKeys(plain, { dataKey: key, committed: () => committed });
  open(); open(); committed = true; open(); // migrate, keep, retire
  assert.equal(existsSync(plain), false, 'retired');
  const sealedAfterRetire = readFileSync(enc);
  // keys.enc now carries no digest: opening it with the key shows no jsonDigest
  const k = open();
  assert.equal(k.get('openai', O1), K1);
  // downgrade: 0.3.4 cannot see keys.enc, starts from an empty keys.json and the owner pastes one key
  writeFileSync(plain, JSON.stringify({ version: 1, keys: { web: { key: K3, origin: O1 } } }));
  const up = open();
  assert.equal(up.get('openai', O1), K1, 'a key from before the downgrade is not dropped');
  assert.equal(up.get('other', O2), K2);
  assert.equal(up.get('web', O1), K3);
  assert.notDeepEqual(readFileSync(enc), sealedAfterRetire);
});

// ------------------------------------------------------------------------------------------------ F3

test('F3 sealing-failed with a data key is blocked, not plain: keys stay readable, saves are refused with the ruled text, keys.json is not written', () => {
  const { plain, enc } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  const before = readFileSync(plain, 'utf8');
  const k = new ProviderKeys(plain, { dataKey: Buffer.alloc(5), committed: () => true });
  assert.equal(existsSync(enc), false);
  assert.equal(k.get('openai', O1), K1);
  assert.deepEqual(k.status(), { mode: 'plain', locked: false, reason: 'sealing-failed', blocked: true });
  assert.throws(() => k.set('x', K2, O1), new RegExp(KEYS_BLOCKED_MESSAGE.slice(0, 30)));
  assert.throws(() => k.remove('openai'), /did not unlock/);
  assert.equal(readFileSync(plain, 'utf8'), before, 'nothing written');
  assert.equal(keyStoreLine(k.status()), KEYS_BLOCKED_MESSAGE);
});

// ------------------------------------------------------------------------------------------------ F4

test('F4 PKEY - unavailable with a key.bin or a keys.enc in the providers folder is blocked: no plain write, no "could not be unlocked" line', () => {
  for (const mk of ['keyBin', 'enc'] as const) {
    const { plain, enc, keyBin } = setup();
    writeFileSync(mk === 'keyBin' ? keyBin : enc, 'wrapped');
    const k = new ProviderKeys(plain, { noKey: 'unavailable' });
    const st = k.status();
    assert.equal(st.blocked, true, mk);
    assert.throws(() => k.set('x', K2, O1), /did not unlock/);
    assert.equal(existsSync(plain), false, 'no plain file is made');
    assert.equal(keyStoreLine(st), KEYS_BLOCKED_MESSAGE);
    assert.equal(keyStoreDoctor(st).ok, false);
    assert.match(keyStoreDoctor(st).detail, /did not unlock/);
    assert.doesNotMatch(keyStoreLine(st), /could not be unlocked/);
  }
});

test('F4 PKEY - unavailable on a machine that never encrypted stays plain; so does a headless core with no admin pipe, even with leftover files', () => {
  const a = setup();
  const ka = new ProviderKeys(a.plain, { noKey: 'unavailable' });
  ka.set('openai', K1, O1);
  assert.deepEqual(ka.status(), { mode: 'plain', locked: false, reason: 'unavailable' });
  assert.equal(JSON.parse(readFileSync(a.plain, 'utf8')).keys.openai.key, K1);
  const b = setup();
  writeFileSync(b.keyBin, 'wrapped'); writeFileSync(b.enc, 'sealed');
  const kb = new ProviderKeys(b.plain, {});
  kb.set('openai', K1, O1);
  assert.equal(kb.status().blocked, undefined, 'no admin pipe, no line: today behaviour');
  assert.equal(JSON.parse(readFileSync(b.plain, 'utf8')).keys.openai.key, K1);
});

test('F4 an Electron-launched core (admin pipe) with no PKEY line: plain only when this machine never encrypted', () => {
  const never = setup();
  const k1 = new ProviderKeys(never.plain, { launchedByApp: true });
  k1.set('openai', K1, O1);
  assert.equal(k1.status().blocked, undefined);
  assert.equal(k1.status().mode, 'plain');
  assert.notEqual(k1.status().reason, 'headless', 'the words must not say Legion was started without the app');
  for (const mk of ['keyBin', 'enc'] as const) {
    const m = setup();
    writeFileSync(mk === 'keyBin' ? m.keyBin : m.enc, 'wrapped');
    const k = new ProviderKeys(m.plain, { launchedByApp: true });
    assert.equal(k.status().blocked, true, mk);
    assert.throws(() => k.set('x', K2, O1), /did not unlock/);
    assert.equal(existsSync(m.plain), false);
  }
});

test('B-L3: key files set aside by a start over still count as "was encrypted": a failed start over cannot fall back to plain saves', () => {
  for (const name of ['key.bin.unreadable-2026-10-18', 'keys.enc.unreadable-2026-10-18-2']) {
    const m = setup();
    writeFileSync(join(m.dir, 'providers', name), 'set aside'); // neither key.bin nor keys.enc is left
    const k = new ProviderKeys(m.plain, { launchedByApp: true, noKey: 'unavailable' });
    assert.equal(k.status().blocked, true, name);
    assert.throws(() => k.set('x', K2, O1), /did not unlock/);
    assert.equal(existsSync(m.plain), false, 'nothing was written in plain');
  }
  const none = setup();
  writeFileSync(join(none.dir, 'providers', 'other.unreadable-2026-10-18'), 'x'); // an unrelated file does not count
  const k = new ProviderKeys(none.plain, { launchedByApp: true, noKey: 'unavailable' });
  assert.equal(k.status().blocked, undefined);
});

test('F4 legion-core passes the admin-pipe flag to the key store', () => {
  const src = readFileSync(join(repoRoot, 'src/bin/legion-core.ts'), 'utf8');
  assert.match(src, /const launchedByApp = process\.env\[ADMIN_STDIN_FLAG\] === '1';\s+const \{ admin: adminSecret/);
  assert.match(src, /new ProviderKeys\([^\n]*launchedByApp/);
});

// ------------------------------------------------------------------------------------------------ F5

test('F5 a failed migration never deletes a keys.enc it did not create', () => {
  const { plain, enc } = setup();
  writePlain(plain, { openai: { key: K1, origin: O1 } });
  writeFileSync(enc, 'a file that was already here');
  // sealing with a bad key fails the read-back; the old file must survive
  const bad = new ProviderKeys(plain, { dataKey: Buffer.alloc(5) }) as unknown as { migrate(p: { doc: unknown; text: string }, setAside: boolean): void };
  writeFileSync(enc, 'a file that was already here');
  bad.migrate({ doc: { openai: { key: K1, origin: O1 } }, text: readFileSync(plain, 'utf8') }, false);
  assert.equal(existsSync(enc), true);
  assert.equal(readFileSync(enc, 'utf8'), 'a file that was already here');
});

// ------------------------------------------------------------------------------------------------ F6

test('F6 renameWithRetry retries EPERM/EBUSY/EACCES with short delays and never removes the target', () => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const calls: string[] = []; const sleeps: number[] = [];
    let n = 0;
    renameWithRetry('a', 'b', {
      rename: () => { calls.push('rename'); if (++n < 3) throw Object.assign(new Error('locked'), { code }); },
      sleep: (ms) => { sleeps.push(ms); },
    });
    assert.equal(n, 3, code);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps.every((ms) => ms > 0 && ms <= 250));
  }
});

test('F6 renameWithRetry gives up after a few tries with the original error; other errors are not retried', () => {
  let n = 0;
  assert.throws(() => renameWithRetry('a', 'b', { rename: () => { n++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); }, sleep: () => undefined }), /busy/);
  assert.ok(n >= 4 && n <= 12, `tried ${n} times`);
  let m = 0;
  assert.throws(() => renameWithRetry('a', 'b', { rename: () => { m++; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }, sleep: () => undefined }), /nope/);
  assert.equal(m, 1);
});

test('F6 the sealed-file write and the key.bin write use the retried rename, with no unlink of the target', () => {
  const parts: Array<[string, string, string]> = [['src/core/providers/secrets.ts', 'private writeSealed', 'private save'], ['src/electron/connector-key.ts', 'function writeAtomic', 'export async function loadConnectorKey']];
  for (const [f, from, to] of parts) {
    const src = readFileSync(join(repoRoot, f), 'utf8');
    const body = src.slice(src.indexOf(from), src.indexOf(to));
    assert.ok(body.length > 50, f);
    assert.match(body, /renameWithRetry\(/, f);
    assert.doesNotMatch(body, /unlinkSync\((this\.sealedFile|file)\)/, `${f} never deletes the target before the rename`);
  }
});

// ------------------------------------------------------------------------------------------------ F2

const BLOCKED_VIEW = { providers: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }], keyStoreState: 'blocked' };
const OK_VIEW = { providers: [{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }], keyStoreState: 'encrypted' };

function rig(views: Array<Record<string, unknown>>, unlocks: boolean) {
  const log: string[] = [];
  let gets = 0;
  const d: ProviderIpcDeps = {
    async call(method, route) {
      log.push(`${method} ${route}`);
      if (method === 'GET') return { status: 200, json: views[Math.min(gets++, views.length - 1)] };
      return { status: 200, json: { ok: true } };
    },
    async confirm() { log.push('confirm'); return true; },
    startOver: {
      async storeReady() { log.push('storeReady'); return true; },
      async unlocks() { log.push('unlocks'); return unlocks; },
      async setAsideKey() { log.push('setAsideKey'); },
      async restartCore() { log.push('restartCore'); return null; },
    },
  };
  return { d, log };
}

test('F2 start over: a key.bin that unwraps now makes main restart the core and re-check; unlocked means done, no dialog, nothing set aside', async () => {
  const { d, log } = rig([BLOCKED_VIEW, OK_VIEW], true);
  const r = await providerChange({ kind: 'start-over' }, d);
  assert.equal(r.ok, true);
  assert.equal((r as { unlocked?: boolean }).unlocked, true);
  assert.deepEqual(log, ['GET /api/providers', 'storeReady', 'unlocks', 'restartCore', 'GET /api/providers']);
});

test('F2 start over is still offered when the restart with the unwrapped key stays blocked (keys.enc really does not open)', async () => {
  const { d, log } = rig([BLOCKED_VIEW, BLOCKED_VIEW, OK_VIEW], true);
  const r = await providerChange({ kind: 'start-over' }, d);
  assert.equal(r.ok, true);
  assert.equal((r as { unlocked?: boolean }).unlocked, undefined);
  assert.deepEqual(log, ['GET /api/providers', 'storeReady', 'unlocks', 'restartCore', 'GET /api/providers', 'confirm', 'POST /api/providers/keys/start-over', 'setAsideKey', 'restartCore', 'GET /api/providers']);
});

test('F2 a key.bin that does not unwrap goes straight to the dialog (no extra restart)', async () => {
  const { d, log } = rig([BLOCKED_VIEW, OK_VIEW], false);
  assert.equal((await providerChange({ kind: 'start-over' }, d)).ok, true);
  assert.deepEqual(log.slice(0, 4), ['GET /api/providers', 'storeReady', 'unlocks', 'confirm']);
});

function lockableStorage() {
  const state = { locked: false };
  const ss: SafeStorageLike = {
    isAsyncEncryptionAvailable: async () => !state.locked,
    encryptStringAsync: async (p) => Buffer.from('WRAP:' + Buffer.from(p).toString('hex')),
    decryptStringAsync: async (b) => { if (state.locked) throw new Error('keychain locked'); const t = b.toString(); return { result: Buffer.from(t.slice(5), 'hex').toString(), shouldReEncrypt: false }; },
  };
  return { ss, state };
}

test('F2 a key store that was locked at core start but works now: the launch line said unreadable, providerKeyUnlocks says yes, key.bin is untouched', async () => {
  const dir = tempDir('legion-pk-f2-');
  const { ss, state } = lockableStorage();
  const hex = await ensureProviderKey(dir, ss, 'win32');
  assert.ok(hex);
  const wrapped = readFileSync(join(dir, 'providers', 'key.bin'));
  state.locked = true;
  assert.equal(await providerKeyLaunchLine(dir, ss, 'win32'), 'PKEY - unreadable\n');
  assert.equal(await providerKeyUnlocks(dir, ss, 'win32'), false, 'still locked: not unlocked');
  state.locked = false;
  assert.equal(await providerKeyUnlocks(dir, ss, 'win32'), true);
  assert.equal(await providerKeyLaunchLine(dir, ss, 'win32'), `PKEY ${hex}\n`);
  assert.deepEqual(readFileSync(join(dir, 'providers', 'key.bin')), wrapped);
});

test('F2 main.ts passes the unlock check to start over', () => {
  const main = readFileSync(join(repoRoot, 'src/electron/main.ts'), 'utf8');
  const h = main.slice(main.indexOf("ipcMain.handle('legion:provider-change'"), main.indexOf("ipcMain.handle('legion:web-search-change'"));
  assert.match(h, /unlocks: \(\) => providerKeyUnlocks\(dataDir\(\), safeStorage\)/);
});
