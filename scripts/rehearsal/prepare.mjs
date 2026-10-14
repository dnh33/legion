// Rehearsal-only: builds two throwaway candidate releases from a BUILT checkout, signs their manifests with a throwaway key, and
// lays them out for scripts/rehearsal/serve.mjs. Nothing is published and the real signing key is never used or read.
//   good: version 0.99.0, a normal full package (a dependency-change release: requiresFullInstall + fullAsset)
//   base: version 0.98.0, only its full zip: a baseline built from THIS checkout, for scenarios that must run the new swap helper
//         (an install of a published release always swaps with the helper of that older release)
//   bad:  version 0.99.1, the same but its Electron main exits at once, so the first start fails and must be rolled back
// usage: node scripts/rehearsal/prepare.mjs --out <folder outside the repo> [--good 0.99.0] [--bad 0.99.1] [--base 0.98.0]
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, die, insideGitTree, readZipEntry, REPO } from '../lib/release-lib.mjs';

const a = args(process.argv.slice(2), { out: 'v', good: 'v', bad: 'v', base: 'v' });
if (!a.out) die('usage: node scripts/rehearsal/prepare.mjs --out <folder outside the repo>');
const out = resolve(a.out);
if (insideGitTree(out)) die('--out must be outside the repository and any git work tree (the throwaway key is written there)');
const versions = { good: a.good ?? '0.99.0', bad: a.bad ?? '0.99.1', base: a.base ?? '0.98.0' };
mkdirSync(out, { recursive: true });

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
writeFileSync(trustFile, `import { verifyManifestSignature as v } from ${JSON.stringify(pathToFileURL(join(REPO, 'dist/src/core/updater/trust.js')).href)};\nexport const UPDATE_KEYS = [{ id: 'k1', publicKeyPem: ${JSON.stringify(pub)} }];\nexport const verifyManifestSignature = (m, s, k) => v(m, s, k);\n`);

// 2. each candidate: a copy of the built code set with its own version (and, for "bad", a main that exits)
const CODE = ['dist', 'dist-ui', 'assets', 'scripts', 'licenses', 'package.json', 'package-lock.json', 'NOTICE', 'LICENSE', 'README.md', 'SECURITY.md', 'CHANGELOG.md', 'setup.cmd', 'setup-yes.cmd', 'start-legion.cmd'];
const publishedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const served = join(out, 'served');
for (const name of ['base', 'good', 'bad']) {
  const version = versions[name];
  const tree = join(out, 'trees', name);
  rmSync(tree, { recursive: true, force: true }); mkdirSync(tree, { recursive: true });
  for (const n of CODE) if (existsSync(join(REPO, n))) cpSync(join(REPO, n), join(tree, n), { recursive: true, filter: (s) => !/[\/]dist[\/]test([\/]|$)/.test(s) });
  const patch = (rel, fn) => { const f = join(tree, rel); writeFileSync(f, fn(readFileSync(f, 'utf8'))); };
  patch('package.json', (t) => { const j = JSON.parse(t); j.version = version; return JSON.stringify(j, null, 2) + '\n'; });
  patch('package-lock.json', (t) => { const j = JSON.parse(t); j.version = version; if (j.packages?.['']) j.packages[''].version = version; return JSON.stringify(j, null, 2) + '\n'; });
  patch('dist/src/shared/config.js', (t) => { const re = /(export const VERSION = ')[^']+(')/; if (!re.test(t)) die('dist/src/shared/config.js has no VERSION to patch'); return t.replace(re, `$1${version}$2`); });
  if (name === 'bad') writeFileSync(join(tree, 'dist/src/electron/main.js'), '// rehearsal: a build whose first start fails\nprocess.exit(1);\n');

  const pkg = join(out, `pkg-${name}`);
  rmSync(pkg, { recursive: true, force: true });
  run('build-package.mjs', ['--out', pkg, '--skip-build', '--root', tree, '--published-at', publishedAt, ...(name === 'bad' ? ['--no-selfcheck'] : [])]);
  if (name === 'base') {
    mkdirSync(join(served, 'base'), { recursive: true });
    cpSync(join(pkg, `legion-${version}-win-x64.zip`), join(served, 'base', `legion-${version}-win-x64.zip`));
    rmSync(tree, { recursive: true, force: true });
    console.log(`prepared base ${version}`);
    continue;
  }
  const notes = join(pkg, 'notes.txt'); writeFileSync(notes, `Rehearsal build ${version}. Not a release.\n`);
  const full = join(pkg, `legion-${version}-win-x64.zip`);
  run('release-manifest.mjs', ['--zip', join(pkg, `legion-${version}-app.zip`), '--full-zip', full, '--requires-full-install', '--notes', notes, '--out', pkg]);
  run('release-sign.mjs', ['--key', join(keys, 'legion-update-k1.key.pem'), '--manifest', join(pkg, 'legion-update-manifest.json'), '--trust-module', trustFile]);
  run('release-verify.mjs', ['--dir', pkg, '--trust-module', trustFile]);
  const dest = join(served, name);
  mkdirSync(dest, { recursive: true });
  for (const f of ['legion-update-manifest.json', 'legion-update-manifest.json.sig', `legion-${version}-win-x64.zip`]) cpSync(join(pkg, f), join(dest, f));
  // the package's own file list: the scenarios compare the installed files with it (an install does not keep this file)
  const listed = readZipEntry(readFileSync(full), `legion-${version}/PACKAGE-FILES.json`);
  if (!listed) die('the full package has no PACKAGE-FILES.json');
  writeFileSync(join(dest, 'PACKAGE-FILES.json'), listed);
  rmSync(tree, { recursive: true, force: true });
  console.log(`prepared ${name} ${version}`);
}
// What the scenario jobs download: the served folders, the PUBLIC key and this file. The private key stays in keys/ and is never uploaded.
cpSync(pubFile, join(out, 'legion-update-k1.pub.pem'));
writeFileSync(join(out, 'prepared.json'), JSON.stringify({ versions, publishedAt }, null, 2));
