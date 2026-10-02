/** The provider runtime: which model values mean a provider, running one provider turn for the engine, and the views Settings shows. */
import { scrubSecrets } from '../comms/scrub.js';
import { listModelIds } from './openai-compat.js';
import type { chatTurn } from './openai-compat.js';
import { ProviderHttpError } from './http.js';
import type { HttpLimits, ProviderTarget } from './http.js';
import { checkEndpoint } from './endpoint.js';
import { PRESET_IDS, PROVIDER_PRESETS } from './presets.js';
import { PROVIDER_ID_RE } from './config.js';
import type { ProviderKeys } from './secrets.js';
import { runToolLoop } from './tool-loop.js';
import { TokenLedger } from './usage.js';
import { providersExperimental } from './flag.js';
import { createProcessPort } from './proc.js';
import type { ProcessPort } from './proc.js';
import { runCli } from './cli.js';
import { homedir } from 'node:os';
import type { ProviderEntry, ProviderHost, ProviderRunResult, ProvidersConfig, ResolvedModel } from './types.js';
import type { ProviderView, ProvidersView } from '../../shared/providers-view.js';
import { CLI_WARNING, ROOM_BUDGET_NOTE } from '../../shared/providers-view.js';
import type { McpServerEntry } from '../../shared/types.js';
import { isStdioEntry, stdioCommandLine, stdioFingerprint } from './stdio-allow.js';

export interface RuntimeDeps {
  /** Live: Settings edits replace `providers` on this object. */
  config: { providers: ProvidersConfig; mcpServers?: Record<string, McpServerEntry>; workspaceDir?: string; experimental?: { providers?: boolean } };
  /** Legion's data folder (a CLI run may not work inside it, except in an agent's workspace). */
  dataDir?: string;
  /** Tests only. */
  home?: string; appRoots?: string[]; cliSource?: Record<string, string | undefined>;
  keys: ProviderKeys;
  /** Tests only. */
  limits?: Partial<HttpLimits>;
  turn?: typeof chatTurn;
  /** Where the per-day token counts are kept (absent: in memory only). */
  usageFile?: string;
  /** Tests only: the clock. */
  now?: () => Date;
  /** Tests only: the process port a CLI run uses. */
  cliPort?: ProcessPort;
}

export type { ProviderView, ProvidersView } from '../../shared/providers-view.js';

/** What a provider-run agent cannot do, in the words the UI shows. */
export const PROVIDER_LIMITS_TEXT: string[] = [
  'No file editing, shell, web search or web fetch of its own. It gets Legion\'s own tools (agents, kg, comms, Blender, BSV status, and the VM tools when the agent has a VM) and the MCP servers you enabled for the agent.',
  'No Claude Code skills, plugins, slash commands, sub-agents, plan mode or claude.ai connectors.',
  'Your MCP servers run under stricter rules than for Claude: an approval card for each tool call (unless the agent is on full access), the run counts as touching outside content, a local server starts with a small environment instead of Legion\'s own, and a server address must be https or this computer.',
  'A continued task remembers less than a resumed Claude session (the newest messages only).',
  'Tool use is only as reliable as the model; some models, especially small local ones, cannot call tools at all.',
  'Cost is shown only when the provider returns token counts and you entered prices; otherwise it is unknown.',
];

export { ROOM_BUDGET_NOTE };
export { CLI_WARNING };

/** `<provider>:<model>` shape check only (a Bedrock ARN is not one). Whether the provider exists is the runtime's business. */
const PREFIX_RE = /^([a-z][a-z0-9-]{1,31}):(.+)$/;
export function providerPrefix(model: string | undefined): string | undefined {
  const m = typeof model === 'string' ? PREFIX_RE.exec(model) : null;
  return m && m[1] !== 'arn' ? m[1] : undefined;
}

export class ProviderRuntime {
  private readonly tests = new Map<string, { at: string; ok: boolean; detail: string }>();
  private readonly fetched = new Map<string, string[]>();
  readonly usage: TokenLedger;
  constructor(readonly deps: RuntimeDeps) { this.usage = new TokenLedger(deps.usageFile, deps.now); }

  private get cfg(): ProvidersConfig { return this.deps.config.providers; }
  /** config.experimental.providers is true (the second pass's surfaces are on). */
  get experimental(): boolean { return providersExperimental(this.deps.config); }
  get keys(): ProviderKeys { return this.deps.keys; }
  config(): ProvidersConfig { return this.cfg; }

