/**
 * "Get Lightpanda for Legion": fetches ONE pinned release asset into <dataDir>/browser/app/<id>/. Pure orchestration over injected ports
 * (tests use fakes and never touch a network; the real ports are in system.ts). Same order as Blender's B4:
 * platform has a pin; a sha256 must exist (else nothing is asked or fetched); the owner approves a card naming address, size, hash, folder and
 * licence; download to a .part file; the sha256 must equal the pin BEFORE the file is made executable or renamed into place; one record.
 * Any failure removes the partial file and leaves an earlier install untouched. Lightpanda is AGPL-3.0: Legion never bundles it.
 */
import { join, resolve, sep } from 'node:path';
import type { BrowserPin } from '../../shared/browser.js';

export interface GetStep { step: string; ok: boolean; detail: string }
export interface GetPorts {
  platformKey: string;
  download(url: string, dest: string, opts: { maxBytes: number }): Promise<{ sha256: string; bytes: number }>;
  mkdirp(p: string): void;
  exists(p: string): boolean;
  readText(p: string): string | undefined;
  writeText(p: string, t: string): void;
  rename(a: string, b: string): void;
  removeFile(p: string): void;
  removeDir(p: string): void;
  makeExecutable(p: string): void;
  hashFile(p: string): Promise<string>;
  now(): Date;
}
export interface GetApproval { id: string; url: string; sha256: string; approxMb: number; folder: string; license: string; sourceUrl: string; summary: string }
export interface ManagedRecord { id: string; exe: string; sha256: string; url: string; at: string; license: string }
export interface ManagedInstall { id: string; path: string; sha256: string }

const HEX64 = /^[0-9a-f]{64}$/;
export const appDir = (dataDir: string): string => join(dataDir, 'browser', 'app');
export const recordFile = (dataDir: string): string => join(dataDir, 'browser', 'managed.json');
export const effectiveSha = (pin: Pick<BrowserPin, 'sha256'>, cfgSha: string | undefined): string => (HEX64.test(pin.sha256) ? pin.sha256 : cfgSha && HEX64.test(cfgSha) ? cfgSha : '');

export function approvalFor(pin: BrowserPin, sha: string, dataDir: string): GetApproval {
  const mb = Math.round(pin.approxBytes / (1024 * 1024));
  const folder = join(appDir(dataDir), pin.id);
  return {
    id: pin.id, url: pin.url, sha256: sha, approxMb: mb, folder, license: pin.license, sourceUrl: pin.sourceUrl,
    summary: `Download Lightpanda (${pin.id}, about ${mb} MB) from ${pin.url}. Legion checks it against sha256 ${sha.slice(0, 16)}... before it makes it runnable in ${folder}. `
      + `Lightpanda is ${pin.license}, a separate program (source: ${pin.sourceUrl}); Legion does not include it. Agents will be able to read web pages through it after you switch the browser tool on.`,
  };
}

/** The install on disk, or null. The record is believed only when the executable it names is inside the managed folder and exists. */
export function readManaged(ports: Pick<GetPorts, 'readText' | 'exists'>, dataDir: string): (ManagedInstall & { recordSha: string }) | null {
  const text = ports.readText(recordFile(dataDir));
  if (!text) return null;
  let o: Partial<ManagedRecord>;
  try { o = JSON.parse(text) as Partial<ManagedRecord>; } catch { return null; }
  if (!o || typeof o.exe !== 'string' || typeof o.id !== 'string' || !/^[a-z0-9-]{3,40}$/.test(o.id)) return null;
  const root = resolve(appDir(dataDir));
  const abs = resolve(root, o.exe);
  if (!abs.startsWith(root + sep) || /(^|[\\/])\.\.([\\/]|$)/.test(o.exe)) return null;
  if (!ports.exists(abs)) return null;
  return { id: o.id, path: abs, sha256: typeof o.sha256 === 'string' ? o.sha256 : '', recordSha: typeof o.sha256 === 'string' ? o.sha256 : '' };
}

/** Tamper check before every start of a managed binary: the file on disk must still hash to the recorded value. */
export async function verifyManaged(ports: Pick<GetPorts, 'hashFile'>, m: ManagedInstall): Promise<boolean> {
  if (!HEX64.test(m.sha256)) return false;
  try { return (await ports.hashFile(m.path)).toLowerCase() === m.sha256; } catch { return false; }
}

