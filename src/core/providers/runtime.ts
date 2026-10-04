/** The provider runtime: which model values mean a provider, running one provider turn for the engine, and the views Settings shows. */
import { scrubSecrets } from '../comms/scrub.js';
import { contextWindowFor } from './model-window.js';
import { compactNow, type ManualCompaction } from './tool-loop.js';
import type { ChatMessage } from './types.js';
import { compactionFor, DEFAULT_COMPACTION } from '../../shared/config.js';
import type { CompactionSettings } from '../../shared/types.js';
import { chatTurn, listModelIds } from './openai-compat.js';
import { ProviderHttpError } from './http.js';
import type { HttpLimits, ProviderTarget } from './http.js';
import { checkEndpoint } from './endpoint.js';
import { PRESET_IDS, PROVIDER_PRESETS } from './presets.js';
import { PROVIDER_ID_RE } from './config.js';
import type { ProviderKeys } from './secrets.js';
import { runToolLoop } from './tool-loop.js';
import type { ProviderEntry, ProviderHost, ProviderRunResult, ProvidersConfig, ResolvedModel } from './types.js';
import type { ProviderView, ProvidersView } from '../../shared/providers-view.js';

export interface RuntimeDeps {
  /** Live: Settings edits replace `providers` on this object. */
  config: { providers: ProvidersConfig; compaction?: CompactionSettings };
  keys: ProviderKeys;
  /** Tests only. */
  limits?: Partial<HttpLimits>;
  turn?: typeof chatTurn;
}

export type { ProviderView, ProvidersView } from '../../shared/providers-view.js';

/** What a provider-run agent cannot do, in the words the UI shows. */
export const PROVIDER_LIMITS_TEXT: string[] = [
  'No file editing, shell, web search or web fetch of its own. It gets Legion\'s own tools (agents, kg, comms, Blender, BSV status, and the VM tools when the agent has a VM) and the MCP servers you enabled for the agent.',
  'No Claude Code skills, plugins, slash commands, sub-agents, plan mode or claude.ai connectors.',
  'Your MCP servers run under stricter rules than for Claude: an approval card for each tool call (unless the agent is on full access), the run counts as touching outside content, a local server starts with a small environment instead of Legion\'s own, and a server address must be https or this computer.',
  'A continued task summarises older turns instead of keeping them verbatim, so detail from much earlier in a conversation may be lost.',
  'Tool use is only as reliable as the model; some models, especially small local ones, cannot call tools at all.',
  'Cost is shown only when the provider returns token counts and you entered prices; otherwise it is unknown.',
];

/** `<provider>:<model>` shape check only (a Bedrock ARN is not one). Whether the provider exists is the runtime's business. */
const PREFIX_RE = /^([a-z][a-z0-9-]{1,31}):(.+)$/;
export function providerPrefix(model: string | undefined): string | undefined {
  const m = typeof model === 'string' ? PREFIX_RE.exec(model) : null;
  return m && m[1] !== 'arn' ? m[1] : undefined;
}

export class ProviderRuntime {
  private readonly tests = new Map<string, { at: string; ok: boolean; detail: string }>();
  private readonly fetched = new Map<string, string[]>();
  constructor(private readonly deps: RuntimeDeps) {}

  private get cfg(): ProvidersConfig { return this.deps.config.providers; }
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

  /** True when `model` names a provider (configured, preset, or just provider-shaped): used by the caps that keep a bot on the owner's provider. */
  isProviderModel(model: string | undefined): boolean { return providerPrefix(model) !== undefined; }

  private target(id: string, entry: ProviderEntry): ProviderTarget {
    const ep = checkEndpoint(entry.baseUrl, { allowPrivate: entry.allowPrivateNetwork === true });
    const origin = ep.ok ? ep.origin : '';
    const key = this.deps.keys.get(id, origin);
    return { entry, ...(key ? { key, keyOrigin: origin } : {}) };
  }

