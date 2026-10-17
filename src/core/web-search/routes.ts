/**
 * HTTP routes for Settings, Web search (task 28). All admin-only (none is on the token client list). A key and a loopback or private-network
 * SearXNG address also need the native secret, which only the app's main process holds, so a compromised window cannot do them alone.
 * The setting lives in config.json (inside the data folder that agents may not change); keys live in <dataDir>/providers/keys.json.
 *
 *   GET   /api/settings/web-search          the view (below). Never a key, only a hint.
 *   PATCH /api/settings/web-search          { search?, read?, tregMaxCostUsd?, searxng?: { baseUrl } | null, acknowledge?: '<provider id>' }
 *   POST  /api/settings/web-search/check    the same body as PATCH; changes nothing; answers { ok, error?, needsNotice?, notice?, needsNative? }
 *   POST  /api/settings/web-search/key      { provider, key: string | null }   a string needs native; null removes the key
 *   POST  /api/settings/web-search/test     { provider? }   one tiny search; answers { ok, detail, micro? }
 */
import { existsSync, readFileSync } from 'node:fs';
import { NATIVE_HEADER, safeEqual } from '../admin.js';
import { writeConfigFile } from '../../shared/config.js';
import { NATIVE_REQUIRED, NOTICE_REQUIRED, PROVIDER_NOTICE, TREG_NOTICE } from '../../shared/web-search-copy.js';
import { TREG_CAP_MAX, TREG_CAP_MIN, WEB_PROVIDERS, isWebProviderId, normalizeWebSearch, webProviderMeta } from '../../shared/web-search-config.js';
import type { CoreModule } from '../modules.js';
import { HttpError } from '../server.js';
import { keyStoreLine, type ProviderKeys } from '../providers/secrets.js';
import { ADAPTERS, keyIdOf, validateWebSearchPatch } from './index.js';
import type { WebProviderId, WebSearchConfig, WebSearchService } from './index.js';

