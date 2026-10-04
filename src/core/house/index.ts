/**
 * The house module: the project's own context layer, served to the agents Legion runs.
 *
 * Every agent gets `~/.legion/workspaces/<agentId>` as its working directory, never this repository, so nothing in the
 * repo is in an agent's context and `AGENTS.md` is read by exactly the agents that run in a checkout. This module is
 * the seam that fixes that: on start it copies the shipped layer into `<dataDir>/context` and gives every agent the
 * `legion_house` tools plus the preamble. See docs/adr/0009-house-context-module.md.
 *
 * It is always on. It costs one directory copy at start and three read-only tools per run.
 */
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile } from '../../shared/types.js';
import type { CoreModule, ModuleDeps, ModuleJob } from '../modules.js';
import { CONTEXT_DIRNAME, HOUSE_SERVER_NAME, listContext } from './context.js';
import { syncContext } from './sync.js';
import type { SyncResult } from './sync.js';
import { HOUSE_PREAMBLE, buildHouseServer } from './tools.js';

export { CONTEXT_DIRNAME, HOUSE_LIMITS, HOUSE_SERVER_NAME, listContext, readContextFile, recallContext, resolveInside } from './context.js';
export { syncContext } from './sync.js';
export { HOUSE_PREAMBLE, buildHouseServer } from './tools.js';

export interface HouseModuleOptions {
  /** Where the shipped layer is read from. Defaults to the Legion installation root. */
  repoRoot?: string;
  /** Sync at construction (default true). Tests turn it off to control the data directory themselves. */
  syncOnStart?: boolean;
  log?: (m: string) => void;
}

export interface HouseModule extends CoreModule {
  /** The context root this module serves. */
  root(): string;
  /** Re-copy the layer. Exposed so the settings screen and tests can force it. */
  sync(): SyncResult;
}

export function createHouseModule(deps: ModuleDeps, opts: HouseModuleOptions = {}): HouseModule {
  const log = opts.log ?? (() => undefined);
  const root = (): string => join(deps.dataDir, CONTEXT_DIRNAME);
  const repoRoot = opts.repoRoot ?? repoRootFromInstall();

  const doSync = (): SyncResult => {
    const res = syncContext(repoRoot, deps.dataDir);
    const { files, missing } = listContext(root());
    log(`house: context layer ${files.length} file(s) in ${root()}` +
      (missing.length ? `, ${missing.length} expected file(s) missing (${missing.join(', ')})` : '') +
      (res.keptNewer.length ? `, ${res.keptNewer.length} local copy/copies kept because they were newer` : ''));
    return res;
  };

  const synced = opts.syncOnStart === false ? null : doSync();

  return {
    id: 'house',

    mcpServers(agent: AgentProfile, job?: ModuleJob): Record<string, McpServerConfig> {
      // Nothing to serve: do not hand out tools that would only ever return "the layer is empty".
      if (!listContext(root()).files.length) return {};
      return { [HOUSE_SERVER_NAME]: buildHouseServer(agent, job, { root }) };
    },

    preamble(agent: AgentProfile): string {
      const { files } = listContext(root());
      if (!files.length) return '';
      const head = HOUSE_PREAMBLE;
      const note = agent.approval === 'ask'
        ? ''
        : ' You run with less friction than the others, and the house rules still do not widen it.';
      return `${head}${note}`;
    },

    routes(add) {
      // Read-only and admin-gated by the dispatcher: it reports what shipped, which is how the owner tells a broken
      // install from a working one with an empty layer.
      add('GET', '/api/house', () => {
        const { files, missing } = listContext(root());
        return { root: root(), files, missing, synced: synced ? { written: synced.written.length, skipped: synced.skipped.length, keptNewer: synced.keptNewer.length, unchanged: synced.unchanged.length } : null };
      }, 200);
    },

    sync: doSync,
    root,
  };
}

/**
 * The installation root, derived the way the updater derives it: `dist/src/core/house` sits three levels below the
 * install root in a packaged build. In a dev checkout this points at the repo, which is what we want.
 *
 * `fileURLToPath`, never `new URL(...).pathname`: on Windows the latter yields `/D:/bots/...`, which resolves to the
 * wrong drive and silently syncs nothing. That is the first entry in CLAUDE.md's Windows lessons, hit on the way in.
 */
function repoRootFromInstall(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const idx = here.lastIndexOf(`${sep}dist${sep}`);
  if (idx <= 0) return process.cwd();
  const root = here.slice(0, idx);
  return root || process.cwd();
}