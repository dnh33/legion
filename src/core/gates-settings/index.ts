/**
 * The gates settings module (spec section 4): the owner's presets per project and for the app, and the one resolver every
 * permission check asks for a run's mode. Routes are admin-only by the gate's default deny (none is a client route).
 * Settings that loosen anything need the app's native confirm (the per-launch native secret) and a key to sign with; without
 * the key only Ask can be stored, so a core without a keystore behaves exactly as 0.3.0 does.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hasSignedGatesFile } from '../../shared/gates-signed.js';
import { dataFolderTargets } from '../exec/canonical-path.js';
import type { ApprovalMode, LegionEvent } from '../../shared/types.js';
import type { CoreModule, ModuleDeps } from '../modules.js';
import { requireDigest, requireNative } from './native.js';
import { baselineMode, effectiveMode } from '../permission-mode.js';
import type { GoalAutonomy, RunMode } from '../permission-mode.js';
import type { ProjectStore } from '../projects/store.js';
import { HttpError } from '../server.js';
import type { Ctx } from '../server.js';
import { DENY_LINE, GATES, NO_SANDBOX_LINE, PRESETS, gateValue } from '../../shared/gates-registry.js';
import type { GateValue, Preset, TrustedFolderRecord } from '../../shared/gates-registry.js';
import { DOCS_HOSTS } from '../../shared/docs-hosts.js';
import { createWebLastUsed } from '../web-hosts.js';
import { plain } from '../folder-trust.js';
import type { WebLastUsed } from '../web-hosts.js';
import { createBuildEdited } from './build-edited.js';
import type { BuildEdited } from './build-edited.js';
import { makeSigner } from './sign.js';
import { modeOf, previewAgentMode } from './agent-mode.js';
import type { AgentModeChange, AgentModeGuard, ModeWorld } from './agent-mode.js';
import { GatesError, GatesStore, PRESET_NAME } from './store.js';
import type { ActivityLog } from '../activity/index.js';
import type { GatesKeyState } from './store.js';

export { GatesStore, GatesError } from './store.js';

export interface ModeResolver {
  /**
   * The mode a tool call is judged by right now (spec 4.2). Called on every call, so a change takes effect on the next one.
   * `startProjectId` is the project the run started in (`job.projectAtStart`, or the helped project for an outside helper), never the live membership: fail closed.
   * `source` is read from disk, so it is not trusted: anything but 'own' or 'project' (absent counts as 'own') gives Ask.
   */
  mode(a: { agentMode: ApprovalMode; source?: unknown; startProjectId?: string; ceiling?: RunMode; goal?: { autonomy: GoalAutonomy; lease?: Preset } }): RunMode;
  /** What the run would be judged by with no presets at all (the would-have-asked comparison). Optional so a bare `{ mode }` stays a resolver. */
  baseline?(a: { agentMode: ApprovalMode; source?: unknown; ceiling?: RunMode }): RunMode;
}
export interface GatesCore {
  store: GatesStore; resolver: ModeResolver;
  /** The value of a gate for a run that started in `startProjectId` (the project's override, else the app's, else the preset's). */
  gate(id: string, startProjectId?: string): GateValue;
  /**
   * True when the owner switched this gate off beyond what the preset already does: its value is off while the preset's own value is on.
   * Bypass has `tool-cards` off by preset, and an agent set to Ask still asks there (the preset moves agents that follow it); an override
   * that turns the cards off is the owner's explicit word for every agent of the project.
   */
  switchedOff(id: string, startProjectId?: string): boolean;
  /** Projects where an agent changed a build or script file and the owner has not yet allowed a build or test command (Smart asks for those). Not a gate: its own store, not signed. */
  buildEdited: BuildEdited;
  /** The owner's keep list for the environment scrub (names, or NAME* prefixes), read from the signed app file. */
  envKeep(): string[];
  /** The folders the owner trusted (real path and fingerprint), from the signed app file. A run is held back unless its folder is here at exactly today's fingerprint. */
  trustedFolders(): TrustedFolderRecord[];
  /** When each approved site was approved and last read (advisory, unsigned): only used to suggest removals. Task 17's web pipeline calls `touch`. */
  webLastUsed: WebLastUsed;
  /** Whether the site list can be written now (it is signed, so this needs the gates key). */
  canAllowHosts(): boolean;
  /**
   * The owner answered "Always allow" on a web card: the site joins the signed site list, like a Settings edit, and gets its approval date.
   * No native confirm here: the card the owner answered is the confirmation. Throws the store's own error when the list cannot be written (no key).
   */
  allowHost(host: string): void;
}