export interface WebSearchModuleOpts {
  /** The live setting. The routes change this object in place, so the service and the engine see an edit at once. */
  config: () => WebSearchConfig;
  keys: ProviderKeys;
  service: WebSearchService;
  configPath: string;
  nativeSecret?: string;
  onChange?: () => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The notice the page shows before the first use of a provider (treg adds its own paragraph). */
export function noticeFor(id: WebProviderId): string {
  const name = webProviderMeta(id).label;
  return id === 'treg' ? `${PROVIDER_NOTICE(name)}\n\n${TREG_NOTICE}` : PROVIDER_NOTICE(name);
}

export function createWebSearchModule(opts: WebSearchModuleOpts): CoreModule {
  const cfg = (): WebSearchConfig => opts.config();

  const requireNative = (req: { headers?: Record<string, string | string[] | undefined> } | undefined): void => {
    if (!opts.nativeSecret) throw new HttpError(403, `native_unavailable: this change needs the Legion app window (this core was not started by it)`);
    const given = req?.headers?.[NATIVE_HEADER];
    if (typeof given !== 'string' || !safeEqual(given, opts.nativeSecret)) throw new HttpError(403, `${NATIVE_REQUIRED}: keys and private-network addresses come only from the app after its confirmation dialog`);
  };

  /** Writes the webSearch part of config.json; the rest of the file is kept as it is. Keys never go here. */
  const persist = (): void => {
    let disk: Record<string, unknown> = {};
    if (existsSync(opts.configPath)) {
      try { const j = JSON.parse(readFileSync(opts.configPath, 'utf8')); if (isObj(j)) disk = j; } catch { throw new HttpError(500, 'config.json is unreadable; fix or delete it first'); }
    }
    disk.webSearch = cfg();
    try { writeConfigFile(opts.configPath, JSON.stringify(disk, null, 2)); } catch (e) { throw new HttpError(500, `Could not write config: ${e instanceof Error ? e.message : String(e)}`); }
    try { opts.onChange?.(); } catch { /* advisory */ }
  };

  const view = () => {
    const c = cfg();
    const keys: Record<string, { set: boolean; hint?: string }> = {};
    for (const p of WEB_PROVIDERS) {
      if (!p.needsKey) continue;
      const origin = ADAPTERS[p.id].origin(c);
      const set = !!origin && opts.keys.get(keyIdOf(p.id), origin) !== undefined;
      keys[keyIdOf(p.id)] = set ? { set, hint: opts.keys.hint(keyIdOf(p.id))! } : { set };
    }
    return {
      search: c.search, read: c.read, tregMaxCostUsd: c.tregMaxCostUsd,
      ...(c.searxng ? { searxng: { baseUrl: c.searxng.baseUrl, ...(c.searxng.allowPrivateNetwork ? { allowPrivateNetwork: true } : {}) } } : {}),
      acknowledged: { ...c.acknowledged },
      providers: WEB_PROVIDERS.map((p) => ({ id: p.id, label: p.label, canSearch: p.canSearch, canRead: p.canRead, needsKey: p.needsKey, ready: opts.service.ready(p.id) })),
      keys,
      keyStore: keyStoreLine(opts.keys.status()),
      capLimits:{ min: TREG_CAP_MIN, max: TREG_CAP_MAX },
      nativeAvailable: !!opts.nativeSecret,
    };
  };

  /** Checks a change; throws the coded error a page can act on. Returns what to apply. */
  const checked = (body: unknown, req: { headers?: Record<string, string | string[] | undefined> } | undefined) => {
    const v = validateWebSearchPatch(body, cfg());
    if (!v.ok) throw new HttpError(400, v.error ?? 'That change was not understood.');
    if (v.needsNative) requireNative(req);
    if (v.needsNotice && v.acknowledge !== v.needsNotice) throw new HttpError(409, `${NOTICE_REQUIRED}: ${noticeFor(v.needsNotice)}`);
    return v;
  };

  return {
    id: 'web-search',
    routes(add) {
      add('GET', '/api/settings/web-search', () => view());

      add('PATCH', '/api/settings/web-search', ({ req, body }) => {
        const v = checked(body, req);
        const c = cfg(); const p = v.patch!;
        const next: WebSearchConfig = { ...c, ...(p.search ? { search: p.search } : {}), ...(p.read ? { read: p.read } : {}), ...(p.tregMaxCostUsd !== undefined ? { tregMaxCostUsd: p.tregMaxCostUsd } : {}), acknowledged: { ...c.acknowledged } };
        if (p.searxng === null) delete next.searxng; else if (p.searxng) next.searxng = p.searxng;
        if (v.acknowledge) next.acknowledged[v.acknowledge] = new Date().toISOString().slice(0, 10);
        // one more pass through the normalizer: what is stored is always a shape the loader accepts
        const clean = normalizeWebSearch(next);
        for (const k of Object.keys(c) as Array<keyof WebSearchConfig>) delete c[k];
        Object.assign(c, clean);
        persist();
        return view();
      });

      add('POST', '/api/settings/web-search/check', ({ body }) => {
        const v = validateWebSearchPatch(body, cfg());
        if (!v.ok) return { ok: false, error: v.error };
        return { ok: true, ...(v.needsNotice ? { needsNotice: v.needsNotice, notice: noticeFor(v.needsNotice) } : {}), ...(v.needsNative ? { needsNative: true } : {}) };
      });

      add('POST', '/api/settings/web-search/key', ({ req, body }) => {
        if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
        if (!isWebProviderId(body.provider)) throw new HttpError(400, 'Unknown provider.');
        const id = body.provider;
        const meta = webProviderMeta(id);
        if (!meta.needsKey) throw new HttpError(400, `${meta.label} needs no key.`);
        if (body.key === null) { opts.keys.remove(keyIdOf(id)); return view(); }
        requireNative(req);
        try { opts.keys.set(keyIdOf(id), body.key, ADAPTERS[id].origin(cfg())!); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Invalid key'); }
        return view();
      });

      add('POST', '/api/settings/web-search/test', async ({ body }) => {
        const want = isObj(body) ? body.provider : undefined;
        if (want !== undefined && !isWebProviderId(want)) throw new HttpError(400, 'Unknown provider.');
        return await opts.service.test(want as WebProviderId | undefined);
      });
    },
  };
}
