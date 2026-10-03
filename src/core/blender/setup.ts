/**
 * Managed setup, only on request (the Set up button): download the backend from its official source, install the Blender add-on
 * headlessly, record how Legion starts the server, and test the connection. Nothing is bundled in Legion and nothing is downloaded
 * unless a person pressed Set up. Every side effect goes through BlenderIo, so tests use fakes and never touch a network or a real Blender.
 *
 * UNVERIFIED against the real upstream projects (see docs/BLENDER.md): the official archive layout (where the add-on and the server
 * project are inside it), how the server is launched, and whether the add-on honours a configured port. All three are config
 * (blender.advanced.*) and every step says what it did, so a wrong guess shows up as a readable failed step, not a silent one.
 */
import { join } from 'node:path';
import type { BlenderConfig, BlenderEntry, BlenderSetupStep, ServerSetupInfo } from '../../shared/blender.js';
import { BLENDER_LICENSE_NOTE, OFFICIAL_MIN_VERSION } from '../../shared/blender.js';
import type { BlenderBackendKind, BlenderInstall } from '../../shared/blender.js';
import type { BlenderBackend } from './backend.js';
import { versionAtLeast } from './detect.js';
import { bothPorts, ensureFreePorts } from './both.js';
import type { DetectEnv, RunResult } from './detect.js';

/** Every side effect of setup. The real one is system.ts. */
export interface BlenderIo {
  detect: DetectEnv;
  run(file: string, args: string[], timeoutMs: number, opts?: { cwd?: string; env?: Record<string, string> }): Promise<RunResult | null>;
  download(url: string, dest: string, opts: { maxBytes: number }): Promise<{ sha256: string; bytes: number }>;
  extract(archive: string, destDir: string): Promise<void>;
  mkdirp(path: string): void;
  writeText(path: string, text: string): void;
  readText(path: string): string | undefined;
  copyFile(from: string, to: string): void;
  exists(path: string): boolean;
  isDir(path: string): boolean;
  listDir(path: string): string[];
  removeDir(path: string): void;
  spawnDetached(file: string, args: string[], env?: Record<string, string>): void;
  now(): Date;
}

export interface LiveSetupOutcome {
  steps: BlenderSetupStep[];
  ok: boolean;
  backend: BlenderBackendKind;
  entry?: BlenderEntry;
  info?: ServerSetupInfo;
  addonInstalled: boolean;
  /** The download differs from the one you trusted before and nothing was changed; press "Trust the new download" to accept it. */
  retrustRequired?: boolean;
}

export interface SetupOptions {
  /** What was recorded the last time this backend was set up (url and sha256), or null for a first use. */
  prior?: ServerSetupInfo | null;
  /** The user explicitly accepts a changed download (the "Trust the new download" button). */
  retrust?: boolean;
}

const OFFICIAL_MAX_BYTES = 200 * 1024 * 1024;
const COMMUNITY_MAX_BYTES = 5 * 1024 * 1024;
const step = (s: string, ok: boolean, detail: string): BlenderSetupStep => ({ step: s, ok, detail });

/** Python that Blender runs headless to copy the add-on into the user's add-on folder and enable it. Legion's own code, never an agent's. */
export function addonInstallPy(src: string, moduleName: string): string {
  return [
    'import os, shutil, bpy, addon_utils',
    `src = ${JSON.stringify(src)}`,
    `name = ${JSON.stringify(moduleName)}`,
    'root = bpy.utils.user_resource("SCRIPTS", path="addons", create=True)',
    'if os.path.isdir(src):',
    '    dst = os.path.join(root, name)',
    '    shutil.rmtree(dst, ignore_errors=True)',
    '    shutil.copytree(src, dst)',
    'else:',
    '    dst = os.path.join(root, name + ".py")',
    '    shutil.copyfile(src, dst)',
    'addon_utils.modules_refresh()',
    'mod = addon_utils.enable(name, default_set=True, persistent=True)',
    'bpy.ops.wm.save_userpref()',
    'print("LEGION_ADDON_OK" if mod is not None else "LEGION_ADDON_FAILED", name, dst)',
  ].join('\n');
}