/**
 * `keyring` is the gates key (its own key file; the per-launch secrets change on every start, so they cannot sign files that must
 * survive a restart). It is read once, here, after the launch pipe installed it. No key: no signer, only Ask can be stored.
 * `state()` says whether Electron made the key now (`new`) or it was there before (`old`, `lost`); see the store. A cap file or list
 * entry for a project missing from projects.json is kept: a damaged or edited projects.json must not remove a cap.
 */
export function createGatesCore(o: { dataDir: string; projects?: ProjectStore; keyring?: { get(): Buffer | undefined; state?(): GatesKeyState }; /** The owner's "Also load MCP servers" switch: with it on, a repository's .mcp.json counts as executable content for folder trust. Default: off. */ inheritMcp?: () => boolean }): GatesCore {
  const signer = makeSigner(o.keyring?.get());
  // `unreadable` means a key file that is there and does not open. Electron also sends it when there is no usable key store at all (Linux with
  // no keyring): then no key file was ever made. With no key file and no signed gates file that is a 0.3.4 folder on a system that cannot sign,
  // and it behaves as 0.3.4 did (no key: only Ask can be stored).
  const gatesDir = join(o.dataDir, 'gates');
  let state = o.keyring?.state?.();
  if (state === 'unreadable' && !existsSync(join(o.dataDir, 'gates-key.bin')) && !hasSignedGatesFile(gatesDir)) state = 'new';
  const store = new GatesStore(gatesDir, { allowed: PRESETS, ...(signer ? { signer } : {}), ...(state ? { keyState: state } : {}), ...(o.inheritMcp ? { inheritMcp: o.inheritMcp } : {}) });
  // A source that is neither 'own' nor 'project' (a damaged agent record) fails closed to Ask, before any preset is read.
  const sourceOf = (source: unknown): 'own' | 'project' | undefined => (source === undefined || source === 'own' ? 'own' : source === 'project' ? 'project' : undefined);
  const resolver: ModeResolver = {
    mode({ agentMode, source, startProjectId, ceiling, goal }) {
      const src = sourceOf(source);
      if (!src) return 'ask';
      const ps = startProjectId ? store.project(startProjectId) : undefined;
      return effectiveMode({
        agentMode, source: src, appPreset: store.app().preset ?? 'ask',
        ...(ps ? { project: { ...(ps.preset ? { preset: ps.preset } : {}), limit: ps.limit ?? true } } : {}),
        ...(goal ? { goal } : {}),
        ...(ceiling ? { ceiling } : {}),
      });
    },
    baseline({ agentMode, source, ceiling }) {
      const src = sourceOf(source);
      return src ? baselineMode({ agentMode, source: src, ...(ceiling ? { ceiling } : {}) }) : 'ask';
    },
  };
  const gate = (id: string, startProjectId?: string): GateValue => gateValue(id, { app: store.app(), ...(startProjectId ? { project: store.project(startProjectId) } : {}) });
  const switchedOff = (id: string, startProjectId?: string): boolean => {
    if (gate(id, startProjectId) !== false) return false;
    const def = GATES.find((g) => g.id === id)?.defaults;
    if (!def || def === 'always') return false;
    const preset: Preset = (startProjectId ? store.project(startProjectId).preset : undefined) ?? store.app().preset ?? 'ask';
    return def[preset] !== false;
  };
  const webLastUsed = createWebLastUsed(store.folder);
  const allowHost = (host: string): void => {
    const cur = store.app().allowedHosts ?? [];
    if (cur.includes(host)) return;
    store.patchApp({ allowedHosts: [...cur, host] });
    try { webLastUsed.approved(host); } catch { /* advisory */ }
  };
  return { store, resolver, gate, switchedOff, envKeep: () => [...(store.app().envKeep ?? [])], trustedFolders: () => (store.app().trustedFolders ?? []).map((e) => ({ ...e })), buildEdited: createBuildEdited(store.folder), webLastUsed, canAllowHosts: () => store.canSign(), allowHost };
}

export interface GatesModule extends CoreModule { store: GatesStore; /** The check the agent routes run before they store a change of mode. */ agentMode: AgentModeGuard }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export { requireNative, requireDigest };

const MODES = ['ask', 'auto-edits', 'full'];
function parseModeChange(b: Record<string, unknown>): AgentModeChange {
  const out: AgentModeChange = {};
  if (b.approval !== undefined) { if (typeof b.approval !== 'string' || !MODES.includes(b.approval)) throw new HttpError(400, 'approval must be ask, auto-edits or full'); out.approval = b.approval as AgentModeChange['approval']; }
  if (b.approvalSource !== undefined) { if (b.approvalSource !== 'own' && b.approvalSource !== 'project') throw new HttpError(400, 'approvalSource must be own or project'); out.approvalSource = b.approvalSource; }
  return out;
}

