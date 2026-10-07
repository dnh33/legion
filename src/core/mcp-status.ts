/**
 * MCP isolation helpers: which servers a run saw (read-only status for Settings -> MCP) and the guard against Legion connecting to its own /mcp.
 * Nothing here connects, reconnects or edits a server; it only reports what the Claude Code process said.
 */
import { LEGION_SERVER_NAMES } from './approvals.js';
import type { LegionConfig, McpServerState, McpStatusView } from '../shared/types.js';

/** Hostname (WHATWG-normalised, so 127.1, 2130706433 and long IPv6 forms are already canonical) that resolves to this machine by spelling alone. */
function isLoopbackHost(raw: string): boolean {
  let h = raw.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.+$/, ''); // `localhost.` is the same name
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '::' || h === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true; // all of 127.0.0.0/8
  // IPv4-mapped IPv6: URL turns ::ffff:127.0.0.1 into ::ffff:7f00:1
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (m) { const hi = parseInt(m[1]!, 16); return hi >> 8 === 127 || (hi === 0 && parseInt(m[2]!, 16) === 0); }
  return false;
}

/** True when an Authorization header carries Legion's own token: that entry reaches Legion whatever host it names. */
function carriesOwnToken(headers: unknown, authToken: unknown): boolean {
  if (typeof authToken !== 'string' || authToken.length < 8 || !headers || typeof headers !== 'object') return false;
  return Object.entries(headers as Record<string, unknown>).some(([k, v]) => k.toLowerCase() === 'authorization' && typeof v === 'string' && v.includes(authToken));
}

/**
 * True when `url` is Legion's own MCP endpoint: a loopback spelling of this core's port at path /mcp, or (when `own` is given) any entry whose
 * Authorization header carries Legion's own token. A server like that would hand an agent its own Legion. String-based: stdio bridges and
 * DNS names that merely resolve to loopback are not detected.
 */
export function isSelfMcpUrl(url: unknown, port: number, own?: { headers?: unknown; authToken?: unknown }): boolean {
  if (own && carriesOwnToken(own.headers, own.authToken)) return true;
  if (typeof url !== 'string') return false;
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (!isLoopbackHost(u.hostname)) return false;
  const p = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return p === port && u.pathname.replace(/\/+$/, '') === '/mcp';
}

/** Settings -> MCP entries that would point back at Legion itself (hand-edited config.json; the Settings route refuses them). */
export function selfMcpNames(config: LegionConfig): string[] {
  return Object.entries(config.mcpServers ?? {})
    .filter(([, e]) => (e.type === 'http' || e.type === 'sse') && isSelfMcpUrl(e.url, config.port, { headers: e.headers, authToken: config.authToken }))
    .map(([name]) => name);
}

interface Seen { name: string; status: string; source?: string; error?: string }

const STATES: McpServerState[] = ['connected', 'failed', 'needs-auth', 'pending', 'disabled'];
const toState = (s: string): McpServerState => (STATES as string[]).includes(s) ? s as McpServerState : 'unknown';

/** Server error text is untrusted: URLs, key-like query params and Bearer tokens are masked, then one short line, no control characters. */
export function plainError(raw: string | undefined): string {
  return (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b(Bearer|Basic)\s+[^\s,;"')]+/gi, '$1 [redacted]')
    .replace(/([?&;]|\b)(access[_-]?token|api[_-]?key|token|key|auth|secret|password)=[^&\s"')]*/gi, '$1$2=[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"')<>]+/gi, '[url]')
    .trim().slice(0, 160);
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
  private notice: string | undefined;

  setNotice(text: string): void { this.notice = text; }

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
    this.notice = undefined;
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
    for (const name of Object.keys(config.mcpServers ?? {})) {
      // an entry named like one of Legion's own servers is never given to an agent (see Engine.buildMcpServers): say so, do not hide it
      if (LEGION_SERVER_NAMES.has(name)) { byName.delete(name); rows.push({ name, state: 'disabled', origin: 'settings', message: 'Skipped: this name belongs to one of the tool servers Legion provides itself, so it is not given to any agent. Rename the entry in Settings, MCP servers.' }); continue; }
      push(name, 'settings');
    }
    // Everything else the process reported: modules' own servers, and (inherit on) servers from your Claude Code setup.
    for (const s of [...byName.values()]) {
      const state = toState(s.status);
      rows.push({ name: s.name, state, origin: s.source ?? 'unknown', message: describeState(state, s.error) });
    }
    return { inheritMcp: inherit, ...(this.at ? { lastRunAt: this.at } : {}), ...(this.notice ? { notice: this.notice } : {}), servers: rows };
  }
}
