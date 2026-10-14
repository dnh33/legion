// The rules for the stepping stone (docs/SHIPPING.md, Stepping stones), shared by release-manifest, release-preflight, release-verify and
// stone-check. A 0.2.7 install reads only `releases/latest/download/legion-update-manifest.json` and builds its package address from that
// manifest's VERSION, so a full-install release parks a stone's own signed manifest under that old name. Pure functions: the caller supplies the
// app's own trust and manifest modules and the network, so tests run offline.
//
// The rule, from the stone release on (0.3.0): EVERY release publishes both names. Its own manifest is the second name. The old name carries the stone's
// original signed manifest and .sig, byte for byte, for every release after the stone, code-only or full. Only the stone release itself publishes its
// own manifest under both names. A 0.2.7 install therefore always lands on the stone (a code-only release its updater can apply), then reads the second name.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './release-lib.mjs';

export const OLD_NAME = 'legion-update-manifest.json';
export const NEW_NAME = 'legion-update-manifest-2.json';
export const REPO_BASE = 'https://github.com/dnh33/legion';
// 0.3.0 is THE permanent stepping stone: 0.2.7 reads only the old manifest name, so every later release carries 0.3.0's original signed manifest there.
// A second stone needs a deliberate change here plus a test, never just another line in the json.
export const PERMANENT_STONE = '0.3.0';
export const readStones = (file = join(REPO, 'scripts', 'stepping-stones.json')) => {
  const stones = JSON.parse(readFileSync(file, 'utf8')).stones;
  if (!Array.isArray(stones) || stones.length !== 1 || stones[0] !== PERMANENT_STONE) throw new Error(`scripts/stepping-stones.json must list exactly the permanent stepping stone ${PERMANENT_STONE} (found ${JSON.stringify(stones)}); a second stone is a deliberate change in scripts/lib/stepping-stone.mjs plus a test`);
  return stones;
};
const cmp = (x, y) => { const p = x.split('.').map(Number), q = y.split('.').map(Number); for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] - q[i]; return 0; };
export const stoneAssetUrl = (base, m) => `${base}/releases/download/v${m.version}/${m.asset.name}`;

const NET_MS = 60_000;

/** Status and bytes of a URL (redirects followed). Gives up after `ms`, so a stalled server fails the check instead of hanging it. */
export async function fetchBytes(url, ms = NET_MS) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(ms) });
    return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
  } catch (e) { throw new Error(`could not fetch ${url}: ${e.message}`); }
}

/** The tag the repository calls its latest release (`v0.3.0`), read from the redirect of /releases/latest. */
export async function latestTagOf(base = REPO_BASE, ms = NET_MS) {
  const r = await fetch(`${base}/releases/latest`, { redirect: 'manual', signal: AbortSignal.timeout(ms) });
  const loc = r.headers.get('location') ?? '';
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(loc);
  if (!m) throw new Error(`/releases/latest answered HTTP ${r.status} with no tag redirect`);
  return decodeURIComponent(m[1]);
}

/** Size and sha256 of what a URL really returns (redirects followed, as an install does). Throws with a plain message. */
export async function hashUrl(url, ms = 300_000) {
  let res;
  try { res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(ms) }); } catch (e) { throw new Error(`could not fetch ${url}: ${e.message}`); }
  if (!res.ok || !res.body) throw new Error(`${url} answered HTTP ${res.status}`);
  const h = createHash('sha256'); let size = 0;
  try { for await (const c of res.body) { h.update(c); size += c.length; } } catch (e) { throw new Error(`could not read ${url}: ${e.message}`); }
  return { size, sha256: h.digest('hex') };
}

