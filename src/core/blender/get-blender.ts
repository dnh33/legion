/**
 * "Get Blender for Legion": fetches ONE pinned official portable Blender (MANAGED_BLENDER in shared/blender.ts) into <dataDir>/blender/app/<version>/.
 * Pure orchestration over injected ports (download, zip, file system, approval), so tests use fakes and never touch a network. The real ports are
 * in system.ts, the only file here that may fetch.
 *
 * Order, each step stopping the run on failure: Windows only; a pinned sha256 must exist (otherwise nothing is asked or fetched); the owner approves
 * a card naming the address, size, hash, folder and licence (never automatic, never from an agent); download to a temp file; the sha256 must equal
 * the pin BEFORE anything is unpacked; unpack into a fresh staging folder (zip.ts refuses unsafe paths); the executable must be there; then one
 * rename into place and one record. A failure deletes the staging folder and the archive and leaves any earlier install and record untouched.
 * It never touches a Blender the user installed themselves.
 */
import { join, resolve, sep } from 'node:path';
import type { BlenderSetupStep } from '../../shared/blender.js';
import { MANAGED_BLENDER } from '../../shared/blender.js';
import { extractZip } from './zip.js';
import type { ZipSink, ZipSource } from './zip.js';

export interface ManagedPin {
  version: string; channel: string; platform: string; url: string; sha256: string; approxBytes: number; maxArchiveBytes: number;
  maxUnpackedBytes: number; maxEntries: number; topDir: string; exe: string; license: string; sourceUrl: string;
}

export interface ManagedRecord { version: string; exe: string; sha256: string; url: string; at: string; license: string }
export interface ManagedInstall { version: string; path: string; sha256: string; at: string }

export interface OpenZip { source: ZipSource; close(): void }
export interface GetBlenderPorts {
  platform: NodeJS.Platform;
  download(url: string, dest: string, opts: { maxBytes: number }): Promise<{ sha256: string; bytes: number }>;
  openZip(file: string): OpenZip;
  sink: ZipSink;
  mkdirp(p: string): void;
  exists(p: string): boolean;
  readText(p: string): string | undefined;
  writeText(p: string, t: string): void;
  rename(from: string, to: string): void;
  removeDir(p: string): void;
  removeFile(p: string): void;
  now(): Date;
}

/** What the approval card shows. Nothing is downloaded before the owner allows exactly this. */
export interface GetBlenderApproval { version: string; channel: string; url: string; sha256: string; approxMb: number; folder: string; license: string; sourceUrl: string; summary: string }

export const appDir = (dataDir: string): string => join(dataDir, 'blender', 'app');
export const managedRecordFile = (dataDir: string): string => join(dataDir, 'blender', 'managed.json');
const step = (s: string, ok: boolean, detail: string): BlenderSetupStep => ({ step: s, ok, detail });
const HEX64 = /^[0-9a-f]{64}$/;

/** The hash the download must match: the pin in code, else the one the owner put in config; '' when neither exists. */
export const effectiveSha = (pin: Pick<ManagedPin, 'sha256'>, cfgSha: string): string => (HEX64.test(pin.sha256) ? pin.sha256 : HEX64.test(cfgSha) ? cfgSha : '');

export function approvalFor(pin: ManagedPin, sha: string, dataDir: string): GetBlenderApproval {
  const mb = Math.round(pin.approxBytes / (1024 * 1024));
  const folder = join(appDir(dataDir), pin.version);
  return {
    version: pin.version, channel: pin.channel, url: pin.url, sha256: sha, approxMb: mb, folder, license: pin.license, sourceUrl: pin.sourceUrl,
    summary: `Download Blender ${pin.version} (${pin.channel}, portable, about ${mb} MB) from ${pin.url}. Legion checks it against sha256 ${sha.slice(0, 16)}... before it unpacks anything into ${folder}. `
      + `Blender is ${pin.license}, a separate program (source: ${pin.sourceUrl}). Your own Blender install is not touched.`,
  };
}

/** The managed install on disk, or null. The record is only believed when the executable it names is inside the managed folder and exists. */
export function readManaged(ports: Pick<GetBlenderPorts, 'readText' | 'exists'>, dataDir: string): ManagedInstall | null {
  const text = ports.readText(managedRecordFile(dataDir));
  if (!text) return null;
  let o: Partial<ManagedRecord>;
  try { o = JSON.parse(text) as Partial<ManagedRecord>; } catch { return null; }
  if (!o || typeof o.exe !== 'string' || typeof o.version !== 'string' || !/^\d{1,2}\.\d{1,2}\.\d{1,3}$/.test(o.version)) return null;
  const root = resolve(appDir(dataDir));
  const abs = resolve(root, o.exe);
  if (!abs.startsWith(root + sep) || /(^|[\\/])\.\.([\\/]|$)/.test(o.exe)) return null;
  if (!ports.exists(abs)) return null;
  return { version: o.version, path: abs, sha256: typeof o.sha256 === 'string' ? o.sha256 : '', at: typeof o.at === 'string' ? o.at : '' };
}

