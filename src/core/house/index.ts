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
import { HttpError } from '../server.js';
import type { CoreModule, ModuleDeps, ModuleJob } from '../modules.js';
import { CONTEXT_DIRNAME, HOUSE_SERVER_NAME, listContext, normalisePath, resolveInside } from './context.js';
import { syncContext } from './sync.js';
import type { SyncResult } from './sync.js';
import { adopt, trustKind, unadopt } from './trust.js';
import { HOUSE_PREAMBLE, buildHouseServer } from './tools.js';

export { CONTEXT_DIRNAME, HOUSE_LIMITS, HOUSE_SERVER_NAME, listContext, readContextFile, recallContext, resolveInside } from './context.js';
export { syncContext } from './sync.js';
export { ADOPTED_NAME, MANIFEST_NAME, adopt, isAdopted, isShipped, trustKind, unadopt } from './trust.js';
export type { TrustKind } from './trust.js';
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
  /**
   * Whether the layer holds any file an agent could read.
   *
   * Not a guess from the sync result: it asks the layer, so a note the owner dropped in counts and a layer holding only
   * the trust manifests does not. The tools and the preamble both go through this, so they can never disagree about
   * whether there is anything to serve.
   */
  hasContent(): boolean;
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

  /** Whether the layer holds anything an agent could usefully read. One call, so the tools and the preamble cannot disagree. */
  const hasContent = (): boolean => listContext(root()).files.length > 0;

  const synced = opts.syncOnStart === false ? null : doSync();

  return {
    id: 'house',
    hasContent,

    mcpServers(agent: AgentProfile, job?: ModuleJob): Record<string, McpServerConfig> {
      // Nothing to serve: do not hand out tools that would only ever return "the layer is empty".
      // `listContext` skips the trust manifests, so a layer holding only `.shipped.json` correctly counts as empty.
      if (!this.hasContent()) return {};
      return { [HOUSE_SERVER_NAME]: buildHouseServer(agent, job, { root }) };
    },

    preamble(agent: AgentProfile): string {
      if (!this.hasContent()) return '';
      const head = HOUSE_PREAMBLE;
      const note = agent.approval === 'ask'
        ? ''
        : ' You run with less friction than the others, and the house rules still do not widen it.';
      return `${head}${note}`;
    },

    routes(add) {
      // Read-only and admin-gated by the dispatcher: it reports what shipped, which is how the owner tells a broken
      // install from a working one with an empty layer. Trust is per file, because that is the decision the owner makes.
      add('GET', '/api/house', () => {
        const { files, missing } = listContext(root());
        return {
          root: root(),
          files: files.map((f) => ({ ...f, trust: trustKind(root(), f.path) })),
          missing,
          synced: synced ? { written: synced.written.length, skipped: synced.skipped.length, keptNewer: synced.keptNewer.length, unchanged: synced.unchanged.length } : null,
        };
      }, 200);

      // The one door to adoption. Reachable only from the app (admin-gated like every other route, and NOT part of the
      // MCP client's short list), and deliberately with no tool equivalent: if a run could call this, "the owner approved
      // it" would mean nothing. The approval is stored as the hash of the bytes approved, so editing the file afterwards
      // makes it untrusted again on its own -- there is no path-shaped grant to inherit. See ADR 0010.
      add('POST', '/api/house/adopt', (c) => {
        const rel = requestedPath(c.body);
        if (!resolveInside(root(), rel)) throw new HttpError(400, 'That path is outside the house context folder.');
        const hash = adopt(root(), rel);
        if (!hash) throw new HttpError(404, `No readable file at ${rel}.`);
        log(`house: owner adopted ${rel} (${hash.slice(0, 12)})`);
        return { path: rel, trust: 'adopted' as const, sha256: hash };
      }, 200);

      add('POST', '/api/house/unadopt', (c) => {
        const rel = requestedPath(c.body);
        const removed = unadopt(root(), rel);
        if (removed) log(`house: owner withdrew approval for ${rel}`);
        // Report what it is NOW, not just that an approval went away: withdrawing an approval from a file whose bytes
        // still match what the app shipped leaves it trusted, and saying "untrusted" here would be a lie.
        return { path: rel, trust: trustKind(root(), rel), approvalRemoved: removed };
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

/**
 * The layer path from a request body, normalised, or a 400.
 *
 * Only the string is validated here. Whether it names a real file inside the context folder is `resolveInside`'s and
 * `adopt`'s answer, and the adopt route refuses a path that resolves outside rather than normalising it into something
 * that happens to land inside.
 */
function requestedPath(body: unknown): string {
  const raw = body && typeof body === 'object' ? (body as { path?: unknown }).path : undefined;
  const path = typeof raw === 'string' ? normalisePath(raw.trim()) : '';
  if (!path) throw new HttpError(400, 'path is required');
  return path;
}