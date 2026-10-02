#!/usr/bin/env node
// Installs (or updates in place) a prebuilt Legion package. Run by setup.ps1 with the PACKAGE'S OWN electron.exe in node mode, so the user needs no Node.
// usage: electron.exe scripts/package-install.mjs --src <unpacked package> --dest <install folder> [--data-dir <folder never touched>]... [--json]
// It checks the unpacked package against its file list while copying (what is installed is what was hashed), swaps it in with the updater's own
// journaled swap/rollback, runs a smoke test of the installed runtime and the bundled claude.exe, and keeps nothing it does not own.
// Exit codes: 0 installed, 2 not a usable package or a refused folder, 3 a file was blocked, removed or failed to run, 1 anything else.
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, loadDist } from './lib/release-lib.mjs';
import { blockedMessage, CLAUDE_REL, ELECTRON_REL, FILES_LIST, listTree, packageTopNames, parseFilesList, readBuildInfo } from './lib/package-lib.mjs';

export class InstallError extends Error {
  constructor(code, message, file) { super(message); this.code = code; this.file = file; }
  get exitCode() { return this.code === 'blocked' || this.code === 'smoke' ? 3 : this.code === 'other' ? 1 : 2; }
}
const BLOCKED_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'UNKNOWN', 'ENOENT', 'EIO', 'EMFILE']);

const under = (parent, child) => { const p = resolve(parent), c = resolve(child); return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep); };
const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

function copyHashed(from, to, size, sha256, mode) {
  return new Promise((done, fail) => {
    const h = createHash('sha256'); let n = 0;
    const input = createReadStream(from);
    const output = createWriteStream(to, { flags: 'wx' });
    const bad = (e) => { input.destroy(); output.destroy(); fail(e); };
    input.on('error', bad); output.on('error', bad);
    input.on('data', (c) => { h.update(c); n += c.length; });
    output.on('finish', () => {
      if (n !== size) return fail(new InstallError('incomplete', `${from} has ${n} bytes, the list says ${size}`, from));
      if (h.digest('hex') !== sha256) return fail(new InstallError('incomplete', `${from} does not match its checksum in ${FILES_LIST}`, from));
      if (process.platform !== 'win32') { try { chmodSync(to, mode); } catch { /* best effort */ } }
      done();
    });
    input.pipe(output);
  });
}
function hashOnly(file, size, sha256) {
  return new Promise((done, fail) => {
    const h = createHash('sha256'); let n = 0;
    createReadStream(file).on('data', (c) => { h.update(c); n += c.length; }).on('error', fail).on('end', () => {
      if (n !== size || h.digest('hex') !== sha256) return fail(new InstallError('incomplete', `${file} does not match its checksum in ${FILES_LIST}`, file));
      done();
    });
  });
}

/** Reads and checks the package in `src`: kind, top-level names, file list equals what is on disk (no missing, no extra, no links). */
export function checkSourceTree(src, topNames) {
  const info = readBuildInfo(src);
  if (!info || info.kind !== 'package' || info.platform !== 'win32-x64' || typeof info.version !== 'string') throw new InstallError('not-package', 'this folder is not a Legion Windows package (build-info.json is missing or is not a package)');
  let files;
  try { files = parseFilesList(readFileSync(join(src, FILES_LIST), 'utf8'), topNames); }
  catch (e) { throw new InstallError('incomplete', `${FILES_LIST}: ${e.message}`); }
  let onDisk;
  try { onDisk = listTree(src, (r) => r === FILES_LIST); } catch (e) { throw new InstallError('incomplete', e.message); }
  const listed = new Map(files.map((f) => [f.path, f]));
  for (const f of onDisk) {
    const want = listed.get(f.rel);
    if (!want) throw new InstallError('incomplete', `the package holds a file that is not on its list: ${f.rel}`, f.rel);
  }
  const have = new Set(onDisk.map((f) => f.rel));
  for (const f of files) if (!have.has(f.path)) throw new InstallError('blocked', blockedMessage(f.path), f.path);
  for (const must of [ELECTRON_REL, CLAUDE_REL, 'package.json', 'dist/src/electron/main.js', 'dist/src/bin/legion-core.js', 'dist-ui/index.html', 'build-info.json']) if (!listed.has(must)) throw new InstallError('incomplete', `the package list has no ${must}`);
  const modes = new Map(onDisk.map((f) => [f.rel, f.mode]));
  return { info, files, modes };
}