export interface GetBlenderResult { ok: boolean; steps: BlenderSetupStep[]; installed?: ManagedInstall; denied?: boolean }

export async function getManagedBlender(
  ports: GetBlenderPorts,
  o: { dataDir: string; cfgSha: string; approve: (a: GetBlenderApproval) => Promise<boolean>; pin?: ManagedPin },
): Promise<GetBlenderResult> {
  const pin = o.pin ?? MANAGED_BLENDER;
  const steps: BlenderSetupStep[] = [];
  const fail = (s: string, d: string): GetBlenderResult => { steps.push(step(s, false, d)); return { ok: false, steps }; };
  if (ports.platform !== pin.platform) return fail('platform', `Legion only fetches the managed Blender for Windows (this is ${ports.platform}). Use "Get full Blender" or install Blender yourself.`);
  const sha = effectiveSha(pin, o.cfgSha);
  if (!sha) return fail('pin', `The hash for Blender ${pin.version} has not been recorded yet, so Legion will not download it. TODO OWNER PC: copy the sha256 of blender-${pin.version}-windows-x64.zip from Blender's checksum file into blender.advanced.managed.sha256 (see docs/BLENDER.md).`);

  const have = readManaged(ports, o.dataDir);
  if (have && have.version === pin.version && have.sha256 === sha) {
    steps.push(step('installed', true, `Blender ${have.version} is already installed for Legion at ${have.path}.`));
    return { ok: true, steps, installed: have };
  }

  const card = approvalFor(pin, sha, o.dataDir);
  let allowed = false;
  try { allowed = await o.approve(card); } catch { allowed = false; }
  if (!allowed) { steps.push(step('approval', false, 'Not approved (or no answer in time). Nothing was downloaded.')); return { ok: false, steps, denied: true }; }
  steps.push(step('approval', true, 'Approved.'));

  const app = appDir(o.dataDir);
  const archive = join(app, `.download-${pin.version}.zip`);
  const stage = join(app, `${pin.version}.partial`);
  const final = join(app, pin.version);
  const cleanup = (): void => { try { ports.removeFile(archive); } catch { /* best effort */ } try { ports.removeDir(stage); } catch { /* best effort */ } };
  try {
    ports.mkdirp(app);
    cleanup();
    const got = await ports.download(pin.url, archive, { maxBytes: pin.maxArchiveBytes });
    if (got.sha256.toLowerCase() !== sha) {
      cleanup();
      return fail('hash', `The download does not match the pinned sha256 (got ${got.sha256.slice(0, 12)}..., expected ${sha.slice(0, 12)}...). Nothing was unpacked or installed.`);
    }
    steps.push(step('download', true, `Downloaded ${Math.round(got.bytes / (1024 * 1024))} MB and the sha256 matches the pin.`));

    const zip = ports.openZip(archive);
    let unpacked: { files: number; bytes: number };
    try {
      unpacked = await extractZip(zip.source, ports.sink, stage, pin.topDir, { maxEntries: pin.maxEntries, maxUnpackedBytes: pin.maxUnpackedBytes });
    } finally { zip.close(); }
    const exeRel = `${pin.topDir}/${pin.exe}`;
    if (!ports.exists(join(stage, pin.topDir, pin.exe))) { cleanup(); return fail('unpack', `Unpacked ${unpacked.files} files but ${exeRel} is not there. Nothing was installed.`); }
    steps.push(step('unpack', true, `Unpacked ${unpacked.files} files (${Math.round(unpacked.bytes / (1024 * 1024))} MB).`));

    ports.removeDir(final);
    ports.rename(stage, final);
    try {
      ports.writeText(join(final, 'LEGION-README.txt'), `This folder was fetched by Legion (Settings, Get Blender for Legion). Blender ${pin.version} is ${pin.license}, a separate program. Source: ${pin.sourceUrl}\nDownloaded from ${pin.url}\nsha256 ${sha}\nThe licence files are inside ${pin.topDir}/. Delete this folder to remove it; Legion never touches a Blender you installed yourself.\n`);
    } catch { /* the readme is a courtesy */ }
    const rec: ManagedRecord = { version: pin.version, exe: `${pin.version}/${exeRel}`, sha256: sha, url: pin.url, at: ports.now().toISOString(), license: pin.license };
    ports.writeText(managedRecordFile(o.dataDir), JSON.stringify(rec, null, 2));
    ports.removeFile(archive);
    const installed = readManaged(ports, o.dataDir);
    if (!installed) return fail('record', 'The files were unpacked but the install could not be recorded.');
    steps.push(step('record', true, `Blender ${pin.version} is installed for Legion at ${installed.path}.`));
    return { ok: true, steps, installed };
  } catch (e) {
    cleanup();
    return fail('error', `${e instanceof Error ? e.message : String(e)} Nothing was installed.`);
  }
}
