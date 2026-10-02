/**
 * HTTP routes for Settings, Providers. All of them are admin-only (none is on the token client list). Changes that could send a key or
 * data somewhere new (a different address, a private-network address, a key) also need the native secret, which only the app's main
 * process holds, so a compromised window cannot do them on its own.
 */
import { existsSync, readFileSync } from 'node:fs';
import { NATIVE_HEADER, safeEqual } from '../admin.js';
import { writeConfigFile } from '../../shared/config.js';
import type { CoreModule } from '../modules.js';
import { HttpError } from '../server.js';
import { normalizeEntry } from './config.js';
import { checkEndpoint } from './endpoint.js';
import { ProviderHttpError } from './http.js';
import { PROVIDER_PRESETS } from './presets.js';
import { PROVIDER_ID_RE } from './config.js';
import { isStdioEntry, stdioFingerprint } from './stdio-allow.js';
import type { ProviderRuntime } from './runtime.js';
import type { ProviderEntry } from './types.js';

export interface ProvidersModuleOpts { runtime: ProviderRuntime; configPath: string; nativeSecret?: string; onChange?: () => void }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createProvidersModule(opts: ProvidersModuleOpts): CoreModule {
  const { runtime } = opts;
  const cfg = () => runtime.config();

  const requireNative = (req: { headers?: Record<string, string | string[] | undefined> } | undefined): void => {
    if (!opts.nativeSecret) throw new HttpError(403, 'native_unavailable: this change needs the Legion app window (this core was not started by it)');
    const given = req?.headers?.[NATIVE_HEADER];
    if (typeof given !== 'string' || !safeEqual(given, opts.nativeSecret)) throw new HttpError(403, 'native_confirmation_required: key and address changes come only from the app after its confirmation dialog');
  };

  const effective = (id: string): ProviderEntry | undefined => cfg().entries[id] ?? PROVIDER_PRESETS.find((p) => p.id === id)?.entry;
  const mustId = (id: string): string => {
    if (!PROVIDER_ID_RE.test(id)) throw new HttpError(400, 'Not a valid provider id (lowercase letters, digits and -, 2 to 32 characters).');
    return id;
  };

  /** Writes the providers part of config.json (the rest of the file is kept as it is; keys never go here). */
  const persist = (): void => {
    let disk: Record<string, unknown> = {};
    if (existsSync(opts.configPath)) {
      try { const j = JSON.parse(readFileSync(opts.configPath, 'utf8')); if (isObj(j)) disk = j; } catch { throw new HttpError(500, 'config.json is unreadable; fix or delete it first'); }
    }
    const c = cfg();
    disk.providers = { version: 1, entries: c.entries, maxTurns: c.maxTurns, maxToolCallsPerTurn: c.maxToolCallsPerTurn, stdioMcpAllow: c.stdioMcpAllow, leadChoices: c.leadChoices };
    try { writeConfigFile(opts.configPath, JSON.stringify(disk, null, 2)); } catch (e) { throw new HttpError(500, `Could not write config: ${e instanceof Error ? e.message : String(e)}`); }
    try { opts.onChange?.(); } catch { /* advisory */ }
  };

  const wrap = <T>(fn: () => Promise<T> | T): Promise<T> | T => {
    try {
      const r = fn();
      return r instanceof Promise ? r.catch((e) => { throw conv(e); }) : r;
    } catch (e) { throw conv(e); }
  };
  const conv = (e: unknown): unknown => (e instanceof ProviderHttpError ? new HttpError(e.code === 'refused' ? 400 : 502, runtime.redact(e.message)) : e);