/**
 * Plain-language problems with the pair of manifests of one release (empty = fine).
 *  oldBytes/oldSig  what is published under the OLD name (what 0.2.7 reads)
 *  newBytes         what is published under the second name (what 0.3.0 and later read): this release's own manifest
 *  fetchAsset(url)  optional, async: {size, sha256} of the old-name package as the world gets it; when given it must equal the SIGNED size and hash
 *  getBytes(url)    optional, async {status, bytes}: when given, the old name and its .sig must equal the PUBLISHED stone's files byte for byte (a failure to fetch is a failure)
 *  publishing       true while the release is not out yet (preflight, verify, publish): the stone release itself then has no package or files to compare
 *  stones           the pinned stone (PERMANENT_STONE; the json must list only it). Tests and rehearsals pass a throwaway one.
 * The release whose own version is a stone publishes one manifest under both names. Every other release, code-only or full, has a listed stone there.
 */
export async function stoneProblems({ oldBytes, oldSig, newBytes, trust, parseManifest, fetchAsset, getBytes, publishing = false, base = REPO_BASE, stones = readStones() }) {
  const out = [];
  const v = trust.verifyManifestSignature(oldBytes, oldSig, trust.UPDATE_KEYS);
  if (!v.ok) out.push(`the old-name manifest signature does not verify: ${v.reason}`);
  let o, n;
  try { o = parseManifest(oldBytes); } catch (e) { out.push(`the old-name manifest does not parse: ${e.message}`); }
  try { n = parseManifest(newBytes); } catch (e) { out.push(`the second-name manifest does not parse: ${e.message}`); }
  if (!o || !n) return out;
  const ownIsStone = stones.includes(n.version);
  if (ownIsStone) {
    if (n.requiresFullInstall || n.fullAsset) out.push(`${n.version} is a declared stepping stone, so it must be a code-only release`);
    if (Buffer.compare(oldBytes, newBytes) !== 0) out.push(`${n.version} is the stepping stone itself: it must publish its own manifest under both names`);
  } else {
    if (o.requiresFullInstall || o.fullAsset) out.push(`the old-name manifest (${o.version}) is itself a full-install release, not a stepping stone: a 0.2.7 install would take the full route with its old helper, which can leave a broken install`);
    if (cmp(o.version, n.version) >= 0) out.push(`the old-name manifest names ${o.version}, which is not older than ${n.version}`);
    if (!stones.includes(o.version)) out.push(`${o.version} is not the permanent stepping stone (${stones.join(', ')}), so a 0.2.7 install would not land on it`);
    if (Buffer.compare(oldBytes, newBytes) === 0) out.push(`both names carry this release's own manifest, so there is no stepping stone: every release after the stone keeps the stone's own manifest under the old name, code-only or not (a 0.2.7 install would stage ${n.version} and be stranded)`);
    if (n.requiresFullInstall) {
      if (!(n.minUpdater >= 2)) out.push('the second-name manifest of a full-install release must set minUpdater to 2 or more');
      const s = n.steppingStone;
      if (!s) out.push('the second-name manifest of a full-install release names no steppingStone');
      else if (s.version !== o.version || s.publishedAt !== o.publishedAt || s.depsSha256 !== o.depsSha256 || s.asset.name !== o.asset.name || s.asset.size !== o.asset.size || s.asset.sha256 !== o.asset.sha256) out.push('the signed steppingStone in the second-name manifest differs from the old-name manifest (version, date, deps hash or asset)');
    }
  }
  if (getBytes && !(ownIsStone && publishing) && !out.length) { // the old name must be the published stone's files, not a re-signed copy
    for (const [name, mine] of [[OLD_NAME, oldBytes], [`${OLD_NAME}.sig`, Buffer.from(oldSig)]]) {
      const url = `${base}/releases/download/v${o.version}/${name}`;
      try {
        const got = await getBytes(url);
        if (got.status !== 200) out.push(`the published stone v${o.version} does not serve ${name} (HTTP ${got.status})`);
        else if (Buffer.compare(got.bytes, mine) !== 0) out.push(`${name} differs from the published v${o.version} file: the old name must carry the stone's original signed file, byte for byte`);
      } catch (e) { out.push(`could not fetch the published stone's ${name}: ${e.message}`); }
    }
  }
  if (fetchAsset && !(ownIsStone && publishing) && !out.length) { // the network is asked only when the files themselves are right; the stone's own package is hashed too once it is live
    const url = stoneAssetUrl(base, o);
    try {
      const got = await fetchAsset(url);
      if (got.size !== o.asset.size) out.push(`${url} returns ${got.size} bytes, the signed size is ${o.asset.size}`);
      if (got.sha256 !== o.asset.sha256) out.push(`${url} returns sha256 ${got.sha256}, the signed hash is ${o.asset.sha256}`);
    } catch (e) { out.push(`the old-name package is not reachable: ${e.message}`); }
  }
  return out;
}

