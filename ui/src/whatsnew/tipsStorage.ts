/**
 * What's new tips: what is remembered. Seen versions and the "Show tips after updates" switch live in localStorage like
 * the app's other per-window choices. Every read and write is guarded: when storage is blocked or full nothing throws,
 * the switch reads as on, and a version reads as unseen (the tour then simply shows at most once per launch).
 */
export interface Kv { readonly length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void }

export const SEEN_KEY = 'legion.tips.seen';
export const ENABLED_KEY = 'legion.tips.enabled';

export function readSeen(kv: Kv): string[] {
  try {
    const v: unknown = JSON.parse(kv.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function markSeen(kv: Kv, version: string): void {
  try {
    const seen = readSeen(kv);
    if (!seen.includes(version)) kv.setItem(SEEN_KEY, JSON.stringify([...seen, version]));
  } catch { /* not remembered: the next launch may show the tips once more */ }
}

export function readEnabled(kv: Kv): boolean {
  try { return kv.getItem(ENABLED_KEY) !== '0'; } catch { return true; }
}

export function writeEnabled(kv: Kv, on: boolean): void {
  try { kv.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* not remembered */ }
}