/** The --python-expr value: reads Legion's script file, so quoting problems on Windows cannot touch the code. */
export const pyExprForFile = (file: string): string => `exec(compile(open(${JSON.stringify(file)}, encoding="utf-8").read(), "legion_blender_setup", "exec"))`;

/** Python-safe module name from a folder or file name. */
export const moduleNameFor = (name: string): string => {
  const base = name.replace(/\.py$/i, '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1');
  return base || 'legion_blender_addon';
};

async function installAddonHeadless(io: BlenderIo, install: BlenderInstall, workDir: string, src: string, moduleName: string): Promise<BlenderSetupStep> {
  const script = join(workDir, 'install_addon.py');
  io.writeText(script, addonInstallPy(src, moduleName));
  const r = await io.run(install.path, ['-b', '--factory-startup', '--python-expr', pyExprForFile(script)], 120_000);
  if (!r) return step('addon', false, `Could not start Blender at ${install.path}.`);
  if (r.stdout.includes('LEGION_ADDON_OK')) return step('addon', true, `Add-on "${moduleName}" installed and enabled in Blender ${install.version}. Restart Blender if it is open.`);
  const tail = (r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ').slice(0, 400);
  return step('addon', false, `Blender ran but the add-on did not enable (exit ${r.code}): ${tail || 'no output'}. You can install ${src} by hand (Edit, Preferences, Add-ons, Install from disk).`);
}

/** The Blender build that makes "extension" commands needs the manifest next to the add-on's code; its presence is how the extension path is chosen. */
export const EXTENSION_MANIFEST = 'blender_manifest.toml';
const tailOf = (r: RunResult, n = 4): string => (r.stderr || r.stdout).trim().split('\n').slice(-n).join(' | ').slice(0, 400);
const BY_HAND = 'You can install the add-on by hand: Blender, Edit, Preferences, Get Extensions, Install from Disk, and pick the zip.';

/** Reads `key = "value"` from the top of a manifest (text match; Legion needs only id and version, and a wrong read becomes a failed step). */
export const manifestValue = (text: string, key: string): string | undefined => new RegExp(`^${key}\\s*=\\s*"([^"\\r\\n]*)"`, 'm').exec(text)?.[1];

/**
 * Picks the id of a local, user-owned extension repository from the text of `extension repo-list`. UNVERIFIED format (needs the PC): blocks that start
 * with an `id:` line are expected; a block that mentions a remote URL is skipped. Prefers `user_default`. Returns undefined when none is found.
 */
export function parseLocalRepoId(out: string): string | undefined {
  const blocks: Array<{ id: string; text: string }> = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+):\s*$/.exec(line.trim());
    if (m && !/^\s/.test(line)) blocks.push({ id: m[1]!, text: '' });
    else if (blocks.length) blocks[blocks.length - 1]!.text += `${line}\n`;
  }
  const local = blocks.filter((b) => !/https?:\/\//i.test(b.text));
  return (local.find((b) => b.id === 'user_default') ?? local[0])?.id;
}

/**
 * Reads `extension list` back: is `id` listed at exactly `version`, and enabled? The entry is the line that STARTS with the id (after an optional bullet or quote), together with the
 * version as a whole token (1.0.30 or 11.0.3 are not 1.0.3), plus the indented lines under it; `enabled` must appear there and `disabled` / `not enabled` must not.
 * Another extension that happens to share a version string, or the word `mcp` somewhere else, does not count. UNVERIFIED format (needs the PC): the exact
 * layout of a real Blender's list is not known, so a layout without an enabled marker fails the step (closed) and the owner installs by hand.
 */
