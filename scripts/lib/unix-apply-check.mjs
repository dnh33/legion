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
 * -> { level: 'pass' | 'warn' | 'fail' | 'skip', message }.
 * `prevDepsSha256` is the previous release's manifest depsSha256 (null when it was not given).
 */
export function unixApplyVerdict({ version, requiresFullInstall, depsSha256, prevDepsSha256 }) {
  if (!unixCloneWouldApply(version)) return { level: 'skip', message: `Mac/Linux apply check: ${version} is not newer than ${FIRST_UNIX_UPDATER}, so no managed clone applies it` };
  const notice = 'Mac and Linux users will get the "run the installer again" notice instead of an automatic update';
  if (!prevDepsSha256) {
    return requiresFullInstall === true
      ? { level: 'warn', message: `${version} is a full-install release: ${notice}. (Pass --prev-manifest <previous release manifest> to also compare the dependency hash.)` }
      : { level: 'warn', message: `Mac/Linux apply check: the previous release's dependency hash was not given, so "code-only with an equal dependency hash" is unchecked. Pass --prev-manifest <previous legion-update-manifest.json> or --prev-deps-sha256 <hex>. If the dependencies changed, ${notice}.` };
  }
  const same = String(depsSha256).toLowerCase() === String(prevDepsSha256).toLowerCase();
  if (requiresFullInstall !== true && !same) return { level: 'fail', message: `the manifest says requiresFullInstall is false, but its dependency hash differs from the previous release's (${String(depsSha256).slice(0, 12)} vs ${String(prevDepsSha256).slice(0, 12)}): the dependencies changed, so it must say requiresFullInstall true. As written, Mac and Linux installs would apply code that needs different dependencies` };
  if (requiresFullInstall === true) return { level: 'warn', message: `${version} needs a full install${same ? ' (its dependency hash equals the previous release\'s, so check that this is intended)' : ''}: ${notice}` };
  return { level: 'pass', message: 'Mac/Linux: code-only with a dependency hash equal to the previous release\'s, so managed clones apply it automatically' };
}

