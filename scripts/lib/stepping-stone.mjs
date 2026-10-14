// The rules for the stepping stone (docs/SHIPPING.md, Stepping stones), shared by release-manifest, release-preflight, release-verify and
// stone-check. A 0.2.7 install reads only `releases/latest/download/legion-update-manifest.json` and builds its package address from that
// manifest's VERSION, so a full-install release parks a stone's own signed manifest under that old name. Pure functions: the caller supplies the
// app's own trust and manifest modules and the network, so tests run offline.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './release-lib.mjs';

export const OLD_NAME = 'legion-update-manifest.json';
export const NEW_NAME = 'legion-update-manifest-2.json';
export const REPO_BASE = 'https://github.com/dnh33/legion';
export const readStones = () => JSON.parse(readFileSync(join(REPO, 'scripts', 'stepping-stones.json'), 'utf8')).stones;
const cmp = (x, y) => { const p = x.split('.').map(Number), q = y.split('.').map(Number); for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] - q[i]; return 0; };
export const stoneAssetUrl = (base, m) => `${base}/releases/download/v${m.version}/${m.asset.name}`;

/** Size and sha256 of what a URL really returns (redirects followed, as an install does). Throws with a plain message. */
export async function hashUrl(url) {
  let res;
  try { res = await fetch(url, { redirect: 'follow' }); } catch (e) { throw new Error(`could not fetch ${url}: ${e.message}`); }
  if (!res.ok || !res.body) throw new Error(`${url} answered HTTP ${res.status}`);
  const h = createHash('sha256'); let size = 0;
  for await (const c of res.body) { h.update(c); size += c.length; }
  return { size, sha256: h.digest('hex') };
}

/**
 * Plain-language problems with the pair of manifests of one release (empty = fine).
 *  oldBytes/oldSig  what is published under the OLD name (what 0.2.7 reads)
 *  newBytes         what is published under the second name (what 0.3.0 and later read)
 *  fetchAsset(url)  optional, async: {size, sha256} of the old-name package as the world gets it; when given it must equal the SIGNED size and hash
 *  stones           optional list of stepping-stone versions (scripts/stepping-stones.json); a full release's old-name version must be one of them
 */
export async function stoneProblems({ oldBytes, oldSig, newBytes, trust, parseManifest, fetchAsset, base = REPO_BASE, stones }) {
  const out = [];
  const v = trust.verifyManifestSignature(oldBytes, oldSig, trust.UPDATE_KEYS);
  if (!v.ok) out.push(`the old-name manifest signature does not verify: ${v.reason}`);
  let o, n;
  try { o = parseManifest(oldBytes); } catch (e) { out.push(`the old-name manifest does not parse: ${e.message}`); }
  try { n = parseManifest(newBytes); } catch (e) { out.push(`the second-name manifest does not parse: ${e.message}`); }
  if (!o || !n) return out;
  if (n.requiresFullInstall) {
    if (o.requiresFullInstall || o.fullAsset) out.push(`the old-name manifest (${o.version}) is itself a full-install release, not a stepping stone: a 0.2.7 install would take the full route with its old helper, which can leave a broken install`);
    if (cmp(o.version, n.version) >= 0) out.push(`the old-name manifest names ${o.version}, which is not older than ${n.version}`);
    if (!(n.minUpdater >= 2)) out.push('the second-name manifest of a full-install release must set minUpdater to 2 or more');
    const s = n.steppingStone;
    if (!s) out.push('the second-name manifest of a full-install release names no steppingStone');
    else if (s.version !== o.version || s.publishedAt !== o.publishedAt || s.depsSha256 !== o.depsSha256 || s.asset.name !== o.asset.name || s.asset.size !== o.asset.size || s.asset.sha256 !== o.asset.sha256) out.push('the signed steppingStone in the second-name manifest differs from the old-name manifest (version, date, deps hash or asset)');
    if (stones && !stones.includes(o.version)) out.push(`${o.version} is not listed in scripts/stepping-stones.json, so it is not a declared stepping stone`);
    if (Buffer.compare(oldBytes, newBytes) === 0) out.push('both names carry the same manifest, so there is no stepping stone');
  } else if (Buffer.compare(oldBytes, newBytes) !== 0) out.push('a code-only release must publish the same manifest under both names');
  if (fetchAsset && !out.length) { // the network is asked only when the files themselves are right
    const url = stoneAssetUrl(base, o);
    try {
      const got = await fetchAsset(url);
      if (got.size !== o.asset.size) out.push(`${url} returns ${got.size} bytes, the signed size is ${o.asset.size}`);
      if (got.sha256 !== o.asset.sha256) out.push(`${url} returns sha256 ${got.sha256}, the signed hash is ${o.asset.sha256}`);
    } catch (e) { out.push(`the old-name package is not reachable: ${e.message}`); }
  }
  return out;
}

/** The same check against a live release (the daily job): fetches both manifests and the old-name package from `base`. */
export async function liveProblems({ base = REPO_BASE, getBytes, fetchAsset, trust, parseManifest }) {
  const dl = `${base}/releases/latest/download`;
  const old = await getBytes(`${dl}/${OLD_NAME}`), oldSig = await getBytes(`${dl}/${OLD_NAME}.sig`);
  if (old.status !== 200 || oldSig.status !== 200) return [`the live old-name manifest or its signature is missing (HTTP ${old.status} / ${oldSig.status}): every install that has not updated yet is stranded`];
  const two = await getBytes(`${dl}/${NEW_NAME}`);
  const out = [];
  let newBytes = old.bytes;
  if (two.status === 200) {
    newBytes = two.bytes;
    const twoSig = await getBytes(`${dl}/${NEW_NAME}.sig`);
    if (twoSig.status !== 200) out.push(`the second-name signature is missing (HTTP ${twoSig.status})`);
    else { const v = trust.verifyManifestSignature(two.bytes, twoSig.bytes.toString('utf8'), trust.UPDATE_KEYS); if (!v.ok) out.push(`the second-name manifest signature does not verify: ${v.reason}`); }
  } else if (two.status !== 404) out.push(`the second-name manifest answered HTTP ${two.status}`);
  return [...out, ...(await stoneProblems({ oldBytes: old.bytes, oldSig: oldSig.bytes.toString('utf8'), newBytes, trust, parseManifest, fetchAsset, base }))];
}
