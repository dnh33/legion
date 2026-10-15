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

export type NoticeCall = (method: 'GET' | 'POST', route: string, body?: unknown) => Promise<{ status: number; json?: any } | undefined>;
export const RETRY_LATER_LINE = 'The update will try again when Legion is idle.';
export type NoticeResult = { kind: 'dismissed' } | { kind: 'installing' } | { kind: 'later'; line: string };

/**
 * What a click on the outcome notice does. Dismiss clears the record. Retry clears it too (a rolled-back version is released first), makes sure
 * an update is known (a fresh start has not checked yet), then installs. If the install is refused or nobody answers, the owner gets one plain
 * line and the reason goes to the log: a Retry never ends in silence.
 */
export async function runNoticeChoice(n: Pick<OutcomeNotice, 'rolledBack' | 'to'>, response: number, call: NoticeCall, log: (line: string) => void): Promise<NoticeResult> {
  if (response !== 0) {
    log('outcome notice: Dismiss clicked');
    await call('POST', '/api/update/ack', {});
    return { kind: 'dismissed' };
  }
  log(`outcome notice: Retry clicked for ${n.to}`);
  if (n.rolledBack) await call('POST', '/api/update/retry', { version: n.to });
  else await call('POST', '/api/update/ack', {});
  const known = async (): Promise<boolean> => { const st = await call('GET', '/api/update/status'); return !!(st && st.status === 200 && (st.json?.available || st.json?.staged)); };
  if (!(await known())) {
    log('outcome notice: no update known yet, checking first');
    const c = await call('POST', '/api/update/check', {});
    if (!c || c.status !== 200) log(`outcome notice: the check did not run (${c ? `status ${c.status}: ${c.json?.error ?? 'no reason'}` : 'the core did not answer'})`);
    await known();
  }
  const r = await call('POST', '/api/update/install', {});
  if (r && r.status === 200) { log('outcome notice: install accepted'); return { kind: 'installing' }; }
  log(`outcome notice: install refused (${r ? `status ${r.status}: ${typeof r.json?.error === 'string' ? r.json.error : 'no reason'}` : 'the core did not answer'})`);
  return { kind: 'later', line: RETRY_LATER_LINE };
}
