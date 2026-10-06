/**
 * One parser of GitHub's workflow run and job JSON (fields: docs.github.com/en/rest/actions/workflow-runs and workflow-jobs). The connectors
 * session imports this too, so the panel and `github_ci_wait` share one RunSummary shape. Everything is read defensively: a field of the
 * wrong type becomes a default, a row without a numeric id is dropped.
 * Also here: log text handling (cap, strip control characters, mask secret-shaped values).
 */
import type { CiCounts, CiJob, CiRun, RunSummary } from '../../shared/ci.js';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v.slice(0, 40) : null);
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null);
const ms = (a: string | null, b: string | null): number | null => {
  if (!a || !b) return null;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : null;
};
/** Only github.com page links are kept; anything else is dropped so the UI never opens a foreign address. */
const ghUrl = (v: unknown): string => (typeof v === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9._\-\/]+(\?[A-Za-z0-9=&_.\-]*)?$/.test(v) ? v : '');

export function parseRun(raw: unknown): CiRun | null {
  if (!isObj(raw)) return null;
  const id = posInt(raw.id);
  if (id === null) return null;
  const head = isObj(raw.head_commit) ? raw.head_commit : {};
  const status = str(raw.status, 30) || 'unknown';
  const startedAt = strOrNull(raw.run_started_at) ?? strOrNull(raw.created_at);
  const updatedAt = strOrNull(raw.updated_at) ?? startedAt ?? '';
  const title = str(raw.display_title) || str(typeof head.message === 'string' ? head.message.split('\n')[0] : '');
  return {
    id, workflow: str(raw.name, 120) || 'Workflow', branch: str(raw.head_branch, 200), sha: str(raw.head_sha, 40),
    title: title.slice(0, 200), status, conclusion: strOrNull(raw.conclusion), url: ghUrl(raw.html_url), event: str(raw.event, 40),
    attempt: posInt(raw.run_attempt) ?? 1, createdAt: strOrNull(raw.created_at) ?? updatedAt, startedAt, updatedAt,
    durationMs: status === 'completed' ? ms(startedAt, updatedAt) : null,
  };
}

/** `{ workflow_runs: [...] }` as GitHub returns it. Anything else is an empty list. */
export function parseRuns(json: unknown): CiRun[] {
  const list = isObj(json) && Array.isArray(json.workflow_runs) ? json.workflow_runs : [];
  return list.map(parseRun).filter((r): r is CiRun => r !== null);
}

const osOf = (text: string): CiJob['os'] => {
  const t = text.toLowerCase();
  if (/windows|\bwin\b|win-/.test(t)) return 'windows';
  if (/macos|mac-|osx|darwin/.test(t)) return 'macos';
  if (/ubuntu|linux/.test(t)) return 'linux';
  return null;
};

export function parseJob(raw: unknown): CiJob | null {
  if (!isObj(raw)) return null;
  const id = posInt(raw.id);
  if (id === null) return null;
  const name = str(raw.name, 200) || 'Job';
  const labels = Array.isArray(raw.labels) ? raw.labels.filter((l): l is string => typeof l === 'string').join(' ') : '';
  const startedAt = strOrNull(raw.started_at);
  const completedAt = strOrNull(raw.completed_at);
  return { id, name, status: str(raw.status, 30) || 'unknown', conclusion: strOrNull(raw.conclusion), url: ghUrl(raw.html_url), startedAt, completedAt, durationMs: ms(startedAt, completedAt), os: osOf(name) ?? osOf(labels) };
}

export function parseJobs(json: unknown): CiJob[] {
  const list = isObj(json) && Array.isArray(json.jobs) ? json.jobs : [];
  return list.map(parseJob).filter((j): j is CiJob => j !== null);
}

const FAILED = new Set(['failure', 'timed_out', 'startup_failure', 'action_required']);
export const isFailure = (conclusion: string | null): boolean => !!conclusion && FAILED.has(conclusion);
export const isRunning = (status: string): boolean => status !== 'completed' && status !== 'unknown';

/** The shape `github_ci_wait` returns: `{status, conclusion, url, failedJobs:[{id,name,conclusion}]}`. */
export function summarizeRun(run: Pick<CiRun, 'status' | 'conclusion' | 'url'>, jobs: CiJob[]): RunSummary {
  return {
    status: run.status, conclusion: run.conclusion, url: run.url,
    failedJobs: jobs.filter((j) => isFailure(j.conclusion)).map((j) => ({ id: j.id, name: j.name, conclusion: j.conclusion })),
  };
}

/** Chip counts for one branch: the latest run of each workflow on it. */
export function countsFor(runs: CiRun[], branch: string | null): CiCounts {
  const latest = new Map<string, CiRun>();
  for (const r of runs) {
    if (branch !== null && r.branch !== branch) continue;
    const cur = latest.get(r.workflow);
    if (!cur || r.createdAt > cur.createdAt || (r.createdAt === cur.createdAt && r.id > cur.id)) latest.set(r.workflow, r);
  }
  const c: CiCounts = { success: 0, failure: 0, running: 0 };
  for (const r of latest.values()) {
    if (isRunning(r.status)) c.running++;
    else if (isFailure(r.conclusion)) c.failure++;
    else if (r.conclusion === 'success') c.success++;
  }
  return c;
}

/* ---------- log text: outside content, shown as plain text only ---------- */

export const LOG_MAX_LINES = 500;
export const LOG_MAX_CHARS = 60_000;

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_\-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g,
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=\-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const ASSIGNED = /\b((?:[A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|apikey|private[_-]?key|authorization))\s*[=:]\s*)(["']?)[^\s"']{6,}\2/gi;

/** Replaces secret-shaped values with a short prefix and `***`. Returns whether anything was masked. */
export function maskSecrets(text: string): { text: string; masked: boolean } {
  let masked = false;
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => { masked = true; return `${m.slice(0, 4)}***`; });
  out = out.replace(ASSIGNED, (_m, head: string) => { masked = true; return `${head}***`; });
  return { text: out, masked };
}

/**
 * Prepares a job log for display: removes ANSI escapes and control characters (tabs kept), keeps the LAST lines (the failure is at the end),
 * caps the size, masks secrets. The result is plain text: the UI must render it as text, never as HTML.
 */
export function prepareLog(raw: string, alreadyTruncated = false): { text: string; truncated: boolean; masked: boolean } {
  let t = raw.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\u001b[@-Z\\-_]/g, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  let truncated = alreadyTruncated;
  // GitHub prefixes each line with an ISO timestamp; they add width and no meaning here
  t = t.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/gm, '');
  // Mask the whole text BEFORE cutting it: a secret that straddles the cut would keep its tail without the prefix the
  // patterns need, and that fragment would then reach the UI or an agent.
  const m = maskSecrets(t);
  t = m.text;
  const lines = t.split('\n');
  if (lines.length > LOG_MAX_LINES) { lines.splice(0, lines.length - LOG_MAX_LINES); truncated = true; }
  t = lines.join('\n');
  if (t.length > LOG_MAX_CHARS) { t = t.slice(t.length - LOG_MAX_CHARS); truncated = true; }
  return { text: t, truncated, masked: m.masked };
}
