// The one rule for the full package in a release folder, shared by release-preflight.mjs and release-verify.mjs.
// A manifest that says requiresFullInstall must carry a fullAsset equal to the legion-<version>-win-x64.zip in the folder
// (name, size, sha256) and SHA256SUMS.txt must list it. A manifest that does not need it must not carry one.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from './package-lib.mjs';

/** Returns a list of plain-language problems (empty = fine). `dir` holds the release files, `sums` is the text of SHA256SUMS.txt. */
export async function fullAssetProblems({ manifest, version, dir, sums }) {
  const name = `legion-${version}-win-x64.zip`;
  const fa = manifest.fullAsset;
  const out = [];
  if (manifest.requiresFullInstall !== true) {
    if (fa) out.push('the manifest carries a fullAsset but does not say requiresFullInstall: installs would treat the release as code-only');
    return out;
  }
  if (!fa) return ['requiresFullInstall is true but the manifest has no fullAsset: this release could only notify, never self-apply (re-run release-manifest with --full-zip)'];
  if (fa.name !== name) out.push(`fullAsset name is ${fa.name}, expected ${name}`);
  let size;
  try { size = statSync(join(dir, name)).size; } catch { out.push(`the full package ${name} is not in the folder`); return out; }
  if (fa.size !== size) out.push(`fullAsset size ${fa.size} differs from the full package in the folder (${size})`);
  const real = await sha256File(join(dir, name));
  if (fa.sha256 !== real) out.push('fullAsset sha256 differs from the full package in the folder');
  if (!sums.split(/\r?\n/).some((l) => l === `${real}  ${name}`)) out.push(`SHA256SUMS.txt has no line for ${name} with the real hash`);
  return out;
}
