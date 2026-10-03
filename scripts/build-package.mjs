#!/usr/bin/env node
// Builds the prebuilt Windows package: legion-<version>-win-x64.zip (full) next to legion-<version>-app.zip (the updater's code-only subset, byte for byte
// the same files), legion-update-manifest.json (NOT signed: the owner signs with release-sign.mjs) and SHA256SUMS.txt. Run it on Windows x64.
// usage: node scripts/build-package.mjs --out <folder> [--skip-build] [--allow-dirty] [--published-at <UTC ISO>] [--keep-work] [--no-selfcheck]
//   test/advanced: --foreign --node-modules <production node_modules> --electron-dist <folder> --electron-version <x.y.z> --root <built tree> [--commit <sha>]
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, die, isReleaseVersion, listZipNames, loadDist, readZipEntry, REPO } from './lib/release-lib.mjs';
import { CAPS, checkSdkBinary, ELECTRON_REL, FILES_LIST, isSafeRel, listTree, packageAssetName, PLATFORM, pruneSdkPlatforms, sha256File } from './lib/package-lib.mjs';
import { writeZipFile } from './lib/zip-stream.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const SKIP_NM = (r) => r === '.bin' || r.startsWith('.bin/') || r === '.package-lock.json' || r === '.cache' || r.startsWith('.cache/');

function run(cmd, argv, cwd) {
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) die(`${cmd} ${argv.join(' ')} failed (exit ${r.status})`);
}

/**
 * o: { repo, root, out, publishedAt, commit, dirty, nodeModules (a production-only node_modules that THIS function may prune), electronDist, electronVersion,
 *      selfcheck, log }
 * Returns { zip, appZip, size, sha256, entries, version }.
 */
