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
import { existsSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { args, die, isReleaseVersion, listZipNames, readZipEntry, REPO } from './lib/release-lib.mjs';

const a = args(process.argv.slice(2), { version: 'v', pkg: 'v' });

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
const manifestPath = join(pkgFolder, 'legion-update-manifest.json');
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
  if (m.requiresFullInstall === true) warn('manifest says requiresFullInstall: this release cannot self-apply (correct only if dependencies changed)');
  else pass('manifest allows self-apply (requiresFullInstall: false)');
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

// --------------------------------------------- 5. install-mode + no unattended apply
try {
  const { installMode } = await import(new URL(`../dist/src/core/updater/apply.js?p=${Date.now()}`, import.meta.url).href);
  const mode = installMode({ root: REPO, platform: process.platform });
  if (mode === 'checkout') warn('this working tree is a git checkout: installMode() there is notify-only (that is correct for a checkout, not for a user install)');
  else pass(`installMode for a real install: ${mode}`);
} catch { warn('could not determine installMode (non-fatal)'); }

// ---------------------------------------------------------------- verdict
console.log(`\n${ok.length} ok, ${warns.length} warning(s), ${fails.length} failure(s)`);
if (warns.length) { console.log('\nWarnings:'); for (const w of warns) console.log(`  - ${w}`); }
if (fails.length) { console.error('\nDO NOT PUBLISH. Fix these first:'); for (const f of fails) console.error(`  - ${f}`); process.exit(1); }
console.log('\nPre-flight passed. Safe to publish.');
void tmpdir; void mkdtempSync; void mkdirSync; void writeFileSync; void rmSync; void die;