/**
 * The same check against a live release (the daily job): fetches both manifests and the old-name package from `base`.
 * A missing second name is a FAILURE: every 0.3.0 and later install then gets a 404, falls back to the old name and says "up to date" forever.
 * `latestTag()` answers the tag of the latest release; the second-name manifest must be that release's own.
 */
export async function liveProblems({ base = REPO_BASE, getBytes, latestTag, fetchAsset, trust, parseManifest, stones = readStones() }) {
  const dl = `${base}/releases/latest/download`;
  const old = await getBytes(`${dl}/${OLD_NAME}`), oldSig = await getBytes(`${dl}/${OLD_NAME}.sig`);
  if (old.status !== 200 || oldSig.status !== 200) return [`the live old-name manifest or its signature is missing (HTTP ${old.status} / ${oldSig.status}): every install that has not updated yet is stranded`];
  const two = await getBytes(`${dl}/${NEW_NAME}`);
  if (two.status !== 200) return [`the latest release has no second-name manifest (${NEW_NAME}, HTTP ${two.status}): every 0.3.0 and later install falls back to the stepping stone and says it is up to date, for ever. Publish ${NEW_NAME} and its .sig with the release`];
  const out = [];
  const twoSig = await getBytes(`${dl}/${NEW_NAME}.sig`);
  if (twoSig.status !== 200) out.push(`the second-name signature is missing (HTTP ${twoSig.status})`);
  else { const v = trust.verifyManifestSignature(two.bytes, twoSig.bytes.toString('utf8'), trust.UPDATE_KEYS); if (!v.ok) out.push(`the second-name manifest signature does not verify: ${v.reason}`); }
  let n;
  try { n = parseManifest(two.bytes); } catch (e) { out.push(`the second-name manifest does not parse: ${e.message}`); }
  if (n) {
    let tag;
    try { tag = await latestTag(); } catch (e) { out.push(`could not read the latest release tag: ${e.message}`); }
    if (tag !== undefined && tag !== `v${n.version}`) out.push(`the latest release is ${tag} but its second-name manifest says ${n.version}: the second name is stale or from another release`);
  }
  out.push(...(await stoneProblems({ oldBytes: old.bytes, oldSig: oldSig.bytes.toString('utf8'), newBytes: two.bytes, trust, parseManifest, fetchAsset, base, stones })));
  // The old name must be the stone exactly as published at its own tag, not a copy that drifted.
  let o;
  try { o = parseManifest(old.bytes); } catch { /* stoneProblems already said so */ }
  if (o) {
    const own = await getBytes(`${base}/releases/download/v${o.version}/${OLD_NAME}`);
    if (own.status !== 200) out.push(`the stepping stone's own release v${o.version} does not serve ${OLD_NAME} (HTTP ${own.status})`);
    else if (Buffer.compare(own.bytes, old.bytes) !== 0) out.push(`the live old-name manifest differs from the stone as published at v${o.version}: it must be that file, byte for byte`);
    const ownSig = await getBytes(`${base}/releases/download/v${o.version}/${OLD_NAME}.sig`);
    if (ownSig.status !== 200) out.push(`the stepping stone's own release v${o.version} does not serve ${OLD_NAME}.sig (HTTP ${ownSig.status})`);
    else if (Buffer.compare(ownSig.bytes, oldSig.bytes) !== 0) out.push(`the live old-name signature differs from the stone's as published at v${o.version}: it must be that file, byte for byte`);
  }
  return out;
}
