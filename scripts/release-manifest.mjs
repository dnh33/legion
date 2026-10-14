#!/usr/bin/env node
// Builds the manifests and SHA256SUMS.txt from a package made by release-package.mjs. It does NOT sign: the owner signs by hand
// with release-sign.mjs. usage: node scripts/release-manifest.mjs --zip <file> --out <folder> [--notes <text file>] [--previous <old manifest>] [--full-zip <file>] [--requires-full-install] [--notify-only] [--stepping-stone <folder>] [--stones <v,v>]
//
// TWO manifest names (docs/SHIPPING.md, Stepping stones). legion-update-manifest-2.json is this release's own manifest and is what 0.3.0 and later read
// first. legion-update-manifest.json is what 0.2.7 reads. Only the stepping-stone release itself (a version listed in scripts/stepping-stones.json)
// publishes its own manifest under both names. EVERY later release, code-only or full, needs --stepping-stone: the stone's own signed manifest and
// .sig, copied byte for byte (never re-signed) under the old name. A full-install release also names the stone in its own manifest and sets minUpdater 2.
// --stones overrides the list (tests and rehearsals only).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { args, die, isReleaseVersion, listZipNames, loadDist, readZipEntry } from './lib/release-lib.mjs';
import { NEW_NAME, OLD_NAME, readStones } from './lib/stepping-stone.mjs';

const a = args(process.argv.slice(2), { zip: 'v', out: 'v', notes: 'v', previous: 'v', 'full-zip': 'v', 'requires-full-install': 'flag', 'notify-only': 'flag', 'stepping-stone': 'v', stones: 'v' });
const stones = a.stones ? a.stones.split(',') : readStones();
if (!a.zip || !a.out) die('usage: node scripts/release-manifest.mjs --zip <file> --out <folder> [--notes <file>] [--previous <manifest>] [--full-zip <file>] [--requires-full-install] [--notify-only]');
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
// A dependency change without the signed full package is a release that only notifies. That used to be what a forgotten --full-zip
// produced silently (exit 0), so it now needs --notify-only to be asked for by name.
if (a['requires-full-install'] && !fullAsset) {
  if (!a['notify-only']) die('--requires-full-install needs --full-zip <legion-<version>-win-x64.zip>, or the release cannot self-apply. Pass --notify-only if a notice-only release is what you want.');
  console.error('warning: --notify-only: installs get a notice only, this release cannot self-apply');
}
if (a['notify-only'] && fullAsset) die('--notify-only and --full-zip contradict each other');
if (fullAsset && !a['requires-full-install']) console.error('warning: --full-zip without --requires-full-install: the manifest will not declare the dependency change, so installs treat it as a code-only update');
const cmp = (x, y) => { const p = x.split('.').map(Number), q = y.split('.').map(Number); for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] - q[i]; return 0; };
const manifest = {
  schema: 1, product: 'legion', channel: 'stable', version, publishedAt: info.publishedAt,
  asset: { name: `legion-${version}-app.zip`, size: zip.length, sha256: sha(zip) },
  ...(fullAsset ? { fullAsset } : {}),
  depsSha256: sha(lock), requiresFullInstall: !!a['requires-full-install'], notes,
};
const out = resolve(a.out); mkdirSync(out, { recursive: true });
// The stepping stone: a full-install release names a code-only release that an older updater applies first. Its manifest and .sig are
// taken as published (the folder of its release), checked with the app's own parser, and never changed.
let stoneManifest, stoneSig;
const ownIsStone = stones.includes(version);
if (ownIsStone) {
  if (a['stepping-stone']) die(`${version} is itself a stepping stone (scripts/stepping-stones.json): it publishes its own manifest under both names, so --stepping-stone does not apply`);
} else {
  if (!a['stepping-stone']) die(`${version} is not a stepping stone, so the old name must carry the stone's own signed manifest, not this release: pass --stepping-stone <folder with the stone's legion-update-manifest.json and .sig> (gh release download v${stones[stones.length - 1]} -p 'legion-update-manifest.json*' -D <folder>). Without it a 0.2.7 install would stage this release and be stranded.`);
  const dir = resolve(a['stepping-stone']);
  const { parseManifest } = await loadDist('src/core/updater/manifest.js');
  stoneManifest = readFileSync(join(dir, OLD_NAME)); stoneSig = readFileSync(join(dir, `${OLD_NAME}.sig`));
  const st = parseManifest(stoneManifest);
  if (st.requiresFullInstall || st.fullAsset) die(`${st.version} is itself a full-install release, so it cannot be a stepping stone`);
  if (cmp(st.version, version) >= 0) die(`the stepping stone ${st.version} is not older than ${version}`);
  if (!stones.includes(st.version)) die(`${st.version} is not listed in scripts/stepping-stones.json`);
  if (fullAsset) {
    manifest.minUpdater = 2;
    manifest.steppingStone = { version: st.version, publishedAt: st.publishedAt, depsSha256: st.depsSha256, asset: st.asset };
  }
}
const mBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(out, NEW_NAME), mBytes);
const oldBytes = stoneManifest ?? mBytes;
writeFileSync(join(out, OLD_NAME), oldBytes);
if (stoneSig) writeFileSync(join(out, `${OLD_NAME}.sig`), stoneSig);
else rmSync(join(out, `${OLD_NAME}.sig`), { force: true }); // a signature left from an earlier run belongs to other bytes
rmSync(join(out, `${NEW_NAME}.sig`), { force: true });
// SHA256SUMS.txt also carries the full installer's line, which build-package.mjs wrote earlier and which the one-line
// installer and `setup -PackagePath` rely on. Keep the other lines of this version; only the two files written here are
// replaced. The installer's hash is added when its zip sits in this folder and no line names it yet.
const sumsPath = join(out, 'SHA256SUMS.txt');
const mine = new Set([`legion-${version}-app.zip`, OLD_NAME, NEW_NAME]);
const kept = (existsSync(sumsPath) ? readFileSync(sumsPath, 'utf8') : '').split(/\r?\n/)
  .filter((l) => /^[0-9a-f]{64} {2}\S/.test(l) && !mine.has(l.slice(66)) && l.slice(66).startsWith(`legion-${version}-`));
const full = `legion-${version}-win-x64.zip`;
if (!kept.some((l) => l.slice(66) === full) && existsSync(join(out, full))) kept.push(`${sha(readFileSync(join(out, full)))}  ${full}`);
writeFileSync(sumsPath, [`${sha(zip)}  legion-${version}-app.zip`, ...kept, `${sha(oldBytes)}  ${OLD_NAME}`, ...(Buffer.compare(oldBytes, mBytes) === 0 ? [] : [`${sha(mBytes)}  ${NEW_NAME}`])].join('\n') + '\n');
console.log(`wrote ${join(out, NEW_NAME)}, ${join(out, OLD_NAME)}${stoneManifest ? ' (the stepping stone, unchanged)' : ''} and SHA256SUMS.txt for ${version}. Next: sign ${NEW_NAME} with scripts/release-sign.mjs and SHA256SUMS.txt with scripts/release-sign-sums.mjs.`);
