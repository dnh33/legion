/** Tiny shared helpers. */
import { randomUUID } from 'node:crypto';

export const nowIso = (): string => new Date().toISOString();
export const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
export const slugify = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';
export const titleFrom = (prompt: string): string => {
  const one = prompt.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? one.slice(0, 57) + '…' : one;
};
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
