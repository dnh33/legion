/**
 * The Armory module: skills your agents can pick up when a task calls for one.
 *
 * Two tiers (docs/adr/0012, claude/plan-armory.md): Doctrine drills are few, trust-checked and served by the house tools; the
 * Armory is the open library, with Claude Code's own semantics. This module:
 * - keeps the Armory store and lists every skill Legion knows (the owner's, imported, Claude Code personal / plugin / built-in);
 * - hands each Claude run an explicit `skills` list (never omitted: omitted means "everything") and the local plugin folder;
 * - classifies a Skill load for taint, and refuses a typed /command for a skill that is off;
 * - serves provider agents the same skills through two read-only tools;
 * - exposes admin-only routes. Never add them to the MCP client list in admin.ts, and no tool changes any of this state.
 * No network and no child process lives here.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile } from '../../shared/types.js';
import { agentSkillsAllow, armoryId, drillId } from '../../shared/skill-ids.js';
import { HttpError } from '../server.js';
import type { CoreModule, ModuleDeps, ModuleJob } from '../modules.js';
import { CONTEXT_DIRNAME } from '../house/context.js';
import { listSkills } from '../house/skills.js';
import { ArmoryInputError, buildSkillMd, prepareImport, reviewImport, sanitizeSkillMd } from './files.js';
import { buildChildEnv, connectorSettings } from '../engine.js';
import { CLI_COMMANDS, THIRD_PARTY, access, buildCatalog, commandOf, groupKindOf, loadTaints, refusedCommand, resolveName } from './catalog.js';
import { deliveryRoot, scanSource, syncDelivery } from './delivery.js';
import { claudeHomeDir, discoverFromSdk } from './discover.js';
import type { DiscoveredSkill } from './discover.js';
import { sdkHandshake } from './handshake.js';
import type { SdkProbe } from './handshake.js';
import type { CatalogEntry } from './catalog.js';
import { armoryDir, readArmoryFile, removeSkillFolder, pluginRoot, sha256Of, updateArmoryFile, writeSkillFolder, STATES } from './store.js';
import type { SkillRecord, SkillState } from './store.js';
import { ARMORY_SERVER_NAME, buildArmoryServer } from './tools.js';

export { ARMORY_SERVER_NAME } from './tools.js';
export { access, buildCatalog, loadTaints, refusedCommand } from './catalog.js';
export type { CatalogEntry } from './catalog.js';

export interface ArmoryOptions {
  /** Where Claude Code keeps its files. Defaults to CLAUDE_CONFIG_DIR, else ~/.claude. Tests always set it. */
  claudeHome?: string;
  /** How long a scan of the disk is reused, ms. Writes through the routes always drop it. Default 5000. */
  ttlMs?: number;
  log?: (m: string) => void;
  /** Lists what the Claude Code SDK loads (handshake.ts). Tests pass a fake: no test ever starts a real Claude Code. */
  sdkProbe?: SdkProbe;
  /** How long a failed listing is kept before the next read tries again, ms. Default 5 minutes. */
  retryMs?: number;
}

/** What the last listing of Claude Code skills found, and how. 'disk-fallback' reads installed_plugins.json and settings.json instead. */
interface Discovery {
  at: string;
  atMs: number;
  mode: 'sdk' | 'disk-fallback';
  reason: string | null;
  /** The inherit switch when it ran: a change of the switch lists again. */
  inherit: boolean;
  /** Present only for 'sdk'. */
  skills?: DiscoveredSkill[];
  /** Present only for 'sdk': the commands of Claude Code itself (not skills, not plugin commands). */
  cli?: Set<string>;
  plugins: number;
}

export interface ArmoryModule extends CoreModule {
  catalog(): CatalogEntry[];
}

/** Settings warns above this many skill descriptions in one agent's prompt. */
export const SKILL_WARN_ABOVE = 40;
/** Most skill ids one bulk state change may carry. */
export const MAX_BULK = 1000;

