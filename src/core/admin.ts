/**
 * Two-secret model (token fix v1).
 *
 * 1. `authToken` (config.json) is the MCP-CLIENT secret: Claude Code, Cowork and curl hold it. It opens `/mcp` and the small
 *    client route list below. It cannot approve, accept notes, change settings or touch BSV.
 * 2. The ADMIN secret is generated per launch by the Electron main process, handed to its core child over the stdin pipe and kept
 *    only in memory (never env, argv or a file, never logged or echoed). The UI sends it as `X-Legion-Admin`.
 *
 * Everything not listed as a client route needs the admin secret (default deny, decided BEFORE routing, so an unknown path is a 403, not a 404).
 * A core without a secret (headless, started by the MCP stdio bridge) is admin-closed: nothing can pass the gate.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ADMIN_HEADER = 'x-legion-admin';
/** Env flag the Electron main sets to say "the admin secret is on stdin". Its value is only ever '1', never the secret. */
export const ADMIN_STDIN_FLAG = 'LEGION_ADMIN_STDIN';
/** Anything shorter is ignored (admin stays closed) rather than accepted as a guessable secret. Electron sends 64 hex chars (32 random bytes). */
export const MIN_ADMIN_SECRET_LENGTH = 32;

/** Constant-time string compare (length differences are not hidden; secrets are fixed length). */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** A challenge nonce for `GET /health?nonce=`: 16 to 128 hex characters. */
export const isHexNonce = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{16,128}$/i.test(v);

/**
 * Proof that a core holds the admin secret, without revealing it: HMAC-SHA256(secret, nonce) as hex. The Electron app sends a fresh random
 * nonce to /health and hands the renderer the secret only if the answer matches; anything else on the port (a foreign core, a rogue
 * server that copies our pid) cannot produce it.
 */
export function healthProof(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(nonce, 'utf8').digest('hex');
}

/** True when `given` (the header value) equals the per-launch secret. No secret configured: always false. */
export function isAdminSecret(given: string | string[] | undefined, secret: string | undefined): boolean {
  if (typeof given !== 'string' || !given || !secret) return false;
  return safeEqual(given, secret);
}

/**
 * Routes the MCP-client token may call. Everything else is admin-only: approvals, settings, agent edits, VM start/stop/exec/desktop,
 * every /api/kg/* (GETs too: they run as the human and skip per-agent visibility), rooms, BSV, doctor, config, task edits/deletes.
 */
const CLIENT_ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/api\/state\/?$/],
  ['GET', /^\/api\/agents\/?$/],
  ['GET', /^\/api\/catalog\/?$/],
  ['GET', /^\/api\/tasks\/[^/]+(\/wait)?\/?$/],
  ['POST', /^\/api\/tasks\/?$/],
  ['POST', /^\/api\/tasks\/[^/]+\/cancel\/?$/],
  // BSV freeze only makes Legion safer (it denies, disarms and stops wallet contact), so a core with no app window can still be frozen with the bearer token.
  // Nothing that loosens BSV policy is here.
  ['POST', /^\/api\/bsv\/policy\/freeze\/?$/],
];
export function isClientRoute(method: string, path: string): boolean {
  return CLIENT_ROUTES.some(([m, re]) => m === method && re.test(path));
}
export const isMcpPath = (path: string): boolean => path === '/mcp';
export const isSsePath = (method: string, path: string): boolean => method === 'GET' && path === '/api/events';

export type GateDecision =
  | { allow: true; admin: boolean }
  | { allow: false; status: 401 | 403; error: string };

/**
 * The whole gate, pure. `bearerOk` = a valid `authToken` was presented (header; `?token=` only for SSE, resolved by the caller).
 * Admin secret alone is enough (the UI sends both). Order: admin header, then bearer validity, then route class.
 */
