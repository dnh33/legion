#!/usr/bin/env node
// The Electron migration helper (.claude/skills/upgrading-electron/SKILL.md).
//
//   node scripts/electron-upgrade.mjs --draft <to>   prints a draft docs/electron-upgrades.json entry from the pinned version to <to>:
//                                                    every stable version crossed with its official release notes URL, and the
//                                                    notes themselves to read. "affects", apisChecked and checks are left for you.
//   node scripts/electron-upgrade.mjs --check        the record rules (as test/electron-pin.test.ts) plus two network checks: the
//                                                    versions listed are exactly the stable versions npm published in the range, and
//                                                    every cited release page exists. CI runs this on every pull request.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { checkRecord, cmpVersion, COMMIT_EVIDENCE, GUIDE_URL, NOTES_URL } from './lib/electron-upgrade-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const json = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const STABLE = /^\d+\.\d+\.\d+$/;

async function stableVersions() {
  const r = await fetch('https://registry.npmjs.org/electron', { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`npm registry answered ${r.status}`);
  return Object.keys((await r.json()).versions).filter((v) => STABLE.test(v)).sort(cmpVersion);
}
const inRange = (all, from, to) => all.filter((v) => cmpVersion(v, from) > 0 && cmpVersion(v, to) <= 0);
// GitHub's API, with the CI token when there is one (60 requests an hour without).
const gh = async (path) => {
  const headers = { accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
  const r = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status} for ${path}`);
  return r.json();
};
const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
/** The record's evidence for one version, checked at the source: the line is in the release notes, or the commit is in that release. */
async function evidenceProblem(v, prev) {
  const m = COMMIT_EVIDENCE.exec(v.evidence ?? '');
  if (m) {
    const cmp = await gh(`repos/electron/electron/compare/v${prev}...v${v.version}`);
    return cmp.commits.some((c) => c.sha.startsWith(m[1])) ? null : `${v.version}: commit ${m[1]} is not in v${prev}...v${v.version}`;
  }
  const body = (await gh(`repos/electron/electron/releases/tags/v${v.version}`)).body ?? '';
  return squash(body).includes(squash(v.evidence)) ? null : `${v.version}: the evidence is not a line of its release notes (${NOTES_URL(v.version)})`;
}
/** The record on main, if main has one: a pull request may add an upgrade, never rewrite history or lower the floor. */
async function mainRecord() {
  const r = await fetch('https://raw.githubusercontent.com/dnh33/legion/main/docs/electron-upgrades.json', { signal: AbortSignal.timeout(30_000) }).catch(() => null);
  return r?.ok ? r.json() : null;
}

async function check() {
  const pin = json('package.json').devDependencies.electron;
  const record = json('docs/electron-upgrades.json');
  const problems = checkRecord(record, pin, (p) => existsSync(join(ROOT, p)));
  const u = record.upgrades.at(-1);
  if (u && u.to === pin) {
    const want = inRange(await stableVersions(), u.from, u.to);
    const got = u.versions.map((v) => v.version);
    for (const v of want) if (!got.includes(v)) problems.push(`npm published ${v} between ${u.from} and ${u.to}, and the record skips it: read its notes (${NOTES_URL(v)}) and add it`);
    for (const v of got) if (!want.includes(v)) problems.push(`the record lists ${v}, which npm never published as a stable version in that range`);
    let prev = u.from;
    for (const v of u.versions) {
      const r = await fetch(v.notes, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(30_000) }).catch((e) => ({ ok: false, status: e.message }));
      if (!r.ok) problems.push(`${v.notes} did not open (${r.status})`);
      const p = await evidenceProblem(v, prev).catch((e) => `${v.version}: could not check the evidence (${e.message})`);
      if (p) problems.push(p);
      prev = v.version;
    }
  }
  const main = await mainRecord();
  if (main) {
    if (cmpVersion(record.floor.version, main.floor.version) < 0) problems.push(`the floor went down from ${main.floor.version} (main) to ${record.floor.version}: a floor is never lowered`);
    const kept = JSON.stringify(record.upgrades.slice(0, main.upgrades.length)) === JSON.stringify(main.upgrades);
    if (!kept) problems.push('the upgrades already on main were changed: add a new entry instead');
  }
  if (problems.length) { console.error(`Electron upgrade record: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`); process.exit(1); }
  console.log(`Electron upgrade record: OK (electron ${pin}, ${u.versions.length} versions from ${u.from}, each with its official notes)`);
}

async function draft(to) {
  const from = json('package.json').devDependencies.electron.replace(/^[\^~]/, '');
  if (!STABLE.test(to ?? '')) throw new Error('--draft needs a stable target version, e.g. --draft 44.9.3');
  const versions = inRange(await stableVersions(), from, to);
  if (!versions.includes(to)) throw new Error(`npm has no stable electron ${to}`);
  const majorsCrossed = [];
  for (let m = Number(from.split('.')[0]) + 1; m <= Number(to.split('.')[0]); m++) majorsCrossed.push({ major: m, guide: `${GUIDE_URL}#breaking-api-changes-${m}0`, checked: '' });
  const entry = { from, to, date: new Date().toISOString().slice(0, 10), why: '', versions: versions.map((v) => ({ version: v, notes: NOTES_URL(v), evidence: '', affects: '' })), majorsCrossed, apisChecked: [], checks: [] };
  console.log(JSON.stringify(entry, null, 2));
  console.error(`\nRead every one of these before you fill "affects" (an empty release page still needs its commits read):`);
  for (const v of versions) {
    const r = await fetch(`https://api.github.com/repos/electron/electron/releases/tags/v${v}`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) });
    const body = r.ok ? ((await r.json()).body ?? '').trim() : `(could not load: ${r.status})`;
    console.error(`\n===== ${v}  ${NOTES_URL(v)}\n${body || `(empty notes: read https://github.com/electron/electron/compare/v${versions[versions.indexOf(v) - 1] ?? from}...v${v})`}`);
  }
  if (majorsCrossed.length) console.error(`\nMajors crossed: ${majorsCrossed.map((m) => m.major).join(', ')}. Read ${GUIDE_URL} for each.`);
}

const [flag, arg] = process.argv.slice(2);
if (flag === '--check') await check();
else if (flag === '--draft') await draft(arg);
else { console.error('usage: node scripts/electron-upgrade.mjs --check | --draft <version>'); process.exit(2); }
