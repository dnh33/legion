/** The SearXNG address rules (pure, no network): the same checks run when the setting is saved and again before every request. */
import { isPrivateLiteral } from '../providers/endpoint.js';

export interface SearxngOk { ok: true; origin: string; host: string; /** origin plus path, no trailing slash */ url: string; /** loopback or a private-network literal: needs the app's native confirmation */ private: boolean; http: boolean }
export interface SearxngBad { ok: false; reason: string }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * https anywhere; http only for loopback or a private-network literal (a home server). Refuses user info, a fragment, a query string
 * and any other scheme. A hostname that the network resolves to a private address cannot be seen here (no DNS lookup is made).
 */
export function checkSearxngAddress(raw: unknown): SearxngOk | SearxngBad {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) return { ok: false, reason: 'The address must be a URL of at most 300 characters.' };
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: 'The address is not a valid URL.' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'Only https addresses are allowed (http only for your computer or a server on your network).' };
  if (u.username || u.password) return { ok: false, reason: 'The address must not contain a user name or password.' };
  if (u.hash) return { ok: false, reason: 'The address must not contain a # fragment.' };
  if (u.search) return { ok: false, reason: 'The address must not contain a query string.' };
  const priv = LOOPBACK.has(u.hostname) || isPrivateLiteral(u.hostname);
  if (u.protocol === 'http:' && !priv) return { ok: false, reason: 'http is only allowed for your computer or a server on your network. Use https for any other host.' };
  return { ok: true, origin: u.origin, host: u.host, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, private: priv, http: u.protocol === 'http:' };
}