export function checkDest(src, dest, dataDirs) {
  const full = resolve(dest);
  if (parse(full).root === full || /^[A-Za-z]:[\\/]?$/.test(dest)) throw new InstallError('unsafe-dest', `refusing to install into ${dest}: that is a drive root`);
  for (const d of dataDirs.filter(Boolean)) if (under(d, full) || under(full, d)) throw new InstallError('unsafe-dest', `refusing to install into ${full}: it is, contains or sits inside the Legion data folder (${d})`);
  if (existsSync(full)) {
    if (lstatSync(full).isSymbolicLink()) throw new InstallError('unsafe-dest', `refusing to install through a link: ${full}`);
    if (!statSync(full).isDirectory()) throw new InstallError('unsafe-dest', `${full} is a file, not a folder`);
    const kids = readdirSync(full).filter((n) => n !== '.update');
    if (kids.length) {
      let ok = false;
      try { ok = JSON.parse(readFileSync(join(full, 'package.json'), 'utf8')).name === 'legion'; } catch { ok = false; }
      if (!ok) throw new InstallError('unsafe-dest', `${full} is not empty and is not a Legion install; pick a new or empty folder`);
    }
  }
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const inPlace = existsSync(full) && same(real(src), real(full));
  if (!inPlace && (under(real(src), real(full)) || under(real(full), real(src)))) throw new InstallError('unsafe-dest', 'the install folder and the package folder must not be inside each other');
  return { full, inPlace };
}

