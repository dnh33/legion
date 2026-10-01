/** Tiny shared helpers. */
import { randomUUID } from 'node:crypto';

export const nowIso = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';
/**
 * A free agent id for a new agent: the slug itself, or on ANY collision the slug plus a short random suffix. Never "-2": a
 * numbered suffix would tell a caller that the id was taken, which includes ids of agents that are hidden from them.
 */
export const uniqueAgentId = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (;;) {
    const bytes = new Uint8Array(5);
    globalThis.crypto.getRandomValues(bytes);
    const suffix = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    const id = `${base.slice(0, 32)}-${suffix}`;
    if (!taken.has(id)) return id;
  }
};
export const titleFrom = (prompt: string): string => {
  const one = prompt.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? one.slice(0, 57) + '…' : one;
};
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