export async function buildPackage(o) {
  const log = o.log ?? (() => undefined);
  const root = resolve(o.root ?? o.repo);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const top = `legion-${version}`;
  if (!isReleaseVersion(version)) throw new Error(`package.json version "${version}" is not MAJOR.MINOR.PATCH with an optional single-letter patch suffix (e.g. 0.2.2-a)`);
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const lockElectron = lock.packages?.['node_modules/electron']?.version;
  if (!lockElectron) throw new Error('package-lock.json has no electron entry');
  if (o.electronVersion !== lockElectron) throw new Error(`Electron ${o.electronVersion} is installed but the lock pins ${lockElectron}: run npm ci`);
  if (!existsSync(join(o.electronDist, 'electron.exe'))) throw new Error(`${o.electronDist}\\electron.exe is missing (is this the Windows Electron?)`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(o.publishedAt)) throw new Error('publishedAt must look like 2026-10-20T10:00:00Z');

  const gone = pruneSdkPlatforms(o.nodeModules);
  log(`removed other SDK platforms: ${gone.join(', ') || 'none'}`);
  const sdk = await checkSdkBinary(o.nodeModules);
  const sdkVersion = JSON.parse(readFileSync(join(o.nodeModules, '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;

  const out = resolve(o.out); mkdirSync(out, { recursive: true });
  const work = join(out, '.work'); rmSync(work, { recursive: true, force: true }); mkdirSync(work, { recursive: true });
  const info = { platform: PLATFORM, kind: 'package', builtAt: o.publishedAt, commit: o.commit ?? 'unknown', dirty: !!o.dirty, electron: o.electronVersion, sdk: sdkVersion, sdkBinarySha256: sdk.sha256 };
  const infoFile = join(work, 'build-info-extra.json'); writeFileSync(infoFile, JSON.stringify(info));
  const rp = spawnSync(process.execPath, [join(REPO, 'scripts', 'release-package.mjs'), '--out', out, '--root', root, '--published-at', o.publishedAt, '--build-info', infoFile], { encoding: 'utf8' });
  if (rp.status !== 0) throw new Error(`release-package.mjs failed: ${rp.stderr || rp.stdout}`);
  const appZip = join(out, `legion-${version}-app.zip`);
  const appBytes = readFileSync(appZip);
  const entries = [];
  for (const name of listZipNames(appBytes)) entries.push({ name, data: readZipEntry(appBytes, name) });
  log(`code set: ${entries.length} files from the update zip`);

  for (const f of listTree(o.nodeModules, SKIP_NM)) entries.push({ name: `${top}/node_modules/${f.rel}`, file: join(o.nodeModules, ...f.rel.split('/')), size: f.size });
  for (const f of listTree(o.electronDist)) entries.push({ name: `${top}/runtime/electron/${f.rel}`, file: join(o.electronDist, ...f.rel.split('/')), size: f.size });

  // names and limits (the installer and PowerShell refuse the same things; better to fail here)
  let unpacked = 0;
  for (const e of entries) {
    const rel = e.name.slice(top.length + 1);
    const bad = isSafeRel(rel); if (bad) throw new Error(`cannot ship "${rel.slice(0, 80)}": ${bad}`);
    if (rel.length > CAPS.relPathChars) throw new Error(`path too long for Windows (${rel.length} > ${CAPS.relPathChars}): ${rel.slice(0, 80)}`);
    unpacked += e.data ? e.data.length : e.size;
  }
  if (entries.length + 1 > CAPS.entries) throw new Error(`${entries.length} files is more than the installer accepts (${CAPS.entries})`);
  if (unpacked > CAPS.unpackedBytes) throw new Error(`the package unpacks to ${Math.round(unpacked / 1e6)} MB, over the installer's limit`);
  if (!entries.some((e) => e.name === `${top}/${ELECTRON_REL}`)) throw new Error('electron.exe did not make it into the package');

  const list = { schema: 1, files: [] };
  for (const e of entries) list.files.push({ path: e.name.slice(top.length + 1), size: e.data ? e.data.length : e.size, sha256: e.data ? sha(e.data) : await sha256File(e.file) });
  list.files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  entries.push({ name: `${top}/${FILES_LIST}`, data: Buffer.from(JSON.stringify(list)) });
  entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));

  const zip = join(out, packageAssetName(version));
  const w = writeZipFile(zip, entries);
  log(`wrote ${zip}: ${w.entries} entries, ${Math.round(w.size / 1e6)} MB`);

  const mf = spawnSync(process.execPath, [join(REPO, 'scripts', 'release-manifest.mjs'), '--zip', appZip, '--out', out], { encoding: 'utf8' });
  if (mf.status !== 0) throw new Error(`release-manifest.mjs failed: ${mf.stderr || mf.stdout}`);
  const sums = readFileSync(join(out, 'SHA256SUMS.txt'), 'utf8').trimEnd().split('\n');
  sums.push(`${w.sha256}  ${basename(zip)}`);
  sums.sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : 1));
  writeFileSync(join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

  if (o.selfcheck !== false) {
    log('self-check: reading the finished zip back with the installer\'s own zip reader and file list');
    await selfCheck(zip, top, work);
  }
  if (!o.keepWork) rmSync(work, { recursive: true, force: true });
  return { zip, appZip, size: w.size, sha256: w.sha256, entries: w.entries, version };
}

/** Extracts the finished zip with the strict reader (src/core/blender/zip.ts) and runs the installer's own in-place verification on it. */
export async function selfCheck(zip, top, work) {
  const { extractZip } = await loadDist('src/core/blender/zip.js');
  const { createReadStream, createWriteStream, closeSync, fstatSync, openSync, readSync } = await import('node:fs');
  const fd = openSync(zip, 'r'); const size = fstatSync(fd).size;
  const dir = join(work, 'selfcheck'); rmSync(dir, { recursive: true, force: true });
  try {
    await extractZip({ size, read: async (off, len) => { const b = Buffer.alloc(len); const n = readSync(fd, b, 0, len, off); return b.subarray(0, n); }, stream: (s, e) => createReadStream(zip, { start: s, end: e }) },
      { mkdirp: (d) => mkdirSync(d, { recursive: true }), openWrite: (f) => createWriteStream(f, { flags: 'wx' }) }, dir, top, { maxEntries: CAPS.entries, maxUnpackedBytes: CAPS.unpackedBytes });
  } finally { closeSync(fd); }
  const { installPackage } = await import('./package-install.mjs');
  await installPackage({ src: join(dir, top), dest: join(dir, top), smoke: () => null });
  rmSync(dir, { recursive: true, force: true });
}

