/**
 * The log redactor: what every log line passes through before it is written (plan-logging.md, agreed with the
 * connectors session on 2026-10-07).
 *
 * General token shapes live in `scrubSecrets` (src/core/comms/scrub.ts), one list for every caller. This file adds only
 * what a log needs on top of that:
 *   - exact values the core holds in memory (the admin secret, the native secret, the connectors data key), matched as
 *     the raw value and its base64, base64url and hex forms, because a value can be logged in any of those encodings;
 *   - OAuth device-flow codes (the device code next to its label, and the user code next to its label);
 *   - query strings on URLs: a log never needs them, and a signed URL carries its capability there.
 *
 * The exact-value list lives in this module's memory only. It is never serialised, exported or logged.
 */
import { scrubSecrets } from '../comms/scrub.js';

const exactValues = new Set<string>();

/** Values shorter than this are not registered: they would mask ordinary words. */
const MIN_EXACT = 8;

function encodings(value: string): string[] {
  const buf = Buffer.from(value, 'utf8');
  const out = [value, buf.toString('base64'), buf.toString('base64url'), buf.toString('hex')];
  // base64 without padding also appears in logs (e.g. inside URLs or JSON)
  out.push(buf.toString('base64').replace(/=+$/, ''));
  return [...new Set(out)].filter((v) => v.length >= MIN_EXACT);
}

/** Registers a secret the core holds, so it can never be written to a log in any common encoding. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value !== 'string' || value.length < MIN_EXACT) return;
  for (const v of encodings(value)) exactValues.add(v);
}

/** Test hook: forgets every registered value. */
export function clearRegisteredSecrets(): void {
  exactValues.clear();
}

const LOG_RULES: Array<{ re: RegExp; to: string | ((...m: string[]) => string) }> = [
  // OAuth device flow (RFC 8628): the device code and the user code, next to their labels
  { re: /(\bdevice[_ -]?code\b["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{8,}/gi, to: (_m: string, pre: string) => `${pre}[redacted-code]` },
  { re: /(\buser[_ -]?code\b["']?\s*[:=]\s*["']?)[A-Z0-9]{4}-?[A-Z0-9]{4}\b/gi, to: (_m: string, pre: string) => `${pre}[redacted-code]` },
  // any query string on a URL: logs keep scheme, host and path only
  { re: /(\b(?:https?|wss?):\/\/[^\s"'<>?#]*)\?[^\s"'<>]*/gi, to: (_m: string, url: string) => `${url}?[redacted-query]` },
];

/** Redacts one log line. Exact values first (longest first, so an encoding that contains another is caught whole). */
export function redact(line: string): string {
  let out = line;
  if (exactValues.size) {
    for (const v of [...exactValues].sort((a, b) => b.length - a.length)) {
      if (out.includes(v)) out = out.split(v).join('[redacted-secret]');
    }
  }
  // Bare 64-hex is masked too (it can be a private key); a transaction id in a log is masked as a side effect.
  out = scrubSecrets(out);
  for (const r of LOG_RULES) out = out.replace(r.re, r.to as never);
  return out;
}
