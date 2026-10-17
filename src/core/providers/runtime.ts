/** The provider runtime: which model values mean a provider, running one provider turn for the engine, and the views Settings shows. */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
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
  /** Where the model lists are saved (`<dataDir>/provider-models.json`). Absent: kept in memory only. */
  cacheFile?: string;
  turn?: typeof chatTurn;
}

export type { ProviderView, ProvidersView } from '../../shared/providers-view.js';

/** What a provider-run agent cannot do, in the words the UI shows. */
export const PROVIDER_LIMITS_TEXT: string[] = [
  'No file editing, shell, web search or web fetch of its own. It gets Legion\'s own tools (agents, kg, comms, Blender, BSV status, and the VM tools when the agent has a VM) and the MCP servers you enabled for the agent.',
  'No Claude Code skills, plugins, slash commands, sub-agents, plan mode or claude.ai connectors.',
  'Your MCP servers run under stricter rules than for Claude: an approval card for each tool call (unless the agent is on full access), the run counts as touching outside content, a local server starts with a small environment instead of Legion\'s own, and a server address must be https or your computer.',
  'A continued task summarises older turns instead of keeping them verbatim, so detail from much earlier in a conversation may be lost.',
  'Tool use is only as reliable as the model; some models, especially small local ones, cannot call tools at all.',
  'Cost is shown only when the provider returns token counts and you entered prices; otherwise it is unknown.',
];

/** A provider's model list is fetched again once it is this old (the picker opens it at most once a day). */
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;

/** `<provider>:<model>` shape check only (a Bedrock ARN is not one). Whether the provider exists is the runtime's business. */
const PREFIX_RE = /^([a-z][a-z0-9-]{1,31}):(.+)$/;
export function providerPrefix(model: string | undefined): string | undefined {
  const m = typeof model === 'string' ? PREFIX_RE.exec(model) : null;
  return m && m[1] !== 'arn' ? m[1] : undefined;
}

export class ProviderRuntime {
  private readonly tests = new Map<string, { at: string; ok: boolean; detail: string }>();
  private readonly fetched = new Map<string, string[]>();
  /** When each provider's list was last fetched (ISO), and the last refresh error (redacted). Both survive a restart through the cache file. */
  private readonly fetchedAt = new Map<string, string>();
  private readonly fetchError = new Map<string, string>();
  private staleRun?: Promise<void>;
  /** Bumped when a provider's address or key changes or its list is forgotten: a fetch that started before the bump is not kept. */
  private readonly epoch = new Map<string, number>();
  constructor(private readonly deps: RuntimeDeps) { this.loadCache(); }

  /** The saved model lists (ids and when each was fetched). A missing or broken file is an empty cache. */
  private loadCache(): void {
    const file = this.deps.cacheFile;
    if (!file || !existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { providers?: Record<string, { at?: unknown; ids?: unknown }> };
      for (const [id, v] of Object.entries(raw.providers ?? {})) {
        if (!PROVIDER_ID_RE.test(id) || typeof v?.at !== 'string' || !Array.isArray(v.ids)) continue;
        this.fetched.set(id, v.ids.filter((x): x is string => typeof x === 'string').slice(0, 500));
        this.fetchedAt.set(id, v.at);
      }
    } catch { /* a broken cache is an empty one */ }
  }

  private saveCache(): void {
    const file = this.deps.cacheFile;
    if (!file) return;
    const providers: Record<string, { at: string; ids: string[] }> = {};
    for (const [id, at] of this.fetchedAt) providers[id] = { at, ids: this.fetched.get(id) ?? [] };
    // Written to a temp file and renamed over the saved one: a crash mid-write leaves the last good file, never half of one.
    const tmp = `${file}.tmp`;
    try { writeFileSync(tmp, JSON.stringify({ providers }, null, 2)); renameSync(tmp, file); } catch {
      try { unlinkSync(tmp); } catch { /* no temp file to clean up */ }
      /* the lists still work for this session */
    }
  }

  /** Drops a provider's list (its address or key changed, or the provider was removed or lost its key). The picker shows nothing for it until a fresh fetch. */
  forgetModels(id: string): void {
    this.epoch.set(id, (this.epoch.get(id) ?? 0) + 1);
    this.fetched.delete(id);
    this.fetchedAt.delete(id);
    this.fetchError.delete(id);
    this.saveCache();
  }

  private get cfg(): ProvidersConfig { return this.deps.config.providers; }
  get keys(): ProviderKeys { return this.deps.keys; }
  config(): ProvidersConfig { return this.cfg; }

