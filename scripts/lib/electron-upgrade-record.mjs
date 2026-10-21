// The rules for docs/electron-upgrades.json, the record every Electron change must carry (test/electron-pin.test.ts runs them offline;
// scripts/electron-upgrade.mjs --check runs them plus the npm registry and the release pages). Plain JS on purpose: CI and agents
// run it without a build. How to write a record: .claude/skills/upgrading-electron/SKILL.md.

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
export const NOTES_URL = (v) => `https://github.com/electron/electron/releases/tag/v${v}`;
export const GUIDE_URL = 'https://github.com/electron/electron/blob/main/docs/breaking-changes.md';

/** Compares two stable x.y.z versions: negative, zero or positive. */
export function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
const major = (v) => Number(String(v).split('.')[0]);
const blank = (s) => typeof s !== 'string' || s.trim() === '';
const thin = (s, n = 20) => blank(s) || s.trim().length < n;
/** Evidence that the notes were read: a line copied from the release notes, or, for a release with empty notes, the commit that matters. */
export const COMMIT_EVIDENCE = /^commit ([0-9a-f]{10,40})$/;

/**
 * Every problem with the record for the pinned Electron version, as plain sentences; an empty list means the record is complete.
 * `exists(repoPath)` says whether a repo file exists (the API checks name the Legion file they read).
 */
export function checkRecord(record, pin, exists) {
  const out = [];
  const ups = Array.isArray(record?.upgrades) ? record.upgrades : [];
  if (!record?.floor || !STABLE.test(record.floor.version ?? '') || blank(record.floor.reason) || blank(record.floor.source)) out.push('floor needs a stable version, a reason and a source');
  for (let i = 1; i < ups.length; i++) if (ups[i].from !== ups[i - 1].to) out.push(`upgrade ${i}: from ${ups[i].from} does not continue from ${ups[i - 1].to}`);
  const u = ups.at(-1);
  if (!u || u.to !== pin) { out.push(`no upgrade record ends at ${pin}: read the release notes of every version crossed and add one (see .claude/skills/upgrading-electron)`); return out; }
  const at = `upgrade ${u.from} -> ${u.to}`;
  if (!STABLE.test(u.from ?? '') || !STABLE.test(u.to)) out.push(`${at}: from and to must be stable x.y.z versions`);
  if (cmpVersion(u.to, u.from) <= 0) out.push(`${at}: to must be newer than from`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(u.date ?? '')) out.push(`${at}: date must be YYYY-MM-DD`);
  if (blank(u.why)) out.push(`${at}: why is empty`);
  const vs = Array.isArray(u.versions) ? u.versions : [];
  if (vs.length === 0) out.push(`${at}: versions is empty`);
  let prev = u.from;
  for (const v of vs) {
    if (!STABLE.test(v.version ?? '')) { out.push(`${at}: ${v.version} is not a stable release (no alphas, betas or nightlies)`); continue; }
    if (cmpVersion(v.version, prev) <= 0) out.push(`${at}: ${v.version} is out of order or not after ${prev}`);
    if (cmpVersion(v.version, u.to) > 0) out.push(`${at}: ${v.version} is past ${u.to}`);
    if (v.notes !== NOTES_URL(v.version)) out.push(`${at}: ${v.version} must cite its official release notes, ${NOTES_URL(v.version)}`);
    if (thin(v.affects)) out.push(`${at}: ${v.version} needs "affects" (20+ characters): what it means for Legion, after reading the notes`);
    if (!COMMIT_EVIDENCE.test(v.evidence ?? '') && thin(v.evidence)) out.push(`${at}: ${v.version} needs "evidence": a line copied from its release notes, or "commit <sha>" when the notes are empty`);
    prev = v.version;
  }
  if (vs.length && vs.at(-1).version !== u.to) out.push(`${at}: the last version listed must be ${u.to} itself`);
  const crossed = new Map((Array.isArray(u.majorsCrossed) ? u.majorsCrossed : []).map((m) => [m.major, m]));
  for (let m = major(u.from) + 1; m <= major(u.to); m++) {
    const e = crossed.get(m);
    if (!e || !String(e.guide ?? '').startsWith(GUIDE_URL) || blank(e.checked)) out.push(`${at}: major ${m} is crossed: cite ${GUIDE_URL} (its ${m}.0 section) and say what was checked`);
  }
  const apis = Array.isArray(u.apisChecked) ? u.apisChecked : [];
  if (apis.length === 0) out.push(`${at}: apisChecked is empty: list the Electron APIs Legion uses that the notes touch, and the verdict`);
  for (const a of apis) {
    if (blank(a.api) || thin(a.verdict)) out.push(`${at}: an apisChecked entry needs api and a verdict (20+ characters)`);
    if (blank(a.where) || !exists(a.where)) out.push(`${at}: apisChecked "${a.api}" names ${a.where}, which is not a file in the repo`);
  }
  if (!Array.isArray(u.checks) || u.checks.length === 0 || u.checks.some(blank)) out.push(`${at}: checks must list what was run to prove Legion still works`);
  return out;
}