export function extensionListed(out: string, id: string, version: string): { listed: boolean; enabled: boolean } {
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idRe = new RegExp(`^\\s*[-*]?\\s*["']?${esc(id)}["']?(?=[\\s:(\\[,]|$)`);
  const verRe = new RegExp(`(^|[^0-9.])v?${esc(version)}([^0-9.]|$)`);
  const lines = out.split(/\r?\n/);
  const indent = (l: string): number => l.length - l.trimStart().length;
  let listed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!idRe.test(line) || !verRe.test(line)) continue;
    listed = true;
    let text = line;
    for (let j = i + 1; j < lines.length && lines[j]!.trim() && indent(lines[j]!) > indent(line); j++) text += `\n${lines[j]}`;
    if (/(^|[^A-Za-z])enabled([^A-Za-z]|$)/i.test(text) && !/(disabled|not enabled)/i.test(text)) return { listed: true, enabled: true };
  }
  return { listed, enabled: false };
}

/**
 * The official add-on is a Blender EXTENSION (blender_manifest.toml), not a legacy add-on: build the zip, make sure a local repo exists, install the
 * zip into it and enabled, then read `extension list` back. Every command is `blender --factory-startup --command extension ...` (global flags
 * before --command, which takes the rest of the arguments) and no shell. The first failure stops the rest. Argument names are from Blender's manual;
 * how they behave on a real 5.1 is not yet tried (docs/BLENDER.md).
 */
async function installExtension(io: BlenderIo, install: BlenderInstall, root: string, addonSrc: string, manifest: string): Promise<{ steps: BlenderSetupStep[]; ok: boolean }> {
  const steps: BlenderSetupStep[] = [];
  const fail = (name: string, detail: string) => { steps.push(step(name, false, `${detail} ${BY_HAND}`)); return { steps, ok: false }; };
  const ext = async (args: string[], ms = 120_000): Promise<RunResult | null> => io.run(install.path, ['--factory-startup', '--command', 'extension', ...args], ms);
  const version = manifestValue(manifest, 'version') ?? '0';
  const id = manifestValue(manifest, 'id') ?? 'mcp';
  const zip = join(root, `${id}-${version}.zip`);
  io.mkdirp(root);

  const b = await ext(['build', '--source-dir', addonSrc, '--output-filepath', zip]);
  if (!b) return fail('ext-build', `Could not start Blender at ${install.path}.`);
  if (b.code !== 0 || !io.exists(zip)) return fail('ext-build', `Building the extension zip failed (exit ${b.code}): ${tailOf(b) || 'no output'}.`);
  steps.push(step('ext-build', true, `Built ${zip} from ${addonSrc}.`));

  const l = await ext(['repo-list'], 60_000);
  if (!l) return fail('ext-repo', 'Could not ask Blender for its extension repositories.');
  let repo = l.code === 0 ? parseLocalRepoId(l.stdout) : undefined;
  if (repo) steps.push(step('ext-repo', true, `Using the local extension repository "${repo}".`));
  else {
    const dir = join(root, 'extensions');
    io.mkdirp(dir);
    const a = await ext(['repo-add', '--name', 'Legion', '--directory', dir, 'legion_local'], 60_000);
    if (!a || a.code !== 0) return fail('ext-repo', `No local extension repository was found and one could not be added${a ? ` (exit ${a.code}): ${tailOf(a)}` : ''}.`);
    repo = 'legion_local';
    steps.push(step('ext-repo', true, `Added a local extension repository "legion_local" at ${dir}.`));
  }

  const i = await ext(['install-file', '-r', repo, '--enable', zip]);
  if (!i || i.code !== 0) return fail('ext-install', `Installing ${zip} failed${i ? ` (exit ${i.code}): ${tailOf(i)}` : ''}.`);
  steps.push(step('ext-install', true, `Installed ${id} ${version} into "${repo}" and asked Blender to enable it.`));

  const v = await ext(['list'], 60_000);
  const seen = v && v.code === 0 ? extensionListed(v.stdout, id, version) : { listed: false, enabled: false };
  if (!seen.enabled) return fail('verify', `The extension list ${seen.listed ? `shows ${id} ${version} but not as enabled` : `does not show ${id} ${version}`} after the install${v ? `: ${tailOf(v, 3) || 'no output'}` : ''}.`);
  steps.push(step('verify', true, `Blender lists ${id} ${version}. Its module name is bl_ext.${repo}.${id}. Start the add-on's server from its sidebar panel in Blender, then press Test. Not yet tried on a real Blender 5.1 or later: check it there.`));
  return { steps, ok: true };
}