/** The installed runtime must start and the bundled claude.exe must run. Returns null when fine, else the file that failed. */
export function realSmoke(dest) {
  const electron = join(dest, ...ELECTRON_REL.split('/'));
  const r = spawnSync(electron, ['-e', 'process.stdout.write("legion-node-ok")'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000, windowsHide: true, encoding: 'utf8' });
  if (r.error || r.status !== 0 || !String(r.stdout).includes('legion-node-ok')) return ELECTRON_REL;
  const claude = join(dest, ...CLAUDE_REL.split('/'));
  const c = spawnSync(claude, ['--version'], { timeout: 90_000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (c.error || c.status !== 0) return CLAUDE_REL;
  return null;
}

/**
 * opts: { src, dest, dataDirs?: string[], smoke?: (dest) => string|null, log?: (s) => void, retryMs?: number, step?: (label) => void }
 * Returns { version, from, files, bytes, inPlace }. Throws InstallError.
 */
export async function installPackage(opts) {
  const log = opts.log ?? (() => undefined);
  const { CODE_SET, swapIn, rollback, markCommitted, removeOwned } = await loadDist('src/core/updater/apply.js');
  const topNames = packageTopNames(CODE_SET);
  const src = resolve(opts.src);
  const { info, files, modes } = checkSourceTree(src, topNames);
  const topSrc = new Set(readdirSync(src));
  for (const n of topSrc) if (n !== FILES_LIST && !topNames.includes(n)) throw new InstallError('incomplete', `the package holds "${n}", which is not part of a Legion package`);
  const { full: dest, inPlace } = checkDest(src, opts.dest, opts.dataDirs ?? []);
  const smoke = opts.smoke ?? realSmoke;
  const bytes = files.reduce((a, f) => a + f.size, 0);
  const prev = (() => { const b = readBuildInfo(dest); if (b && typeof b.version === 'string') return b.version; try { return JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; } })();
  const mapIo = (e, file) => (e instanceof InstallError ? e : new InstallError(BLOCKED_CODES.has(e.code) ? 'blocked' : 'other', BLOCKED_CODES.has(e.code) ? blockedMessage(file) : `${e.message}`, file));

  if (inPlace) {
    log('verifying the files in place');
    for (const f of files) { try { await hashOnly(join(src, ...f.path.split('/')), f.size, f.sha256); } catch (e) { throw mapIo(e, f.path); } }
    const bad = smoke(dest); if (bad) throw new InstallError('smoke', blockedMessage(bad), bad);
    return { version: info.version, from: info.version, files: files.length, bytes, inPlace: true };
  }

  mkdirSync(dest, { recursive: true });
  const upDir = join(dest, '.update');
  if (existsSync(upDir) && (lstatSync(upDir).isSymbolicLink() || !lstatSync(upDir).isDirectory())) throw new InstallError('unsafe-dest', 'the .update folder is not a plain folder');
  mkdirSync(upDir, { recursive: true });
  const staged = join(upDir, 'staging', 'pkg');
  removeOwned(dest, join(upDir, 'staging'));
  mkdirSync(staged, { recursive: true });
  try {
    log(`copying ${files.length} files (${Math.round(bytes / 1e6)} MB) and checking each one`);
    const made = new Set();
    for (const f of files) {
      const to = join(staged, ...f.path.split('/'));
      const dir = dirname(to);
      if (!made.has(dir)) { mkdirSync(dir, { recursive: true }); made.add(dir); }
      try { await copyHashed(join(src, ...f.path.split('/')), to, f.size, f.sha256, modes.get(f.path) ?? 0o644); } catch (e) { throw mapIo(e, f.path); }
    }
    const names = topNames.filter((n) => existsSync(join(staged, n)));
    try {
      await swapIn({ installDir: dest, stagedDir: staged, from: prev, to: info.version, names, retryMs: opts.retryMs ?? 15_000, ...(opts.step ? { step: opts.step } : {}) });
    } catch (e) { throw mapIo(e, dest); }
    const bad = smoke(dest);
    if (bad) {
      await rollback(dest, `the new build failed its start test (${bad})`, opts.retryMs ?? 15_000);
      throw new InstallError('smoke', blockedMessage(bad) + ' The previous version was put back.', bad);
    }
    markCommitted(dest);
    try { removeOwned(dest, join(upDir, 'prev')); } catch { /* it is only a spare copy */ }
    return { version: info.version, from: prev, files: files.length, bytes, inPlace: false };
  } finally {
    try { removeOwned(dest, join(upDir, 'staging')); } catch { /* leftovers are inside .update */ }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const raw = process.argv.slice(2); const dataDirs = []; const rest = [];
  for (let i = 0; i < raw.length; i++) { if (raw[i] === '--data-dir') { dataDirs.push(raw[++i]); } else rest.push(raw[i]); }
  const a = args(rest, { src: 'v', dest: 'v', json: 'flag' });
  try {
    if (!a.src || !a.dest) throw new InstallError('other', 'usage: package-install.mjs --src <package folder> --dest <install folder> [--data-dir <folder>] [--json]');
    const r = await installPackage({ src: a.src, dest: a.dest, dataDirs, log: (s) => console.error(`[package-install] ${s}`) });
    console.log(a.json ? JSON.stringify({ ok: true, ...r }) : `Installed Legion ${r.version} (${r.files} files) in ${a.dest}`);
    process.exit(0);
  } catch (e) {
    const ie = e instanceof InstallError ? e : new InstallError('other', e && e.message ? e.message : String(e));
    console.error(`ERROR: ${ie.message}`);
    if (a.json) console.log(JSON.stringify({ ok: false, code: ie.code, message: ie.message, ...(ie.file ? { file: ie.file } : {}) }));
    process.exit(ie.exitCode);
  }
}
