/**
 * The seam between Legion and whatever talks to Blender. The guard (guard.ts) is the only caller of `exec`: agents never get it.
 * Two implementations: the community add-on's JSON socket (backends/community.ts) and the official Blender Lab MCP server over stdio
 * (backends/official.ts). Tests use an in-process fake.
 */
import type { BlenderBackendKind } from '../../shared/blender.js';

export interface BackendImage { mime: string; /** base64 */ data: string }
export interface BackendResult {
  ok: boolean;
  text: string;
  images: BackendImage[];
  /** The call hit its time limit; whatever it started in Blender may still be running. */
  timedOut?: boolean;
}

export interface BlenderBackend {
  readonly kind: BlenderBackendKind;
  /** Opens the connection if it is not open (idempotent). Throws a plain-language Error when Blender or the add-on is not reachable. */
  connect(): Promise<void>;
  isConnected(): boolean;
  /** RAW code execution. Only the guard calls this, after the static check and an approval (or for a fixed script Legion wrote itself). */
  exec(script: string, opts?: { timeoutMs?: number }): Promise<BackendResult>;
  inspect(opts: { object?: string }): Promise<BackendResult>;
  screenshot(opts: { maxSize?: number }): Promise<BackendResult>;
  docs(query: string): Promise<BackendResult>;
  /** Tool names the server offers (official backend only); for the status view. */
  toolNames?(): string[];
  close(): Promise<void>;
}

/**
 * Every Python program Legion starts for Blender (the MCP server, `blender --python-expr`, the GUI) gets these two. On Windows Python writes
 * stdout/stderr in the ANSI code page (cp1252), so a script or a reply that holds U+2028, an emoji or any other character outside it raises
 * UnicodeEncodeError and the run fails for a reason the user cannot see. UTF-8 mode also makes open() default to UTF-8. Legion reads the output as UTF-8.
 */
export const PYTHON_UTF8_ENV: Readonly<Record<string, string>> = Object.freeze({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });

export const ok = (text: string, images: BackendImage[] = []): BackendResult => ({ ok: true, text, images });
export const fail = (text: string, timedOut = false): BackendResult => ({ ok: false, text, images: [], ...(timedOut ? { timedOut: true } : {}) });

/** Hard cap on text that goes back to an agent. */
export const MAX_RESULT_CHARS = 12_000;
export function capText(s: string, max = MAX_RESULT_CHARS): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[truncated: ${s.length - max} more characters]`;
}