function git(argv) { const r = spawnSync('git', argv, { cwd: REPO, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2), { out: 'v', 'skip-build': 'flag', 'allow-dirty': 'flag', 'published-at': 'v', 'keep-work': 'flag', 'no-selfcheck': 'flag', foreign: 'flag', 'node-modules': 'v', 'electron-dist': 'v', 'electron-version': 'v', root: 'v', commit: 'v' });
  if (!a.out) die('usage: node scripts/build-package.mjs --out <folder> [--skip-build] [--allow-dirty] [--published-at <UTC ISO>]');
  if (!a.foreign && !(process.platform === 'win32' && process.arch === 'x64')) die('this builds the Windows x64 package: run it on Windows x64 (the Windows Electron and claude.exe come from the dependency install).');
  if (resolve(a.out) === REPO || resolve(a.out).startsWith(REPO + (process.platform === 'win32' ? '\\' : '/'))) die('--out must be outside the repository (the output would dirty the tree and could end up in the package)');
  const nodeVer = process.versions.node.split('.').map(Number);
  if (nodeVer[0] < 20 || (nodeVer[0] === 20 && nodeVer[1] < 10)) die('Node 20.10 or newer is needed to build');
  const dirty = a.foreign ? false : git(['status', '--porcelain']) !== '';
  if (dirty && !a['allow-dirty']) die('the git tree has uncommitted changes (use --allow-dirty to build anyway; it is recorded in build-info.json)');
  const commit = a.commit ?? (git(['rev-parse', 'HEAD']) || 'unknown');
  let publishedAt = a['published-at'];
  if (!publishedAt) { const c = git(['log', '-1', '--format=%cI']); publishedAt = c ? new Date(c).toISOString().replace(/\.\d+Z$/, 'Z') : ''; }
  if (!publishedAt) die('could not read the commit time; pass --published-at 2026-10-20T10:00:00Z');
  if (a.foreign && !a['node-modules']) die('--foreign needs --node-modules, --electron-dist and --electron-version (it never runs npm for you)');
  let nodeModules = a['node-modules']; let electronDist = a['electron-dist']; let electronVersion = a['electron-version'];
  if (!nodeModules) {
    if (!a['skip-build']) { run('npm', ['ci'], REPO); run('npm', ['run', 'build'], REPO); }
    const scratch = join(resolve(a.out), '.prod'); rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch, { recursive: true });
    copyFileSync(join(REPO, 'package.json'), join(scratch, 'package.json')); copyFileSync(join(REPO, 'package-lock.json'), join(scratch, 'package-lock.json'));
    run('npm', ['ci', '--omit=dev', '--ignore-scripts'], scratch);
    nodeModules = join(scratch, 'node_modules');
    electronDist = join(REPO, 'node_modules', 'electron', 'dist');
    electronVersion = JSON.parse(readFileSync(join(REPO, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  }
  if (!electronDist || !electronVersion) die('--electron-dist and --electron-version are needed with --node-modules');
  try {
    const r = await buildPackage({ repo: REPO, ...(a.root ? { root: a.root } : {}), out: a.out, publishedAt, commit, dirty, nodeModules, electronDist, electronVersion, selfcheck: !a['no-selfcheck'], keepWork: !!a['keep-work'], log: (s) => console.log(`[build-package] ${s}`) });
    rmSync(join(resolve(a.out), '.prod'), { recursive: true, force: true });
    console.log(`\nDone. ${r.zip}\n  ${Math.round(r.size / 1e6)} MB, ${r.entries} files, sha256 ${r.sha256}\nNext: sign the manifest with scripts/release-sign.mjs (your key, outside the repo); publish the zips, the manifest, its .sig and SHA256SUMS.txt.`);
  } catch (e) { die(e && e.message ? e.message : String(e)); }
}
