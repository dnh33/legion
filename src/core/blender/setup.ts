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

/** Checks a downloaded file against the pinned hash, or records its hash (trust on first use) and says so. */
function checkHash(pinned: string, got: string): { ok: boolean; detail: string } {
  const p = pinned.trim().toLowerCase();
  if (p) return p === got ? { ok: true, detail: `sha256 matches the pinned value (${got.slice(0, 12)}...)` } : { ok: false, detail: `sha256 ${got.slice(0, 12)}... does not match the pinned ${p.slice(0, 12)}...; the file was not used` };
  return { ok: true, detail: `sha256 ${got} (no pin set: trusted on first use; pin it in blender.advanced to refuse changes)` };
}

function subst(s: string, v: { serverDir: string; host: string; port: number }): string {
  return s.replace(/\{serverDir\}/g, v.serverDir).replace(/\{host\}/g, v.host).replace(/\{port\}/g, String(v.port));
}

/**
 * Sets up the live backend for `kind`. Steps are returned in order and the first failure stops the run (later steps need the earlier ones).
 */
export async function setupLive(io: BlenderIo, cfg: BlenderConfig, dataDir: string, install: BlenderInstall | undefined, kind: BlenderBackendKind): Promise<LiveSetupOutcome> {
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
      const h = checkHash(adv.sha256, d.sha256);
      steps.push(step('download', h.ok, `Downloaded the community add-on (${d.bytes} bytes) from ${adv.addonUrl}. ${h.detail}`));
      if (!h.ok) { io.removeDir(root); return out(false); }
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
    const h = checkHash(adv.sha256, d.sha256);
    steps.push(step('download', h.ok, `Downloaded the official Blender Lab MCP server (${Math.round(d.bytes / 1024)} KB) from ${adv.sourceUrl}. ${h.detail}`));
    if (!h.ok) { io.removeDir(root); return out(false); }
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
    const a = await installAddonHeadless(io, install, root, addonSrc, moduleNameFor(adv.addonPath.split(/[\\/]/).filter(Boolean).pop() ?? 'legion_blender_lab'));
    steps.push(a);
    if (!a.ok) return out(false, { info });
    const v = { serverDir, host: cfg.host, port: cfg.port };
    const entry: BlenderEntry = { command: adv.command, args: adv.args.map((x) => subst(x, v)), env: { ...adv.env }, serverDir, at: io.now().toISOString() };
    const probe = await io.run(entry.command, ['--version'], 15_000);
    if (!probe) {
      steps.push(step('launcher', false, `"${entry.command}" is not installed or not on PATH. The official server is a Python project started with it. Install it (for uv: docs.astral.sh/uv) or change blender.advanced.official.command.`));
      return out(false, { info, addonInstalled: true });
    }
    steps.push(step('launcher', true, `Launcher "${entry.command}" found. The first start also downloads the server's Python dependencies through it (a second download, from the package index).`));
    steps.push(step('config', true, `Saved how to start the server (${entry.command} ${entry.args.join(' ')}). It is kept in Legion's Blender settings, not handed to agents.`));
    return out(true, { info, entry, addonInstalled: true });
  } catch (e) {
    steps.push(step('setup', false, e instanceof Error ? e.message : String(e)));
    return out(false);
  }
}

/** The connection test: a TCP probe of the add-on socket, then connect and a trivial inspect. */
export async function testConnection(probe: (host: string, port: number) => Promise<boolean>, cfg: BlenderConfig, getBackend: () => Promise<BlenderBackend>): Promise<{ ok: boolean; steps: BlenderSetupStep[] }> {
  const steps: BlenderSetupStep[] = [];
  const open = await probe(cfg.host, cfg.port);
  steps.push(step('socket', open, open ? `Something is listening on ${cfg.host}:${cfg.port}` : `Nothing is listening on ${cfg.host}:${cfg.port}. Open Blender and start the add-on's server (3D View sidebar), or press Launch.`));
  if (!open) return { ok: false, steps };
  try {
    const b = await getBackend();
    steps.push(step('connect', true, `Connected through the ${b.kind} backend`));
    const r = await b.inspect({});
    steps.push(step('inspect', r.ok, r.ok ? `Read the scene: ${r.text.replace(/\s+/g, ' ').slice(0, 160)}` : `The scene could not be read: ${r.text.slice(0, 200)}`));
    return { ok: steps.every((s) => s.ok), steps };
  } catch (e) {
    steps.push(step('connect', false, e instanceof Error ? e.message : String(e)));
    return { ok: false, steps };
  }
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

