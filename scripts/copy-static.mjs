// Copies non-TS files into dist.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/src/electron', { recursive: true });
cpSync('src/electron/preload.cjs', 'dist/src/electron/preload.cjs');
