/**
 * "Get the skill finder's model": fetches ONE pinned set of files (FINDER_MODEL_PIN in shared/finder.ts) into
 * <dataDir>/skill-finder/model/<revision>/. Pure orchestration over injected ports, so tests use fakes and never touch a network.
 * The real ports are the Blender ones (blender/system.ts): https and public hosts only, a redirect cap, a size cap, sha256 while streaming.
 *
 * Order, each step stopping the run on failure: the pin is checked (https addresses, 64-character hashes); an install of this
 * revision that is already complete ends the run; the owner approves a card naming the addresses, sizes, hashes, folder and
 * licence (never automatic, never from an agent); each file goes to a staging folder and its sha256 must equal the pin BEFORE
 * the next file starts; then one rename into place and one record. A failure deletes the staging folder and leaves any earlier
 * install and record untouched.
 */
import { join } from 'node:path';
import type { GetBlenderPorts } from '../../blender/get-blender.js';
import { FINDER_MODEL_PIN, finderHostOk } from '../../../shared/finder.js';
import type { FinderModelPin } from '../../../shared/finder.js';

export type GetModelPorts = Pick<GetBlenderPorts, 'mkdirp' | 'exists' | 'readText' | 'writeText' | 'rename' | 'removeDir' | 'removeFile' | 'now'> & {
  /** The Blender download, which also refuses any address (first or redirect) that `urlOk` does not allow. */
  download(url: string, dest: string, opts: { maxBytes: number; urlOk?: (url: string) => boolean }): Promise<{ sha256: string; bytes: number }>;
  /** The size of a file in bytes, or undefined when it is not there. */
  size(p: string): number | undefined;
};

export interface InstalledRecord {
  id: string;
  revision: string;
  files: { name: string; sha256: string; bytes: number }[];
  at: string;
}

/** What the approval card shows. Nothing is downloaded before the owner allows exactly this. */
export interface GetModelApproval {
  id: string;
  revision: string;
  files: { name: string; url: string; bytes: number; sha256: string }[];
  hosts: string[];
  totalMb: number;
  folder: string;
  license: string;
  sources: string[];
  summary: string;
}

export interface ModelStep { step: string; ok: boolean; detail: string }
export interface GetModelResult { ok: boolean; steps: ModelStep[]; installed?: InstalledRecord; denied?: boolean }

const HEX64 = /^[0-9a-f]{64}$/;
const step = (s: string, ok: boolean, detail: string): ModelStep => ({ step: s, ok, detail });

export const finderRoot = (dataDir: string): string => join(dataDir, 'skill-finder');
export const modelDirFor = (dataDir: string, pin: FinderModelPin = FINDER_MODEL_PIN): string => join(finderRoot(dataDir), 'model', pin.revision);
export const installedFile = (dataDir: string): string => join(finderRoot(dataDir), 'installed.json');
export const vectorsFile = (dataDir: string): string => join(finderRoot(dataDir), 'vectors.json');
const partialDir = (dataDir: string): string => join(finderRoot(dataDir), '.partial');