  /**
   * The provider a model value names, or undefined (the Claude path, exactly as before). A preset with no saved entry runs on
   * the preset's own entry, the one Settings shows: saving only a key (a fresh install's OpenRouter) is enough to run. A preset
   * that ships off resolves to its off entry, so the run says "turned off". A configured provider whose entry is gone stops the
   * run instead of sending the id to Claude.
   */
  resolve(model: string | undefined): ResolvedModel | undefined {
    const m = typeof model === 'string' ? PREFIX_RE.exec(model) : null;
    if (!m || m[1] === 'arn') return undefined;
    const id = m[1]!;
    const entry = this.cfg.entries[id] ?? PROVIDER_PRESETS.find((p) => p.id === id)?.entry;
    if (!entry && !PRESET_IDS.has(id)) return undefined;
    return { providerId: id, model: m[2]!, ...(entry ? { entry } : {}) };
  }

  /** True when `model` names a provider (configured, preset, or just provider-shaped): used by the caps that keep a bot on the owner's provider. */
  isProviderModel(model: string | undefined): boolean { return providerPrefix(model) !== undefined; }

  /**
   * The target for a call that is not a model run (the skill finder's embeddings): the saved entry for `id`, or the preset's own
   * entry, with its key. Undefined when there is none, or the provider is turned off.
   */
  targetFor(id: string): ProviderTarget | undefined {
    const entry = this.cfg.entries[id] ?? PROVIDER_PRESETS.find((p) => p.id === id)?.entry;
    return entry && entry.enabled ? this.target(id, entry) : undefined;
  }

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

  /** The provider keys Legion holds, as exact values (the agent shell redacts them from what it returns). */
  secretValues(): string[] { return this.deps.keys.all(); }

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
        wire: e.wire === 'responses' ? 'responses' : 'chat', toolCalls: e.toolCalls ?? 'auto', keyless: e.keyless === true, allowPrivateNetwork: e.allowPrivateNetwork === true, loopback: ep.ok && ep.loopback, models, configuredModels: [...(e.models ?? [])],
        ...(this.fetchedAt.get(id) ? { modelsFetchedAt: this.fetchedAt.get(id) } : {}),
        ...(this.fetchError.get(id) ? { modelsError: this.fetchError.get(id) } : {}),
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

  /** Owner pressed "Refresh models" (or the picker's daily refresh): one GET /models. The ids are kept for the picker and saved to the cache file. */
  async refreshModels(id: string): Promise<string[]> {
    const e = this.entryFor(id);
    const epoch = this.epoch.get(id) ?? 0;
    const current = () => (this.epoch.get(id) ?? 0) === epoch;
    try {
      const ids = await listModelIds(this.target(id, { ...e, enabled: true }), this.deps.limits);
      if (!current()) return ids; // the address or key changed while this was fetched: the answer is not kept
      this.fetched.set(id, ids);
      this.fetchedAt.set(id, new Date().toISOString());
      this.fetchError.delete(id);
      this.saveCache();
      return ids;
    } catch (err) {
      const pe = new ProviderHttpError('network', this.redact(err instanceof Error ? err.message : String(err)));
      if (current()) this.fetchError.set(id, pe.message.slice(0, 200));
      throw pe;
    }
  }

  /**
   * The picker's automatic refresh: every switched-on provider that can be called (a key saved, or none needed) whose list is missing or
   * older than a day gets one GET /models. Never throws: a failure becomes that provider's last error and its saved list stays.
   * Concurrent calls share one run.
   */
  ensureModels(): Promise<void> {
    if (!this.staleRun) this.staleRun = this.refreshStale().finally(() => { this.staleRun = undefined; });
    return this.staleRun;
  }

  private async refreshStale(): Promise<void> {
    const ids = new Set([...Object.keys(this.cfg.entries), ...PROVIDER_PRESETS.map((p) => p.id)]);
    for (const id of ids) {
      if (!PROVIDER_ID_RE.test(id)) continue;
      let e: ProviderEntry;
      try { e = this.entryFor(id); } catch { continue; }
      if (!e.enabled || !(e.keyless === true || this.deps.keys.has(id))) continue;
      const at = this.fetchedAt.get(id);
      if (at && Date.now() - Date.parse(at) < MODELS_TTL_MS) continue;
      try { await this.refreshModels(id); } catch { /* kept as this provider's last error */ }
    }
  }

  /** Owner pressed "Test": the same GET /models; the result is a fact about that request, not a verdict on the provider. */
  async test(id: string): Promise<{ ok: boolean; detail: string }> {
    const at = new Date().toISOString();
    try {
      const ids = await this.refreshModels(id);
      const r = { at, ok: true, detail: ids.length ? `Legion's test request was accepted (${ids.length} model ids listed).` : "Legion's test request was accepted, but the server lists no models yet. Add or load one, then press Refresh models." };
      this.tests.set(id, r);
      return r;
    } catch (e) {
      const r = { at, ok: false, detail: this.redact(e instanceof Error ? e.message : String(e)).slice(0, 300) };
      this.tests.set(id, r);
      return r;
    }
  }
}
