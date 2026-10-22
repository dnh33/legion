/**
 * The run key: the one credential an agent host (Hermes) gets so that the tool shim it starts can reach Legion's own tools for
 * that one run (src/core/acp/run-tools.ts is what answers behind it).
 *
 * What the key is, and is not:
 *  - 32 random bytes, in hex, one per run. It is bound to the task and the agent it was issued for: the tools behind it are the
 *    ones built for that run, so it cannot act as another task or agent.
 *  - It is NOT the authToken and opens nothing but `/mcp/run/legion` (admin.ts gate). The authToken and the admin secret do not
 *    open that route either.
 *  - It travels in the shim's environment (never in argv or in a URL) and in an `Authorization: Bearer` header to this core.
 *  - Every key is a Legion secret while it lives: the agent's own environment is cleaned of it and log lines never show it.
 *  - It dies when the run ends or is cancelled (`revoke`), and revoking cuts the calls that are waiting.
 *  - A key whose run has not been attached (`bind`) opens nothing.
 */
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEqual } from '../admin.js';
import type { ProviderHost } from '../providers/types.js';
import { addLegionSecret, removeLegionSecret } from './process.js';
import type { AcpStdioServer } from './session.js';

/** The route the shim talks to. The key goes in the Authorization header, never in this address. */
export const RUN_ROUTE = '/mcp/run/legion';

/** What a run hands over so its tools can be served: the in-process tool servers and the per-call callbacks of a provider run. */
export type RunToolsHost = Pick<ProviderHost, 'servers' | 'authorize' | 'noteToolUse' | 'onToolCall' | 'onToolResult' | 'onNotice' | 'cancelled' | 'signal'> & {
  /** Taken out of every result before it is stored or sent (the run's secrets). Absent: the log redactor (src/core/log/redact.js) is used, never nothing. */
  redact?(text: string): string;
};

/** What the route sees of a live key. */
export interface RunGrant {
  readonly taskId: string;
  readonly agentId: string;
  /** Aborted when the key is revoked. */
  readonly signal: AbortSignal;
  /** The run's tools, or undefined while none are attached. */
  host(): RunToolsHost | undefined;
  /** `cb` runs once when the key is revoked (at once if it already was). */
  onRevoke(cb: () => void): void;
}

export interface RunToken {
  readonly token: string;
  /** Attach the run's tools. Once only: a key serves one run. */
  bind(host: RunToolsHost): void;
  /** End the key. Idempotent. */
  revoke(): void;
}

interface Live { token: string; grant: RunGrant; revoke(): void }
const live = new Map<symbol, Live>();

export function issueRunToken(taskId: string, agentId: string): RunToken {
  if (typeof taskId !== 'string' || !taskId || typeof agentId !== 'string' || !agentId) throw new Error('a run key needs a task and an agent');
  const token = randomBytes(32).toString('hex');
  const id = Symbol('run-key');
  const ac = new AbortController();
  const callbacks: Array<() => void> = [];
  let host: RunToolsHost | undefined;
  let revoked = false;
  addLegionSecret(token);
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    live.delete(id); // first: from here on a new request finds nothing
    removeLegionSecret(token); // this key only, and once
    ac.abort();
    for (const cb of callbacks.splice(0)) { try { cb(); } catch { /* one failing cleanup must not stop the others */ } }
  };
  const grant: RunGrant = {
    taskId, agentId, signal: ac.signal,
    host: () => (revoked ? undefined : host),
    onRevoke: (cb) => { if (revoked) { try { cb(); } catch { /* ignore */ } } else callbacks.push(cb); },
  };
  live.set(id, { token, grant, revoke });
  return {
    token,
    bind(h) {
      if (host) throw new Error('this run key already serves a run');
      if (!revoked) host = h;
    },
    revoke,
  };
}

/**
 * The live key equal to `presented`, or undefined. Compared with a constant-time equality against every live key, with no early
 * exit, so the time taken does not say which key matched or how much of one did.
 */
export function findRunGrant(presented: string): RunGrant | undefined {
  if (typeof presented !== 'string' || !presented) return undefined;
  let hit: RunGrant | undefined;
  for (const l of live.values()) if (safeEqual(presented, l.token)) hit = l.grant;
  return hit;
}

/** Ends every live key: core shutdown. */
export function revokeAllRunTokens(): void {
  for (const l of [...live.values()]) l.revoke();
}

/**
 * The ACP stdio server entry that starts the tool shim for one run. The key is in the environment, not in argv. The shim runs on
 * the same program as the core (Electron in node mode when packaged), so it needs no Node on PATH.
 */
export function shimServer(token: string, port: number): AcpStdioServer {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the core port is not a valid port');
  return {
    name: 'legion',
    command: process.execPath,
    args: [resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'legion-acp-tools-stdio.js')],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
      { name: 'LEGION_RUN_URL', value: `http://127.0.0.1:${port}${RUN_ROUTE}` },
      { name: 'LEGION_RUN_TOKEN', value: token },
    ],
  };
}
