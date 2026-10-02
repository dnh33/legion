/**
 * The per-server opt-in for starting an owner-configured stdio MCP server in a provider run. The approval is bound to the server's exact
 * command line (command, arguments, and the names and values of its env entries, as a hash): if Settings later changes any of it, the
 * approval no longer matches and the server is not started until the owner confirms the new command line again.
 */
import { createHash } from 'node:crypto';
import type { McpServerEntry } from '../../shared/types.js';

type Stdio = Extract<McpServerEntry, { command: string }>;
export const isStdioEntry = (e: McpServerEntry | undefined): e is Stdio => !!e && (e.type === undefined || e.type === 'stdio') && typeof (e as Stdio).command === 'string';

export function stdioFingerprint(e: Stdio): string {
  const env = Object.entries(e.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify([e.command, e.args ?? [], env])).digest('hex');
}

/** The command line as the confirmation dialog and the Providers panel show it (env VALUES are never shown, only the names). */
export function stdioCommandLine(e: Stdio): string {
  const q = (s: string): string => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : JSON.stringify(s));
  const line = [e.command, ...(e.args ?? [])].map(q).join(' ');
  const names = Object.keys(e.env ?? {});
  return names.length ? `${line}    (env: ${names.join(', ')})` : line;
}
