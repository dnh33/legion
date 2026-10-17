/** Rig for the web provider settings routes (task 28): the real module over a temp data folder, called without an HTTP server. Nothing here touches the network. */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tempDir } from './tmp-cleanup.js';
import type { Handler } from '../src/core/server.js';
import { ProviderKeys } from '../src/core/providers/secrets.js';
import { ADAPTERS } from '../src/core/web-search/adapters.js';
import { WebSearchService } from '../src/core/web-search/index.js';
import { createWebSearchModule } from '../src/core/web-search/routes.js';
import { defaultWebSearch } from '../src/shared/web-search-config.js';
import type { WebSearchConfig } from '../src/shared/web-search-config.js';

export function webSearchRoutes(o: { native?: string; fetchImpl?: typeof fetch; cfg?: Partial<WebSearchConfig> } = {}) {
  const dir = tempDir('legion-wsroutes-');
  const configPath = join(dir, 'config.json');
  const cfg: WebSearchConfig = { ...defaultWebSearch(), ...(o.cfg ?? {}) };
  const keys = new ProviderKeys(join(dir, 'providers', 'keys.json'), { dataKey: randomBytes(32) }); // sealed, as in the app
  const service = new WebSearchService({ config: () => cfg, keys, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  const handlers: Array<{ method: string; re: RegExp; h: Handler }> = [];
  const mod = createWebSearchModule({ config: () => cfg, keys, service, configPath, ...(o.native ? { nativeSecret: o.native } : {}) });
  mod.routes!((method, pattern, h) => { handlers.push({ method, re: new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '/?$'), h }); });
  /** One request to the module's routes; a thrown HttpError comes back as an Error whose message is the error text. */
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> => {
    for (const r of handlers) {
      const m = r.re.exec(path);
      if (r.method === method && m) return await r.h({ req: { headers } as never, res: undefined as never, url: new URL(`http://x${path}`), params: m.slice(1), body });
    }
    throw new Error(`no route ${method} ${path}`);
  };
  return { call, dir, configPath, keys, service, config: () => cfg };
}

/** The settings view with these keys saved (id -> key), as the real GET route returns it. */
export async function getWebSearchSettings(saved: Record<string, string>): Promise<{ keys: Record<string, { set: boolean; hint?: string }> } & Record<string, unknown>> {
  const w = webSearchRoutes();
  for (const [id, key] of Object.entries(saved)) w.keys.set(id, key, ADAPTERS[id.replace(/^web:/, '') as keyof typeof ADAPTERS].origin(w.config())!);
  return await w.call('GET', '/api/settings/web-search') as never;
}

/** A service over an in-memory key store for the keys given (id -> key, ids like 'web:exa') and a fake fetch; nothing here touches the network. */
export function makeWebSearch(cfg: Partial<WebSearchConfig> = {}, saved: Record<string, string> = {}, fetchImpl?: typeof fetch): WebSearchService {
  const full: WebSearchConfig = { ...defaultWebSearch(), ...cfg };
  const keys = new ProviderKeys(join(tempDir('legion-wskeys-'), 'providers', 'keys.json'));
  for (const [id, key] of Object.entries(saved)) keys.set(id, key, ADAPTERS[id.replace(/^web:/, '') as keyof typeof ADAPTERS].origin(full)!);
  return new WebSearchService({ config: () => full, keys, ...(fetchImpl ? { fetchImpl } : {}) });
}