interface HashVerdict { ok: boolean; detail: string; changed?: boolean }

/**
 * Checks a downloaded file. A pinned sha256 must match. With no pin, the first download from a URL is trusted and its hash recorded; a LATER
 * download from the same URL with a different hash is refused until the user re-trusts it, so an upstream that changes (or is replaced) under
 * a branch name is noticed instead of silently installed. A different URL is a new source and counts as a first use.
 */
export function checkHash(pinned: string, got: string, url: string, prior: ServerSetupInfo | null | undefined, retrust: boolean): HashVerdict {
  const p = pinned.trim().toLowerCase();
  if (p) return p === got ? { ok: true, detail: `sha256 matches the pinned value (${got.slice(0, 12)}...)` } : { ok: false, detail: `sha256 ${got.slice(0, 12)}... does not match the pinned ${p.slice(0, 12)}...; the file was not used` };
  if (prior && prior.url === url) {
    if (prior.sha256 === got) return { ok: true, detail: `sha256 ${got.slice(0, 12)}... is the same file you trusted on ${prior.at.slice(0, 10) || 'an earlier setup'}` };
    if (retrust) return { ok: true, detail: `sha256 ${got.slice(0, 12)}... differs from the one you trusted (${prior.sha256.slice(0, 12)}...); you chose to trust the new download` };
    return { ok: false, changed: true, detail: `CHANGED: this download is ${got.slice(0, 12)}..., but the one you trusted was ${prior.sha256.slice(0, 12)}... (same address). Nothing was installed or replaced. If you expected an update, press "Trust the new download"; otherwise leave it, the source may have been tampered with. Pin a sha256 in blender.advanced to stop this prompt.` };
  }
  return { ok: true, detail: `sha256 ${got} (no pin set: trusted on first use, and recorded; a later download with a different hash is refused until you re-trust it)` };
}

function subst(s: string, v: { serverDir: string; host: string; port: number }): string {
  return s.replace(/\{serverDir\}/g, v.serverDir).replace(/\{host\}/g, v.host).replace(/\{port\}/g, String(v.port));
}

/**
 * Sets up the live backend for `kind`. Steps are returned in order and the first failure stops the run (later steps need the earlier ones).
 */
