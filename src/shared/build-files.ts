/**
 * The files whose change can make a later build or test command run something new: package and lock files, build and test
 * configs, and anything under a `scripts` folder. Smart asks for local build and test commands once an agent changed one
 * of these in the project (see needsApproval). Matched on the whole path with either slash, case-insensitive.
 */
const BUILD = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|makefile|gnumakefile|cargo\.toml|cargo\.lock|pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|pytest\.ini|conftest\.py|\.npmrc|go\.mod|go\.sum|(jest|vitest|playwright|mocha|karma)\.config\.[cm]?[jt]s|\.mocharc\.[\w.]+|scripts\/.*)$/i;

/**
 * Windows reads some other spellings as the same file: a trailing dot or space (`package.json.`), an NTFS stream (`package.json::$DATA`)
 * and a drive-relative name (`C:package.json`). Each path segment is cleaned of those before matching. (8.3 short names are not
 * undone here; the build-file fingerprint in gates-settings/build-edited.ts covers the project's root files.)
 */
export const isBuildFile = (p: string): boolean => {
  const segs = p.replace(/\\/g, '/').split('/').map((seg, i) => {
    let s = i === 0 ? seg.replace(/^[a-z]:(?=.)/i, '') : seg;
    s = s.replace(/:.*$/, '');
    return s.replace(/[. ]+$/, '');
  });
  return BUILD.test(segs.join('/'));
};
