#!/usr/bin/env node
// Builds legion-update-manifest.json and SHA256SUMS.txt from a package made by release-package.mjs. It does NOT sign: the owner signs by hand
// with release-sign.mjs. usage: node scripts/release-manifest.mjs --zip <file> --out <folder> [--notes <text file>] [--previous <old manifest>] [--requires-full-install]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { args, die, isReleaseVersion, listZipNames, readZipEntry } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { zip: 'v', out: 'v', notes: 'v', previous: 'v', 'full-zip': 'v', 'requires-full-install': 'flag' });
if (!a.zip || !a.out) die('usage: node scripts/release-manifest.mjs --zip <file> --out <folder> [--notes <file>] [--previous <manifest>] [--full-zip <file>] [--requires-full-install]');
const zip = readFileSync(resolve(a.zip));
const sha = (b) => createHash('sha256').update(b).digest('hex');
// Read the version out of the package's own top folder. Kept as its own literal (and checked against the shared rule below)
// because splicing VERSION_RE.source into a second regex is exactly the kind of cleverness that silently stops matching.
// The acceptance check below is the real guard: it fails loudly if this and the app's rule ever disagree.
const FOLDER_RE = /^legion-((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})(?:-[a-z])?)\//;
const first = FOLDER_RE.exec(listZipNames(zip)[0] ?? '');
if (!first) die('the zip has no legion-<version>/ folder');
const version = first[1];
const top = `legion-${version}`;
// Guard the duplication above: FOLDER_RE (what the zip's top folder may be called) and the shared rule (what the app will
// accept) must agree on exactly the same versions. If they ever drift, packaging fails HERE with a clear message instead of
// shipping a package the updater would silently refuse.
for (const v of ['0.2.2-a', '0.2.1', '1.0.0-a', '0.2.2-A', '0.2.2-ab', '01.2.3', '0.2.2a', '0.2.2-beta.1']) {
  const viaFolder = FOLDER_RE.test(`legion-${v}/package.json`);
  const viaSharedRule = isReleaseVersion(v);
  if (viaFolder !== viaSharedRule) die(`version rule drift: FOLDER_RE says ${viaFolder} and the shared rule says ${viaSharedRule} for "${v}". Fix the regexes before packaging.`);
}
if (!isReleaseVersion(version)) die(`the package folder says "${version}", which this project's version rule does not accept`);
if (basename(a.zip) !== `legion-${version}-app.zip`) die(`the file must be named legion-${version}-app.zip`);
const pkg = JSON.parse((readZipEntry(zip, `${top}/package.json`) ?? die('package.json missing in the zip')).toString('utf8'));
if (pkg.version !== version) die('package.json version does not match the folder name');
const lock = readZipEntry(zip, `${top}/package-lock.json`) ?? die('package-lock.json missing in the zip');
const info = JSON.parse((readZipEntry(zip, `${top}/build-info.json`) ?? die('build-info.json missing in the zip')).toString('utf8'));
if (info.version !== version) die('build-info.json version does not match');
let notes = a.notes ? readFileSync(resolve(a.notes), 'utf8').replace(/\r\n/g, '\n').trim() : '';
if (notes.length > 2000) die(`the notes are ${notes.length} characters; the limit is 2000`);
if (a.previous) {
  const prev = JSON.parse(readFileSync(resolve(a.previous), 'utf8'));
  const cmp = (x, y) => { const p = x.split('.').map(Number), q = y.split('.').map(Number); for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] - q[i]; return 0; };
  if (cmp(version, prev.version) <= 0) die(`version ${version} is not greater than the previous release ${prev.version}`);
  if (Date.parse(info.publishedAt) < Date.parse(prev.publishedAt)) die('this package is dated before the previous release');
}
// The full package (legion-<version>-win-x64.zip) is what lets a release that changed dependencies self-apply in the
// app, through the same journaled swap as a code-only update (src/core/updater/package.ts stageFullPackage). Its name,
// size and sha256 are signed in the manifest's `fullAsset`, so the app authenticates it exactly like the app zip.
// Without it a `--requires-full-install` release stays notify-only, which is the deliberate fallback.
let fullAsset;
if (a['full-zip']) {
  const fz = readFileSync(resolve(a['full-zip']));
  const wantName = `legion-${version}-win-x64.zip`;
  if (basename(a['full-zip']) !== wantName) die(`the full package must be named ${wantName}`);
  fullAsset = { name: wantName, size: fz.length, sha256: sha(fz) };
}
if (a['requires-full-install'] && !fullAsset) console.error('warning: --requires-full-install without --full-zip: installs get a notice only, this release cannot self-apply');
if (fullAsset && !a['requires-full-install']) console.error('warning: --full-zip without --requires-full-install: the manifest will not declare the dependency change, so installs treat it as a code-only update');
const manifest = {
  schema: 1, product: 'legion', channel: 'stable', version, publishedAt: info.publishedAt,
  asset: { name: `legion-${version}-app.zip`, size: zip.length, sha256: sha(zip) },
  ...(fullAsset ? { fullAsset } : {}),
  depsSha256: sha(lock), requiresFullInstall: !!a['requires-full-install'], notes,
};
const out = resolve(a.out); mkdirSync(out, { recursive: true });
const mBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(out, 'legion-update-manifest.json'), mBytes);
// SHA256SUMS.txt also carries the full installer's line, which build-package.mjs wrote earlier and which the one-line
// installer and `setup -PackagePath` rely on. Keep the other lines of this version; only the two files written here are
// replaced. The installer's hash is added when its zip sits in this folder and no line names it yet.
const sumsPath = join(out, 'SHA256SUMS.txt');
const mine = new Set([`legion-${version}-app.zip`, 'legion-update-manifest.json']);
const kept = (existsSync(sumsPath) ? readFileSync(sumsPath, 'utf8') : '').split(/\r?\n/)
  .filter((l) => /^[0-9a-f]{64} {2}\S/.test(l) && !mine.has(l.slice(66)) && l.slice(66).startsWith(`legion-${version}-`));
const full = `legion-${version}-win-x64.zip`;
if (!kept.some((l) => l.slice(66) === full) && existsSync(join(out, full))) kept.push(`${sha(readFileSync(join(out, full)))}  ${full}`);
writeFileSync(sumsPath, [`${sha(zip)}  legion-${version}-app.zip`, ...kept, `${sha(mBytes)}  legion-update-manifest.json`].join('\n') + '\n');
console.log(`wrote ${join(out, 'legion-update-manifest.json')} and SHA256SUMS.txt for ${version}. Next: sign the manifest with scripts/release-sign.mjs and SHA256SUMS.txt with scripts/release-sign-sums.mjs.`);
