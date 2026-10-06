// Copies non-TS files into dist.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { stageLayer } from './stage-layer.mjs';
mkdirSync('dist/src/electron', { recursive: true });
cpSync('src/electron/preload.cjs', 'dist/src/electron/preload.cjs');

// Model context windows (read at runtime by src/core/providers/model-window.ts). Regenerate with
// scripts/scrape-model-windows.mjs; the folder may not exist yet.
if (existsSync('src/core/providers/data')) {
  mkdirSync('dist/src/core/providers/data', { recursive: true });
  for (const f of readdirSync('src/core/providers/data')) {
    if (f.endsWith('.tsv')) cpSync(`src/core/providers/data/${f}`, `dist/src/core/providers/data/${f}`);
  }
}

// Knowledge-graph seed packs (read at runtime by src/core/kg/seed.ts). The folder may not exist yet.
if (existsSync('src/core/kg/seeds')) {
  mkdirSync('dist/src/core/kg/seeds', { recursive: true });
  for (const f of readdirSync('src/core/kg/seeds')) {
    if (f.endsWith('.json')) cpSync(`src/core/kg/seeds/${f}`, `dist/src/core/kg/seeds/${f}`);
  }
}

// The house context layer, staged into dist so a PACKAGED install has it.
//
// This exists because the layer's content lives in the repository root (AGENTS.md, docs/, context/), and CODE_SET --
// the only list an update may replace, and the list release-package.mjs packs -- does not contain any of those paths.
// So a packaged install shipped none of them: the house module started, synced nothing, and handed three tools to
// every agent over an empty layer. Measured on the real v0.2.3-a app.zip: 397 entries, 0 of them under docs/, and
// sync reported 11 of 11 expected files missing.
//
// Adding `docs` to CODE_SET would fix that and ship 85 MB, 66 MB of which is demo video under docs/video-v2. The
// layer needs 110 KB of markdown. So stage exactly the layer into dist, which is already in CODE_SET and already
// shipped: same fix, 785x smaller, and no change to the updater's replace rules -- an update swaps the whole of
// dist, staging included.
//
// These lists must stay identical to SHIPPED_FILES / SHIPPED_DIRS in src/core/house/context.ts, or the layer reports
// files as missing that it can never have. test/house-context.test.ts asserts the two agree.
const LAYER_FILES = [
  'AGENTS.md',
  'CONTEXT.md',
  'docs/SESSION-LOG.md',
  'docs/VERSIONING.md',
  'docs/RELEASE-NOTES.md',
  'docs/ARCHITECTURE.md',
  'docs/TESTING.md',
  'docs/adr/README.md',
];
/**
 * Directories copied whole and RECURSIVELY (scripts/stage-layer.mjs): an ADR is useless without its neighbours, and a skill is
 * `skills/<group>/<name>/SKILL.md` plus its `references/`, which a flat copy would have left out of every packaged install.
 */
const LAYER_DIRS = ['docs/adr', 'context', 'skills'];

const layerOut = 'dist/context-layer';
const { staged, missing } = stageLayer({ files: LAYER_FILES, dirs: LAYER_DIRS, out: layerOut });
if (staged || missing) console.log(`[copy-static] house layer: staged ${staged} file(s) into ${layerOut}${missing ? `, ${missing} missing` : ''}`);
