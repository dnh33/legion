// Rehearsal-only: builds throwaway candidate releases from a BUILT checkout, signs their manifests with a throwaway key, and
// lays them out for scripts/rehearsal/serve.mjs. Nothing is published and the real signing key is never used or read.
//   good: version 0.99.0, a normal full package (a dependency-change release: requiresFullInstall + fullAsset)
//   base: version 0.98.0, only its full zip: a baseline built from THIS checkout, for scenarios that must run the new swap helper
//         (an install of a published release always swaps with the helper of that older release)
//   codeonly: the base version as a CODE-ONLY release (app.zip, no full package), signed like the others: the first hop of the chain
//         scenario (live release -> code-only candidate -> full-package candidate). It keeps the lock of the latest PUBLISHED release, so it
//         is a realistic code-only release for that baseline (a checkout whose lock differs would be refused by the baseline)
//   realstone: the REAL published stepping stone (v0.3.0): its legion-0.3.0-app.zip is downloaded from the public release, checked against the pin in
//         scripts/stepping-stones.json, and only its MANIFEST is rebuilt from those exact bytes and re-signed with the throwaway key. The
//         stone scenarios walk through that real package, so the frozen 0.3.0 updater itself is under test
//   stone: the stepping-stone layout of a full-install release (docs/SHIPPING.md): the OLD manifest name carries the real stone's manifest (what
//         the live 0.2.7 reads), the SECOND name carries the full candidate 0.99.0 and names that stone (what 0.3.0 and later read)
//   later: version 0.99.2, a CODE-ONLY release published after the full one, with the STONE's lock: its own manifest under the second name, the stone's
//         under the old name, for the stone-later scenario (both hops are code swaps)
//   stranded: version 0.99.2 as the next code-only release after the stone, with a lock that DIFFERS from the stone's, built with --carry-full (its
//         own full package in the manifest). stone-stranded: the frozen 0.3.0 updater must fall back to that package. stone-stranded-nofull: the
//         same release WITHOUT a fullAsset (what the old rule would have published): the stone install must end on a notice
//   stranded2: version 0.99.3, a code-only release with the same lock as stranded, also carrying its full package: a stranded-2 install must take the
//         CODE package and never download the carried one
//   bad:  version 0.99.1, the same as good but its Electron main exits at once, so the first start fails and must be rolled back
//   unix, unixbad, unixold (scripts/rehearsal/run-unix.mjs, the Mac and Linux jobs): CODE-ONLY releases that keep the lock of THIS checkout, which is also the lock of the
//         throwaway baseline the Unix jobs install, so the code route is taken. unix 0.99.0 is the good one, unixbad 0.99.1 has a main that exits (rolled back),
//         unixold 0.97.0 is validly signed but older than the baseline 0.98.0 (a downgrade, refused). Laid out like a real release after the stone: the second
//         name is the release, the old name is the real stone's signed manifest. unix-badsig is unix's second-name manifest with its version text changed
//         after signing and the ORIGINAL .sig, so the signature no longer matches the bytes. None of them has a Windows package.
// usage: node scripts/rehearsal/prepare.mjs --out <folder outside the repo> [--good 0.99.0] [--bad 0.99.1] [--base 0.98.0]
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, insideGitTree, readZipEntry, REPO } from '../lib/release-lib.mjs';
import { fetchBytes, latestTagOf, readStones, REPO_BASE } from '../lib/stepping-stone.mjs';

const a = args(process.argv.slice(2), { out: 'v', good: 'v', bad: 'v', base: 'v', later: 'v' });
if (!a.out) die('usage: node scripts/rehearsal/prepare.mjs --out <folder outside the repo>');
const out = resolve(a.out);
if (insideGitTree(out)) die('--out must be outside the repository and any git work tree (the throwaway key is written there)');
const STONE = readStones().at(-1);
const versions = { good: a.good ?? '0.99.0', bad: a.bad ?? '0.99.1', base: a.base ?? '0.98.0', later: a.later ?? '0.99.2', stone: STONE, stranded: '0.99.2', stranded2: '0.99.3', unix: a.good ?? '0.99.0', unixbad: a.bad ?? '0.99.1', unixold: '0.97.0' };
mkdirSync(out, { recursive: true });

