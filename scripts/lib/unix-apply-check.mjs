// Mac and Linux installs made by install.sh update themselves from 0.3.5 on, but only through the code route: they have no
// Windows runtime to swap, so a release that changes the dependency tree (or says it needs a full install) is shown as news
// and the person is told to run the installer again. This is the preflight side of that rule. Pure; no I/O.

/** First release whose managed clones can apply an update. */
export const FIRST_UNIX_UPDATER = '0.3.5';

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]))?$/;
/** True when `version` is newer than 0.3.5 (a lettered patch of 0.3.5 counts as newer). false for 0.3.5 itself and for anything unparseable. */
export function unixCloneWouldApply(version) {
  const v = VERSION.exec(String(version)); const f = VERSION.exec(FIRST_UNIX_UPDATER);
  if (!v) return false;
  for (let i = 1; i <= 3; i++) { const d = Number(v[i]) - Number(f[i]); if (d !== 0) return d > 0; }
  return Boolean(v[4]);
}

/**
 * The git arguments that read package-lock.json at the previous release's tag, or null when the tag is not a release tag (it must
 * start with "v" and a digit). --end-of-options keeps a value that starts with a dash from being read as a git option.
 */
export function prevTagShowArgs(repo, tag) {
  if (typeof tag !== 'string' || !/^v\d/.test(tag)) return null;
  return ['-C', repo, 'show', '--end-of-options', `${tag}:package-lock.json`];
}

/**
 * The dependency hash the updater compares (dependencyHash in src/core/updater/package.ts: the lock with its own version fields blanked
 * out). NOT the manifest's depsHash, which is the raw file hash and changes on every release. Needs `npm run build` (reads dist).
 */
export async function unixDepsHashOfLock(lockText) {
  const { dependencyHash } = await import(new URL(`../../dist/src/core/updater/package.js?p=${Date.now()}`, import.meta.url).href);
  return dependencyHash(lockText);
}

/**
 * -> { level: 'pass' | 'warn' | 'fail' | 'skip', message }.
 * `depsHash` and `prevDepsHash` are dependency hashes (unixDepsHashOfLock) of this release's lock and the previous release's lock;
 * `prevDepsHash` is null when the previous lock was not given.
 */
export function unixApplyVerdict({ version, requiresFullInstall, depsHash, prevDepsHash }) {
  if (!unixCloneWouldApply(version)) return { level: 'skip', message: `Mac/Linux apply check: ${version} is not newer than ${FIRST_UNIX_UPDATER}, so no managed clone applies it` };
  const notice = 'Mac and Linux users will get the "run the installer again" notice instead of an automatic update';
  if (!prevDepsHash) {
    return requiresFullInstall === true
      ? { level: 'warn', message: `${version} is a full-install release: ${notice}. (Pass --prev-lock <the previous release's package-lock.json> or --prev-tag v<previous> to also compare the dependency hash.)` }
      : { level: 'warn', message: `Mac/Linux apply check: the previous release's dependency hash was not given, so "code-only with an equal dependency hash" is unchecked. Pass --prev-lock <the previous release's package-lock.json> or --prev-tag v<previous> (read with git show). If the dependencies changed, ${notice}.` };
  }
  if (!depsHash) return { level: 'fail', message: `Mac/Linux apply check: the app zip has no package-lock.json, so the dependency hash cannot be compared with the previous release's` };
  const same = String(depsHash).toLowerCase() === String(prevDepsHash).toLowerCase();
  if (requiresFullInstall !== true && !same) return { level: 'fail', message: `the manifest says requiresFullInstall is false, but this release's dependencies differ from the previous release's (dependency hash ${String(depsHash).slice(0, 12)} vs ${String(prevDepsHash).slice(0, 12)}, with each lock's own version ignored). Either the dependencies really changed, and then the release must say requiresFullInstall true, or the wrong previous lock was given. As written, Mac and Linux installs would apply code that needs different dependencies` };
  if (requiresFullInstall === true) return { level: 'warn', message: `${version} needs a full install${same ? ' (its dependency hash equals the previous release\'s, so check that this is intended)' : ''}: ${notice}` };
  return { level: 'pass', message: 'Mac/Linux: code-only with a dependency hash equal to the previous release\'s, so managed clones apply it automatically' };
}

