import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseBackend, compareVersions, detectInstalls, normalizeVersion, parseRegistryInstallDirs, parseSteamLibraries, parseVersionOutput,
  pickInstall, versionAtLeast, versionFromName,
} from '../src/core/blender/detect.js';
import type { DetectEnv, RunResult } from '../src/core/blender/detect.js';

interface FakeOpts { platform?: NodeJS.Platform; files?: string[]; dirs?: Record<string, string[]>; text?: Record<string, string>; registry?: Record<string, string>; versions?: Record<string, string | null>; env?: Record<string, string>; runs?: string[] }
function fake(o: FakeOpts = {}): DetectEnv {
  const files = new Set((o.files ?? []).map((f) => f.toLowerCase()));
  return {
    platform: o.platform ?? 'win32',
    env: o.env ?? { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\Dan\\AppData\\Local' },
    home: o.platform === 'win32' || !o.platform ? 'C:\\Users\\Dan' : '/home/dan',
    exists: (p) => files.has(p.toLowerCase()),
    readDir: (p) => o.dirs?.[p] ?? [],
    readText: (p) => o.text?.[p],
    registryQuery: o.registry ? async (k) => o.registry![k] : undefined,
    run: async (file, args): Promise<RunResult | null> => {
      o.runs?.push(`${file} ${args.join(' ')}`);
      const v = o.versions?.[file];
      if (v === undefined || v === null) return v === null ? { code: 1, stdout: '', stderr: 'boom' } : null;
      return { code: 0, stdout: `Blender ${v}\n\tbuild date: 2026-04-01\n`, stderr: '' };
    },
  };
}

test('version parsing and comparison', () => {
  assert.equal(normalizeVersion('Blender 5.1'), '5.1.0');
  assert.equal(normalizeVersion('4.2.3 LTS'), '4.2.3');
  assert.equal(normalizeVersion('nothing'), null);
  assert.equal(parseVersionOutput('Blender 5.1.0\n\tbuild date: 2026'), '5.1.0');
  assert.equal(parseVersionOutput('Blender 4.2.3 LTS\n'), '4.2.3');
  assert.equal(parseVersionOutput('some warning\nBlender 3.6.5\n'), '3.6.5');
  assert.equal(parseVersionOutput('garbage'), null);
  assert.equal(versionFromName('Blender 5.1'), '5.1.0');
  assert.equal(versionFromName('blender-4.2.3-linux-x64'), '4.2.3');
  assert.equal(versionFromName('Blender5.1'), '5.1.0');
  assert.equal(versionFromName('Steam'), null);
  assert.ok(compareVersions('5.1.0', '4.9.9') > 0);
  assert.ok(compareVersions('4.2.10', '4.2.9') > 0, 'numeric, not lexical');
  assert.ok(compareVersions('5.10.0', '5.9.0') > 0);
  assert.equal(compareVersions('5.1', '5.1.0'), 0);
  assert.ok(compareVersions('junk', '0.0.1') < 0);
  assert.equal(versionAtLeast('5.1.0', '5.1.0'), true);
  assert.equal(versionAtLeast('5.0.9', '5.1.0'), false);
});

test('registry and steam parsing', () => {
  const reg = `HKEY_LOCAL_MACHINE\\SOFTWARE\\BlenderFoundation\\Blender\\4.2\r\n    InstallDir    REG_SZ    C:\\Program Files\\Blender Foundation\\Blender 4.2\\\r\n\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\BlenderFoundation\\Blender\\5.1\r\n    InstallDir    REG_SZ    D:\\Apps\\Blender 5.1\r\n`;
  assert.deepEqual(parseRegistryInstallDirs(reg), ['C:\\Program Files\\Blender Foundation\\Blender 4.2', 'D:\\Apps\\Blender 5.1']);
  assert.deepEqual(parseRegistryInstallDirs('nothing here'), []);
  const vdf = '"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"E:\\\\SteamLibrary"\n\t}\n}';
  assert.deepEqual(parseSteamLibraries(vdf), ['C:\\Program Files (x86)\\Steam', 'E:\\SteamLibrary']);
});

test('Windows: Program Files folders, newest first, version asked from the exe', async () => {
  const a = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
  const b = 'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe';
  const runs: string[] = [];
  const env = fake({ files: [a, b], dirs: { 'C:\\Program Files\\Blender Foundation': ['Blender 4.2', 'Blender 5.1', 'Readme.txt'] }, versions: { [a]: '4.2.3', [b]: '5.1.0' }, runs });
  const list = await detectInstalls(env);
  assert.deepEqual(list.map((i) => i.version), ['5.1.0', '4.2.3']);
  assert.equal(list[0]!.source, 'program-files');
  assert.equal(list[0]!.versionGuessed, undefined);
  assert.ok(runs.every((r) => r.endsWith('--version')));
  assert.equal(pickInstall(list)!.version, '5.1.0');
});

test('Windows: Steam default folder and a library from libraryfolders.vdf', async () => {
  const steam = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Blender\\blender.exe';
  const lib = 'E:\\SteamLibrary\\steamapps\\common\\Blender\\blender.exe';
  const vdf = '"libraryfolders" { "1" { "path" "E:\\\\SteamLibrary" } }';
  const a = await detectInstalls(fake({ files: [steam], versions: { [steam]: '4.1.1' } }));
  assert.equal(a[0]!.source, 'steam');
  const b = await detectInstalls(fake({ files: [lib], text: { 'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf': vdf }, versions: { [lib]: '5.1.0' } }));
  assert.equal(b[0]!.path, lib);
  assert.equal(b[0]!.source, 'steam');
});

test('Windows: registry InstallDir, deduped against Program Files', async () => {
  const pf = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
  const other = 'D:\\Apps\\Blender 5.1\\blender.exe';
  const registry = { 'HKLM\\SOFTWARE\\BlenderFoundation': `    InstallDir    REG_SZ    C:\\Program Files\\Blender Foundation\\Blender 4.2\\\r\n    InstallDir    REG_SZ    D:\\Apps\\Blender 5.1\r\n` };
  const list = await detectInstalls(fake({ files: [pf, other], dirs: { 'C:\\Program Files\\Blender Foundation': ['Blender 4.2'] }, registry, versions: { [pf]: '4.2.3', [other]: '5.1.0' } }));
  assert.equal(list.length, 2, 'the same exe through two routes is listed once');
  assert.equal(list.find((i) => i.path === other)!.source, 'registry');
  assert.equal(list.find((i) => i.path === pf)!.source, 'program-files');
});

test('a Blender that cannot be asked for its version falls back to the folder name and says so', async () => {
  const p = 'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe';
  const list = await detectInstalls(fake({ files: [p], dirs: { 'C:\\Program Files\\Blender Foundation': ['Blender 4.2'] }, versions: { [p]: null } }));
  assert.equal(list[0]!.version, '4.2.0');
  assert.equal(list[0]!.versionGuessed, true);
  const none = await detectInstalls(fake({ files: [p], env: { PATH: 'C:\\Program Files\\Blender Foundation\\Blender 4.2' }, versions: { [p]: null } }));
  assert.equal(none[0]!.version, '4.2.0', 'path name helps too');
  const unknown = await detectInstalls(fake({ files: ['C:\\tools\\blender.exe'], env: { PATH: 'C:\\tools' }, versions: {} }));
  assert.equal(unknown[0]!.version, '0.0.0');
  assert.equal(unknown[0]!.versionGuessed, true);
});

test('override: a file or a folder wins over newer installs; a missing path is ignored', async () => {
  const pf = 'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe';
  const mine = 'D:\\mine\\Blender 4.2\\blender.exe';
  const base = { files: [pf, mine], dirs: { 'C:\\Program Files\\Blender Foundation': ['Blender 5.1'] }, versions: { [pf]: '5.1.0', [mine]: '4.2.3' } };
  const byFile = await detectInstalls(fake(base), mine);
  assert.equal(byFile[0]!.path, mine);
  assert.equal(byFile[0]!.source, 'config');
  assert.equal(pickInstall(byFile)!.path, mine);
  const byFolder = await detectInstalls(fake(base), 'D:\\mine\\Blender 4.2');
  assert.equal(byFolder[0]!.path, mine);
  const quoted = await detectInstalls(fake(base), '"D:\\mine\\Blender 4.2\\blender.exe"');
  assert.equal(quoted[0]!.path, mine);
  const missing = await detectInstalls(fake(base), 'Z:\\nowhere');
  assert.equal(missing[0]!.source, 'program-files');
  assert.equal(pickInstall(missing)!.version, '5.1.0');
});

test('Linux: common paths, /opt and PATH; macOS: Applications', async () => {
  const l = await detectInstalls(fake({ platform: 'linux', files: ['/usr/bin/blender', '/opt/blender-4.2.3-linux-x64/blender'], dirs: { '/opt': ['blender-4.2.3-linux-x64', 'other'] }, versions: { '/usr/bin/blender': '3.6.5', '/opt/blender-4.2.3-linux-x64/blender': '4.2.3' }, env: { PATH: '/usr/bin:/bin' } }));
  assert.deepEqual(l.map((i) => i.version), ['4.2.3', '3.6.5']);
  assert.equal(l.length, 2, 'PATH entry for /usr/bin/blender is the same file');
  const m = await detectInstalls(fake({ platform: 'darwin', files: ['/Applications/Blender.app/Contents/MacOS/Blender'], versions: { '/Applications/Blender.app/Contents/MacOS/Blender': '5.1.0' }, env: {} }));
  assert.equal(m[0]!.source, 'applications');
  assert.equal(m[0]!.version, '5.1.0');
  const nothing = await detectInstalls(fake({ platform: 'linux', env: {} }));
  assert.deepEqual(nothing, []);
  assert.equal(pickInstall(nothing), undefined);
});

test('chooseBackend: official on 5.1+, community below, explicit choices honoured, never a silent fallback', () => {
  const inst = (version: string, extra: object = {}) => ({ path: 'x', version, source: 'path' as const, ...extra });
  assert.equal(chooseBackend('auto', inst('5.1.0')).kind, 'official');
  assert.equal(chooseBackend('auto', inst('5.2.1')).kind, 'official');
  assert.equal(chooseBackend('auto', inst('5.0.9')).kind, 'community');
  assert.equal(chooseBackend('auto', inst('4.2.3')).kind, 'community');
  assert.equal(chooseBackend('auto', inst('2.93.0')).kind, null);
  assert.equal(chooseBackend('auto', undefined).kind, null);
  assert.match(chooseBackend('auto', undefined).reason, /not found/);
  assert.equal(chooseBackend('official', inst('4.2.3')).kind, null, 'forcing official on old Blender does not quietly switch');
  assert.match(chooseBackend('official', inst('4.2.3')).reason, /5\.1\.0/);
  assert.equal(chooseBackend('official', inst('5.1.0')).kind, 'official');
  assert.equal(chooseBackend('community', inst('5.1.0')).kind, 'community');
  assert.equal(chooseBackend('community', inst('2.8.0')).kind, null);
  assert.match(chooseBackend('auto', inst('4.2.0', { versionGuessed: true })).reason, /folder name/);
});
