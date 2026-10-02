/**
 * Per-provider token counts for the owner's optional daily cap. Kept in <dataDir>/providers/usage.json (no key, no text: only a date
 * and numbers per provider id); in memory only when no file is given. A day is the local calendar day.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeConfigFile } from '../../shared/config.js';

export const usageFileFor = (dataDir: string): string => join(dataDir, 'providers', 'usage.json');

export class TokenLedger {
  private day = '';
  private counts: Record<string, number> = {};
  constructor(private readonly file?: string, private readonly now: () => Date = () => new Date()) { this.load(); }
  private today_(): string { const d = this.now(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as { day?: unknown; counts?: Record<string, unknown> };
      if (typeof j.day === 'string') { this.day = j.day; for (const [k, v] of Object.entries(j.counts ?? {})) if (typeof v === 'number' && Number.isFinite(v) && v >= 0) this.counts[k] = v; }
    } catch { /* an unreadable file counts as empty */ }
  }
  private roll(): void { const t = this.today_(); if (this.day !== t) { this.day = t; this.counts = {}; } }
  today(id: string): number { this.roll(); return this.counts[id] ?? 0; }
  add(id: string, tokens: number): void {
    if (!(tokens > 0)) return;
    this.roll(); this.counts[id] = (this.counts[id] ?? 0) + Math.round(tokens);
    if (!this.file) return;
    try { mkdirSync(dirname(this.file), { recursive: true }); writeConfigFile(this.file, JSON.stringify({ version: 1, day: this.day, counts: this.counts })); } catch { /* advisory */ }
  }
}