export async function setupLive(io: BlenderIo, cfg: BlenderConfig, dataDir: string, install: BlenderInstall | undefined, kind: BlenderBackendKind, opts: SetupOptions = {}): Promise<LiveSetupOutcome> {
  const steps: BlenderSetupStep[] = [];
  const out = (ok: boolean, extra: Partial<LiveSetupOutcome> = {}): LiveSetupOutcome => ({ steps, ok, backend: kind, addonInstalled: false, ...extra });
  if (!install) { steps.push(step('blender', false, 'Blender was not found on this computer. Install it from blender.org, or set the install path in Settings.')); return out(false); }
  if (kind === 'official' && !versionAtLeast(install.version, OFFICIAL_MIN_VERSION)) {
    steps.push(step('blender', false, `The official backend needs Blender ${OFFICIAL_MIN_VERSION}+; found ${install.version}.`));
    return out(false);
  }
  steps.push(step('blender', true, `Using Blender ${install.version} at ${install.path}`));
  const root = join(dataDir, 'blender', kind);
  steps.push(step('license', true, kind === 'official' ? BLENDER_LICENSE_NOTE : 'The community Blender MCP add-on is MIT licensed. It is downloaded from its own project and not copied into Legion.'));

  try {
    if (kind === 'community') {
      const adv = cfg.advanced.community;
      const file = join(root, 'addon.py');
      const d = await io.download(adv.addonUrl, file, { maxBytes: COMMUNITY_MAX_BYTES });
      const h = checkHash(adv.sha256, d.sha256, adv.addonUrl, opts.prior, opts.retrust === true);
      steps.push(step('download', h.ok, `Downloaded the community add-on (${d.bytes} bytes) from ${adv.addonUrl}. ${h.detail}`));
      if (!h.ok) { io.removeDir(root); return out(false, h.changed ? { retrustRequired: true } : {}); }
      const info: ServerSetupInfo = { url: adv.addonUrl, sha256: d.sha256, at: io.now().toISOString(), license: 'MIT' };
      const a = await installAddonHeadless(io, install, root, file, 'legion_community_blender_mcp');
      steps.push(a);
      if (!a.ok) return out(false, { info });
      steps.push(step('config', true, `No MCP entry is needed: Legion talks to the add-on's socket at ${cfg.host}:${cfg.port} directly. Start the add-on's server in Blender (3D View sidebar, BlenderMCP tab) or press Launch.`));
      return out(true, { info, addonInstalled: true });
    }

    // official
    const adv = cfg.advanced.official;
    const archive = join(root, 'server-archive.zip');
    const d = await io.download(adv.sourceUrl, archive, { maxBytes: OFFICIAL_MAX_BYTES });
    const h = checkHash(adv.sha256, d.sha256, adv.sourceUrl, opts.prior, opts.retrust === true);
    steps.push(step('download', h.ok, `Downloaded the official Blender Lab MCP server (${Math.round(d.bytes / 1024)} KB) from ${adv.sourceUrl}. ${h.detail}`));
    if (!h.ok) { io.removeDir(root); return out(false, h.changed ? { retrustRequired: true } : {}); }
    const unpack = join(root, 'server');
    io.removeDir(unpack);
    await io.extract(archive, unpack);
    // an archive usually has one top folder; use it as the server folder
    const top = io.listDir(unpack).filter((n) => io.isDir(join(unpack, n)));
    const serverDir = io.listDir(unpack).length === 1 && top.length === 1 ? join(unpack, top[0]!) : unpack;
    steps.push(step('unpack', true, `Unpacked to ${serverDir}`));
    const addonSrc = join(serverDir, adv.addonPath);
    if (!io.exists(addonSrc)) {
      steps.push(step('addon', false, `The add-on was not found at "${adv.addonPath}" inside the download (found: ${io.listDir(serverDir).slice(0, 12).join(', ') || 'nothing'}). Set blender.advanced.official.addonPath in config.json to the add-on folder or file.`));
      return out(false);
    }
    const info: ServerSetupInfo = { url: adv.sourceUrl, sha256: d.sha256, at: io.now().toISOString(), license: 'GPL-3.0-or-later' };
    const manifest = io.readText(join(addonSrc, EXTENSION_MANIFEST)) ?? (io.exists(join(addonSrc, EXTENSION_MANIFEST)) ? '' : undefined);
    if (manifest !== undefined) {
      const x = await installExtension(io, install, root, addonSrc, manifest);
      steps.push(...x.steps);
      if (!x.ok) return out(false, { info });
    } else {
      const a = await installAddonHeadless(io, install, root, addonSrc, moduleNameFor(adv.addonPath.split(/[\\/]/).filter(Boolean).pop() ?? 'legion_blender_lab'));
      steps.push(a);
      if (!a.ok) return out(false, { info });
    }
    const v = { serverDir, host: cfg.host, port: cfg.port };
    const entry: BlenderEntry = { command: adv.command, args: adv.args.map((x) => subst(x, v)), env: Object.fromEntries(Object.entries(adv.env).map(([k, x]) => [k, subst(x, v)])), serverDir, at: io.now().toISOString() };
    const probe = await io.run(entry.command, ['--version'], 15_000);
    if (!probe) {
      steps.push(step('launcher', false, `"${entry.command}" is not installed or not on PATH. The official server is a Python project started with it. Install it (for uv: docs.astral.sh/uv) or change blender.advanced.official.command.`));
      return out(false, { info, addonInstalled: true });
    }
    steps.push(step('launcher', true, `Launcher "${entry.command}" found.`));
    // lock the server's Python dependencies, where the launcher is uv: later starts then install exactly what the lock file names, hashes included
    const lock = await lockDependencies(io, entry);
    steps.push(lock.step);
    if (lock.args) entry.args = lock.args;
    steps.push(step('config', true, `Saved how to start the server (${entry.command} ${entry.args.join(' ')}). It is kept in Legion's Blender settings, not handed to agents.`));
    return out(true, { info, entry, addonInstalled: true });
  } catch (e) {
    steps.push(step('setup', false, e instanceof Error ? e.message : String(e)));
    return out(false);
  }
}

