/**
 * Provider API keys. They live in <dataDir>/providers/keys.json (owner read/write only, atomic write), never in config.json.
 * Each key is stored with the origin it was saved for and is handed out only for that origin, so repointing a provider at another
 * host cannot send the key there. Same protection class as config.json: other local users are kept out, a process running as the
 * same user is not.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeConfigFile } from '../../shared/config.js';

export const MIN_KEY_LENGTH = 8;
export const MAX_KEY_LENGTH = 500;
export const keyFileFor = (dataDir: string): string => join(dataDir, 'providers', 'keys.json');

interface Stored { key: string; origin: string }

export class ProviderKeys {
  private map = new Map<string, Stored>();
  constructor(private readonly file: string) { this.load(); }

  private load(): void {
    this.map.clear();
    if (!existsSync(this.file)) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { keys?: Record<string, Partial<Stored>> };
      for (const [id, v] of Object.entries(j.keys ?? {})) if (v && typeof v.key === 'string' && typeof v.origin === 'string') this.map.set(id, { key: v.key, origin: v.origin });
    } catch { /* an unreadable file holds no keys; the next save replaces it */ }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const keys: Record<string, Stored> = {};
    for (const [id, v] of this.map) keys[id] = v;
    writeConfigFile(this.file, JSON.stringify({ version: 1, keys }, null, 2));
  }

  /** The key, only when it was saved for exactly this origin. */
  get(id: string, origin: string): string | undefined {
    const s = this.map.get(id);
    return s && s.origin === origin ? s.key : undefined;
  }
  has(id: string): boolean { return this.map.has(id); }
  originOf(id: string): string | undefined { return this.map.get(id)?.origin; }
  hint(id: string): string | undefined { const s = this.map.get(id); return s ? `…${s.key.slice(-4)}` : undefined; }
  /** Every stored key, for redaction of text Legion is about to store or show. */
  all(): string[] { return [...this.map.values()].map((s) => s.key); }

  set(id: string, key: unknown, origin: string): void {
    if (typeof key !== 'string') throw new Error('The key must be text.');
    const k = key.trim();
    if (k.length < MIN_KEY_LENGTH || k.length > MAX_KEY_LENGTH || /\s/.test(k)) throw new Error(`A key is ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters without spaces.`);
    this.map.set(id, { key: k, origin });
    this.save();
  }
  remove(id: string): boolean {
    const had = this.map.delete(id);
    if (had) this.save();
    return had;
  }
  /** The provider's origin changed or the provider was deleted: a key saved for another origin is deleted, not kept. */
  dropIfOriginDiffers(id: string, origin: string): boolean {
    const s = this.map.get(id);
    if (!s || s.origin === origin) return false;
    return this.remove(id);
  }
}
