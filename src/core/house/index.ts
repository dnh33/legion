/**
 * The house module: the project's own context layer, served to the agents Legion runs.
 *
 * Every agent gets `~/.legion/workspaces/<agentId>` as its working directory, never this repository, so nothing in the
 * repo is in an agent's context and `AGENTS.md` is read by exactly the agents that run in a checkout. This module is
 * the seam that fixes that: on start it copies the shipped layer into `<dataDir>/context` and gives every agent the
 * `legion_house` tools plus the preamble. See docs/adr/0009-house-context-module.md.
 *
 * It is always on. It costs one directory copy at start and five read-only tools per run (recall, read, list, skills,
 * skill). The owner's switches (./switches.ts) decide which files and skills those tools show.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile } from '../../shared/types.js';
import { HttpError } from '../server.js';
import type { CoreModule, ModuleDeps, ModuleJob } from '../modules.js';
import { CONTEXT_DIRNAME, HOUSE_LIMITS, HOUSE_SERVER_NAME, headingOf, listContext, normalisePath, readContextFile, resolveInside } from './context.js';
import { syncContext } from './sync.js';
import type { SyncResult } from './sync.js';
import { adopt, readManifest, trustKind, unadopt } from './trust.js';
import { HOUSE_PREAMBLE, buildHouseServer, drillFilterFor, skillsPreambleLine } from './tools.js';
import { SKILL_NAME_RE } from '../../shared/skill-ids.js';
import { ArmoryInputError, buildSkillMd } from '../armory/files.js';
import { buildCatalog } from '../armory/catalog.js';
import type { CatalogEntry } from '../armory/catalog.js';
import { CATEGORIES, categoryOf, isLocked, isOn, readSwitches, resetSwitches, setSwitch, skillGroupOf, skillRootOf } from './switches.js';
import type { HouseCategory } from './switches.js';
import { allSkills, enabledSkillNames, listSkills, parseFrontmatter } from './skills.js';

export { CONTEXT_DIRNAME, HOUSE_LIMITS, HOUSE_SERVER_NAME, listContext, readContextFile, recallContext, resolveInside } from './context.js';
export { syncContext } from './sync.js';
export { ADOPTED_NAME, MANIFEST_NAME, adopt, isAdopted, isShipped, trustKind, unadopt } from './trust.js';
export type { TrustKind } from './trust.js';
export { HOUSE_PREAMBLE, buildHouseServer, skillsPreambleLine } from './tools.js';
export { SWITCHES_NAME, categoryOf, isLocked, isOn, readSwitches } from './switches.js';
export { allSkills, listSkills, readSkill } from './skills.js';

export interface HouseModuleOptions {
  /** Where the shipped layer is read from. Defaults to the Legion installation root. */
  repoRoot?: string;
  /** Sync at construction (default true). Tests turn it off to control the data directory themselves. */
  syncOnStart?: boolean;
  /** Where Claude Code keeps its files (for promoting a Claude Code skill). Tests set it; default is the real one. */
  claudeHome?: string;
  /** The skill catalog the Armory lists (its cached Claude Code listing included). Promote looks ids up here so it sees the same skills the owner sees. */
  catalog?: () => CatalogEntry[];
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
    const { files, missing } = listContext(root(), { all: true });
    log(`house: context layer ${files.length} file(s) in ${root()}` +
      (missing.length ? `, ${missing.length} expected file(s) missing (${missing.join(', ')})` : '') +
      (res.keptNewer.length ? `, ${res.keptNewer.length} local copy/copies kept because they were newer` : ''));
    return res;
  };

  /**
   * Whether the layer holds anything an agent could usefully read. One call, so the tools and the preamble cannot disagree.
   * It asks the SERVED view: a layer whose every file the owner switched off, and no skill on, has nothing to hand out.
   */
  const hasContent = (): boolean => listContext(root()).files.length > 0 || listSkills(root()).length > 0;

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
      const skills = skillsPreambleLine(enabledSkillNames(root(), drillFilterFor(agent)));
      return `${head}${skills ? `\n${skills}` : ''}${note}`;
    },

    routes(add) {
      // Read-only and admin-gated by the dispatcher: it reports what shipped, which is how the owner tells a broken
      // install from a working one with an empty layer. Trust is per file, because that is the decision the owner makes.
      add('GET', '/api/house', () => {
        // The WHOLE layer, switches included: this is the owner's screen, and an owner must see what is off in order to
        // turn it on. Agents never get this view (listContext without `all`).
        const { files, missing } = listContext(root(), { all: true });
        const state = readSwitches(root());
        const skillInfo = new Map(allSkills(root(), state).map((k) => [k.path.toLowerCase(), k]));
        return {
          root: root(),
          files: files.map((f) => {
            const category = categoryOf(f.path);
            const home = category === 'skills' ? skillRootOf(f.path) : undefined;
            const skill = home ? skillInfo.get(home.toLowerCase()) : undefined;
            const isSkillMd = !!skill && skill.path.toLowerCase() === f.path.toLowerCase();
            const head = headOf(root(), f.path, f.bytes);
            return {
              ...f,
              trust: trustKind(root(), f.path),
              category,
              ...(category === 'skills' ? { group: skillGroupOf(f.path) ?? null, skill: skill?.path ?? null } : {}),
              title: isSkillMd ? (head.name || skill.folder) : head.heading || fileTitle(f.path),
              ...(isSkillMd ? { description: head.description } : {}),
              on: isOn(f.path, state),
              locked: isLocked(f.path),
            };
          }),
          missing,
          synced: synced ? { written: synced.written.length, skipped: synced.skipped.length, keptNewer: synced.keptNewer.length, unchanged: synced.unchanged.length } : null,
        };
      }, 200);

      // One file's text for the owner's screen ("Read it" before switching a skill on). It ignores the switches, because
      // the owner reading a file is not an agent being served one, and it reports the trust state so the screen can say so.
      // Same traversal rule as everything else here; read-only; no tool equivalent.
      add('GET', '/api/house/file', (c) => {
        const rel = requestedPath({ path: c.url.searchParams.get('path') });
        const out = readContextFile(root(), rel, { ignoreSwitches: true });
        // The same messages serve the agents' tool, which tells them to call house_list; this screen has no such tool.
        if (!out.ok) throw new HttpError(out.reason === 'outside' ? 400 : 404, out.message.replace(/ (?:Use|Call) house_list[^.]*\./, ''));
        return { path: out.path, text: out.text, clipped: out.clipped, trust: out.kind };
      }, 200);

      // The switches. Admin-only like adoption (default-deny gate; NOT on the MCP client list) and with no tool
      // equivalent: if a run could flip these, "the owner turned it on" would mean nothing. See ./switches.ts.
      add('POST', '/api/house/switch', (c) => {
        const rel = requestedPath(c.body);
        const want = (c.body as { on?: unknown }).on;
        if (typeof want !== 'boolean') throw new HttpError(400, 'on must be true or false');
        if (!resolveInside(root(), rel)) throw new HttpError(400, 'That path is outside the Doctrine folder.');
        const real = listContext(root(), { all: true }).files.find((f) => f.path.toLowerCase() === rel.toLowerCase());
        if (!real) throw new HttpError(404, `No such file in the Doctrine folder: ${rel}.`);
        const path = real.path;
        if (isLocked(path) && !want) {
          throw new HttpError(400, `${path} is a core rule: every agent reads it first, so it stays on and cannot be switched off.`);
        }
        let target = path;
        if (categoryOf(path) === 'skills') {
          // A skill is switched as a whole, by its SKILL.md; its reference files follow it but cannot be switched themselves.
          const home = skillRootOf(path);
          const skill = home ? allSkills(root()).find((k) => k.path.toLowerCase() === home.toLowerCase()) : undefined;
          if (!skill) throw new HttpError(400, `${path} is not a skill. A skill is a folder with a SKILL.md in it.`);
          // Only the SKILL.md carries the switch. A reference or licence file would otherwise flip the whole skill
          // without saying so, so it is refused and the message names the skill to switch instead.
          if (skill.path.toLowerCase() !== path.toLowerCase()) throw new HttpError(400, `${path} is part of the ${skill.folder} skill; switch the skill instead.`);
          target = skill.path;
        }
        setSwitch(root(), target, want);
        log(`house: owner switched ${target} ${want ? 'on' : 'off'}`);
        return { path: target, on: isOn(target, readSwitches(root())), locked: isLocked(target) };
      }, 200);

      add('POST', '/api/house/switch/reset', (c) => {
        const b = c.body && typeof c.body === 'object' ? (c.body as { category?: unknown; group?: unknown }) : {};
        const hasCat = b.category !== undefined;
        const hasGroup = b.group !== undefined;
        if (hasCat === hasGroup) throw new HttpError(400, 'Give either category or group, not both and not neither.');
        if (hasCat) {
          if (typeof b.category !== 'string' || !(CATEGORIES as readonly string[]).includes(b.category)) {
            throw new HttpError(400, `category must be one of: ${CATEGORIES.join(', ')}.`);
          }
          const reset = resetSwitches(root(), { category: b.category as HouseCategory });
          log(`house: owner reset the ${b.category} switches to their defaults`);
          return { category: b.category, reset };
        }
        if (typeof b.group !== 'string' || !b.group.trim() || /[\\/]/.test(b.group)) throw new HttpError(400, 'group must be a skill group name.');
        const reset = resetSwitches(root(), { group: b.group.trim() });
        log(`house: owner reset the ${b.group} skills to their defaults`);
        return { group: b.group.trim(), reset };
      }, 200);

      // The owner's own drill: written as an owner file under skills/yours/<name>/SKILL.md. It is NOT shipped, so it is untrusted until the
      // owner adopts it (the existing adopt route), and a skill is off until switched on (the existing switch model). Nothing here approves or switches.
      add('POST', '/api/house/drill', (c) => {
        const b = c.body && typeof c.body === 'object' && !Array.isArray(c.body) ? c.body as Record<string, unknown> : null;
        if (!b) throw new HttpError(400, 'JSON object body required');
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        let md: string;
        try {
          md = buildSkillMd({ name, description: String(b.description ?? ''), body: String(b.body ?? ''), ...(typeof b.whenToUse === 'string' ? { whenToUse: b.whenToUse } : {}) });
        } catch (e) {
          if (e instanceof ArmoryInputError) throw new HttpError(e.status, e.message);
          throw e;
        }
        // A name that is taken is refused unless the editor's Edit path says replace. New never overwrites by accident.
        return writeDrill(name, md, b.replace === true);
      }, 200);

      // Removes one of the owner's own drills (the folder under skills/yours). Only that exact shape is accepted, and a file the app shipped is refused.
      // The text comes back so the screen can offer Undo by posting it again with replace. Admin-only like every other write route.
      add('DELETE', '/api/house/drill', (c) => {
        const rel = normalisePath(String(c.url.searchParams.get('path') ?? '').trim());
        const m = /^skills\/yours\/([^/]+)\/SKILL\.md$/.exec(rel);
        if (!m || !SKILL_NAME_RE.test(m[1]!)) throw new HttpError(400, 'Only one of your own drills (skills/yours/<name>/SKILL.md) can be removed here.');
        const abs = resolveInside(root(), rel);
        if (!abs) throw new HttpError(400, 'That path is outside the Doctrine folder.');
        if (rel in readManifest(root())) throw new HttpError(400, 'That drill ships with the app, so it cannot be removed. Switch it off instead.');
        let st; try { st = lstatSync(abs); } catch { throw new HttpError(404, `No drill at ${rel}.`); }
        if (!st.isFile()) throw new HttpError(400, 'That is not a drill file.');
        const text = readFileSync(abs, 'utf8');
        const folder = join(root(), 'skills', 'yours', m[1]!);
        try { if (lstatSync(folder).isSymbolicLink()) throw new HttpError(400, 'That drill folder is a link, so it is not removed here.'); } catch (e) { if (e instanceof HttpError) throw e; }
        rmSync(folder, { recursive: true, force: true });
        log(`house: owner removed drill ${rel}`);
        return { removed: rel, name: m[1]!, text };
      });

      // Copies an Armory skill's SKILL.md into Your drills, as a new owner file: not approved and off. It never approves or switches on, and it
      // copies the text only (a drill is text an agent reads, never run).
      add('POST', '/api/house/drill/promote', (c) => {
        const id = c.body && typeof c.body === 'object' ? (c.body as { armoryId?: unknown }).armoryId : undefined;
        if (typeof id !== 'string' || !id.trim()) throw new HttpError(400, 'armoryId is required');
        const wanted = id.trim();
        const list = opts.catalog ? opts.catalog() : buildCatalog({ dataDir: deps.dataDir, inheritClaudeCode: deps.config?.claude?.inheritClaudeCodeSettings !== false, ...(opts.claudeHome ? { claudeHome: opts.claudeHome } : {}) });
        const entry = list.find((e) => e.id === wanted);
        if (!entry) throw new HttpError(404, 'That skill is not in the Armory any more. Reload the Armory and try again.');
        if (!entry.path) throw new HttpError(400, `${entry.name} is built in to Claude Code and has no text on this computer to copy.`);
        let text: string;
        try { text = readFileSync(entry.path, 'utf8'); } catch { throw new HttpError(404, 'That skill file is not there any more.'); }
        if (text.length > HOUSE_LIMITS.maxFileBytes) throw new HttpError(400, 'That skill is too large to copy into Doctrine.');
        const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
        if (!SKILL_NAME_RE.test(slug)) throw new HttpError(400, 'Could not make a drill name from that skill.');
        return writeDrill(slug, text, false);
      }, 200);

      // The one door to adoption. Reachable only from the app (admin-gated like every other route, and NOT part of the
      // MCP client's short list), and deliberately with no tool equivalent: if a run could call this, "the owner approved
      // it" would mean nothing. The approval is stored as the hash of the bytes approved, so editing the file afterwards
      // makes it untrusted again on its own -- there is no path-shaped grant to inherit. See ADR 0010.
      add('POST', '/api/house/adopt', (c) => {
        const rel = requestedPath(c.body);
        if (!resolveInside(root(), rel)) throw new HttpError(400, 'That path is outside the Doctrine folder.');
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

  /** Writes skills/yours/<name>/SKILL.md. `overwrite` false refuses an existing one (409). The file is the owner's, so it is untrusted and off. */
  function writeDrill(name: string, md: string, overwrite: boolean) {
    const rel = `skills/yours/${name}/SKILL.md`;
    const abs = resolveInside(root(), rel);
    if (!abs) throw new HttpError(400, 'That name does not make a path inside the Doctrine folder.');
    if (!overwrite && existsSync(abs)) throw new HttpError(409, `A drill called ${name} already exists. Edit it, or pick another name.`);
    mkdirSync(join(root(), 'skills', 'yours', name), { recursive: true });
    writeFileSync(abs, md, 'utf8');
    log(`house: owner wrote drill ${rel}`);
    return { path: rel, name, group: 'yours', trust: trustKind(root(), rel), on: isOn(rel, readSwitches(root())) };
  }
}

/** Title for a file with no heading: its file name, without the extension. */
const fileTitle = (path: string): string => (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');

/**
 * The first heading of a markdown file, and a skill's frontmatter name and description, read from the head of the file
 * only: the screen lists every file, and reading all of them whole on each refresh would cost far more than it shows.
 */
function headOf(root: string, rel: string, bytes: number): { heading: string; name: string; description: string } {
  const none = { heading: '', name: '', description: '' };
  if (!rel.toLowerCase().endsWith('.md') || bytes > HOUSE_LIMITS.maxFileBytes) return none;
  const abs = resolveInside(root, rel);
  if (!abs) return none;
  let text = '';
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(bytes, 8192));
    const n = readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, n).toString('utf8');
  } catch {
    return none;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* nothing to release */ } }
  }
  const fm = parseFrontmatter(text);
  const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  let heading = '';
  for (const line of body.split(/\r?\n/)) { heading = headingOf(line); if (heading) break; }
  return { heading, name: fm.name ?? '', description: (fm.description ?? '').replace(/\s+/g, ' ').trim() };
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