export function createGatesModule(deps: ModuleDeps, opts: { projects: ProjectStore; core: GatesCore; nativeSecret?: string; dataDir?: string; /** Every successful change writes `gate-changed` lines here. */ activity?: ActivityLog }): GatesModule {
  const { store } = opts.core;
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) { if (e instanceof GatesError) throw new HttpError(e.status, e.message); throw e; }
  };
  const emit = (): void => { try { deps.bus.emit({ type: 'gates.updated' }); } catch { /* advisory */ } };
  const must = (id: string | undefined): string => {
    if (!id || !opts.projects.get(id)) throw new HttpError(404, `Unknown project "${String(id).slice(0, 40)}"`);
    return id;
  };
  /** The sentences of a patch, read before it is applied (the store's own wording, so the log says what the dialog said). Empty when it cannot be previewed. */
  const linesOf = (name: string, b: Record<string, unknown>): string[] => {
    try { return store.preview(name, b).lines.filter((l) => l !== DENY_LINE && l !== NO_SANDBOX_LINE && !l.startsWith('The preset is now ')); } catch { return []; }
  };
  /** Sites that joined the approved list since `before` get an approval date (the list only grows through a change the owner confirmed). */
  const stampApproved = (before: readonly string[] | undefined): void => {
    try { for (const h of store.app().allowedHosts ?? []) if (!before?.includes(h)) opts.core.webLastUsed.approved(h); } catch { /* advisory */ }
  };
  const scopeOf = (name: string): string => (name === 'app' ? 'all projects' : `project ${opts.projects.get(name)?.name ?? name}`);
  const logChange = (name: string, headline: string, lines: string[] = []): void => {
    if (!opts.activity) return;
    const projectId = name === 'app' ? undefined : name;
    // the change is already applied: a log problem must never turn it into an error answer
    try { for (const text of [headline, ...lines.slice(0, 8)]) opts.activity.append({ kind: 'gate-changed', text, ...(projectId ? { projectId } : {}), data: { scope: name === 'app' ? 'app' : 'project' } }); } catch { /* logged nothing */ }
  };
  const headlineOf = (name: string, b: Record<string, unknown>): string => {
    const scope = scopeOf(name);
    if ('preset' in b) return `Preset set to ${typeof b.preset === 'string' && b.preset in PRESET_NAME ? PRESET_NAME[b.preset as keyof typeof PRESET_NAME] : 'Per agent'} for ${scope}`;
    if ('trustFolder' in b) return `Folder trusted: ${plain(b.trustFolder, 200)}`;
    if ('untrustFolder' in b) return `Folder no longer trusted: ${plain(b.untrustFolder, 200)}`;
    if ('limit' in b) return `Agent limit turned ${b.limit === false ? 'off' : 'on'} for ${scope}`;
    return `Gate settings changed for ${scope}`;
  };
  /** The presets that decide the mode an agent follows: the app's, and the preset of each project it is in. */
  const worldOf = (agentId: string | undefined): ModeWorld => ({
    appPreset: store.app().preset,
    projects: agentId ? opts.projects.list().filter((p) => p.status !== 'archived' && p.members.includes(agentId)).map((p) => ({ id: p.id, name: p.name, preset: store.project(p.id).preset })) : [],
  });
  const agentMode: AgentModeGuard = {
    check(c, { cur, name, change }) {
      const pv = previewAgentMode({ agentId: cur?.id, name, before: modeOf(cur), change, world: worldOf(cur?.id) });
      if (pv.raises) requireNative(c, opts);
      requireDigest(c, () => pv.digest, pv.raises);
    },
  };
  const body = (c: Ctx): Record<string, unknown> => { if (!isObj(c.body)) throw new HttpError(400, 'JSON object body required'); return c.body; };
  return {
    id: 'gates', store, agentMode,
    // One protected set for the file tools and the shell guard: the gates folder, the key file, config, state and the project list (not agents' workspaces).
    protectedPaths: () => [store.folder, ...(opts.dataDir ? dataFolderTargets(opts.dataDir) : [])],
    routes: (add) => {
      add('GET', '/api/gates/settings', () => store.view(opts.projects.list().map((p) => p.id)));
      // The approved sites with when each was approved and last read, and the built-in docs list. Read-only; admin-only like every gates route.
      add('GET', '/api/gates/web-hosts', () => {
        const dates = opts.core.webLastUsed.get();
        return { allowed: (store.app().allowedHosts ?? []).map((host) => ({ host, ...dates[host] })), builtIn: [...DOCS_HOSTS] };
      });
      // The trusted folders with whether each still fits what it holds today (a changed folder asks again) and a short summary of what it carries. Read-only.
      add('GET', '/api/gates/trusted-folders', () => (store.app().trustedFolders ?? []).map((e) => {
        const scan = store.scan(e.folder);
        return { folder: e.folder, current: scan.digest === e.digest, summary: scan.lines.map((l) => plain(l, 300)), more: scan.more };
      }));
      add('PATCH', '/api/gates/app', (c) => {
        const b = body(c);
        const loosens = store.isLoosening('app', b);
        if (loosens) requireNative(c, opts);
        requireDigest(c, () => wrap(() => store.preview('app', b)).digest, loosens);
        const lines = linesOf('app', b);
        const before = store.app().allowedHosts;
        const r = wrap(() => store.patchApp(b)); stampApproved(before); logChange('app', headlineOf('app', b), lines); emit(); return r;
      });
      add('PATCH', '/api/gates/projects/:id', (c) => {
        const id = must(c.params[0]); const b = body(c);
        const loosens = store.isLoosening(id, b);
        if (loosens) requireNative(c, opts);
        requireDigest(c, () => wrap(() => store.preview(id, b)).digest, loosens);
        const lines = linesOf(id, b);
        const r = wrap(() => store.patchProject(id, b)); logChange(id, headlineOf(id, b), lines); emit(); return r;
      });
      // A file changed outside Legion: Accept applies what is on disk (a loosening, so native only); Keep mine rewrites what the core holds.
      add('POST', '/api/gates/accept/:name', (c) => { requireNative(c, opts); requireDigest(c, () => wrap(() => store.previewAccept(c.params[0] ?? '')).digest, true); const name = c.params[0] ?? ''; const before = store.app().allowedHosts; const r = wrap(() => store.accept(name)); stampApproved(before); logChange(name, `Applied the settings file that changed outside Legion for ${scopeOf(name)}`); emit(); return r; });
      add('POST', '/api/gates/keep/:name', (c) => { const name = c.params[0] ?? ''; wrap(() => store.keepMine(name, opts.projects.list().map((p) => p.id))); logChange(name, `Kept the settings Legion holds for ${scopeOf(name)}`); emit(); return store.view(opts.projects.list().map((p) => p.id)); });
      // What a change would do, in plain sentences, and the digest of the result. The app words its dialog from this and nothing else.
      add('POST', '/api/gates/preview', (c) => {
        const b = body(c);
        if (Object.keys(b).some((k) => k !== 'name' && k !== 'patch' && k !== 'accept')) throw new HttpError(400, 'Only name, patch and accept can be sent.');
        const name = b.name;
        if (typeof name !== 'string') throw new HttpError(400, 'name is required.');
        if (name !== 'app') must(name);
        if (b.accept === true) return wrap(() => store.previewAccept(name));
        if (!isObj(b.patch)) throw new HttpError(400, 'patch must be an object.');
        return wrap(() => store.preview(name, b.patch as Record<string, unknown>));
      });
      // What a change of an agent's mode would do (the app words its dialog from this) and the digest the change must carry. No agentId: a new agent.
      add('POST', '/api/agents/mode-preview', (c) => {
        const b = body(c);
        if (Object.keys(b).some((k) => k !== 'agentId' && k !== 'approval' && k !== 'approvalSource' && k !== 'assumeAppPreset')) throw new HttpError(400, 'Only agentId, approval, approvalSource and assumeAppPreset can be sent.');
        const change = parseModeChange(b);
        // Read-only "what if the app default were this": the first-run screen asks about the default and the agents in ONE dialog, before the default is saved.
        // Nothing is written; the digest of an answer given this way still carries the preset it assumed, so it only fits a save made once that preset stands.
        if (b.assumeAppPreset !== undefined && !(typeof b.assumeAppPreset === 'string' && (PRESETS as readonly string[]).includes(b.assumeAppPreset))) throw new HttpError(400, 'assumeAppPreset must be ask, accept-edits, smart or bypass');
        const cur = b.agentId === undefined ? undefined : deps.store.getAgent(String(b.agentId));
        if (b.agentId !== undefined && !cur) throw new HttpError(404, `Unknown agent "${String(b.agentId).slice(0, 40)}"`);
        const world = worldOf(cur?.id);
        if (b.assumeAppPreset !== undefined) world.appPreset = b.assumeAppPreset as Preset;
        const pv = previewAgentMode({ agentId: cur?.id, name: cur?.name ?? 'This agent', before: modeOf(cur), change, world });
        return { ...pv, agentName: cur?.name ?? '' };
      });
      add('POST', '/api/gates/reload', () => { wrap(() => store.reload()); emit(); return store.view(opts.projects.list().map((p) => p.id)); });
    },
    dispose: async () => { await store.flush(); },
  };
}