  /**
   * The provider a model value names, or undefined (the Claude path, exactly as before). A prefix that is a preset name or a configured
   * provider counts even when its entry is gone, so a deleted provider stops the run instead of sending the id to Claude.
   */
  resolve(model: string | undefined): ResolvedModel | undefined {
    const m = typeof model === 'string' ? PREFIX_RE.exec(model) : null;
    if (!m || m[1] === 'arn') return undefined;
    const id = m[1]!;
    const entry = this.cfg.entries[id];
    if (!entry && !PRESET_IDS.has(id)) return undefined;
    return { providerId: id, model: m[2]!, ...(entry ? { entry } : {}) };
  }

  /** True only when the owner confirmed this stdio server's exact current command line for provider runs. */
  stdioAllowed(name: string, entry: McpServerEntry | undefined): boolean {
    return isStdioEntry(entry) && this.cfg.stdioMcpAllow[name] === stdioFingerprint(entry);
  }

  /** The stdio servers in Settings with their provider-run state, for the Providers panel and the native dialog. */
  stdioServers(): Array<{ name: string; commandLine: string; allowed: boolean; changedSinceAllowed: boolean }> {
    const out: Array<{ name: string; commandLine: string; allowed: boolean; changedSinceAllowed: boolean }> = [];
    if (!this.experimental) return out;
    for (const [name, e] of Object.entries(this.deps.config.mcpServers ?? {})) {
      if (!isStdioEntry(e)) continue;
      const has = this.cfg.stdioMcpAllow[name] !== undefined;
      const allowed = this.stdioAllowed(name, e);
      out.push({ name, commandLine: this.redact(stdioCommandLine(e)), allowed, changedSinceAllowed: has && !allowed });
    }
    return out;
  }

  /** True when `model` names a provider (configured, preset, or just provider-shaped): used by the caps that keep a bot on the owner's provider. */
  isProviderModel(model: string | undefined): boolean { return providerPrefix(model) !== undefined; }

  /**
   * Whether a run on this provider starts tainted. A CLI always does. A custom endpoint (not a preset's own address, not this computer)
   * does unless the owner relaxed it (admin plus native confirmation). A preset at its own address, and a loopback address, do not.
   */
  startsTainted(r: ResolvedModel): boolean {
    const e = r.entry;
    if (!e) return false;
    if (e.kind === 'cli') return true;
    if (e.trusted === true) return false;
    const ep = checkEndpoint(e.baseUrl, { allowPrivate: e.allowPrivateNetwork === true });
    if (!ep.ok) return true;
    if (ep.loopback) return false;
    const preset = PROVIDER_PRESETS.find((p) => p.id === r.providerId);
    if (preset) { const pe = checkEndpoint(preset.entry.baseUrl); return !(pe.ok && pe.origin === ep.origin); }
    return true;
  }

  /**
   * May a lead agent run `q.target` on the provider choice `q.value` (a per-task choice made through ask/tell/room posts)? Only when the
   * owner allowed it: the value is on that agent's Lead choices list, or its provider is marked lead-selectable (both are changed only with
   * admin plus native confirmation). Never a CLI. A lead that has touched outside content cannot pick a provider whose runs start tainted
   * (a custom remote endpoint the owner has not marked trusted), so injected text cannot steer work to an endpoint nobody vouched for.
   */
  leadDecision(q: { target: { id: string; name: string }; value: string; leadTainted?: boolean }): { ok: boolean; reason?: string } {
    const fix = 'Allow it in Settings, Providers, Lead choices.';
    const no = (reason: string) => ({ ok: false, reason });
    if (!this.experimental) return no('A per-task provider choice is not available in this version. Leave model out.');
    const r = this.resolve(q.value);
    if (!r?.entry) return no(`"${q.value}" is not a provider that is set up, so ${q.target.name} cannot run on it. Leave model out, or ask the user to set it up in Settings, Providers.`);
    if (r.entry.kind === 'cli') return no(`"${r.entry.label}" runs a program on this computer and only the user can start it, in the Legion app. Leave model out.`);
    if (!r.entry.enabled) return no(`The provider "${r.entry.label}" is turned off. Leave model out, or ask the user to turn it on in Settings, Providers.`);
    const listed = (this.cfg.leadChoices[q.target.id] ?? []).includes(q.value);
    if (!listed && r.entry.leadSelectable !== true) return no(`${q.target.name} can only run on "${q.value}" if the user allows leads to choose it. ${fix}`);
    if (q.leadTainted && this.startsTainted(r)) return no(`You have read outside content in this task, and "${r.entry.label}" is an endpoint the user has not marked trusted, so you cannot send work to it. Leave model out, or ask the user to mark it trusted in Settings, Providers.`);
    return { ok: true };
  }

