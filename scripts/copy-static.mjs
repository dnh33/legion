// Copies non-TS files into dist.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
mkdirSync('dist/src/electron', { recursive: true });
cpSync('src/electron/preload.cjs', 'dist/src/electron/preload.cjs');

// Knowledge-graph seed packs (read at runtime by src/core/kg/seed.ts). The folder may not exist yet.
if (existsSync('src/core/kg/seeds')) {
  mkdirSync('dist/src/core/kg/seeds', { recursive: true });
  for (const f of readdirSync('src/core/kg/seeds')) {
    if (f.endsWith('.json')) cpSync(`src/core/kg/seeds/${f}`, `dist/src/core/kg/seeds/${f}`);
  }
}
