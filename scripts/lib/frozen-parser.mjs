// Pre-publish gate: the manifest must be accepted by the FROZEN stepping-stone updater's own parser (src/core/updater/manifest.ts as tagged at
// the stone, e.g. v0.3.0) as well as by the current one. That updater can never change, so a manifest it rejects strands every install that
// holds it (for example a fullAsset named for another version: "the full-package asset name is not the expected one").
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { REPO, loadDist } from './release-lib.mjs';

const FILES = ['manifest', 'config', 'semver'];

/** The source of the parser at a git tag: { 'manifest.ts': text, ... }, or undefined when the tag cannot be read. */
export function sourcesFromGit({ tag, repo = REPO }) {
  try {
    return Object.fromEntries(FILES.map((n) => [`${n}.ts`, execFileSync('git', ['-C', repo, 'show', `${tag}:src/core/updater/${n}.ts`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 << 20 })]));
  } catch { return undefined; }
}

async function loadFrozen(sources) {
  const ts = createRequire(join(REPO, 'package.json'))('typescript');
  const dir = mkdtempSync(join(tmpdir(), 'legion-frozen-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const n of FILES) {
      const src = sources[`${n}.ts`];
      if (typeof src !== 'string') throw new Error(`${n}.ts is missing`);
      const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(join(dir, `${n}.js`), js);
    }
    return await import(pathToFileURL(join(dir, 'manifest.js')).href);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Problems (empty = both parsers accept). `label` names the frozen parser in messages ("v0.3.0"). Fails closed when the frozen source cannot be loaded.
 * parseManifest and manifestForUpdater (generation 2, the frozen client) run on the frozen code and on the current code.
 */
export async function frozenParserProblems({ manifestBytes, sources, label }) {
  const out = [];
  let frozen;
  try {
    if (!sources) throw new Error('the source could not be read from git');
    frozen = await loadFrozen(sources);
  } catch (e) { return [`could not load the ${label} parser (${e.message}): the manifest cannot be proven acceptable to the frozen updater`]; }
  const current = await loadDist('src/core/updater/manifest.js');
  for (const [name, mod] of [[`frozen ${label}`, frozen], ['current', current]]) {
    try {
      const m = mod.parseManifest(manifestBytes);
      if (typeof mod.manifestForUpdater === 'function') {
        const v = mod.manifestForUpdater(m, 2);
        if (!v.use) out.push(`the ${name} parser accepts the manifest but offers no update: ${v.reason}`);
      }
    } catch (e) { out.push(`the ${name} parser REJECTS this manifest: ${e.message}`); }
  }
  return out;
}
