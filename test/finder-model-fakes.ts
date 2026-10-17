/** Shared fakes for the finder model tests: a tiny pin and an in-memory disk behind the download ports. */
import { createHash } from 'node:crypto';
import type { GetModelPorts } from '../src/core/armory/finder/get-model.js';
import type { FinderModelPin } from '../src/shared/finder.js';

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
export const CONTENT: Record<string, string> = { 'a.mjs': 'runtime code', 'b.wasm': 'wasm bytes', 'm.onnx': 'model bytes' };
export const PIN: FinderModelPin = {
  id: 'test-model', revision: 'rev1', license: 'MIT', approxBytes: 100, sources: ['https://example.com/src'],
  allowedHosts: ['cdn.example.com', 'models.example.com'],
  files: [
    { name: 'a.mjs', url: 'https://cdn.example.com/a.mjs', bytes: CONTENT['a.mjs']!.length, sha256: sha(CONTENT['a.mjs']!), role: 'runtime' },
    { name: 'b.wasm', url: 'https://cdn.example.com/b.wasm', bytes: CONTENT['b.wasm']!.length, sha256: sha(CONTENT['b.wasm']!), role: 'runtime' },
    { name: 'm.onnx', url: 'https://models.example.com/m.onnx', bytes: CONTENT['m.onnx']!.length, sha256: sha(CONTENT['m.onnx']!), role: 'model' },
  ],
};

/** An in-memory disk. Directories are prefixes; rename moves every key under the prefix. */
export function fakePorts(over: { serve?: (url: string) => string } = {}) {
  const files = new Map<string, string>();
  const log: string[] = [];
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const ports: GetModelPorts = {
    async download(url, dest) {
      log.push(`download ${url}`);
      const name = url.split('/').pop()!;
      const text = over.serve ? over.serve(url) : CONTENT[name]!;
      files.set(norm(dest), text);
      return { sha256: sha(text), bytes: text.length };
    },
    mkdirp: () => undefined,
    exists: (p) => { const n = norm(p); return files.has(n) || [...files.keys()].some((k) => k.startsWith(`${n}/`)); },
    readText: (p) => files.get(norm(p)),
    size: (p) => files.get(norm(p))?.length,
    writeText: (p, t) => { files.set(norm(p), t); },
    rename(from, to) {
      const f = norm(from); const t = norm(to);
      for (const k of [...files.keys()]) if (k === f || k.startsWith(`${f}/`)) { files.set(t + k.slice(f.length), files.get(k)!); files.delete(k); }
    },
    removeDir(p) { const n = norm(p); for (const k of [...files.keys()]) if (k === n || k.startsWith(`${n}/`)) files.delete(k); },
    removeFile(p) { files.delete(norm(p)); },
    now: () => new Date('2026-10-17T10:00:00Z'),
  };
  return { ports, files, log, keys: () => [...files.keys()].sort() };
}

