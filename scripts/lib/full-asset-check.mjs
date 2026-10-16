// The one rule for the full package in a release folder, shared by release-preflight.mjs and release-verify.mjs.
// A manifest that says requiresFullInstall must carry a fullAsset equal to the legion-<version>-win-x64.zip in the folder
// (name, size, sha256) and SHA256SUMS.txt must list it.
// A code-only manifest (requiresFullInstall false) carries one exactly when `carryRequired`: its lock differs from the stepping stone's
// (scripts/lib/stone-carry.mjs), so a stone-era install that refuses the code package can fall back to it. Then the same checks apply.
// A code-only release whose lock equals the stone's must not carry one.
// `published`: the release is live and the folder holds only the small files, so the zip comparison is skipped (the live fetch does it).
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256File } from './package-lib.mjs';

/** Returns a list of plain-language problems (empty = fine). `dir` holds the release files, `sums` is the text of SHA256SUMS.txt. */
export async function fullAssetProblems({ manifest, version, dir, sums, carryRequired = false, stoneVersion = '0.3.0', published = false }) {
  const name = `legion-${version}-win-x64.zip`;
  const fa = manifest.fullAsset;
  const out = [];
  if (manifest.requiresFullInstall !== true) {
    if (!carryRequired) {
      if (fa) out.push("the manifest carries a fullAsset but does not say requiresFullInstall, and its lock equals the stepping stone's: nothing needs it, and installs would treat the release as code-only");
      return out;
    }
    if (!fa) return [`this code-only release changes the dependency lock against the stepping stone ${stoneVersion} but the manifest has no fullAsset: every install still holding the ${stoneVersion} lock (all ${stoneVersion} users and every 0.2.7 user who stepped to ${stoneVersion}) would be stranded on a notice. Rebuild the manifest with --full-zip <legion-${version}-win-x64.zip> --carry-full`];
  } else if (!fa) return ['requiresFullInstall is true but the manifest has no fullAsset: this release could only notify, never self-apply (re-run release-manifest with --full-zip)'];
  if (fa.name !== name) out.push(`fullAsset name is ${fa.name}, expected ${name}`);
  if (published) {
    // Post-publish: the package is not in the folder (285 MB). Its size and sha256 are compared with the signed manifest by the live fetch
    // (stone-carry.mjs liveFullAssetProblems); here SHA256SUMS.txt must list the signed hash.
    if (!sums.split(/\r?\n/).some((l) => l === `${fa.sha256}  ${name}`)) out.push(`SHA256SUMS.txt has no line for ${name} with the signed fullAsset hash`);
    return out;
  }
  let size;
  try { size = statSync(join(dir, name)).size; } catch { out.push(`the full package ${name} is not in the folder`); return out; }
  if (fa.size !== size) out.push(`fullAsset size ${fa.size} differs from the full package in the folder (${size})`);
  const real = await sha256File(join(dir, name));
  if (fa.sha256 !== real) out.push('fullAsset sha256 differs from the full package in the folder');
  if (!sums.split(/\r?\n/).some((l) => l === `${real}  ${name}`)) out.push(`SHA256SUMS.txt has no line for ${name} with the real hash`);
  return out;
}