export function gate(input: { method: string; path: string; adminOk: boolean; bearerOk: boolean; hasSecret: boolean }): GateDecision {
  if (input.adminOk) return { allow: true, admin: true };
  if (!input.bearerOk) return { allow: false, status: 401, error: 'Unauthorized: missing or invalid bearer token' };
  if (isMcpPath(input.path) || isSsePath(input.method, input.path) || isClientRoute(input.method, input.path)) return { allow: true, admin: false };
  return {
    allow: false, status: 403,
    error: input.hasSecret ? 'admin_required' : 'admin_unavailable: open the Legion app',
  };
}

/**
 * Reads the admin secret from a stream (the stdin pipe): the first line, or everything up to EOF. Resolves undefined on timeout, EOF
 * with nothing, or a value shorter than MIN_ADMIN_SECRET_LENGTH. The secret is returned, never logged, and the stream is released.
 */
export function readSecretFromStream(stream: NodeJS.ReadableStream, timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onEnd);
      try { stream.pause(); } catch { /* ignore */ }
      buf = '';
      resolve(value && value.length >= MIN_ADMIN_SECRET_LENGTH ? value : undefined);
    };
    const onData = (c: Buffer | string) => {
      buf += typeof c === 'string' ? c : c.toString('utf8');
      const i = buf.indexOf('\n');
      if (i >= 0) finish(buf.slice(0, i).trim());
    };
    const onEnd = () => finish(buf.trim());
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onEnd);
    try { (stream as { resume?: () => void }).resume?.(); } catch { /* ignore */ }
  });
}

/**
 * Core start: if the flag is set, take the secret from stdin; the flag is removed from the environment (it is not the secret,
 * but nothing about it should reach agent children). Never reads an env value, argv or a file.
 */
export async function readAdminSecret(env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream): Promise<string | undefined> {
  if (env[ADMIN_STDIN_FLAG] !== '1') return undefined;
  delete env[ADMIN_STDIN_FLAG];
  return readSecretFromStream(stdin);
}

/** The two per-launch secrets the Electron main process hands its core: `admin` (also given to the app window) and `native` (never given to the window). */
export interface LaunchSecrets { admin?: string; native?: string }
export const NATIVE_HEADER = 'x-legion-native';

/**
 * Reads up to two secret lines from the stdin pipe: the admin secret, then the NATIVE secret. The native secret is held by the Electron
 * main process only (the app window never sees it); the core demands it, in addition to the admin secret, for every change to BSV policy
 * state, so that a compromised window cannot arm or unfreeze on its own: the change has to come from main, after its confirmation dialog.
 * A missing or short second line leaves `native` undefined (policy changes then stay closed). After the first line the reader waits at
 * most `followMs` for the second.
 */
export function readSecretsFromStream(stream: NodeJS.ReadableStream, timeoutMs = 5000, followMs = 400): Promise<LaunchSecrets> {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => finish(), timeoutMs);
    let follow: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (follow) clearTimeout(follow);
      stream.removeListener('data', onData);
      stream.removeListener('end', finish);
      stream.removeListener('error', finish);
      try { stream.pause(); } catch { /* ignore */ }
      const parts = buf.split('\n').map((l) => l.trim());
      buf = '';
      const ok = (v: string | undefined) => (v && v.length >= MIN_ADMIN_SECRET_LENGTH ? v : undefined);
      resolve({ admin: ok(parts[0]), native: ok(parts[1]) });
    };
    const onData = (c: Buffer | string) => {
      buf += typeof c === 'string' ? c : c.toString('utf8');
      const lines = buf.split('\n');
      if (lines.length >= 3) finish(); // two complete lines
      else if (lines.length === 2 && !follow) follow = setTimeout(finish, followMs);
    };
    stream.on('data', onData);
    stream.on('end', finish);
    stream.on('error', finish);
    try { (stream as { resume?: () => void }).resume?.(); } catch { /* ignore */ }
  });
}

/** Core start: like readAdminSecret, but also takes the native secret (second line). */
export async function readLaunchSecrets(env: NodeJS.ProcessEnv, stdin: NodeJS.ReadableStream): Promise<LaunchSecrets> {
  if (env[ADMIN_STDIN_FLAG] !== '1') return {};
  delete env[ADMIN_STDIN_FLAG];
  return readSecretsFromStream(stdin);
}