  /**
   * Compact a stored conversation on demand, for `POST /api/tasks/:id/compact`.
   *
   * A manual cut has to ask the SAME model the run uses - a summary written by a different model is a different
   * conversation - so this goes through the same resolve/target path as `run()` rather than reaching around it. The
   * settings, window and redaction are the ones a run would use, so a manual compact cannot be a cheaper or laxer
   * path than the automatic one.
   */
  async compactNow(opts: { model: string; messages: ChatMessage[]; focus?: string; signal?: AbortSignal; onNotice?: (t: string) => void }): Promise<ManualCompaction> {
    const r = this.resolve(opts.model);
    if (!r?.entry) return { messages: opts.messages, compacted: false, usedFallback: false, missing: [], reason: 'Choose a provider model in Settings before compacting this conversation.' };
    if (!r.entry.enabled) return { messages: opts.messages, compacted: false, usedFallback: false, missing: [], reason: `The provider "${r.entry.label}" is turned off.` };
    const compaction = compactionFor({ compaction: this.deps.config.compaction ?? DEFAULT_COMPACTION });
    if (compaction.enabled === false) return { messages: opts.messages, compacted: false, usedFallback: false, missing: [], reason: 'Compaction is turned off in Settings, Compaction.' };
    return compactNow({
      messages: opts.messages,
      target: this.target(r.providerId, r.entry),
      turnFn: this.deps.turn ?? chatTurn,
      model: r.model,
      window: compaction.contextWindowOverride ?? contextWindowFor(r.model, r.entry.contextWindow),
      compaction,
      ...(opts.focus ? { focus: opts.focus } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      limits: this.deps.limits,
      redact: (text: string) => this.redact(text),
      onNotice: opts.onNotice ?? (() => undefined),
    });
  }

  /** Strips the keys Legion holds and any key-shaped text from a string before it is stored or shown. */
  redact(s: string): string { return scrubSecrets(s, { exact: this.deps.keys.all() }); }

  private costOf(r: ResolvedModel, res: ProviderRunResult): number | undefined {
    const p = r.entry?.prices?.[r.model];
    if (!p || !res.usage || res.usageUnknown) return undefined;
    return (res.usage.inputTokens * p.inputPerMTok + res.usage.outputTokens * p.outputPerMTok) / 1_000_000;
  }

  async run(host: ProviderHost, r: ResolvedModel): Promise<ProviderRunResult & { costUsd?: number }> {
    const fail = (errorText: string): ProviderRunResult => ({ subtype: 'error_during_execution', isError: true, errorText, turns: 0, usageUnknown: false });
    if (!r.entry) return fail(`The provider "${r.providerId}" is not set up any more. Choose another model for this agent in Settings, Providers.`);
    if (!r.entry.enabled) return fail(`The provider "${r.entry.label}" is turned off. Turn it on in Settings, Providers, or choose another model for this agent.`);
    if (!r.model.trim()) return fail('No model id was given for this provider.');
    const compaction = compactionFor({ compaction: this.deps.config.compaction ?? DEFAULT_COMPACTION });
    const res = await runToolLoop(host, this.target(r.providerId, r.entry), r.model, {
      maxTurns: this.cfg.maxTurns, maxToolCallsPerTurn: this.cfg.maxToolCallsPerTurn, limits: this.deps.limits,
      // Per MODEL, not per entry: one entry on an aggregator serves hundreds of models whose windows differ by 60x.
      // The owner's own value for the entry still wins (a self-hosted model can differ from any catalogue), and the
      // Settings override wins over both - otherwise the Compaction page would save a value that does nothing.
      contextWindow: compaction.contextWindowOverride ?? contextWindowFor(r.model, r.entry.contextWindow),
      compaction,
      ...(this.deps.turn ? { turn: this.deps.turn } : {}),
    }, (s) => this.redact(s));
    const cost = this.costOf(r, res);
    return { ...res, ...(cost !== undefined ? { costUsd: cost } : {}) };
  }

  // ------------------------------------------------------------ Settings views and owner-initiated calls

  private entryStatus(id: string, e: ProviderEntry): { text: string; keyMatches: boolean } {
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
      const ep = checkEndpoint(e.baseUrl, { allowPrivate: e.allowPrivateNetwork === true });
      const t = this.tests.get(id);
      const models = [...new Set([...(e.models ?? []), ...(this.fetched.get(id) ?? [])])];
      return {
        id, label: e.label, baseUrl: e.baseUrl, enabled: e.enabled, preset: !!preset, needsKey: preset ? preset.needsKey : !e.keyless,
        ...(preset ? { note: preset.note } : {}),
        keySet: this.deps.keys.has(id), ...(this.deps.keys.has(id) ? { keyHint: this.deps.keys.hint(id) } : {}), keyMatchesAddress: st.keyMatches,
        wire: e.wire === 'responses' ? 'responses' : 'chat', keyless: e.keyless === true, allowPrivateNetwork: e.allowPrivateNetwork === true, loopback: ep.ok && ep.loopback, models,
        hasPrices: !!e.prices && Object.keys(e.prices).length > 0, status: st.text, ...(t ? { lastTest: t } : {}),
      };
    };
    for (const p of PROVIDER_PRESETS) {
      const e = this.cfg.entries[p.id] ?? p.entry;
      out.push(mk(p.id, e, { needsKey: p.needsKey, note: p.note })); seen.add(p.id);
    }
    for (const [id, e] of Object.entries(this.cfg.entries)) if (!seen.has(id)) out.push(mk(id, e));
    return { providers: out, maxTurns: this.cfg.maxTurns, maxToolCallsPerTurn: this.cfg.maxToolCallsPerTurn, dropped: this.cfg.dropped ?? [], cannotDo: PROVIDER_LIMITS_TEXT };
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