const isUv = (command: string): boolean => /^uv(\.exe)?$/i.test(command.split(/[\\/]/).pop() ?? '');

/**
 * `uv run` resolves and downloads the server's Python dependencies on its first start and again whenever they change. Where the launcher is uv
 * this locks them: an existing uv.lock is used as is, otherwise `uv lock` creates one now (one download from the package index, hashes recorded),
 * and the saved start command gets --frozen so no later start re-resolves. Not possible for another launcher: said plainly, not hidden.
 */
async function lockDependencies(io: BlenderIo, entry: BlenderEntry): Promise<{ step: BlenderSetupStep; args?: string[] }> {
  if (!isUv(entry.command)) return { step: step('lock', true, `NOT PINNED: "${entry.command}" is not uv, so Legion cannot lock the server's Python dependencies; they are resolved by whatever starts the server.`) };
  if (entry.args.some((a) => a === '--frozen' || a === '--locked')) return { step: step('lock', true, 'The start command already uses --frozen or --locked.') };
  const pi = entry.args.indexOf('--project');
  const project = pi >= 0 && entry.args[pi + 1] ? entry.args[pi + 1]! : entry.serverDir;
  const lockFile = join(project, 'uv.lock');
  const withFrozen = (): string[] => { const i = entry.args.indexOf('run'); return i < 0 ? ['--frozen', ...entry.args] : [...entry.args.slice(0, i + 1), '--frozen', ...entry.args.slice(i + 1)]; };
  if (io.exists(lockFile)) return { step: step('lock', true, `uv.lock found in ${project}: later starts use --frozen, so dependencies are exactly the locked, hash-checked set.`), args: withFrozen() };
  const r = await io.run(entry.command, ['lock', '--project', project], 240_000);
  if (r && r.code === 0 && io.exists(lockFile)) return { step: step('lock', true, `No uv.lock came with the download, so one was created now (dependencies resolved once from the package index, hashes recorded in ${lockFile}). Later starts use --frozen. This pins what was resolved TODAY; it does not prove those packages are the ones the authors tested.`), args: withFrozen() };
  const why = r ? (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' | ').slice(0, 240) : `${entry.command} could not be started`;
  return { step: step('lock', true, `NOT PINNED: could not create uv.lock (${why || 'no output'}). The first start will resolve and download the server's Python dependencies from the package index, unpinned.`) };
}

