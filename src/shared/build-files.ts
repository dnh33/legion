/**
 * The files whose change can make a later build or test command run something new: package and lock files, build and test
 * configs, and anything under a `scripts` folder. Smart asks for local build and test commands once an agent changed one
 * of these in the project (see needsApproval). Matched on the whole path with either slash, case-insensitive.
 */
const BUILD = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|makefile|gnumakefile|cargo\.toml|cargo\.lock|pyproject\.toml|setup\.cfg|setup\.py|tox\.ini|pytest\.ini|conftest\.py|\.npmrc|go\.mod|go\.sum|(jest|vitest|playwright|mocha|karma)\.config\.[cm]?[jt]s|\.mocharc\.[\w.]+|scripts\/.*)$/i;

export const isBuildFile = (p: string): boolean => BUILD.test(p.replace(/\\/g, '/'));