  private target(id: string, entry: ProviderEntry): ProviderTarget {
    const ep = checkEndpoint(entry.baseUrl, { allowPrivate: entry.allowPrivateNetwork === true });
    const origin = ep.ok ? ep.origin : '';
    const key = this.deps.keys.get(id, origin);
    return { entry, ...(key ? { key, keyOrigin: origin } : {}) };
  }

  /** Strips the keys Legion holds and any key-shaped text from a string before it is stored or shown. */
  redact(s: string): string { return scrubSecrets(s, { exact: this.deps.keys.all() }); }

  private costOf(r: ResolvedModel, res: ProviderRunResult): number | undefined {
    const p = r.entry?.prices?.[r.model];
    if (!p || !res.usage || res.usageUnknown) return undefined;
    return (res.usage.inputTokens * p.inputPerMTok + res.usage.outputTokens * p.outputPerMTok) / 1_000_000;
  }

  async run(host: ProviderHost, r: ResolvedModel): Promise<ProviderRunResult & { costUsd?: number }> {
    if (r.entry?.kind === 'cli') {
      if (!this.experimental) return { subtype: 'error_during_execution', isError: true, errorText: 'CLI providers are not available in this version.', turns: 0, usageUnknown: true };
      if (!r.entry.enabled) return { subtype: 'error_during_execution', isError: true, errorText: `The provider "${r.entry.label}" is turned off. Turn it on in Settings, Providers.`, turns: 0, usageUnknown: true };
      return runCli(host, r.providerId, r.entry, r.model, {
        port: this.deps.cliPort ?? createProcessPort(), redact: (s) => this.redact(s),
        folder: { home: this.deps.home ?? homedir(), workspaceDir: this.deps.config.workspaceDir ?? '', ...(this.deps.dataDir ? { dataDir: this.deps.dataDir } : {}), appRoots: this.deps.appRoots ?? [process.cwd()] },
        ...(this.deps.cliSource ? { source: this.deps.cliSource } : {}),
      });
    }
    const fail = (errorText: string): ProviderRunResult => ({ subtype: 'error_during_execution', isError: true, errorText, turns: 0, usageUnknown: false });
    if (!r.entry) return fail(`The provider "${r.providerId}" is not set up any more. Choose another model for this agent in Settings, Providers.`);
    if (!r.entry.enabled) return fail(`The provider "${r.entry.label}" is turned off. Turn it on in Settings, Providers, or choose another model for this agent.`);
    if (!r.model.trim()) return fail('No model id was given for this provider.');
    const res = await runToolLoop(host, this.target(r.providerId, r.entry), r.model, {
      maxTurns: this.cfg.maxTurns, maxToolCallsPerTurn: this.cfg.maxToolCallsPerTurn, limits: this.deps.limits, ...(this.deps.turn ? { turn: this.deps.turn } : {}),
      cap: { ...(r.entry.tokenCapPerTask ? { perTask: r.entry.tokenCapPerTask } : {}), ...(r.entry.tokenCapPerDay ? { perDay: r.entry.tokenCapPerDay } : {}), taskBefore: host.taskTokensBefore ?? 0, dayUsed: () => this.usage.today(r.providerId), onTokens: (n) => this.usage.add(r.providerId, n), label: `"${r.entry.label}"` },
    }, (s) => this.redact(s), () => this.deps.keys.all());
    const cost = this.costOf(r, res);
    return { ...res, ...(cost !== undefined ? { costUsd: cost } : {}) };
  }

  // ------------------------------------------------------------ Settings views and owner-initiated calls

  private entryStatus(id: string, e: ProviderEntry): { text: string; keyMatches: boolean } {
    if (e.kind === 'cli') return { text: [e.enabled ? 'On' : 'Off', (e.allowedAgents?.length ?? 0) ? `Enabled for ${e.allowedAgents!.length} agent(s)` : 'Not enabled for any agent', 'Runs outside Legion\'s controls'].join('. '), keyMatches: false };
    const ep = checkEndpoint(e.baseUrl, { allowPrivate: e.allowPrivateNetwork === true });
    const keySet = this.deps.keys.has(id);
    const keyMatches = ep.ok && this.deps.keys.get(id, ep.origin) !== undefined;
    const t = this.tests.get(id);
    const parts: string[] = [];
    if (!e.enabled) parts.push('Off');
    if (keySet && !keyMatches) parts.push('The saved key belongs to a different address: save it again');
    else if (keySet) parts.push('Key saved');
    else if (e.keyless && ep.ok && ep.loopback) parts.push('Local, no key needed');
    else parts.push('No key');
    parts.push(t ? `Last test ${t.ok ? 'accepted' : 'failed'} at ${t.at.slice(11, 16)}` : 'Not tested');
    return { text: parts.join('. '), keyMatches };
  }

