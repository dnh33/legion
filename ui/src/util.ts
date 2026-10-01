import type { VmState } from '../../src/shared/types';

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const d = Math.max(0, now - new Date(iso).getTime());
  const s = Math.floor(d / 1000);
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
/** "3m ago", or "just now" when relTime says "now". */
export const ago = (iso: string | null | undefined, now = Date.now()): string => { const r = relTime(iso, now); return r === 'now' ? 'just now' : `${r} ago`; };
export const money = (n: number | undefined) => (n == null ? '' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
export const shortTool = (name?: string) => (name ?? 'tool').replace(/^mcp__/, '').replace(/__/g, '·');
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const vmLabel: Record<VmState, string> = {
  none: 'No VM', provisioning: 'Starting', ready: 'Ready', running: 'Running', idle: 'Idle',
  archiving: 'Stopping', archived: 'Stopped', error: 'Error',
};
export type Tone = 'on' | 'busy' | 'off' | 'bad';
export const vmTone = (s: VmState): Tone =>
  s === 'running' || s === 'ready' || s === 'idle' ? 'on' : s === 'provisioning' || s === 'archiving' ? 'busy' : s === 'error' ? 'bad' : 'off';
export const vmIsLive = (s: VmState | undefined) => s === 'running' || s === 'ready' || s === 'idle';

export function tryPretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

/** Short one-line preview of a tool input JSON. */
export function toolPreview(text: string): string {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const pref = ['command', 'file_path', 'path', 'url', 'query', 'pattern', 'prompt', 'description'];
    for (const k of pref) if (typeof o[k] === 'string') return o[k] as string;
    const first = Object.values(o).find((v) => typeof v === 'string');
    if (typeof first === 'string') return first;
  } catch { /* fallthrough */ }
  return text;
}

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }
}

/** Display-only: drop a leading /opus or /sonnet model override from a task title. */
export const cleanTitle = (t: string | undefined) => (t ?? '').replace(/^\s*\/(opus|sonnet)\b\s*/i, '').trim() || 'Untitled';

/** Shorten to n characters with an ellipsis (display only). */
export const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n - 1).trimEnd() + '\u2026' : t);

/** Title without the router prefix and, for bridge tasks, without the "Sender: " lead that the from-chip already says. */
export function taskTitle(title: string, from?: string | null): string {
  let t = cleanTitle(title);
  if (from && t.toLowerCase().startsWith(from.toLowerCase() + ':')) t = t.slice(from.length + 1).trim();
  return t || cleanTitle(title);
}