export async function getLightpanda(
  ports: GetPorts,
  o: { dataDir: string; cfgSha?: string; pins: BrowserPin[]; approve: (a: GetApproval) => Promise<boolean> },
): Promise<{ ok: boolean; steps: GetStep[]; installed?: ManagedInstall; denied?: boolean }> {
  const steps: GetStep[] = [];
  const fail = (s: string, d: string) => { steps.push({ step: s, ok: false, detail: d }); return { ok: false, steps }; };
  const pin = o.pins.find((p) => p.platform === ports.platformKey);
  if (!pin) return fail('platform', `Lightpanda has no build for this system (${ports.platformKey}). On Windows install it inside WSL and set the launcher in Settings, or point Legion at your own copy.`);
  const sha = effectiveSha(pin, o.cfgSha);
  if (!sha) return fail('pin', `The hash for ${pin.id} has not been recorded yet, so Legion will not download it. TODO OWNER PC: pick a release, compute its sha256 and put it in the browser setting managedSha256 (see claude/plan-browser.md).`);

  const have = readManaged(ports, o.dataDir);
  if (have && have.id === pin.id && have.sha256 === sha) {
    if (await verifyManaged(ports, have)) { steps.push({ step: 'installed', ok: true, detail: `Lightpanda ${pin.id} is already installed for Legion at ${have.path}.` }); return { ok: true, steps, installed: have }; }
  }

  const card = approvalFor(pin, sha, o.dataDir);
  let allowed = false;
  try { allowed = await o.approve(card); } catch { allowed = false; }
  if (!allowed) { steps.push({ step: 'approval', ok: false, detail: 'Not approved (or no answer in time). Nothing was downloaded.' }); return { ok: false, steps, denied: true }; }
  steps.push({ step: 'approval', ok: true, detail: 'Approved.' });

  const dir = join(appDir(o.dataDir), pin.id);
  const part = join(appDir(o.dataDir), `.download-${pin.id}.part`);
  const stage = join(appDir(o.dataDir), `${pin.id}.partial`);
  const cleanup = () => { try { ports.removeFile(part); } catch { /* best effort */ } try { ports.removeDir(stage); } catch { /* best effort */ } };
  try {
    ports.mkdirp(appDir(o.dataDir));
    cleanup();
    const got = await ports.download(pin.url, part, { maxBytes: pin.maxBytes });
    if (got.sha256.toLowerCase() !== sha) { cleanup(); return fail('hash', `The download does not match the pinned sha256 (got ${got.sha256.slice(0, 12)}..., expected ${sha.slice(0, 12)}...). Nothing was installed.`); }
    steps.push({ step: 'download', ok: true, detail: `Downloaded ${Math.round(got.bytes / (1024 * 1024))} MB and the sha256 matches the pin.` });
    // only now does the file become a program
    ports.mkdirp(stage);
    ports.rename(part, join(stage, pin.exe));
    ports.makeExecutable(join(stage, pin.exe));
    ports.removeDir(dir);
    ports.rename(stage, dir);
    try { ports.writeText(join(dir, 'LEGION-README.txt'), `Fetched by Legion (Settings, Browser, Get Lightpanda). Lightpanda is ${pin.license}, a separate program. Source: ${pin.sourceUrl}\nDownloaded from ${pin.url}\nsha256 ${sha}\nDelete this folder to remove it; Legion never touches a copy you installed yourself.\n`); } catch { /* courtesy */ }
    const rec: ManagedRecord = { id: pin.id, exe: `${pin.id}/${pin.exe}`, sha256: sha, url: pin.url, at: ports.now().toISOString(), license: pin.license };
    ports.writeText(recordFile(o.dataDir), JSON.stringify(rec, null, 2));
    const installed = readManaged(ports, o.dataDir);
    if (!installed) return fail('record', 'The file was installed but could not be recorded.');
    steps.push({ step: 'record', ok: true, detail: `Lightpanda ${pin.id} is installed for Legion at ${installed.path}.` });
    return { ok: true, steps, installed };
  } catch (e) {
    cleanup();
    return fail('error', `${e instanceof Error ? e.message : String(e)} Nothing was installed.`);
  }
}
