#!/usr/bin/env node
/**
 * RELEASE READINESS GATE — run before publishing anything.
 *
 * Why this exists: twice in one session (2026-10-03/04) a release was published that could not
 * actually be installed by the people it was meant for.
 *   1. `depsSha256` hashed the RAW package-lock.json. npm rewrites the lock's own `version` on
 *      every release bump, so every patch was flagged as "changes dependencies" and the updater
 *      refused to stage it. Self-update could never work, on any version.
 *   2. `0.2.2-a` shipped a lettered patch. A build predating lettered-patch support rejects it at
 *      the manifest version check — BEFORE any download or approval — so it was invisible to every
 *      existing install. The server cannot fix this; the old binary decides.
 *
 * Both were invisible to `npm test`, because the suite tests each piece in isolation and nothing
 * tested "can the version that currently exists on a user's disk actually install this release".
 * That question is what this gate asks, end to end, against the real artifacts.
 *
 * Usage: node scripts/release-preflight.mjs [--version <v>]
 * Exits non-zero and prints what is wrong. Run it after building + signing, before `gh release create`.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { args, die, isReleaseVersion, listZipNames, readZipEntry, REPO, requireRehearsalFor } from './lib/release-lib.mjs';
import { fullAssetProblems } from './lib/full-asset-check.mjs';
import { fetchBytes, hashUrl, NEW_NAME, OLD_NAME, readStones, stoneProblems } from './lib/stepping-stone.mjs';
import { carryForFolder } from './lib/stone-carry.mjs';
import { prevTagShowArgs, unixApplyVerdict, unixDepsHashOfLock } from './lib/unix-apply-check.mjs';
import { frozenParserProblems, sourcesFromGit } from './lib/frozen-parser.mjs';

const a = args(process.argv.slice(2), { version: 'v', pkg: 'v', 'no-network': 'flag', stones: 'v', 'stone-lock': 'v', 'prev-lock': 'v', 'prev-tag': 'v' });
requireRehearsalFor(a, ['no-network', 'stones']);

// --pkg is REQUIRED, with no default. It used to fall back to a hardcoded owner-local folder, which was wrong twice over:
// it put a private path in a script that ships in the public repo, and it made a missing flag read as "release artifacts
// missing — run build-package.mjs first" about a folder nobody named. That is precisely the misleading failure the
// comment above the artifact checks says this gate must avoid: the owner who builds somewhere else, and every person
// running it from the public repo, was told to re-run a build they had already run.
if (!a.pkg) {
  die('usage: release-preflight.mjs [--version <v>] --pkg <folder>\n'
    + '  --pkg  the folder build-package.mjs wrote to (its --out), holding legion-<version>-app.zip,\n'
    + '         legion-<version>-win-x64.zip, legion-update-manifest.json and the .sig\n'
    + '  There is deliberately no default: a guessed folder reports missing artifacts for a build you may have run.');
}

const fails = [];
const warns = [];
const ok = [];
const fail = (m) => { fails.push(m); console.error(`  FAIL  ${m}`); };
const warn = (m) => { warns.push(m); console.warn(`  WARN  ${m}`); };
const pass = (m) => { ok.push(m); console.log(`  ok    ${m}`); };

console.log('RELEASE PREFLIGHT — can a real install actually receive this release?\n');

// ---------------------------------------------------------------- 1. version shape
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const version = a.version ?? pkg.version;
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
const configTs = readFileSync(join(REPO, 'src', 'shared', 'config.ts'), 'utf8');

if (!isReleaseVersion(version)) fail(`version "${version}" is not MAJOR.MINOR.PATCH[-letter]`);
else pass(`version shape accepted: ${version}`);
if (pkg.version !== version) fail(`package.json says ${pkg.version}, gate was asked about ${version}`);
if (lock.version !== version) fail(`package-lock.json says ${lock.version}, expected ${version} — the three must move together`);
if (!new RegExp(`export const VERSION = '${version.replace(/\./g, '\\.')}'`).test(configTs)) fail(`src/shared/config.ts VERSION is not ${version}`);
if (pkg.version === lock.version && configTs.includes(`VERSION = '${pkg.version}'`)) pass('package.json, package-lock.json and config.ts VERSION all agree');

// --pkg may be either the package folder itself (…/legion-0.2.2-pkg) or its PARENT (…/legion-v022-pkg): the two are easy to
// mix up, and a wrong guess must not read as "release artifacts missing".
const given = resolve(a.pkg);
const pkgFolder = existsSync(join(given, `legion-${version}-app.zip`)) ? given : join(given, `legion-${version}-pkg`);

// ------------------------------------------- 2. the shipped app can parse THIS version
// The real question behind bug 2: does the binary people already run accept this version string?
try {
  const { isPlainSemver, compareSemver } = await import(
    new URL(`../dist/src/core/updater/semver.js?p=${Date.now()}`, import.meta.url).href
  );
  if (!isPlainSemver(version)) fail(`the built updater's own isPlainSemver REJECTS "${version}"`);
  else pass('the built updater accepts this version');
  // A lettered patch must outrank the previous release, or nobody is offered it.
  // Decrementing the patch component must keep the dot: '0.2.3'.replace(/\.(\d+)$/, '2') yields '0.22', which is not
  // semver, so compareSemver threw and every lettered release failed this gate with a misleading "could not load the
  // built semver module". Found 2026-10-04 while cutting 0.2.3-a.
  const prev = version.includes('-')
    ? version.split('-')[0].replace(/\.(\d+)$/, (_, p) => (Number(p) > 0 ? `.${Number(p) - 1}` : '.0'))
    : null;
  if (prev && compareSemver(version, prev) <= 0) fail(`${version} does not outrank ${prev}: existing installs would NOT be offered it`);
  else if (prev) pass(`${version} outranks ${prev} (so installs on ${prev} are offered it)`);
  if (/\d-[a-z]/.test(version)) {
    const plain = version.split('-')[0];
    if (compareSemver(version, plain) >= 0) fail(`${version} does not rank below its own plain release ${plain}`);
    else pass(`${version} ranks below its own plain release ${plain} (so ${plain} can supersede it)`);
    warn(`lettered patch: only installs that ALREADY support lettered versions can install ${version}. If those do not exist yet, publish plain ${plain} instead.`);
  }
} catch (e) {
  fail(`could not load the built semver module (run npm run build first): ${e.message}`);
}

// ------------------------------------- 3. a version-only lock bump must NOT demand a reinstall
// The real question behind bug 1.
try {
  const { dependencyHash } = await import(new URL(`../dist/src/core/updater/package.js?p=${Date.now()}`, import.meta.url).href);
  const installed = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
  const bumped = JSON.stringify({
    ...installed,
    version: '9.9.9',
    packages: { ...installed.packages, '': { ...(installed.packages[''] ?? {}), version: '9.9.9' } },
  });
  if (dependencyHash(JSON.stringify(installed)) !== dependencyHash(bumped)) fail('a lock that differs only in its own version changes the dependency hash → every patch would demand a full install');
  else pass('a version-only lock bump does not read as a dependency change');
} catch (e) {
  fail(`could not load dependencyHash (run npm run build first): ${e.message}`);
}

// --------------------------------------------- 4. the built artifacts + the manifest
const appZip = join(pkgFolder, `legion-${version}-app.zip`);
const fullZip = join(pkgFolder, `legion-${version}-win-x64.zip`);
// This release's OWN manifest is the second-name file (docs/SHIPPING.md, Stepping stones); the old name is checked separately below.
const manifestPath = join(pkgFolder, NEW_NAME);
const sigPath = `${manifestPath}.sig`;

if (!existsSync(fullZip)) fail(`missing ${fullZip} — run build-package.mjs first`);
else pass(`full installer present (${(readFileSync(fullZip).length / 1e6).toFixed(0)} MB)`);

if (!existsSync(appZip)) {
  fail(`missing ${appZip} — run build-package.mjs first`);
} else {
  pass(`update package present (${(readFileSync(appZip).length / 1e6).toFixed(1)} MB)`);
  const names = listZipNames(readFileSync(appZip));
  const top = `legion-${version}/`;
  if (!names.length || !names[0].startsWith(top)) fail(`the app.zip top folder is not ${top} (first entry: ${names[0]})`);
  else pass(`app.zip folder matches the version (${top})`);
  const pkgInZip = readZipEntry(readFileSync(appZip), `${top}package.json`);
  if (!pkgInZip) fail('app.zip has no package.json');
  else if (JSON.parse(pkgInZip.toString('utf8')).version !== version) fail('app.zip package.json version does not match');
  for (const must of ['dist/src/electron/main.js', 'dist/src/bin/legion-core.js', 'dist-ui/index.html']) {
    if (!readZipEntry(readFileSync(appZip), `${top}${must}`)) fail(`app.zip is missing ${must}`);
  }
}

if (!existsSync(manifestPath)) fail(`missing ${manifestPath}`);
else {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (m.version !== version) fail(`manifest version is ${m.version}, expected ${version}`);
  else pass('manifest version matches');
  // A dependency change must ship the signed full package, or the release only notifies. This used to be a warning that a
  // forgotten --full-zip slipped through; it is a failure now, and the package in the folder is checked byte for byte.
  const sumsText = existsSync(join(pkgFolder, 'SHA256SUMS.txt')) ? readFileSync(join(pkgFolder, 'SHA256SUMS.txt'), 'utf8') : '';
  // Option A (docs/SHIPPING.md, Stepping stones): a code-only release whose lock differs from the stone's lock must carry the full package.
  const stonesForCarry = a.stones ? a.stones.split(',') : readStones();
  let carry = { carryRequired: true, problems: [] };
  if (m.requiresFullInstall === true) carry = { carryRequired: false, problems: [] }; // a full-install release carries its package because it says so
  else try {
    const { dependencyHash } = await import(new URL(`../dist/src/core/updater/package.js?p=${Date.now()}`, import.meta.url).href);
    const { parseManifest } = await import(new URL(`../dist/src/core/updater/manifest.js?p=${Date.now()}`, import.meta.url).href);
    const oldP = join(pkgFolder, OLD_NAME);
    carry = carryForFolder({ version, stones: stonesForCarry, appZip: existsSync(appZip) ? readFileSync(appZip) : Buffer.alloc(0), oldManifestBytes: existsSync(oldP) ? readFileSync(oldP) : Buffer.alloc(0), parseManifest, dependencyHash, stoneLockPath: a['stone-lock'] });
  } catch (e) { carry.problems.push(`could not compare the lock with the stepping stone's: ${e.message}`); }
  for (const p of carry.problems) fail(`stepping stone lock: ${p}`);
  const fullProblems = await fullAssetProblems({ manifest: m, version, dir: pkgFolder, sums: sumsText, carryRequired: carry.carryRequired, stoneVersion: stonesForCarry[stonesForCarry.length - 1] });
  for (const p of fullProblems) fail(`fullAsset: ${p}`);
  if (!fullProblems.length) pass(m.requiresFullInstall === true ? 'full package: fullAsset equals the full zip (name, size, sha256) and is listed in SHA256SUMS.txt' : carry.carryRequired ? 'code-only release carries its full package (lock differs from the stepping stone): fullAsset equals the full zip (name, size, sha256) and is listed in SHA256SUMS.txt' : 'manifest is code-only (requiresFullInstall: false, no fullAsset; its lock equals the stepping stone lock)');
  // The frozen stepping-stone updater (its own manifest.ts, as tagged) can never change: it must accept this manifest, or the install holding it is stranded.
  {
    const stoneTag = `v${stonesForCarry[stonesForCarry.length - 1]}`;
    const fp = await frozenParserProblems({ manifestBytes: readFileSync(manifestPath), sources: sourcesFromGit({ tag: stoneTag }), label: stoneTag });
    for (const p of fp) fail(`frozen parser: ${p}`);
    if (!fp.length) pass(`the manifest parses with the frozen ${stoneTag} parser and the current one`);
  }
  // Mac and Linux installs made by install.sh apply only code-only releases whose dependency hash equals the previous release's.
  {
    // The previous release's lock: a file (--prev-lock) or the tag's lock (--prev-tag, git show). Compared as dependency hashes, as the updater does.
    let prevLock = null;
    if (a['prev-lock']) {
      try { prevLock = readFileSync(a['prev-lock'], 'utf8'); } catch (e) { fail(`could not read --prev-lock: ${e.message}`); }
    } else if (a['prev-tag']) {
      const showArgs = prevTagShowArgs(REPO, a['prev-tag']);
      if (!showArgs) fail('--prev-tag must be a release tag such as v0.3.4 (it has to start with "v" and a digit)');
      else {
        const g = spawnSync('git', showArgs, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        if (g.status === 0) prevLock = g.stdout; else fail(`could not read package-lock.json at ${a['prev-tag']} (git show): ${String(g.stderr).trim()}`);
      }
    }
    const thisLock = existsSync(appZip) ? readZipEntry(readFileSync(appZip), `legion-${version}/package-lock.json`) : null;
    let depsHash = null; let prevDepsHash = null;
    try {
      if (thisLock) depsHash = await unixDepsHashOfLock(thisLock.toString('utf8'));
      if (prevLock !== null) prevDepsHash = await unixDepsHashOfLock(prevLock);
    } catch (e) { fail(`could not compute the dependency hash (run npm run build first): ${e.message}`); }
    const v = unixApplyVerdict({ version, requiresFullInstall: m.requiresFullInstall, depsHash, prevDepsHash });
    if (v.level === 'fail') fail(v.message); else if (v.level === 'warn') warn(v.message); else pass(v.message);
  }
  if (!m.notes || !String(m.notes).trim()) fail('manifest has no release notes — people read these before updating');
  else if (String(m.notes).length > 2000) fail('manifest notes exceed the 2000-char cap');
  else pass(`manifest carries release notes (${String(m.notes).length} chars)`);
  if (existsSync(appZip) && m.asset) {
    const real = createHash('sha256').update(readFileSync(appZip)).digest('hex');
    if (m.asset.sha256 !== real) fail('manifest asset sha256 does not match the built app.zip — the updater would refuse it');
    else pass('manifest sha256 matches the built app.zip');
    if (m.asset.name !== `legion-${version}-app.zip`) fail(`manifest asset name is ${m.asset.name}`);
  }
}

if (!existsSync(sigPath)) fail(`missing signature ${sigPath} — run release-sign.mjs`);
else {
  const sig = JSON.parse(readFileSync(sigPath, 'utf8'));
  if (sig.keyId !== 'k1') warn(`signature keyId is ${sig.keyId}`);
  // Verify with the app's OWN verifier and its OWN baked-in keys — the same code path a user's build runs. `UPDATE_KEYS` is a
  // required argument; passing undefined here tested nothing.
  try {
    const { verifyManifestSignature, UPDATE_KEYS } = await import(new URL(`../dist/src/core/updater/trust.js?p=${Date.now()}`, import.meta.url).href);
    const v = verifyManifestSignature(readFileSync(manifestPath), readFileSync(sigPath, 'utf8'), UPDATE_KEYS);
    if (!UPDATE_KEYS.length) fail('this build has no baked-in update key, so no install could ever verify a release');
    if (!v.ok) fail(`the app's own verifier REJECTED the signature: ${v.reason}`);
    else pass(`signature verifies with the app's own verifier (key ${v.keyId})`);
  } catch (e) {
    fail(`could not verify the signature with the app's verifier: ${e.message}`);
  }
}

// ----------------------------------- 4b. the old name: a signed stepping stone, still served as signed
// 0.2.7 reads only the old name and builds its package address from that manifest's version. For every release after the stone it must therefore be the
// stone's own signed manifest (never this release; only the stone release itself, 0.3.0, has its own there), full-install or code-only, and the
// stone's package must really come back with the signed size and sha256.
try {
  const trust = await import(new URL(`../dist/src/core/updater/trust.js?p=${Date.now()}`, import.meta.url).href);
  const { parseManifest } = await import(new URL(`../dist/src/core/updater/manifest.js?p=${Date.now()}`, import.meta.url).href);
  const oldPath = join(pkgFolder, OLD_NAME);
  if (!existsSync(oldPath) || !existsSync(`${oldPath}.sig`) || !existsSync(manifestPath)) fail(`a release publishes both ${OLD_NAME} (+ .sig) and ${NEW_NAME} (+ .sig); one is missing in ${pkgFolder}`);
  else {
    const stones = a.stones ? a.stones.split(',') : readStones(); // --stones: tests and rehearsals only
    const problems = await stoneProblems({ oldBytes: readFileSync(oldPath), oldSig: readFileSync(`${oldPath}.sig`, 'utf8'), newBytes: readFileSync(manifestPath), trust, parseManifest, stones, publishing: true, ...(!a['no-network'] ? { fetchAsset: hashUrl, getBytes: fetchBytes } : {}) });
    for (const p of problems) fail(`stepping stone: ${p}`);
    if (!problems.length) pass(stones.includes(parseManifest(readFileSync(manifestPath)).version) ? 'this is the stepping stone: both manifest names carry its own signed manifest' : 'old-name manifest is the signed stepping stone and its package returns the signed size and sha256');
  }
} catch (e) {
  fail(`could not check the stepping stone: ${e.message}`);
}

// --------------------------------------------- 5. install-mode + no unattended apply
try {
  const { installMode } = await import(new URL(`../dist/src/core/updater/index.js?p=${Date.now()}`, import.meta.url).href);
  const mode = installMode({ root: REPO, platform: process.platform });
  if (mode === 'checkout') warn('this working tree is a git checkout: installMode() there is notify-only (that is correct for a checkout, not for a user install)');
  else pass(`installMode for a real install: ${mode}`);
} catch (e) { fail(`could not run the installMode check (run npm run build first): ${e.message}`); }

// ---------------------------------------------------------------- verdict
console.log(`\n${ok.length} ok, ${warns.length} warning(s), ${fails.length} failure(s)`);
if (warns.length) { console.log('\nWarnings:'); for (const w of warns) console.log(`  - ${w}`); }
if (fails.length) { console.error('\nDO NOT PUBLISH. Fix these first:'); for (const f of fails) console.error(`  - ${f}`); process.exit(1); }
console.log('\nPre-flight passed. Safe to publish.');
void tmpdir; void mkdtempSync; void mkdirSync; void writeFileSync; void rmSync; void die;