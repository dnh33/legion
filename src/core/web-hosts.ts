/**
 * When each approved site was approved and last read: `<gates dir>/web-last-used.json`, written atomically (temp file, then rename).
 * Advisory and unsigned: it is only used to suggest sites the owner may remove (a tightening), never to decide a read. A missing,
 * corrupt or wrongly shaped file reads as empty, a write that fails is dropped, and an entry is never pruned.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalHost } from '../shared/web-verdict.js';

export interface WebHostDates { lastUsed?: string; approvedAt?: string }
export interface WebLastUsed {
  /** An agent read this site just now. */
  touch(host: string, at?: Date): void;
  /** The owner approved this site just now. */
  approved(host: string, at?: Date): void;
  get(): Record<string, WebHostDates>;
}

const FILE = 'web-last-used.json';
/** A read within this long of the last one is not written again: the file is advisory, and a busy run would otherwise rewrite it on every fetch. */
const TOUCH_GAP_MS = 60_000;

const isoOrUndefined = (v: unknown): string | undefined => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined);

function load(file: string): Record<string, WebHostDates> {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    const hosts = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { hosts?: unknown }).hosts : undefined;
    if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) return {};
    const out: Record<string, WebHostDates> = {};
    for (const [h, d] of Object.entries(hosts)) {
      if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
      const lastUsed = isoOrUndefined((d as WebHostDates).lastUsed), approvedAt = isoOrUndefined((d as WebHostDates).approvedAt);
      if ((d as WebHostDates).lastUsed !== undefined && !lastUsed) continue;
      if ((d as WebHostDates).approvedAt !== undefined && !approvedAt) continue;
      if (lastUsed || approvedAt) out[h] = { ...(approvedAt ? { approvedAt } : {}), ...(lastUsed ? { lastUsed } : {}) };
    }
    return out;
  } catch { return {}; }
}

export function createWebLastUsed(folder: string): WebLastUsed {
  const file = join(folder, FILE);
  const hosts = load(file);
  const save = (): void => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, hosts }), 'utf8');
      renameSync(tmp, file);
    } catch { /* advisory: a lost write only costs a suggestion */ }
  };
  const key = (host: string): string => canonicalHost(`https://${host.trim()}`) ?? host.trim().toLowerCase().replace(/\.$/, '');
  return {
    touch(host, at = new Date()) {
      const k = key(host), cur = hosts[k], now = at.toISOString();
      const gap = cur?.lastUsed ? at.getTime() - Date.parse(cur.lastUsed) : Infinity;
      if (gap >= 0 && gap < TOUCH_GAP_MS) return;
      hosts[k] = { ...cur, lastUsed: now };
      save();
    },
    approved(host, at = new Date()) {
      const k = key(host);
      hosts[k] = { ...hosts[k], approvedAt: at.toISOString() };
      save();
    },
    get() {
      const out: Record<string, WebHostDates> = {};
      for (const [h, d] of Object.entries(hosts)) out[h] = { ...d };
      return out;
    },
  };
}