const sha = (b) => createHash('sha256').update(b).digest('hex');
const run = (script, argv) => {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', script), ...argv], { encoding: 'utf8' });
  if (r.status !== 0) die(`${script} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
};

// 1. throwaway key + a trust module that holds only it (what release-sign and release-verify are told to trust)
const keys = join(out, 'keys');
rmSync(keys, { recursive: true, force: true }); // a rerun makes a new throwaway key
run('release-keygen.mjs', ['--out', keys]);
const pubFile = join(keys, 'legion-update-k1.pub.pem');
const pub = readFileSync(pubFile, 'utf8');
const trustFile = join(keys, 'trust.mjs');
const key = join(keys, 'legion-update-k1.key.pem');
writeFileSync(trustFile, `import { verifyManifestSignature as v } from ${JSON.stringify(pathToFileURL(join(REPO, 'dist/src/core/updater/trust.js')).href)};\nexport const UPDATE_KEYS = [{ id: 'k1', publicKeyPem: ${JSON.stringify(pub)} }];\nexport const verifyManifestSignature = (m, s, k) => v(m, s, k);\n`);
const served = join(out, 'served');
const sign = (manifest) => run('release-sign.mjs', ['--key', key, '--manifest', manifest, '--trust-module', trustFile]);
const copyTo = (dir, from, names) => { mkdirSync(dir, { recursive: true }); for (const f of names) cpSync(join(from, f), join(dir, f)); };

// 2. the REAL stepping stone and the lock of the latest published release (read-only downloads from the public repo)
const releaseZip = async (v) => {
  const r = await fetchBytes(`${REPO_BASE}/releases/download/v${v}/legion-${v}-app.zip`, 600_000);
  if (r.status !== 200) die(`could not download legion-${v}-app.zip (HTTP ${r.status})`);
  return r.bytes;
};
const lockOfZip = (zip, v) => (readZipEntry(zip, `legion-${v}/package-lock.json`) ?? die(`legion-${v}-app.zip has no package-lock.json`)).toString('utf8');
const stoneZip = await releaseZip(STONE);
const pinned = JSON.parse(readFileSync(join(REPO, 'scripts', 'stepping-stones.json'), 'utf8')).pins?.[STONE]?.files?.[`legion-${STONE}-app.zip`];
if (!pinned) die(`scripts/stepping-stones.json has no pin for legion-${STONE}-app.zip`);
if (sha(stoneZip) !== pinned) die(`the downloaded legion-${STONE}-app.zip is not the pinned stone (sha256 ${sha(stoneZip)}, pinned ${pinned})`);
const stoneLock = lockOfZip(stoneZip, STONE);
const stoneLockFile = join(out, 'stone-package-lock.json');
writeFileSync(stoneLockFile, stoneLock);
const liveTag = (await latestTagOf(REPO_BASE)).replace(/^v/, '');
const liveLock = liveTag === STONE ? stoneLock : lockOfZip(await releaseZip(liveTag), liveTag);
console.log(`real stone ${STONE} downloaded and matches its pin; latest published release is ${liveTag}`);
// The stone's manifest is rebuilt from the real package's exact bytes (name, size, sha256, depsSha256 of its lock) and signed with the throwaway key.
// Both names carry it (it is the stone itself); only the old name is served.
const stoneBuild = join(out, 'pkg-realstone');
rmSync(stoneBuild, { recursive: true, force: true }); mkdirSync(stoneBuild, { recursive: true });
writeFileSync(join(stoneBuild, `legion-${STONE}-app.zip`), stoneZip);
const stoneNotes = join(stoneBuild, 'notes.txt'); writeFileSync(stoneNotes, `Rehearsal manifest of the real ${STONE} package. Not a release.\n`);
run('release-manifest.mjs', ['--zip', join(stoneBuild, `legion-${STONE}-app.zip`), '--notes', stoneNotes, '--out', stoneBuild]);
sign(join(stoneBuild, 'legion-update-manifest.json'));
const stoneDir = join(served, 'realstone');
copyTo(stoneDir, stoneBuild, ['legion-update-manifest.json', 'legion-update-manifest.json.sig', `legion-${STONE}-app.zip`]);
/** The files every stone-era layout needs next to its own: the real stone, under the old name. */
const withStone = (dir) => copyTo(dir, stoneDir, ['legion-update-manifest.json', 'legion-update-manifest.json.sig', `legion-${STONE}-app.zip`]);

// 3. each candidate: a copy of the built code set with its own version (and, for "bad", a main that exits)
const CODE = ['dist', 'dist-ui', 'assets', 'scripts', 'licenses', 'package.json', 'package-lock.json', 'NOTICE', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'setup.cmd', 'setup-yes.cmd', 'start-legion.cmd'];
const publishedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
/** The lock a candidate carries: `text` with its own version fields set; `marker` adds a dependency entry, so its dependency content differs from `text`. */
const lockFor = (text, version, marker) => {
  const j = JSON.parse(text); j.version = version; if (j.packages?.['']) j.packages[''].version = version;
  if (marker) { j.packages = { ...(j.packages ?? {}), 'node_modules/legion-rehearsal-lock-marker': { version: '1.0.0' } }; }
  return JSON.stringify(j, null, 2) + '\n';
};
const checkoutLock = readFileSync(join(REPO, 'package-lock.json'), 'utf8');
// which lock each candidate carries, and whether it needs the full package built (the two code-only ones are packaged as the app zip alone)
const PLAN = {
  base: { lock: () => checkoutLock, full: true }, good: { lock: () => checkoutLock, full: true }, bad: { lock: () => checkoutLock, full: true },
  later: { lock: () => stoneLock, full: false },
  stranded: { lock: () => checkoutLock, marker: true, full: true }, stranded2: { lock: () => checkoutLock, marker: true, full: false },
  unix: { lock: () => checkoutLock, full: false }, unixbad: { lock: () => checkoutLock, full: false }, unixold: { lock: () => checkoutLock, full: false },
};
for (const name of Object.keys(PLAN)) {
  const version = versions[name];
  const tree = join(out, 'trees', name);
  rmSync(tree, { recursive: true, force: true }); mkdirSync(tree, { recursive: true });
  for (const n of CODE) if (existsSync(join(REPO, n))) cpSync(join(REPO, n), join(tree, n), { recursive: true, filter: (s) => !/[\/]dist[\/]test([\/]|$)/.test(s) });
  const patch = (rel, fn) => { const f = join(tree, rel); writeFileSync(f, fn(readFileSync(f, 'utf8'))); };
  patch('package.json', (t) => { const j = JSON.parse(t); j.version = version; return JSON.stringify(j, null, 2) + '\n'; });
  patch('package-lock.json', () => lockFor(PLAN[name].lock(), version, PLAN[name].marker));
  patch('dist/src/shared/config.js', (t) => { const re = /(export const VERSION = ')[^']+(')/; if (!re.test(t)) die('dist/src/shared/config.js has no VERSION to patch'); return t.replace(re, `$1${version}$2`); });
  if (name === 'bad' || name === 'unixbad') writeFileSync(join(tree, 'dist/src/electron/main.js'), '// rehearsal: a build whose first start fails\nprocess.exit(1);\n');

  const pkg = join(out, `pkg-${name}`);
  rmSync(pkg, { recursive: true, force: true });
  if (PLAN[name].full) run('build-package.mjs', ['--out', pkg, '--skip-build', '--root', tree, '--published-at', publishedAt, ...(name === 'bad' ? ['--no-selfcheck'] : [])]);
  else run('release-package.mjs', ['--out', pkg, '--root', tree, '--published-at', publishedAt]);
  const app = join(pkg, `legion-${version}-app.zip`);
  if (name === 'base') {
    mkdirSync(join(served, 'base'), { recursive: true });
    cpSync(join(pkg, `legion-${version}-win-x64.zip`), join(served, 'base', `legion-${version}-win-x64.zip`));
    // the chain's first hop: this checkout's code as a CODE-ONLY release that keeps the lock of the latest published release
    patch('package-lock.json', () => lockFor(liveLock, version));
    const coPkg = join(out, 'pkg-codeonly');
    rmSync(coPkg, { recursive: true, force: true });
    run('release-package.mjs', ['--out', coPkg, '--root', tree, '--published-at', publishedAt]);
    const cnotes = join(coPkg, 'notes.txt'); writeFileSync(cnotes, `Rehearsal code-only build ${version}. Not a release.\n`);
    run('release-manifest.mjs', ['--zip', join(coPkg, `legion-${version}-app.zip`), '--notes', cnotes, '--out', coPkg, '--stones', version]);
    sign(join(coPkg, 'legion-update-manifest.json'));
    copyTo(join(served, 'codeonly'), coPkg, ['legion-update-manifest.json', 'legion-update-manifest.json.sig', `legion-${version}-app.zip`]);
    rmSync(tree, { recursive: true, force: true });
    console.log(`prepared base ${version}`);
    continue;
  }
  const notes = join(pkg, 'notes.txt'); writeFileSync(notes, `Rehearsal build ${version}. Not a release.\n`);
  // Verified with the real release-verify (offline), so every layout served is the one the tooling accepts. The stone lock is the real stone's.
  const verify = () => run('release-verify.mjs', ['--dir', pkg, '--trust-module', trustFile, '--no-network', '--stone-lock', stoneLockFile]);
  if (name === 'later') {
    run('release-manifest.mjs', ['--zip', app, '--notes', notes, '--out', pkg, '--stepping-stone', stoneDir]);
    sign(join(pkg, 'legion-update-manifest-2.json'));
    verify();
    const ld = join(served, 'stone-later');
    withStone(ld);
    copyTo(ld, pkg, ['legion-update-manifest-2.json', 'legion-update-manifest-2.json.sig', `legion-${version}-app.zip`]);
    rmSync(tree, { recursive: true, force: true });
    console.log(`prepared later ${version}`);
    continue;
  }
  if (name === 'unix' || name === 'unixbad' || name === 'unixold') {
    // Not run through release-verify: that tool checks a code-only release against the STONE's lock, and these carry this checkout's lock on purpose.
    run('release-manifest.mjs', ['--zip', app, '--notes', notes, '--out', pkg, '--stepping-stone', stoneDir]);
    sign(join(pkg, 'legion-update-manifest-2.json'));
    const dirName = { unix: 'unix-good', unixbad: 'unix-bad', unixold: 'unix-old' }[name];
    const ud = join(served, dirName);
    withStone(ud);
    copyTo(ud, pkg, ['legion-update-manifest-2.json', 'legion-update-manifest-2.json.sig', `legion-${version}-app.zip`]);
    if (name === 'unix') {
      const bd = join(served, 'unix-badsig');
      withStone(bd);
      copyTo(bd, pkg, ['legion-update-manifest-2.json.sig', `legion-${version}-app.zip`]);
      const mf = join(pkg, 'legion-update-manifest-2.json');
      const text = readFileSync(mf, 'utf8');
      const tampered = text.replace(`"version": "${version}"`, '"version": "0.99.9"');
      if (tampered === text) die('could not tamper with the unix manifest: no version line');
      writeFileSync(join(bd, 'legion-update-manifest-2.json'), tampered);
    }
    rmSync(tree, { recursive: true, force: true });
    console.log(`prepared ${name} ${version}`);
    continue;
  }
  if (name === 'stranded' || name === 'stranded2') {
    const fullName = `legion-${version}-win-x64.zip`;
    // stranded2 never has its carried package fetched: a tiny placeholder is enough to carry (and to prove it is not downloaded)
    if (name === 'stranded2') writeFileSync(join(pkg, fullName), `rehearsal placeholder for ${fullName}: the code route must never fetch this\n`);
    const full = join(pkg, fullName);
    run('release-manifest.mjs', ['--zip', app, '--full-zip', full, '--carry-full', '--notes', notes, '--out', pkg, '--stepping-stone', stoneDir]);
    sign(join(pkg, 'legion-update-manifest-2.json'));
    verify();
    const dest = join(served, name === 'stranded' ? 'stone-stranded' : 'stone-stranded-2');
    withStone(dest);
    copyTo(dest, pkg, ['legion-update-manifest-2.json', 'legion-update-manifest-2.json.sig', `legion-${version}-app.zip`, fullName]);
    if (name === 'stranded') {
      const listed = readZipEntry(readFileSync(full), `legion-${version}/PACKAGE-FILES.json`);
      if (!listed) die('the full package has no PACKAGE-FILES.json');
      writeFileSync(join(dest, 'PACKAGE-FILES.json'), listed);
      // The negative variant: the same code-only release as the old rule would have published it, WITHOUT the fullAsset. A 0.3.0 install cannot take
      // its code package (different lock) and has nothing to fall back to. The tooling refuses to publish this layout, so it is not verified.
      const nf = join(out, 'pkg-stranded-nofull');
      rmSync(nf, { recursive: true, force: true }); mkdirSync(nf, { recursive: true });
      cpSync(app, join(nf, `legion-${version}-app.zip`));
      run('release-manifest.mjs', ['--zip', join(nf, `legion-${version}-app.zip`), '--notes', notes, '--out', nf, '--stepping-stone', stoneDir]);
      sign(join(nf, 'legion-update-manifest-2.json'));
      const nd = join(served, 'stone-stranded-nofull');
      withStone(nd);
      copyTo(nd, nf, ['legion-update-manifest-2.json', 'legion-update-manifest-2.json.sig', `legion-${version}-app.zip`]);
    }
    rmSync(tree, { recursive: true, force: true });
    console.log(`prepared ${name} ${version}`);
    continue;
  }
  const full = join(pkg, `legion-${version}-win-x64.zip`);
  const manifestArgs = ['--zip', app, '--full-zip', full, '--requires-full-install', '--notes', notes, '--out', pkg];
  if (name === 'good') {
    // The stepping-stone layout first: old name = the real stone's manifest, second name = this full candidate.
    run('release-manifest.mjs', [...manifestArgs, '--stepping-stone', stoneDir]);
    sign(join(pkg, 'legion-update-manifest-2.json'));
    verify();
    const sd = join(served, 'stone');
    withStone(sd);
    copyTo(sd, pkg, ['legion-update-manifest-2.json', 'legion-update-manifest-2.json.sig', `legion-${version}-win-x64.zip`]);
  }
  // The direct layout (a full release whose old name is the release itself, served WITHOUT the second name, so updaters fall back to the old one):
  // what the scenarios that prove a direct jump use. The tooling refuses to publish this layout, so it is not verified with release-verify.
  run('release-manifest.mjs', [...manifestArgs, '--stones', version]);
  sign(join(pkg, 'legion-update-manifest.json'));
  const dest = join(served, name);
  copyTo(dest, pkg, ['legion-update-manifest.json', 'legion-update-manifest.json.sig', `legion-${version}-win-x64.zip`]);
  // the package's own file list: the scenarios compare the installed files with it (an install does not keep this file)
  const listed = readZipEntry(readFileSync(full), `legion-${version}/PACKAGE-FILES.json`);
  if (!listed) die('the full package has no PACKAGE-FILES.json');
  writeFileSync(join(dest, 'PACKAGE-FILES.json'), listed);
  if (name === 'good') writeFileSync(join(served, 'stone', 'PACKAGE-FILES.json'), listed);
  rmSync(tree, { recursive: true, force: true });
  console.log(`prepared ${name} ${version}`);
}
// What the scenario jobs download: the served folders, the PUBLIC key and this file. The private key stays in keys/ and is never uploaded.
cpSync(pubFile, join(out, 'legion-update-k1.pub.pem'));
writeFileSync(join(out, 'prepared.json'), JSON.stringify({ versions, publishedAt }, null, 2));
