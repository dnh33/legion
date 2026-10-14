/** Signatures for the repos turned on in Legion (design 6.2). Names are stored lower-case; a corrupt file reads as empty (fail closed). */
import fs from 'node:fs';
import { join } from 'node:path';
import { normRepo } from '../../../shared/github-area.js';
import { validRepoString } from '../../ci/repo.js';

export interface Allowlist { v: 1; ticked: string[]; agentsEnabled: boolean }

export const MAX_TICKED = 500;
const fileOf = (dataDir: string): string => join(dataDir, 'connectors', 'github-repos.json');
const empty = (): Allowlist => ({ v: 1, ticked: [], agentsEnabled: true });

export function readAllowlist(dataDir: string): Allowlist {
  let raw: string;
  try { raw = fs.readFileSync(fileOf(dataDir), 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? empty() : { v: 1, ticked: [], agentsEnabled: false };
  }
  try {
    const j = JSON.parse(raw) as Partial<Allowlist> | null;
    if (!j || j.v !== 1 || !Array.isArray(j.ticked) || typeof j.agentsEnabled !== 'boolean') throw new Error('shape');
    if (j.ticked.length > MAX_TICKED || !j.ticked.every((s) => typeof s === 'string' && validRepoString(s) && s === normRepo(s))) throw new Error('entries');
    return { v: 1, ticked: [...new Set(j.ticked)], agentsEnabled: j.agentsEnabled };
  } catch {
    // corrupt: nothing is ticked and the agents switch is off until the owner saves again
    return { v: 1, ticked: [], agentsEnabled: false };
  }
}

function write(dataDir: string, a: Allowlist): Allowlist {
  const file = fileOf(dataDir); const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(join(dataDir, 'connectors'), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(a, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
  return a;
}

export function setTicked(dataDir: string, fullName: string, on: boolean): Allowlist {
  if (!validRepoString(fullName) || !validRepoString(normRepo(fullName))) throw new Error('not a repository name');
  const name = normRepo(fullName); const cur = readAllowlist(dataDir);
  const set = new Set(cur.ticked);
  if (on) { if (!set.has(name) && set.size >= MAX_TICKED) throw new Error(`at most ${MAX_TICKED} repositories can be turned on`); set.add(name); } else set.delete(name);
  return write(dataDir, { v: 1, ticked: [...set], agentsEnabled: cur.agentsEnabled });
}
export function isTicked(dataDir: string, fullName: string): boolean {
  if (!validRepoString(fullName)) return false;
  return readAllowlist(dataDir).ticked.includes(normRepo(fullName));
}
export function masterOn(dataDir: string): boolean { return readAllowlist(dataDir).agentsEnabled; }
export function setMaster(dataDir: string, on: boolean): Allowlist {
  return write(dataDir, { v: 1, ticked: readAllowlist(dataDir).ticked, agentsEnabled: on });
}