const MAX_READ = 512_000;

export function createArmoryModule(deps: ModuleDeps, opts: ArmoryOptions = {}): ArmoryModule {
  const log = opts.log ?? (() => undefined);
  const ttl = opts.ttlMs ?? 5000;
  const probe = opts.sdkProbe ?? sdkHandshake;
  const retryMs = opts.retryMs ?? 300_000;
  let cache: { at: number; entries: CatalogEntry[] } | undefined;
  let disc: Discovery | undefined;
  let inflight: Promise<Discovery> | undefined;
  const inherit = (): boolean => deps.config?.claude?.inheritClaudeCodeSettings !== false;
  const drop = (): void => { cache = undefined; };
  const catalog = (): CatalogEntry[] => {
    const now = Date.now();
    if (!cache || ttl <= 0 || now - cache.at > ttl) {
      const fromSdk = disc?.mode === 'sdk' && disc.inherit === inherit() ? disc.skills : undefined;
      cache = { at: now, entries: buildCatalog({ dataDir: deps.dataDir, inheritClaudeCode: inherit(), ...(opts.claudeHome ? { claudeHome: opts.claudeHome } : {}), ...(fromSdk ? { claudeSkills: fromSdk } : {}) }) };
    }
    return cache.entries;
  };

  /** Asks the SDK what it loads and keeps the answer. A failure keeps the disk listing and says why. Runs one at a time. */
  const refresh = (): Promise<Discovery> => {
    if (inflight) return inflight;
    const wasInherit = inherit();
    inflight = (async (): Promise<Discovery> => {
      const base = { at: new Date().toISOString(), atMs: Date.now(), inherit: wasInherit };
      let next: Discovery;
      if (!wasInherit) {
        next = { ...base, mode: 'disk-fallback', reason: 'Claude Code settings are not used by your agents, so no Claude Code skills are listed.', plugins: 0 };
      } else {
        try {
          // The same option set as the catalog probe: no bearer token in the environment, connectors off, the owner's executable, hooks off.
          const snap = await probe({
            inheritClaudeCode: true,
            ...(deps.config ? { env: buildChildEnv(deps.config, { probe: true }), settings: { ...connectorSettings(deps.config, { probe: true }).settings }, ...(deps.config.claude.executablePath ? { executablePath: deps.config.claude.executablePath } : {}) } : {}),
          });
          const skills = discoverFromSdk(claudeHomeDir(opts.claudeHome), snap);
          const skillNames = new Set(snap.skills.map((s) => s.name));
          const cli = new Set(snap.commands.map((c) => c.name.toLowerCase()).filter((n) => !n.includes(':') && !skillNames.has(n)));
          if (snap.modelMessages > 0 || snap.costUsd > 0) log(`armory: WARNING the Claude Code listing saw ${snap.modelMessages} model message(s), cost ${snap.costUsd}`);
          next = { ...base, mode: 'sdk', reason: null, skills, cli, plugins: snap.plugins.length };
          log(`armory: Claude Code lists ${snap.plugins.length} plugin(s) and ${skills.length} skill(s)`);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          next = { ...base, mode: 'disk-fallback', reason: why.slice(0, 300) || 'The Claude Code listing failed.', plugins: 0 };
          log(`armory: Claude Code listing failed, reading the disk instead: ${next.reason}`);
        }
      }
      disc = next;
      drop();
      return next;
    })().finally(() => { inflight = undefined; });
    return inflight;
  };
  /** The first read lists once; after that only a changed inherit switch, or a failed listing older than retryMs, lists again. */
  const ensure = async (): Promise<Discovery> => {
    if (disc && disc.inherit === inherit() && (disc.mode === 'sdk' || !disc.inherit || Date.now() - disc.atMs < retryMs)) return disc;
    return refresh();
  };
  const find = (id: string): CatalogEntry | undefined => catalog().find((e) => e.id === id);
  const owned = (e: CatalogEntry): boolean => e.source === 'yours' || e.source === 'imported';
  let lastForeign = -1;
  const noteForeign = (list: string[]): void => {
    if (list.length === lastForeign) return;
    lastForeign = list.length;
    if (list.length) log(`armory: ${list.length} file(s) in the Armory folder are not skills and are never given to an agent: ${list.slice(0, 8).join(', ')}`);
  };

  const view = (e: CatalogEntry) => ({
    id: e.id, name: e.name, description: e.description, source: e.source,
    groupKind: groupKindOf(e), command: commandOf(e),
    plugin: e.plugin ?? null, state: e.state, stateIsDefault: e.stateIsDefault, agents: e.agents,
    path: e.path, manualOnlyInFrontmatter: e.manualOnlyInFrontmatter, runsCommandsOnLoad: e.runsCommandsOnLoad, hiddenText: e.hiddenText,
    ...(e.fit ? { fit: e.fit } : {}), ...(e.offReason ? { offReason: e.offReason } : {}), ...(e.unsafeReason ? { unsafeReason: e.unsafeReason } : {}),
  });

  const need = (b: unknown): Record<string, unknown> => {
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'JSON object body required');
    return b as Record<string, unknown>;
  };
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof ArmoryInputError) throw new HttpError(e.status, e.message);
      throw e;
    }
  };
  const idOf = (v: unknown): CatalogEntry => {
    if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, 'id is required');
    const e = find(v.trim());
    if (!e) throw new HttpError(404, `No skill with the id ${v.trim().slice(0, 100)}.`);
    return e;
  };

  /** Why a skill cannot be set to this state, or '' when it can. The one rule for the single and the bulk route. */
  const stateRefusal = (e: CatalogEntry, to: SkillState): string =>
    to === 'off' ? '' : e.unsafeReason ? `${e.id} cannot be turned on: its header could not be read safely (${e.unsafeReason}) so Legion does not give it to an agent. Fix or remove it.`
      : e.offReason ? `${e.id} acts on Claude Code itself, so Legion keeps it off. ${e.offReason}` : '';
  /** The record for a skill, keeping the hash that vouches for a skill the owner wrote. */
  const stateRecord = (e: CatalogEntry, to: SkillState, f?: { skills: Record<string, SkillRecord> }): SkillRecord => {
    const sha = f?.skills[e.id]?.sha256;
    return { state: to, source: e.source, ...(e.plugin ? { plugin: e.plugin } : {}), ...(e.agents !== 'all' ? { agents: e.agents } : {}), ...(sha && e.source === 'yours' ? { sha256: sha } : {}) };
  };
  const needState = (v: unknown): SkillState => {
    if (typeof v !== 'string' || !STATES.includes(v as SkillState)) throw new HttpError(400, `state must be one of: ${STATES.join(', ')}`);
    return v as SkillState;
  };

  const mod: ArmoryModule = {
    id: 'armory',
    catalog,

    mcpServers(agent: AgentProfile, job?: ModuleJob): Record<string, McpServerConfig> {
      // Claude agents have the skills natively; only a provider run needs the tools.
      if (job?.runtime !== 'provider') return {};
      return { [ARMORY_SERVER_NAME]: buildArmoryServer(agent, job, catalog) };
    },

    claudeSkills(agent: AgentProfile) {
      const all = catalog();
      // What the SDK is given is built by Legion from the owned skills (sanitised, .md only), never the source folder itself.
      const d = syncDelivery(deps.dataDir, new Set(all.filter((e) => owned(e) && !e.unsafeReason).map((e) => e.name)));
      noteForeign(d.foreign);
      // A bare id also matches `<plugin>:<same name>`: when such a skill is not on for this agent, the bare id stays out of the list.
      const shadowsOff = (e: CatalogEntry): boolean => !e.id.includes(':') && all.some((o) => o.id.includes(':') && o.name === e.id && access(o, agent) !== 'on');
      const skills = all
        .filter((e) => access(e, agent) === 'on' && (!owned(e) || d.delivered.has(e.name)) && !shadowsOff(e))
        .map((e) => e.id);
      return { skills, plugins: d.delivered.size ? [d.root] : [] };
    },

    skillGate(agent: AgentProfile, id: string) {
      const cat = catalog();
      // Matched without regard to case, like the typed /command check: Claude Code may resolve `Update-Config` to `update-config`.
      // An exact id decides alone; a bare name that several skills answer to is refused as ambiguous (same rule as the typed /command).
      const { hits, ambiguous } = resolveName(cat, id);
      const off = `${id || 'That skill'} is off in Legion. The owner can turn it on in Settings → Armory.`;
      if (ambiguous) return ambiguous.replace(/^\//, '');
      if (!hits.length) return off;
      for (const e of hits) {
        const a = access(e, agent);
        if (a === 'off') return off;
        if (a === 'manual') return `${e.id} is set to "Only when I ask" in Legion, so an agent may not load it. The owner can turn it on in Settings → Armory.`;
      }
      return undefined;
    },

    protectedPaths: () => [armoryDir(deps.dataDir)],

    skillShellAllowed: () => readArmoryFile(deps.dataDir).allowSkillShell === true,

    skillLoadTaints: (id: string) => loadTaints(catalog(), id),

    refuseSlashCommand: (agent: AgentProfile, prompt: string) => {
      // Claude Code's own commands: what the SDK listed, plus the constant (a listing can miss a headless command such as /compact)
      const known = disc?.mode === 'sdk' && disc.cli ? new Set([...CLI_COMMANDS, ...disc.cli]) : CLI_COMMANDS;
      return refusedCommand(catalog(), agent, prompt, known);
    },

    routes(add) {
      const overview = () => {
        const all = catalog();
        const file = readArmoryFile(deps.dataDir);
        const byPlugin: Record<string, number> = {};
        for (const e of all) if (e.source === 'claude-plugin' && e.plugin) byPlugin[e.plugin] = (byPlugin[e.plugin] ?? 0) + 1;
        const n = (s: string): number => all.filter((e) => e.source === s).length;
        return {
          inherit: inherit(),
          ccNoticeSeen: file.ccNoticeSeen === true,
          allowSkillShell: file.allowSkillShell === true,
          pluginRoot: pluginRoot(deps.dataDir),
          deliveryRoot: deliveryRoot(deps.dataDir),
          foreignFiles: scanSource(deps.dataDir).foreign.length,
          counts: {
            total: all.length, on: all.filter((e) => e.state === 'on' && !e.offReason).length,
            yours: n('yours'), imported: n('imported'), claudePersonal: n('claude-personal'), claudePlugin: n('claude-plugin'), claudeBuiltin: n('claude-builtin'),
            byPlugin,
          },
          skills: all.map(view),
          discoveredAt: disc?.at ?? null,
          discovery: disc?.mode ?? 'disk-fallback',
          discoveryReason: disc?.reason ?? null,
          discoveryPlugins: disc?.plugins ?? 0,
        };
      };
      // The first read asks Claude Code what it loads (a few seconds); the answer is kept until a refresh.
      add('GET', '/api/armory', async () => { await ensure(); return overview(); });
      // Lists again (a new plugin was installed in Claude Code). Admin-only like every state route: it starts the Claude Code listing.
      add('POST', '/api/armory/refresh', async () => { await refresh(); return overview(); });

      add('POST', '/api/armory/state', (c) => {
        const b = need(c.body);
        const e = idOf(b.id);
        const to = needState(b.state);
        const why = stateRefusal(e, to);
        if (why) throw new HttpError(400, why);
        updateArmoryFile(deps.dataDir, (f) => { f.skills[e.id] = stateRecord(e, to, f); });
        drop();
        log(`armory: owner set ${e.id} ${to}`);
        return view(find(e.id)!);
      });

      // Many skills, one state, ONE write of armory.json (a group switch, Turn all on, and their Undo). Same rules as the route above,
      // applied per id: what cannot change is listed in `refused` with the reason, and the rest still goes through.
      add('POST', '/api/armory/state-bulk', (c) => {
        const b = need(c.body);
        const to = needState(b.state);
        if (!Array.isArray(b.ids) || b.ids.length > MAX_BULK) throw new HttpError(400, `ids must be a list of at most ${MAX_BULK} skill ids`);
        const byId = new Map(catalog().map((e) => [e.id, e] as const));
        const refused: { id: string; reason: string }[] = [];
        const apply: CatalogEntry[] = [];
        for (const raw of [...new Set(b.ids as unknown[])]) {
          const id = typeof raw === 'string' ? raw.trim() : '';
          if (!id) { refused.push({ id: String(raw).slice(0, 100), reason: 'id is required' }); continue; }
          const e = byId.get(id);
          if (!e) { refused.push({ id: id.slice(0, 100), reason: `No skill with the id ${id.slice(0, 100)}.` }); continue; }
          const why = stateRefusal(e, to);
          if (why) refused.push({ id: e.id, reason: why });
          else if (!apply.includes(e)) apply.push(e);
        }
        if (apply.length) {
          updateArmoryFile(deps.dataDir, (f) => { for (const e of apply) f.skills[e.id] = stateRecord(e, to, f); });
          drop();
          log(`armory: owner set ${apply.length} skill(s) ${to}${refused.length ? ` (${refused.length} refused)` : ''}`);
        }
        const now = new Map(catalog().map((e) => [e.id, e] as const));
        return { skills: apply.map((e) => view(now.get(e.id) ?? e)), refused };
      });

      add('POST', '/api/armory/agents', (c) => {
        const b = need(c.body);
        const e = idOf(b.id);
        if (e.offReason) throw new HttpError(400, `${e.id} acts on Claude Code itself, so Legion keeps it off. ${e.offReason}`);
        const a = b.agents;
        let grant: 'all' | string[];
        if (a === 'all') grant = 'all';
        else if (Array.isArray(a) && a.length <= 200 && a.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 80)) grant = [...new Set(a as string[])];
        else throw new HttpError(400, "agents must be 'all' or a list of agent ids");
        updateArmoryFile(deps.dataDir, (f) => {
          const cur = f.skills[e.id];
          f.skills[e.id] = { state: cur && cur.source === e.source ? cur.state : e.state, source: e.source, ...(e.plugin ? { plugin: e.plugin } : {}), agents: grant, ...(cur?.sha256 && e.source === 'yours' ? { sha256: cur.sha256 } : {}) };
        });
        drop();
        return view(find(e.id)!);
      });

      add('POST', '/api/armory/allow-shell', (c) => {
        const b = need(c.body);
        if (typeof b.allow !== 'boolean') throw new HttpError(400, 'allow must be true or false');
        updateArmoryFile(deps.dataDir, (f) => { if (b.allow) f.allowSkillShell = true; else delete f.allowSkillShell; });
        log(`armory: owner ${b.allow ? 'allowed' : 'blocked'} inline shell commands in skills`);
        return { allowSkillShell: b.allow };
      });

      // {seen:false} brings the notice back (Undo of "Turn all on" from the notice). No body, or seen:true, marks it seen.
      add('POST', '/api/armory/notice-seen', (c) => {
        const raw = c.body && typeof c.body === 'object' && !Array.isArray(c.body) ? (c.body as { seen?: unknown }).seen : undefined;
        if (raw !== undefined && typeof raw !== 'boolean') throw new HttpError(400, 'seen must be true or false');
        const seen = raw !== false;
        updateArmoryFile(deps.dataDir, (f) => { f.ccNoticeSeen = seen; });
        return { ccNoticeSeen: seen };
      });

      add('POST', '/api/armory/skill', (c) => wrap(() => {
        const b = need(c.body);
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        const md = buildSkillMd({
          name, description: String(b.description ?? ''), body: String(b.body ?? ''),
          ...(typeof b.whenToUse === 'string' ? { whenToUse: b.whenToUse } : {}),
        });
        const id = armoryId(name);
        const cur = find(id);
        // a record that says 'yours' whose file changed (so it reads as imported) can still be rewritten by the owner here, which vouches for it again
        if (cur && cur.source !== 'yours' && readArmoryFile(deps.dataDir).skills[id]?.source !== 'yours') throw new HttpError(409, `A skill called ${name} is already in the Armory and was not written here. Pick another name, or remove it first.`);
        writeSkillFolder(deps.dataDir, name, { 'SKILL.md': md });
        updateArmoryFile(deps.dataDir, (f) => {
          const rec = f.skills[id];
          f.skills[id] = { state: cur && rec ? rec.state : 'off', source: 'yours', plugin: 'legion-armory', ...(rec?.agents ? { agents: rec.agents } : {}), sha256: sha256Of(md) };
        });
        drop();
        log(`armory: owner ${cur ? 'updated' : 'created'} skill ${id}`);
        return { ...view(find(id)!), created: !cur };
      }), 200);

      add('DELETE', '/api/armory/skill', (c) => {
        const e = idOf(c.url.searchParams.get('id'));
        if (!owned(e)) throw new HttpError(400, 'Only skills in the Armory (yours or imported) can be removed here. A Claude Code skill is managed in Claude Code.');
        let textOut = '';
        try { textOut = readFileSync(e.path!, 'utf8'); } catch { /* removed anyway */ }
        removeSkillFolder(deps.dataDir, e.name);
        updateArmoryFile(deps.dataDir, (f) => { delete f.skills[e.id]; });
        drop();
        log(`armory: owner removed ${e.id}`);
        // the text comes back so the screen can offer Undo by posting it again
        return { ok: true, removed: e.id, source: e.source, text: textOut };
      });

      // `dryRun: true` answers with the review (what is kept, left out and stripped, or why it is refused) and writes nothing. The
      // screen shows it before the owner adds the skill; the security rules (what is stripped, refused, dropped) live only here.
      add('POST', '/api/armory/import', (c) => wrap(() => {
        const body = need(c.body);
        const duplicate = (name: string): string => `A skill called ${name} is already in the Armory. Remove it first, or rename the folder.`;
        if (body.dryRun === true) {
          const r = reviewImport(body);
          const id = r.ok ? armoryId(r.name) : '';
          if (r.ok && find(id)) return { ...r, ok: false, refusal: duplicate(r.name), id };
          return { ...r, id };
        }
        const p = prepareImport(body);
        const id = armoryId(p.name);
        if (find(id)) throw new HttpError(409, duplicate(p.name));
        writeSkillFolder(deps.dataDir, p.name, p.files);
        updateArmoryFile(deps.dataDir, (f) => { f.skills[id] = { state: 'off', source: 'imported', plugin: 'legion-armory' }; });
        drop();
        log(`armory: owner imported ${id} (${Object.keys(p.files).length} file(s), off)`);
        return { id, name: p.name, source: 'imported' as const, state: 'off' as const, kept: Object.keys(p.files).sort(), dropped: p.dropped, stripped: p.stripped };
      }), 200);

      add('GET', '/api/armory/file', (c) => {
        const e = idOf(c.url.searchParams.get('id'));
        if (!e.path) throw new HttpError(404, `${e.id} is built in to Claude Code, so its text is not on this computer.`);
        let size = 0;
        try { size = statSync(e.path).size; } catch { throw new HttpError(404, 'That skill file is not there any more.'); }
        if (size > MAX_READ) throw new HttpError(400, `That skill file is over ${MAX_READ} bytes, so it is not shown.`);
        const raw = readFileSync(e.path, 'utf8');
        // An imported or dropped-in Armory skill is shown as it would be delivered (keys outside the allowlist gone); a header that cannot be read is shown as it is, flagged.
        const san = e.source === 'imported' ? sanitizeSkillMd(raw) : undefined;
        const text = san && san.ok ? san.text : raw;
        return { id: e.id, source: e.source, path: e.path, text, thirdParty: THIRD_PARTY.has(e.source), ...(san && san.ok && san.dropped.length ? { stripped: san.dropped } : {}), ...(e.unsafeReason ? { unsafeReason: e.unsafeReason } : {}) };
      });

      /** What one agent would see. `list` and `entries` are read once by a caller that answers for every agent. */
      const effectiveFor = (agent: AgentProfile, list = listSkills(join(deps.dataDir, CONTEXT_DIRNAME)), entries = catalog()) => {
        const drills = list.map((s) => ({ id: drillId(s.group, s.folder), name: s.name, path: s.path }))
          .filter((d) => agentSkillsAllow(agent.skills, d.id));
        const on = entries.filter((e) => access(e, agent) === 'on');
        const armory = on.filter(owned).map((e) => ({ id: e.id, name: e.name, description: e.description, source: e.source, runsCommandsOnLoad: e.runsCommandsOnLoad }));
        const claudeCode = on.filter((e) => !owned(e)).map((e) => ({ id: e.id, name: e.name, description: e.description, source: e.source, runsCommandsOnLoad: e.runsCommandsOnLoad }));
        const total = drills.length + armory.length + claudeCode.length;
        return {
          agent: agent.id,
          setting: agent.skills ?? 'inherit',
          drills, armory, claudeCode,
          counts: { drills: drills.length, armory: armory.length, claudeCode: claudeCode.length, total },
          warnAbove: SKILL_WARN_ABOVE,
          overBudget: total > SKILL_WARN_ABOVE,
        };
      };
      add('GET', '/api/armory/effective', (c) => {
        const agentId = c.url.searchParams.get('agent') ?? '';
        const agent = deps.store.getAgent(agentId);
        if (!agent) throw new HttpError(404, `Unknown agent "${agentId.slice(0, 80)}"`);
        return effectiveFor(agent);
      });
      // The /names this agent may NOT type, so the composer's / menu offers only what would run. Computed with the same
      // refusedCommand the run uses, so the menu and the refusal cannot disagree. Admin-only (not in CLIENT_ROUTES).
      add('GET', '/api/armory/slash', (c) => {
        const agentId = c.url.searchParams.get('agent') ?? '';
        const agent = deps.store.getAgent(agentId);
        if (!agent) throw new HttpError(404, `Unknown agent "${agentId.slice(0, 80)}"`);
        const entries = catalog();
        const known = disc?.mode === 'sdk' && disc.cli ? new Set([...CLI_COMMANDS, ...disc.cli]) : CLI_COMMANDS;
        const names = new Set<string>([...known]);
        for (const e of entries) { const cmd = commandOf(e); if (cmd) { names.add(cmd.toLowerCase()); names.add(e.name.toLowerCase()); } }
        const refused = [...names].filter((n) => refusedCommand(entries, agent, `/${n}`, known) !== undefined).sort();
        return { agent: agent.id, refused };
      });
      // The counts for every agent in one call: the screen that lists them all asked once per agent (a dozen requests, each re-reading the catalog).
      // Admin-only like the rest of /api/armory (not in CLIENT_ROUTES): the default-deny gate answers a token-only caller 403.
      add('GET', '/api/armory/effective-all', () => {
        const list = listSkills(join(deps.dataDir, CONTEXT_DIRNAME));
        const entries = catalog();
        // Counts only: the screen shows a line per agent, and the full lists (every description) are what /effective?agent= is for.
        return { agents: deps.store.listAgents().map((a) => { const { agent, setting, counts, warnAbove, overBudget } = effectiveFor(a, list, entries); return { agent, setting, counts, warnAbove, overBudget }; }) };
      });
    },
  };
  return mod;
}

