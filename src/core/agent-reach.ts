/**
 * What an agent can do on the owner's computer, in one line for a lead's roster and the board matcher.
 *
 * Trial finding 1 (2026-10-12): the Marshal handed shell work to agents on other providers that had no shell, because
 * nothing it read said who had one. A Claude agent always has Claude Code's own shell and file tools; an agent on another
 * provider has them only when its agent shell (host tools) is on; a cloud VM is extra.
 */
import type { AgentProfile } from '../shared/types.js';
import { providerPrefix } from './providers/runtime.js';

export function toolsOf(a: Pick<AgentProfile, 'model'> & { host?: { enabled?: boolean }; vm?: { enabled?: boolean } }): string {
  const parts: string[] = [];
  if (!providerPrefix(a.model)) parts.push('shell and file tools (Claude Code)');
  else if (a.host?.enabled === true) parts.push('shell and file tools (agent shell)');
  else parts.push('no shell and no file tools: give it questions, writing and review, not commands or edits');
  if (a.vm?.enabled === true) parts.push('its own cloud VM');
  return parts.join('; ');
}