/** Why the pin cannot be used, or '' when it can. */
function pinProblem(pin: FinderModelPin): string {
  if (!pin.files.length) return 'The pin lists no files.';
  for (const f of pin.files) {
    if (!HEX64.test(f.sha256)) return `The hash for ${f.name} is not recorded, so Legion will not download it.`;
    if (!/^https:\/\//i.test(f.url)) return `The address for ${f.name} is not https.`;
    if (!finderHostOk(f.url, pin)) return `The address for ${f.name} is not on an allowed host.`;
    if (!/^[A-Za-z0-9._-]+$/.test(f.name)) return `The file name ${f.name.slice(0, 40)} is not allowed.`;
    if (!Number.isFinite(f.bytes) || f.bytes <= 0) return `The size for ${f.name} is not recorded.`;
  }
  return '';
}

export function approvalFor(pin: FinderModelPin, dataDir: string): GetModelApproval {
  // Rounded to 5 MB: "about" is the honest word, and the exact size of every file is in the list below.
  const mb = Math.round(pin.approxBytes / (1024 * 1024) / 5) * 5;
  const folder = modelDirFor(dataDir, pin);
  const hosts = [...new Set(pin.files.map((f) => new URL(f.url).hostname))];
  const list = pin.files.map((f) => `${f.name}: ${f.url} (${(f.bytes / (1024 * 1024)).toFixed(1)} MB, sha256 ${f.sha256})`).join('; ');
  return {
    id: pin.id, revision: pin.revision,
    files: pin.files.map((f) => ({ name: f.name, url: f.url, bytes: f.bytes, sha256: f.sha256 })),
    hosts, totalMb: mb, folder, license: pin.license, sources: pin.sources,
    summary: `Download the skill finder's language model (${pin.id}, about ${mb} MB to download) from ${hosts.join(' and ')}. `
      + `Legion checks every file against its sha256 before it uses it, and keeps the files in ${folder}. Files: ${list}. `
      + `Licences: ${pin.license} (sources: ${pin.sources.join(', ')}). `
      + 'The model runs on your computer in a helper process that stops when it is idle, and uses about 1 GB of memory while it is active. '
      + 'You can remove it again in Settings.',
  };
}

/** The install on disk, or null. Believed only when the record matches the pin and every pinned file is there with its pinned size. */
export function readInstalled(ports: Pick<GetModelPorts, 'readText' | 'exists' | 'size'>, dataDir: string, pin: FinderModelPin = FINDER_MODEL_PIN): InstalledRecord | null {
  const text = ports.readText(installedFile(dataDir));
  if (!text) return null;
  let o: Partial<InstalledRecord>;
  try { o = JSON.parse(text) as Partial<InstalledRecord>; } catch { return null; }
  if (!o || o.id !== pin.id || o.revision !== pin.revision || !Array.isArray(o.files)) return null;
  const dir = modelDirFor(dataDir, pin);
  if (!pin.files.every((f) => ports.exists(join(dir, f.name)) && ports.size(join(dir, f.name)) === f.bytes)) return null;
  return { id: o.id, revision: o.revision, files: o.files, at: typeof o.at === 'string' ? o.at : '' };
}

export async function getModel(
  ports: GetModelPorts,
  o: { dataDir: string; approve: (a: GetModelApproval) => Promise<boolean>; pin?: FinderModelPin; onProgress?: (done: number) => void },
): Promise<GetModelResult> {
  const pin = o.pin ?? FINDER_MODEL_PIN;
  const steps: ModelStep[] = [];
  const fail = (s: string, d: string): GetModelResult => { steps.push(step(s, false, d)); return { ok: false, steps }; };

  const problem = pinProblem(pin);
  if (problem) return fail('pin', problem);

  const have = readInstalled(ports, o.dataDir, pin);
  if (have) {
    steps.push(step('installed', true, `The model is already installed in ${modelDirFor(o.dataDir, pin)}.`));
    return { ok: true, steps, installed: have };
  }

  const card = approvalFor(pin, o.dataDir);
  let allowed = false;
  try { allowed = await o.approve(card); } catch { allowed = false; }
  if (!allowed) { steps.push(step('approval', false, 'Not approved (or no answer in time). Nothing was downloaded.')); return { ok: false, steps, denied: true }; }
  steps.push(step('approval', true, 'Approved.'));

  const stage = partialDir(o.dataDir);
  const final = modelDirFor(o.dataDir, pin);
  const cleanup = (): void => { try { ports.removeDir(stage); } catch { /* best effort */ } };
  try {
    ports.mkdirp(finderRoot(o.dataDir));
    cleanup();
    ports.mkdirp(stage);
    o.onProgress?.(0);
    for (let i = 0; i < pin.files.length; i++) {
      const f = pin.files[i]!;
      const got = await ports.download(f.url, join(stage, f.name), { maxBytes: f.bytes, urlOk: (u) => finderHostOk(u, pin) });
      if (got.sha256.toLowerCase() !== f.sha256 || got.bytes !== f.bytes) {
        cleanup();
        return fail('hash', `${f.name} does not match the pinned sha256 (got ${got.sha256.slice(0, 12)}..., expected ${f.sha256.slice(0, 12)}...). Nothing was installed.`);
      }
      steps.push(step('download', true, `${f.name}: ${Math.round(got.bytes / 1024)} KB, sha256 matches the pin.`));
      o.onProgress?.((i + 1) / pin.files.length);
    }
    ports.mkdirp(join(finderRoot(o.dataDir), 'model'));
    ports.removeDir(final);
    ports.rename(stage, final);
    const rec: InstalledRecord = {
      id: pin.id, revision: pin.revision, files: pin.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes })), at: ports.now().toISOString(),
    };
    ports.writeText(installedFile(o.dataDir), JSON.stringify(rec, null, 2));
    const installed = readInstalled(ports, o.dataDir, pin);
    if (!installed) return fail('record', 'The files were moved into place but the install could not be recorded.');
    steps.push(step('record', true, `The model is installed in ${final}.`));
    return { ok: true, steps, installed };
  } catch (e) {
    cleanup();
    return fail('error', `${e instanceof Error ? e.message : String(e)} Nothing was installed.`);
  }
}

/** Deletes the model files, the record, any staging folder and the vector cache. The usage record is not touched. */
export function removeModel(ports: Pick<GetModelPorts, 'removeDir' | 'removeFile'>, dataDir: string): void {
  for (const dir of [join(finderRoot(dataDir), 'model'), partialDir(dataDir)]) { try { ports.removeDir(dir); } catch { /* best effort */ } }
  for (const file of [installedFile(dataDir), vectorsFile(dataDir)]) { try { ports.removeFile(file); } catch { /* best effort */ } }
}

/** Total bytes of an installed model, from its record. */
export const installedBytes = (rec: InstalledRecord): number => rec.files.reduce((n, f) => n + (Number.isFinite(f.bytes) ? f.bytes : 0), 0);
