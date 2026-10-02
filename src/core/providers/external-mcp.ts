/**
 * The MCP servers the owner added in Settings (stdio, http, sse), reached by Legion's own MCP client for a run on a provider. A Claude
 * run gets these through the Claude Agent SDK; a provider run has no SDK, so this file does the same job under stricter rules:
 * a stdio server starts with the SDK's small default environment plus only the env entries the owner wrote for it (never the core's
 * whole environment, which may hold other keys); an http or sse address must be https, or this computer, with no redirect followed;
 * a server's stderr is dropped. The tools are named `mcp__<server>__<tool>` and are NOT Legion tools, so they need an approval card in
 * every mode but full and taint the run, exactly as for Claude. This file is on the tripwire list for the network and for starting
 * the owner's own configured commands (the stdio transport of the MCP SDK does the spawn; no other providers file imports it).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { checkEndpoint } from './endpoint.js';

export type ExternalServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

export interface ExternalConnection { client: Client; close(): Promise<void> }

const CONNECT_TIMEOUT_MS = 30_000;

/** No redirect is ever followed: a redirect would send the owner's configured headers somewhere they did not choose. */
const noRedirectFetch = (url: string | URL, init?: RequestInit): Promise<Response> => fetch(url, { ...init, redirect: 'manual' });

/** Connects to one configured server; throws a plain-words error (never one that holds a header or env value). */
export async function connectExternal(name: string, cfg: ExternalServerConfig): Promise<ExternalConnection> {
  let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
  if (cfg.type === 'http' || cfg.type === 'sse') {
    const ep = checkEndpoint(cfg.url, { allowPrivate: true });
    if (!ep.ok) throw new Error(`the address is not allowed (${ep.reason})`);
    const requestInit: RequestInit = { ...(cfg.headers ? { headers: cfg.headers } : {}), redirect: 'manual' };
    const url = new URL(cfg.url);
    transport = cfg.type === 'http'
      ? new StreamableHTTPClientTransport(url, { requestInit, fetch: noRedirectFetch })
      : new SSEClientTransport(url, { requestInit, fetch: noRedirectFetch });
  } else {
    const c = cfg as Extract<ExternalServerConfig, { command: string }>;
    if (!c.command || /[\r\n\0]/.test(c.command)) throw new Error('the command is not valid');
    transport = new StdioClientTransport({ command: c.command, args: c.args ?? [], ...(c.env ? { env: c.env } : {}), stderr: 'ignore' });
  }
  const client = new Client({ name: `legion-${name}`.slice(0, 60), version: '1' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('it did not answer in time')), CONNECT_TIMEOUT_MS); }),
    ]);
  } catch (e) {
    try { await client.close(); } catch { /* ignore */ }
    try { await transport.close(); } catch { /* ignore */ }
    throw new Error(e instanceof Error ? e.message.replace(/\s+/g, ' ').slice(0, 160) : 'could not connect');
  } finally { if (timer) clearTimeout(timer); }
  return { client, async close() { try { await client.close(); } catch { /* ignore */ } try { await transport.close(); } catch { /* ignore */ } } };
}
