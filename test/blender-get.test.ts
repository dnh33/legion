/**
 * B4: the managed Blender download. Fake downloads only (no network), zips built in the test. Covers: zip-slip and the other unsafe-archive cases,
 * hash check before unpack, approval before any download, cleanup on failure, record validation, detection preference.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { Readable, Writable } from 'node:stream';
import { MANAGED_BLENDER } from '../src/shared/blender.js';
import { detectInstalls, pickInstall } from '../src/core/blender/detect.js';
import { appDir, effectiveSha, getManagedBlender, managedRecordFile, readManaged } from '../src/core/blender/get-blender.js';
import type { GetBlenderPorts, ManagedPin } from '../src/core/blender/get-blender.js';
import { createGetBlenderPorts } from '../src/core/blender/system.js';
import { crc32Update, extractZip, listEntries, safeEntryPath, targetInside, ZipError } from '../src/core/blender/zip.js';
import type { ZipSink, ZipSource } from '../src/core/blender/zip.js';

// ---------------------------------------------------------------- a tiny zip writer (stored or deflate), with the knobs the attacks need
interface ZEntry { name: string; data?: Buffer; method?: 0 | 8; flags?: number; unixMode?: number; crc?: number; usize?: number; csize?: number }
function makeZip(entries: ZEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const raw = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const crc = e.crc ?? crc32Update(0, raw);
    const csize = e.csize ?? body.length;
    const usize = e.usize ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(((e.unixMode ? 3 : 0) << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.flags ?? 0, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(e.unixMode ? (e.unixMode << 16) >>> 0 : 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

const memSource = (b: Buffer): ZipSource => ({ size: b.length, read: async (o, l) => b.subarray(o, o + l), stream: (s, e) => Readable.from([b.subarray(s, e + 1)]) });
function memSink(): ZipSink & { files: Map<string, Buffer>; dirs: Set<string> } {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  return {
    files, dirs,
    mkdirp: (d) => { dirs.add(d); },
    openWrite: (f) => { const chunks: Buffer[] = []; return new Writable({ write(c, _e, cb) { chunks.push(c); cb(); }, final(cb) { files.set(f, Buffer.concat(chunks)); cb(); } }); },
  };
}
const TOP = 'blender-5.2.2-windows-x64';
const LIM = { maxEntries: 100, maxUnpackedBytes: 1024 * 1024 };
const root = join(tmpdir(), 'legion-zip-root');
const good = (): Buffer => makeZip([
  { name: `${TOP}/` }, { name: `${TOP}/blender.exe`, data: Buffer.from('MZ-fake-exe'), method: 8 }, { name: `${TOP}/5.2/scripts/a.py`, data: Buffer.from('print(1)\n') },
]);

test('B4 zip: a normal archive unpacks (stored and deflate) with CRC checked', async () => {
  const sink = memSink();
  const r = await extractZip(memSource(good()), sink, root, TOP, LIM);
  assert.equal(r.files, 2);
  assert.equal(sink.files.get(join(root, TOP, 'blender.exe'))!.toString(), 'MZ-fake-exe');
});

const BAD: Array<[string, ZEntry, RegExp]> = [
  ['zip-slip with ..', { name: `${TOP}/../../evil.txt`, data: Buffer.from('x') }, /climbs out/],
  ['zip-slip with backslashes', { name: `${TOP}\\..\\..\\evil.txt`, data: Buffer.from('x') }, /climbs out/],
  ['leading ..', { name: '../evil.txt', data: Buffer.from('x') }, /climbs out/],
  ['absolute path', { name: '/etc/passwd', data: Buffer.from('x') }, /absolute/],
  ['absolute backslash path', { name: '\\Windows\\evil.dll', data: Buffer.from('x') }, /absolute/],
  ['drive letter', { name: 'C:/Windows/evil.dll', data: Buffer.from('x') }, /absolute/],
  ['colon (alternate data stream)', { name: `${TOP}/blender.exe:evil`, data: Buffer.from('x') }, /colon/],
  ['outside the expected top folder', { name: 'other/blender.exe', data: Buffer.from('x') }, /outside the expected folder/],
  ['a sibling that only shares the prefix', { name: `${TOP}-evil/blender.exe`, data: Buffer.from('x') }, /outside the expected folder/],
  ['Windows device name', { name: `${TOP}/NUL`, data: Buffer.from('x') }, /device/],
  ['trailing dot', { name: `${TOP}/a.`, data: Buffer.from('x') }, /dot or a space/],
  ['symbolic link', { name: `${TOP}/link`, data: Buffer.from('/etc/passwd'), unixMode: 0o120777 }, /symbolic link/],
  ['encrypted entry', { name: `${TOP}/secret.bin`, data: Buffer.from('x'), flags: 1 }, /encrypted/],
  ['unsupported method', { name: `${TOP}/x.bin`, data: Buffer.from('x') }, /method/],
];
for (const [name, entry, re] of BAD) {
  test(`B4 zip refuses: ${name}`, async () => {
    const e = name === 'unsupported method' ? { ...entry, method: 9 as unknown as 0 } : entry;
    const sink = memSink();
    await assert.rejects(extractZip(memSource(makeZip([{ name: `${TOP}/` }, e])), sink, root, TOP, LIM), (err: Error) => err instanceof ZipError && re.test(err.message));
    assert.equal(sink.files.size, 0, 'nothing was written');
  });
}

test('B4 zip refuses: duplicate paths (case-insensitive), file-and-folder clash, too many entries, too big, zip64, not a zip', async () => {
  await assert.rejects(listEntries(memSource(makeZip([{ name: `${TOP}/A.txt`, data: Buffer.from('1') }, { name: `${TOP}/a.TXT`, data: Buffer.from('2') }])), TOP, LIM), /twice/);
  await assert.rejects(listEntries(memSource(makeZip([{ name: `${TOP}/a`, data: Buffer.from('1') }, { name: `${TOP}/a/b.txt`, data: Buffer.from('2') }])), TOP, LIM), /both a file and a folder/);
  await assert.rejects(listEntries(memSource(good()), TOP, { ...LIM, maxEntries: 2 }), /more than the limit/);
  await assert.rejects(listEntries(memSource(makeZip([{ name: `${TOP}/big.bin`, data: Buffer.from('x'), usize: 5000 }])), TOP, { ...LIM, maxUnpackedBytes: 1000 }), /unpack to more than/);
  await assert.rejects(listEntries(memSource(Buffer.from('this is not a zip file at all, just text')), TOP, LIM), /not a zip/);
  const z = good(); z.writeUInt16LE(0xffff, z.length - 22 + 10);
  await assert.rejects(listEntries(memSource(z), TOP, LIM), /zip64/);
});

test('B4 zip refuses: an entry that inflates past its declared size, and a wrong CRC (zip bomb / corruption)', async () => {
  const big = Buffer.alloc(100_000, 97);
  const bomb = makeZip([{ name: `${TOP}/bomb.bin`, data: big, method: 8, usize: 10 }]);
  await assert.rejects(extractZip(memSource(bomb), memSink(), root, TOP, LIM), /more than its declared size/);
  const bad = makeZip([{ name: `${TOP}/x.bin`, data: Buffer.from('hello'), crc: 123 }]);
  await assert.rejects(extractZip(memSource(bad), memSink(), root, TOP, LIM), /CRC-32/);
  const short = makeZip([{ name: `${TOP}/x.bin`, data: Buffer.from('hello'), usize: 99 }]);
  await assert.rejects(extractZip(memSource(short), memSink(), root, TOP, LIM), /shorter than its declared size/);
});

test('B4 zip: the path helpers on their own (the second check refuses an escape even if the first were bypassed)', () => {
  assert.throws(() => safeEntryPath('a/../b', TOP), ZipError);
  assert.deepEqual(safeEntryPath(`${TOP}/x/y.txt`, TOP), { rel: `${TOP}/x/y.txt`, dir: false });
  assert.throws(() => targetInside(root, '../escape.txt'), /outside the target folder/);
  assert.throws(() => targetInside(root, `${TOP}/../../escape.txt`), /outside the target folder/);
  assert.ok(targetInside(root, `${TOP}/ok.txt`).startsWith(root));
});

// ---------------------------------------------------------------- the orchestrator on fake ports
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
function pinFor(zip: Buffer, over: Partial<ManagedPin> = {}): ManagedPin {
  return { ...MANAGED_BLENDER, version: '5.2.2', topDir: TOP, sha256: sha(zip), maxEntries: 100, maxUnpackedBytes: 1024 * 1024, ...over };
}
function rig(zip: Buffer, o: { served?: Buffer; platform?: NodeJS.Platform } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-get-'));
  const log: string[] = [];
  const ports = createGetBlenderPorts();
  const fake: GetBlenderPorts = {
    ...ports,
    platform: o.platform ?? 'win32',
    download: async (url, dest, opt) => { log.push(`download ${url} max=${opt.maxBytes}`); const b = o.served ?? zip; mkdirSync(join(dest, '..'), { recursive: true }); writeFileSync(dest, b); return { sha256: sha(b), bytes: b.length }; },
    removeDir: (p) => { log.push(`removeDir ${p}`); ports.removeDir(p); },
  };
  return { dir, log, ports: fake };
}
const allow = async (): Promise<boolean> => true;

test('B4 get: approved, hash matches, unpacked through the REAL sink and file ports, recorded, archive removed', async () => {
  const zip = good();
  const r = rig(zip);
  const asked: string[] = [];
  const res = await getManagedBlender(r.ports, { dataDir: r.dir, cfgSha: '', pin: pinFor(zip), approve: async (a) => { asked.push(a.summary); return true; } });
  assert.equal(res.ok, true, JSON.stringify(res.steps));
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /sha256 [0-9a-f]{16}\.\.\./);
  assert.match(asked[0]!, /GPL-3\.0-or-later/);
  assert.ok(existsSync(join(appDir(r.dir), '5.2.2', TOP, 'blender.exe')));
  assert.ok(existsSync(join(appDir(r.dir), '5.2.2', 'LEGION-README.txt')));
  assert.equal(existsSync(join(appDir(r.dir), '.download-5.2.2.zip')), false, 'the archive is deleted');
  assert.equal(existsSync(join(appDir(r.dir), '5.2.2.partial')), false);
  const m = readManaged(r.ports, r.dir)!;
  assert.equal(m.version, '5.2.2');
  assert.equal(m.path, join(appDir(r.dir), '5.2.2', TOP, 'blender.exe'));
});

test('B4 get: the approval is awaited BEFORE any download or folder; a denial (or a throw) fetches nothing', async () => {
  for (const approve of [async () => false, async () => { throw new Error('no'); }] as Array<() => Promise<boolean>>) {
    const zip = good();
    const r = rig(zip);
    const res = await getManagedBlender(r.ports, { dataDir: r.dir, cfgSha: '', pin: pinFor(zip), approve });
    assert.equal(res.ok, false);
    assert.equal(res.denied, true);
    assert.deepEqual(r.log, [], 'no download, no removal');
    assert.equal(existsSync(appDir(r.dir)), false, 'no folder was created');
    assert.equal(readManaged(r.ports, r.dir), null);
  }
});

test('B4 get: a download that does not match the pin is refused BEFORE unpacking; nothing installed, nothing recorded, archive removed', async () => {
  const zip = good();
  const r = rig(zip, { served: Buffer.concat([zip, Buffer.from('x')]) }); // one byte more
  const res = await getManagedBlender(r.ports, { dataDir: r.dir, cfgSha: '', pin: pinFor(zip), approve: allow });
  assert.equal(res.ok, false);
  assert.match(res.steps.at(-1)!.detail, /does not match the pinned sha256/);
  assert.equal(existsSync(join(appDir(r.dir), '5.2.2')), false);
  assert.equal(existsSync(join(appDir(r.dir), '5.2.2.partial')), false, 'nothing was unpacked, not even a staging folder');
  assert.equal(existsSync(join(appDir(r.dir), '.download-5.2.2.zip')), false);
  assert.equal(existsSync(managedRecordFile(r.dir)), false);
});

test('B4 get: no pinned hash at all means no approval card and no download (fail closed); a hash from config is the only fallback', async () => {
  const zip = good();
  const r = rig(zip);
  let asked = 0;
  const res = await getManagedBlender(r.ports, { dataDir: r.dir, cfgSha: '', pin: pinFor(zip, { sha256: '' }), approve: async () => { asked++; return true; } });
  assert.equal(res.ok, false);
  assert.equal(asked, 0);
  assert.deepEqual(r.log, []);
  assert.match(res.steps[0]!.detail, /TODO OWNER PC/);
  assert.equal(effectiveSha({ sha256: '' }, 'not hex'), '');
  assert.equal(effectiveSha({ sha256: '' }, 'A'.repeat(64)), '', 'upper case is not the normalized form: config normalizer lower-cases first');
  assert.equal(effectiveSha({ sha256: '' }, sha(zip)), sha(zip));
  const r2 = rig(zip);
  assert.equal((await getManagedBlender(r2.ports, { dataDir: r2.dir, cfgSha: sha(zip), pin: pinFor(zip, { sha256: '' }), approve: allow })).ok, true);
});

test('B4 get: the shipped pin is the x64 zip hash given by the owner, 64 lower-case hex, https from download.blender.org', () => {
  assert.equal(MANAGED_BLENDER.sha256, '3849d17a682cba006075aaa3f3597ecb5c9c30ec31035b2e092c53e40679b535');
  assert.match(MANAGED_BLENDER.sha256, /^[0-9a-f]{64}$/);
  assert.equal(MANAGED_BLENDER.url, 'https://download.blender.org/release/Blender5.2/blender-5.2.2-windows-x64.zip');
  assert.equal(MANAGED_BLENDER.topDir, 'blender-5.2.2-windows-x64');
  assert.equal(MANAGED_BLENDER.platform, 'win32');
});

test('B4 get: not Windows is refused without a card; an unsafe archive fails cleanly and an earlier install and record survive', async () => {
  const zip = good();
  const lin = rig(zip, { platform: 'linux' });
  assert.equal((await getManagedBlender(lin.ports, { dataDir: lin.dir, cfgSha: '', pin: pinFor(zip), approve: async () => { throw new Error('asked'); } })).ok, false);
  assert.deepEqual(lin.log, []);

  const r = rig(zip);
  assert.equal((await getManagedBlender(r.ports, { dataDir: r.dir, cfgSha: '', pin: pinFor(zip), approve: allow })).ok, true);
  const record = readFileSync(managedRecordFile(r.dir), 'utf8');
  // a "new" pin (different version) whose archive tries to escape
  const evil = makeZip([{ name: `${TOP}/` }, { name: `${TOP}/../../escaped.txt`, data: Buffer.from('x') }]);
  const r2 = { ...r, ports: { ...r.ports, download: async (_u: string, dest: string) => { writeFileSync(dest, evil); return { sha256: sha(evil), bytes: evil.length }; } } };
  const res = await getManagedBlender(r2.ports, { dataDir: r.dir, cfgSha: '', pin: pinFor(evil, { version: '5.2.3' }), approve: allow });
  assert.equal(res.ok, false);
  assert.match(res.steps.at(-1)!.detail, /climbs out/);
  assert.equal(readFileSync(managedRecordFile(r.dir), 'utf8'), record, 'record untouched');
  assert.ok(existsSync(join(appDir(r.dir), '5.2.2', TOP, 'blender.exe')), 'earlier install untouched');
  assert.equal(existsSync(join(appDir(r.dir), '5.2.3.partial')), false);
  assert.equal(existsSync(join(r.dir, 'escaped.txt')), false);
  assert.equal(existsSync(join(appDir(r.dir), 'escaped.txt')), false);
});

test('B4 get: an archive without blender.exe installs nothing; a second call with the same pin does not download again', async () => {
  const noExe = makeZip([{ name: `${TOP}/` }, { name: `${TOP}/readme.txt`, data: Buffer.from('x') }]);
  const r = rig(noExe);
  const res = await getManagedBlender(r.ports, { dataDir: r.dir, cfgSha: '', pin: pinFor(noExe), approve: allow });
  assert.equal(res.ok, false);
  assert.equal(existsSync(join(appDir(r.dir), '5.2.2')), false);

  const zip = good();
  const r2 = rig(zip);
  assert.equal((await getManagedBlender(r2.ports, { dataDir: r2.dir, cfgSha: '', pin: pinFor(zip), approve: allow })).ok, true);
  r2.log.length = 0;
  const again = await getManagedBlender(r2.ports, { dataDir: r2.dir, cfgSha: '', pin: pinFor(zip), approve: async () => { throw new Error('should not ask'); } });
  assert.equal(again.ok, true);
  assert.deepEqual(r2.log, []);
});

test('B4 get: a tampered record that points outside the managed folder (or at a missing file) is not believed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion-rec-'));
  mkdirSync(join(dir, 'blender'), { recursive: true });
  const outside = join(dir, 'evil.exe');
  writeFileSync(outside, 'x');
  const ports = createGetBlenderPorts();
  for (const exe of [outside, '../../evil.exe', '../app-evil/blender.exe', join('5.2.2', TOP, 'blender.exe')]) {
    writeFileSync(managedRecordFile(dir), JSON.stringify({ version: '5.2.2', exe, sha256: 'a', at: 'x' }));
    assert.equal(readManaged(ports, dir), null, exe);
  }
  writeFileSync(managedRecordFile(dir), '{not json');
  assert.equal(readManaged(ports, dir), null);
});

// ---------------------------------------------------------------- detection
test('B4 detect: the managed copy is preferred over a normal install, but a path the user set in Settings still wins', async () => {
  const managed = 'C:\\Users\\Dan\\AppData\\Roaming\\legion\\blender\\app\\5.2.2\\blender-5.2.2-windows-x64\\blender.exe';
  const pf = 'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe';
  const mine = 'D:\\Blender\\blender.exe';
  const files = new Set([managed, pf, mine].map((f) => f.toLowerCase()));
  const versions: Record<string, string> = { [managed]: '5.2.2', [pf]: '5.1.0', [mine]: '4.5.0' };
  const env = {
    platform: 'win32' as const, env: { ProgramFiles: 'C:\\Program Files' }, home: 'C:\\Users\\Dan',
    exists: (p: string) => files.has(p.toLowerCase()),
    readDir: (p: string) => (p === 'C:\\Program Files\\Blender Foundation' ? ['Blender 5.1'] : []),
    run: async (file: string) => (versions[file] ? { code: 0, stdout: `Blender ${versions[file]}\n`, stderr: '' } : null),
  };
  const noManaged = await detectInstalls(env);
  assert.equal(pickInstall(noManaged)!.path, pf);
  const withManaged = await detectInstalls(env, undefined, managed);
  assert.equal(pickInstall(withManaged)!.path, managed);
  assert.equal(pickInstall(withManaged)!.source, 'managed');
  assert.equal(withManaged.some((i) => i.path === pf), true, 'the normal install is still listed, and untouched');
  const override = await detectInstalls(env, mine, managed);
  assert.equal(pickInstall(override)!.path, mine);
});
