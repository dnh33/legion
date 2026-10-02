// Pure logic and small file helpers of the prebuilt package (build-package.mjs, package-install.mjs, mcp-config.mjs, the tests).
// Plain Node, no dependencies. Nothing here talks to the network.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { posix, win32, join } from 'node:path';

export const PLATFORM = 'win32-x64';
export const ELECTRON_REL = 'runtime/electron/electron.exe';
export const SDK_PKG = '@anthropic-ai/claude-agent-sdk-win32-x64';
export const CLAUDE_REL = `node_modules/${SDK_PKG}/claude.exe`;
export const FILES_LIST = 'PACKAGE-FILES.json';
/** Top-level names a full package holds beyond the updater's code set. */
export const EXTRA_TOP = Object.freeze(['node_modules', 'runtime']);
export const CAPS = Object.freeze({ zipBytes: 450 * 1024 * 1024, unpackedBytes: 1200 * 1024 * 1024, entries: 20_000, relPathChars: 200 });

/** Names a package install may swap into place: the updater's code set plus node_modules and runtime. */
export const packageTopNames = (codeSet) => [...codeSet, ...EXTRA_TOP];

const RELEASE = Object.freeze({ host: 'github.com', owner: 'dnh33', repo: 'legion' });
/** github.com serves the release URL, then redirects to GitHub's release-asset hosts. */
export const REDIRECT_HOSTS = Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
export const MAX_REDIRECTS = 3;
const SEMVER = '(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})\\.(?:0|[1-9]\\d{0,8})';
export const packageAssetName = (version) => `legion-${version}-win-x64.zip`;

/** Mirror of the rule setup.ps1 enforces for -PackageUrl. Returns null when fine, else the reason. */
export function checkPackageUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return 'not a valid address'; }
  if (u.protocol !== 'https:') return 'only https addresses are allowed';
  if (u.username || u.password) return 'the address carries user info';
  if (u.port) return 'a port in the address is not allowed';
  if (u.host.toLowerCase() !== RELEASE.host) return `the first host must be ${RELEASE.host}`;
  if (u.search || u.hash) return 'a query or fragment is not allowed';
  const m = new RegExp(`^/${RELEASE.owner}/${RELEASE.repo}/releases/download/v(${SEMVER})/legion-(${SEMVER})-win-x64\\.zip$`).exec(u.pathname);
  if (!m) return `the path must be /${RELEASE.owner}/${RELEASE.repo}/releases/download/v<version>/legion-<version>-win-x64.zip`;
  if (m[1] !== m[2]) return 'the version in the folder and in the file name differ';
  return null;
}
export const isRedirectHostAllowed = (host) => REDIRECT_HOSTS.includes(String(host).toLowerCase());

const DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
/** Why a relative path from a package list is unsafe, or null. */
export function isSafeRel(rel) {
  if (typeof rel !== 'string' || rel === '') return 'empty path';
  if (rel.includes('\\') || rel.includes(':') || rel.includes('\0')) return 'backslash, colon or NUL in path';
  if (rel.startsWith('/')) return 'absolute path';
  if (/[\u0001-\u001f<>"|?*]/.test(rel)) return 'a character Windows does not allow';
  for (const s of rel.split('/')) {
    if (s === '' || s === '.' || s === '..') return 'empty or dot segment';
    if (/[. ]$/.test(s)) return 'segment ends with a dot or space';
    if (DEVICE.test(s)) return 'reserved device name';
  }
  if (posix.normalize(rel) !== rel) return 'path is not normalised';
  return null;
}

export function readBuildInfo(dir) {
  try { const j = JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}
/** 'package' = prebuilt Windows package; 'source' = a checkout or source zip (has src and package.json); 'unknown' otherwise. */
export function detectKind(dir, exists = existsSync, readInfo = readBuildInfo) {
  const info = readInfo(dir);
  if (info && info.kind === 'package' && info.platform === PLATFORM && exists(join(dir, ...ELECTRON_REL.split('/')))) return { kind: 'package', version: typeof info.version === 'string' ? info.version : '' };
  if (exists(join(dir, 'package.json')) && exists(join(dir, 'src'))) return { kind: 'source' };
  return { kind: 'unknown' };
}

/** Every regular file under root as { rel, size, mode }, sorted by rel. Throws on a link or anything that is not a plain file/folder. */
export function listTree(root, skip = () => false) {
  const out = [];
  const walk = (abs, rel) => {
    for (const n of readdirSync(abs).sort()) {
      const a = join(abs, n); const r = rel ? `${rel}/${n}` : n;
      if (skip(r)) continue;
      const st = lstatSync(a);
      if (st.isSymbolicLink()) throw new Error(`refusing a link: ${r}`);
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile()) out.push({ rel: r, size: st.size, mode: st.mode & 0o777 });
      else throw new Error(`refusing a non-file: ${r}`);
    }
  };
  walk(root, '');
  out.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0));
  return out;
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** PACKAGE-FILES.json for a staged tree: every file except the list itself, sorted, with size and sha256. */
export async function makeFilesList(root) {
  const files = [];
  for (const f of listTree(root, (r) => r === FILES_LIST)) files.push({ path: f.rel, size: f.size, sha256: await sha256File(join(root, ...f.rel.split('/'))) });
  return { schema: 1, files };
}
const HEX64 = /^[0-9a-f]{64}$/;
/** Strict parse of PACKAGE-FILES.json text. Throws with a plain reason. */
export function parseFilesList(text, topNames) {
  let j; try { j = JSON.parse(text); } catch { throw new Error('the file list is not valid JSON'); }
  if (!j || j.schema !== 1 || !Array.isArray(j.files)) throw new Error('the file list has the wrong shape');
  if (j.files.length === 0 || j.files.length > CAPS.entries) throw new Error('the file list has an unreasonable number of entries');
  const seen = new Set(); let total = 0;
  for (const f of j.files) {
    if (!f || typeof f.path !== 'string' || !Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== 'string' || !HEX64.test(f.sha256)) throw new Error('a file list entry is malformed');
    const bad = isSafeRel(f.path); if (bad) throw new Error(`unsafe path in the file list (${bad}): ${f.path.slice(0, 80)}`);
    if (f.path.length > CAPS.relPathChars) throw new Error(`a path is too long for Windows: ${f.path.slice(0, 80)}`);
    if (!topNames.includes(f.path.split('/')[0])) throw new Error(`"${f.path.split('/')[0]}" is not a part of a Legion package`);
    const k = f.path.toLowerCase(); if (seen.has(k)) throw new Error(`the file list names ${f.path} twice`); seen.add(k);
    total += f.size;
  }
  if (total > CAPS.unpackedBytes) throw new Error('the package would unpack to more than the size limit');
  return j.files;
}

/** The SDK folder name of every platform build under node_modules/@anthropic-ai (claude-agent-sdk-<os>-<cpu>[-musl]). */
export function sdkPlatformDirs(nodeModules) {
  const base = join(nodeModules, '@anthropic-ai');
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((n) => /^claude-agent-sdk-(?:darwin|linux|win32|android)-/.test(n));
}
/** Removes every SDK platform build except the one wanted. Returns the names removed. */
export function pruneSdkPlatforms(nodeModules, keep = SDK_PKG.split('/')[1]) {
  const gone = [];
  for (const n of sdkPlatformDirs(nodeModules)) if (n !== keep) { rmSync(join(nodeModules, '@anthropic-ai', n), { recursive: true, force: true }); gone.push(n); }
  return gone;
}
/** claude.exe must be there, and equal the size and sha256 the SDK's own manifest.json gives for win32-x64. Returns { size, sha256 }. */
export async function checkSdkBinary(nodeModules) {
  const dir = join(nodeModules, '@anthropic-ai', SDK_PKG.split('/')[1]);
  const exe = join(dir, 'claude.exe');
  if (!existsSync(exe)) throw new Error(`${SDK_PKG}/claude.exe is missing (is this a Windows x64 install of the dependencies?)`);
  let m; try { m = JSON.parse(readFileSync(join(nodeModules, '@anthropic-ai', 'claude-agent-sdk', 'manifest.json'), 'utf8')).platforms?.[PLATFORM]; } catch { m = undefined; }
  if (!m || typeof m.checksum !== 'string' || !Number.isSafeInteger(m.size)) throw new Error('the SDK manifest.json has no win32-x64 entry to check claude.exe against');
  const size = lstatSync(exe).size; const sha = await sha256File(exe);
  if (size !== m.size || sha !== m.checksum) throw new Error('claude.exe does not match the checksum in the SDK manifest.json');
  return { size, sha256: sha };
}

/** How a plain command line (and an MCP client config) runs a script on the package's own Electron in node mode. */
export function nodeModeCommand(installDir) {
  return { command: win32.join(installDir, ...ELECTRON_REL.split('/')), env: { ELECTRON_RUN_AS_NODE: '1' } };
}
/** The mcpServers.legion entry for Claude Desktop / Cowork, for a package install. */
export function mcpStdioEntry(installDir) {
  const n = nodeModeCommand(installDir);
  return { command: n.command, args: [win32.join(installDir, 'dist', 'src', 'bin', 'legion-mcp-stdio.js')], env: n.env };
}

/** Why a file could not be read or written, in words a person can act on. */
export function blockedMessage(file) {
  return `Windows or your antivirus blocked or removed "${file}". Legion did not retry. Open Windows Security > Virus & threat protection > Protection history, restore or allow the file, then run setup again.`;
}