/** The connection test: a TCP probe of the add-on socket, then connect and a trivial inspect. */
export async function testConnection(probe: (host: string, port: number) => Promise<boolean>, cfg: BlenderConfig, getBackend: () => Promise<BlenderBackend>): Promise<{ ok: boolean; steps: BlenderSetupStep[] }> {
  const steps: BlenderSetupStep[] = [];
  const open = await probe(cfg.host, cfg.port);
  steps.push(step('socket', open, open ? `Something is listening on ${cfg.host}:${cfg.port}` : `Nothing is listening on ${cfg.host}:${cfg.port}. Open Blender and start the add-on's server (3D View sidebar), or press Launch.`));
  if (!open) return { ok: false, steps };
  let b: BlenderBackend;
  try {
    b = await getBackend();
    steps.push(step('connect', true, `Connected through the ${b.kind} backend`));
  } catch (e) {
    steps.push(step('connect', false, e instanceof Error ? e.message : String(e)));
    return { ok: false, steps };
  }
  try {
    const r = await b.inspect({});
    steps.push(step('inspect', r.ok, r.ok ? `Read the scene: ${r.text.replace(/\s+/g, ' ').slice(0, 160)}` : `The scene could not be read: ${r.text.slice(0, 200)}`));
  } catch (e) {
    steps.push(step('inspect', false, `The scene could not be read: ${e instanceof Error ? e.message : String(e)}. The add-on accepted the connection but did not answer; check that its server is running inside Blender.`));
  }
  return { ok: steps.every((s) => s.ok), steps };
}

/** Starts Blender with Legion's fixed start-up expression (community add-on only; the official add-on is started from Blender's sidebar). */
export function launchBlender(io: BlenderIo, cfg: BlenderConfig, install: BlenderInstall | undefined, kind: BlenderBackendKind | null): BlenderSetupStep {
  if (!install) return step('launch', false, 'Blender was not found.');
  try {
    if (kind === 'community') {
      io.spawnDetached(install.path, ['--python-expr', cfg.advanced.community.startExpr]);
      return step('launch', true, `Started Blender ${install.version} and asked the add-on to open its socket at ${cfg.host}:${cfg.port}. Give it a few seconds, then press Test.`);
    }
    io.spawnDetached(install.path, []);
    return step('launch', true, `Started Blender ${install.version}. Start the add-on's server from its sidebar panel, then press Test.`);
  } catch (e) { return step('launch', false, e instanceof Error ? e.message : String(e)); }
}


/**
 * Starts Blender with BOTH add-on servers on their own ports (Use both backends at once). Both ports must be free first (nothing may answer on them),
 * Blender gets BLENDER_MCP_PORT for the official add-on, and a fixed expression sets the community add-on's per-scene port and starts its server.
 * UNVERIFIED (needs a real Blender, check B17): that the official add-on reads BLENDER_MCP_PORT, and that the scene exists when the expression runs.
 * If either assumption is wrong the identity check at connect time says which port answers what, and the owner sets the official port in its panel.
 */
export async function launchBoth(io: BlenderIo, cfg: BlenderConfig, install: BlenderInstall | undefined, probe: (host: string, port: number) => Promise<boolean>): Promise<BlenderSetupStep> {
  if (!install) return step('launch', false, 'Blender was not found.');
  const p = bothPorts(cfg);
  if (!p.ok) return step('launch', false, p.error);
  const free = await ensureFreePorts(cfg.host, p.ports, probe);
  if (!free.ok) return step('launch', false, free.error);
  try {
    io.spawnDetached(install.path, ['--python-expr', `import bpy; bpy.context.scene.blendermcp_port = ${p.ports.community}; bpy.ops.blendermcp.start_server()`], { BLENDER_MCP_PORT: String(p.ports.official), BLENDER_MCP_HOST: cfg.host });
    return step('launch', true, `Started Blender ${install.version}: the community add-on is asked to open port ${p.ports.community}; start the official add-on's server from its sidebar panel on port ${p.ports.official}. Then press Test connection.`);
  } catch (e) { return step('launch', false, e instanceof Error ? e.message : String(e)); }
}
