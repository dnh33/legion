import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared by the installer tests that run the real PowerShell scripts. Not a test file itself.
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const procsLib = join(repoRoot, 'scripts', 'lib', 'legion-procs.ps1');

/** Every PowerShell on this machine: Windows PowerShell 5.1 ("powershell") and PowerShell 7 ("pwsh"). */
export function allPowerShells(): string[] {
  const found: string[] = [];
  for (const exe of ['powershell', 'pwsh']) {
    const r = spawnSync(exe, ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) found.push(exe);
  }
  return found;
}

export const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;

export function tempDir(prefix = 'legion-ps-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeFiles(base: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const p = join(base, ...rel.split('/'));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
}

/** Runs a PowerShell script text (after dot-sourcing the helper library) and returns the parsed last stdout line as JSON. */
export function runPs<T>(exe: string, body: string, dir: string, name = 'run.ps1'): T {
  const script = join(dir, name);
  writeFileSync(script, [`. ${q(procsLib)}`, body].join('\n'));
  const r = spawnSync(exe, ['-NoProfile', '-File', script], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${exe} exited ${r.status}: ${r.stderr}${r.stdout}`);
  return JSON.parse(r.stdout.trim().split('\n').pop() as string) as T;
}

/** Async variant for tests that spawn children and must keep the event loop free to reap them. */
export function runPsAsync(exe: string, body: string, dir: string, name = 'run.ps1'): Promise<string> {
  const script = join(dir, name);
  writeFileSync(script, [`. ${q(procsLib)}`, body].join('\n'));
  return new Promise((res, rej) => {
    const c = spawn(exe, ['-NoProfile', '-File', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => { out += String(d); });
    c.stderr.on('data', (d) => { err += String(d); });
    c.on('error', rej);
    c.on('close', (code) => (code === 0 ? res(out.trim().split('\n').pop() as string) : rej(new Error(`${exe} exited ${code}: ${err}${out}`))));
  });
}
