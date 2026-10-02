/**
 * MCP isolation helpers: which servers a run saw (read-only status for Settings -> MCP) and the guard against Legion connecting to its own /mcp.
 * Nothing here connects, reconnects or edits a server; it only reports what the Claude Code process said.
 */
import type { LegionConfig, McpServerState, McpStatusView } from '../shared/types.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '[::]']);

/** True when `url` is Legion's own MCP endpoint (loopback host, this core's port, path /mcp). A server like that would hand an agent its own Legion. */
export function isSelfMcpUrl(url: unknown, port: number): boolean {
  if (typeof url !== 'string') return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (!LOOPBACK.has(u.hostname.toLowerCase())) return false;
  const p = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return p === port && u.pathname.replace(/\/+$/, '') === '/mcp';
}

/** Settings -> MCP entries that would point back at Legion itself (hand-edited config.json; the Settings route refuses them). */
export function selfMcpNames(config: LegionConfig): string[] {
  return Object.entries(config.mcpServers ?? {})
    .filter(([, e]) => (e.type === 'http' || e.type === 'sse') && isSelfMcpUrl(e.url, config.port))
    .map(([name]) => name);
}

interface Seen { name: string; status: string; source?: string; error?: string }

const STATES: McpServerState[] = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'];
const toState = (s: string): McpServerState => (STATES as string[]).includes(s) ? s as McpServerState : 'unknown';

/** Server error text is untrusted: one short line, no control characters. */
export function plainError(raw: string | undefined): string {
  return (raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 160);
}

export function describeState(state: McpServerState, error?: string): string {
  switch (state) {
    case 'connected': return 'Connected on the last run.';
    case 'failed': { const e = plainError(error); return `Could not connect on the last run${e ? ` (${e})` : ''}. Check the command or URL in its settings.`; }
    case 'needs-auth': return 'The server asked for sign-in. Legion cannot sign in to it for you; add its token under Headers or Environment.';
    case 'pending': return 'Was still connecting when the run started.';
    case 'disabled': return 'Turned off for the last run.';
    case 'not-seen': return 'Not used on any run since Legion started.';
    default: return 'The status was not recognised.';
  }
}

/** Remembers the server list the Claude Code process reported at the start of the latest run. */
export class McpStatusTracker {
  private seen: Seen[] = [];
  private at: string | undefined;

  /** `servers` is the `mcp_servers` list of a system/init message (or mcpServerStatus() output); error text only comes from the latter. */
  record(servers: unknown, at: string): void {
    if (!Array.isArray(servers)) return;
    const out: Seen[] = [];
    for (const s of servers) {
      if (!s || typeof s !== 'object' || typeof (s as any).name !== 'string' || typeof (s as any).status !== 'string') continue;
      const o = s as any;
      out.push({ name: o.name, status: o.status, ...(typeof o.source === 'string' ? { source: o.source } : typeof o.scope === 'string' ? { source: o.scope } : {}), ...(typeof o.error === 'string' ? { error: o.error } : {}) });
    }
    this.seen = out;
    this.at = at;
  }

  /** Merge details (errors) learned from mcpServerStatus() into the current snapshot without moving its time. */
  addDetails(servers: unknown): void {
    if (!Array.isArray(servers)) return;
    for (const s of servers) {
      const o = s as any;
      const cur = this.seen.find((x) => x.name === o?.name);
      if (cur && typeof o.status === 'string') { cur.status = o.status; if (typeof o.error === 'string') cur.error = o.error; }
    }
  }

  view(config: LegionConfig): McpStatusView {
    const inherit = config.claude.inheritMcp === true;
    const byName = new Map(this.seen.map((s) => [s.name, s]));
    const rows: McpStatusView['servers'] = [];
    const push = (name: string, origin: string) => {
      const s = byName.get(name);
      const state: McpServerState = s ? toState(s.status) : 'not-seen';
      rows.push({ name, state, origin, message: describeState(state, s?.error) });
      byName.delete(name);
    };
    push('legion', 'legion');
    for (const name of Object.keys(config.mcpServers ?? {})) push(name, 'settings');
    // Everything else the process reported: modules' own servers, and (inherit on) servers from your Claude Code setup.
    for (const s of [...byName.values()]) {
      const state = toState(s.status);
      rows.push({ name: s.name, state, origin: s.source ?? 'unknown', message: describeState(state, s.error) });
    }
    return { inheritMcp: inherit, ...(this.at ? { lastRunAt: this.at } : {}), servers: rows };
  }
}
