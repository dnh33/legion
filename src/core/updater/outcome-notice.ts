/** What the owner is told, on the next start, about an update that did not finish. Pure text and one log line; the window code lives in updater-main.ts. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { formatLine } from '../log/logger.js';
import type { Outcome } from './apply.js';

/** The helper writes short technical reasons; the owner gets plain words. Anything unknown is cleaned and cut, never shown raw and long. */
export function plainReason(reason?: string): string {
  const r = (reason ?? '').trim();
  if (!r) return 'Something went wrong';
  if (/core is still running|still answers on the port/i.test(r)) return 'Legion was opened while it was updating';
  if (/did not exit in time|still running: nothing/i.test(r)) return 'Legion did not close in time';
  if (/files in use|EBUSY|EPERM|EACCES/i.test(r)) return 'Some files were in use';
  if (/did not report healthy|did not become healthy/i.test(r)) return 'The new version did not start correctly, so Legion went back to the previous one';
  if (/^preflight/i.test(r)) return 'Legion could not back up your data first';
  if (/could not prepare the update helper|helper copy/i.test(r)) return 'Legion could not prepare the update helper';
  const clean = r.replace(/[–—]/g, '-').replace(/\s+/g, ' ').replace(/[.\s]+$/, '');
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean;
}

export interface OutcomeNotice { title: string; message: string; buttons: ['Retry', 'Dismiss']; rolledBack: boolean; to: string }
export function outcomeNotice(o: Outcome | null): OutcomeNotice | null {
  if (!o || (o.result !== 'failed' && o.result !== 'rolled-back')) return null;
  return {
    title: 'Legion update',
    message: `The update to ${o.to} did not finish. ${plainReason(o.reason)}. Your files are unchanged.`,
    buttons: ['Retry', 'Dismiss'],
    rolledBack: o.result === 'rolled-back',
    to: o.to,
  };
}

/** One line into <data>/logs/app.log. Never throws. */
export function writeAppLog(dataDirPath: string, level: 'info' | 'warn', event: string, fields: Record<string, string | number | boolean>, nowMs: number = Date.now()): boolean {
  try {
    const dir = join(dataDirPath, 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'app.log'), formatLine(new Date(nowMs), level, 'updater', event, fields) + '\n');
    return true;
  } catch { return false; }
}

/** One app.log line for the outcome found at start. A failure is always logged; an ok one only while it is fresh (it stays on disk until dismissed). */
export function logOutcome(dataDirPath: string, o: Outcome | null, nowMs: number = Date.now()): boolean {
  if (!o) return false;
  const failed = o.result === 'failed' || o.result === 'rolled-back';
  if (!failed) {
    const at = Date.parse(o.at);
    if (o.result !== 'ok' || !Number.isFinite(at) || nowMs - at > 10 * 60_000) return false;
  }
  return writeAppLog(dataDirPath, failed ? 'warn' : 'info', 'outcome', { result: o.result, from: o.from, to: o.to, at: o.at, ...(o.reason ? { reason: o.reason } : {}) }, nowMs);
}