  view(): ProvidersView {
    const out: ProviderView[] = [];
    const seen = new Set<string>();
    const mk = (id: string, e: ProviderEntry, preset?: { needsKey: boolean; note: string }): ProviderView => {
      const st = this.entryStatus(id, e);
      const ep = e.kind === 'cli' ? { ok: false as const, reason: '' } : checkEndpoint(e.baseUrl, { allowPrivate: e.allowPrivateNetwork === true });
      const t = this.tests.get(id);
      const models = [...new Set([...(e.models ?? []), ...(this.fetched.get(id) ?? [])])];
      return {
        id, label: e.label, baseUrl: e.baseUrl, enabled: e.enabled, preset: !!preset, needsKey: preset ? preset.needsKey : !e.keyless,
        ...(preset ? { note: preset.note } : {}),
        keySet: this.deps.keys.has(id), ...(this.deps.keys.has(id) ? { keyHint: this.deps.keys.hint(id) } : {}), keyMatchesAddress: st.keyMatches,
        wire: e.wire === 'responses' ? 'responses' : 'chat', keyless: e.keyless === true, allowPrivateNetwork: e.allowPrivateNetwork === true, loopback: ep.ok && ep.loopback, models,
        hasPrices: !!e.prices && Object.keys(e.prices).length > 0, status: st.text, ...(t ? { lastTest: t } : {}),
        ...(this.experimental ? {
          kind: e.kind, trusted: e.trusted === true, startsTainted: this.startsTainted({ providerId: id, model: '', entry: e }), leadSelectable: e.leadSelectable === true,
          ...(e.tokenCapPerTask ? { tokenCapPerTask: e.tokenCapPerTask } : {}), ...(e.tokenCapPerDay ? { tokenCapPerDay: e.tokenCapPerDay } : {}),
          tokensToday: this.usage.today(id),
          ...(e.kind === 'cli' ? { cli: e.cli, executable: e.executable, sandbox: e.sandbox ?? 'read-only', allowedAgents: e.allowedAgents ?? [], timeoutSeconds: e.timeoutSeconds ?? 900 } : {}),
        } : {}),
      };
    };
    for (const p of PROVIDER_PRESETS) {
      const e = this.cfg.entries[p.id] ?? p.entry;
      out.push(mk(p.id, e, { needsKey: p.needsKey, note: p.note })); seen.add(p.id);
    }
    for (const [id, e] of Object.entries(this.cfg.entries)) if (!seen.has(id) && (e.kind !== 'cli' || this.experimental)) out.push(mk(id, e));
    return { providers: out, maxTurns: this.cfg.maxTurns, maxToolCallsPerTurn: this.cfg.maxToolCallsPerTurn, dropped: this.cfg.dropped ?? [], cannotDo: PROVIDER_LIMITS_TEXT, experimental: this.experimental, stdioServers: this.stdioServers(), leadChoices: this.experimental ? this.cfg.leadChoices : {}, roomBudgetNote: this.experimental ? ROOM_BUDGET_NOTE : '', cliWarning: this.experimental ? CLI_WARNING : '' };
  }

  private entryFor(id: string): ProviderEntry {
    if (!PROVIDER_ID_RE.test(id)) throw new ProviderHttpError('refused', 'Unknown provider.');
    const e = this.cfg.entries[id] ?? PROVIDER_PRESETS.find((p) => p.id === id)?.entry;
    if (!e) throw new ProviderHttpError('refused', 'Unknown provider.');
    return e;
  }

  /** Owner pressed "Refresh models": one GET /models. The ids are kept in memory for the picker. */
  async refreshModels(id: string): Promise<string[]> {
    const e = this.entryFor(id);
    if (e.kind === 'cli') throw new ProviderHttpError('refused', 'A CLI has no model list. Type its model name, or leave it as default.');
    try {
      const ids = await listModelIds(this.target(id, { ...e, enabled: true }), this.deps.limits);
      this.fetched.set(id, ids);
      return ids;
    } catch (err) { throw new ProviderHttpError('network', this.redact(err instanceof Error ? err.message : String(err))); }
  }

  /** Owner pressed "Test": the same GET /models; the result is a fact about that request, not a verdict on the provider. */
  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    const at = new Date().toISOString();
    try {
      const ids = await this.refreshModels(id);
      const r = { at, ok: true, detail: `Legion's test request was accepted${ids.length ? ` (${ids.length} model ids listed)` : ''}.` };
      this.tests.set(id, r);
      return r;
    } catch (e) {
      const r = { at, ok: false, detail: this.redact(e instanceof Error ? e.message : String(e)).slice(0, 300) };
      this.tests.set(id, r);
      return r;
    }
  }
}