  return {
    id: 'providers',
    routes(add) {
      add('GET', '/api/providers', () => runtime.view());

      add('PUT', '/api/providers/limits', ({ body }) => {
        if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
        const int = (v: unknown, f: string, lo: number, hi: number): number => {
          if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new HttpError(400, `${f} must be a whole number from ${lo} to ${hi}`);
          return v;
        };
        if (body.maxTurns !== undefined) cfg().maxTurns = int(body.maxTurns, 'maxTurns', 1, 200);
        if (body.maxToolCallsPerTurn !== undefined) cfg().maxToolCallsPerTurn = int(body.maxToolCallsPerTurn, 'maxToolCallsPerTurn', 1, 64);
        persist();
        return runtime.view();
      });

      // Allow or stop allowing one Settings stdio MCP server for provider runs. Allowing needs the native secret (the app's dialog showed the
      // command line); the fingerprint is computed here from the server's current entry, never taken from the request. Stopping needs admin only.
      add('PUT', '/api/provider-mcp/:name', ({ req, params, body }) => {
        const name = decodeURIComponent(params[0]!);
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new HttpError(400, 'Not a valid server name.');
        if (!isObj(body) || typeof body.allow !== 'boolean') throw new HttpError(400, 'allow (true or false) is required');
        if (body.allow) {
          requireNative(req);
          const entry = runtime.deps.config.mcpServers?.[name];
          if (!isStdioEntry(entry)) throw new HttpError(404, 'No local (stdio) MCP server with that name in Settings.');
          cfg().stdioMcpAllow[name] = stdioFingerprint(entry);
        } else delete cfg().stdioMcpAllow[name];
        persist();
        return runtime.view();
      });

      add('PUT', '/api/providers/:id', ({ req, params, body }) => {
        const id = mustId(params[0]!);
        if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
        const before = effective(id);
        const picked = pick(body);
        if (before && picked.kind !== undefined && picked.kind !== before.kind) throw new HttpError(400, 'A provider keeps its kind; add a new provider instead.');
        const kind = before?.kind ?? (picked.kind === 'cli' ? 'cli' : 'openai-compat');
        const merged = { ...(before ?? {}), ...picked };
        const r = normalizeEntry(id, { ...merged, kind });
        if ('reason' in r) throw new HttpError(400, r.reason);
        const next = r.entry;
        const addressChanged = !before || next.baseUrl !== before.baseUrl;
        const widened = (next.allowPrivateNetwork === true && before?.allowPrivateNetwork !== true) || (next.keyless === true && before?.keyless !== true);
        // relaxations: taint off for a custom endpoint, lead-selectable on; any change to a CLI entry (program, sandbox, who may run it, on/off)
        const relaxed = (next.trusted === true && before?.trusted !== true) || (next.leadSelectable === true && before?.leadSelectable !== true);
        if (next.kind === 'cli' && !before && next.enabled) throw new HttpError(400, 'Add the CLI turned off first; enable it for an agent in a second, confirmed step.');
        const onlyTurnedOff = !!before && next.enabled === false && JSON.stringify({ ...next, enabled: true }) === JSON.stringify({ ...before, enabled: true });
        if (addressChanged || widened || relaxed || (next.kind === 'cli' && !onlyTurnedOff)) requireNative(req);
        if (before && addressChanged && next.kind !== 'cli') {
          const ep = checkEndpoint(next.baseUrl, { allowPrivate: next.allowPrivateNetwork === true });
          if (ep.ok) runtime.keys.dropIfOriginDiffers(id, ep.origin); // a key saved for the old address is deleted, not carried over
        }
        cfg().entries[id] = next;
        persist();
        return runtime.view();
      });

      add('DELETE', '/api/providers/:id', ({ params }) => {
        const id = mustId(params[0]!);
        delete cfg().entries[id];
        runtime.keys.remove(id);
        persist();
        return runtime.view();
      });

      add('PUT', '/api/providers/:id/key', ({ req, params, body }) => {
        const id = mustId(params[0]!);
        requireNative(req);
        if (!isObj(body)) throw new HttpError(400, 'JSON object body required');
        const e = effective(id);
        if (!e) throw new HttpError(404, 'Unknown provider');
        if (e.kind === 'cli') throw new HttpError(400, 'A CLI provider has no key in Legion: sign in to the CLI yourself, outside Legion.');
        const ep = checkEndpoint(e.baseUrl, { allowPrivate: e.allowPrivateNetwork === true });
        if (!ep.ok) throw new HttpError(400, ep.reason);
        try { runtime.keys.set(id, body.key, ep.origin); } catch (err) { throw new HttpError(400, err instanceof Error ? err.message : 'Invalid key'); }
        return runtime.view();
      });

      add('DELETE', '/api/providers/:id/key', ({ params }) => {
        runtime.keys.remove(mustId(params[0]!));
        return runtime.view();
      });

      add('POST', '/api/providers/:id/models', ({ params }) => wrap(async () => ({ models: await runtime.refreshModels(mustId(params[0]!)) })));
      add('POST', '/api/providers/:id/test', ({ params }) => wrap(() => runtime.test(mustId(params[0]!))));
    },
  };
}

/** Only the fields a PUT may set; anything else in the body is ignored. */
function pick(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['kind', 'label', 'baseUrl', 'enabled', 'keyless', 'allowPrivateNetwork', 'models', 'prices', 'wire', 'trusted', 'tokenCapPerTask', 'tokenCapPerDay', 'leadSelectable', 'cli', 'executable', 'sandbox', 'allowedAgents', 'timeoutSeconds']) if (b[k] !== undefined) out[k] = b[k];
  return out;
}
