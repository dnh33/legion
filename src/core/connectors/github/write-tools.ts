/**
 * The GitHub write tools (design 4.3, 4.4, 6.3): exactly the six WRITE names of classes.ts. The gateway has already checked, in order: the
 * agent opted in, the run is not an MCP client's, the master switch is on, the repo is in the agent's `githubWrite`, the repo is turned
 * on in Legion, and the write app is signed in with the permission. What is left is here:
 *
 *   1. check the arguments (types and sizes); a bad one is refused in plain words, with no card;
 *   2. raise ONE card, in every approval mode including `full` (approvals.ts, exception 2026-10-15), naming the repo, the tool, the agent,
 *      the full text of every argument and, when the run read outside text, a warning;
 *   3. only if the owner says yes, send ONE request through `writes.ts`. Never retried: a lost answer is reported as "may have gone through".
 *
 * No answer, a Deny, a timeout, or no way to ask all mean nothing is sent.
 */
import { GhError, validRepo } from './client.js';
import type { Run, ToolCtx, ToolOut } from './tools.js';
import { cancel, commentOn, createIssue, createPullRequest, rerunFailed, submitReview, updateIssue } from './writes.js';
import type { IssueFields, WriteApi } from './writes.js';

/** The card the gateway hands to a write handler to raise. Resolves true only when the owner allowed it. */
export interface WriteCard { tool: string; repo: string; summary: string; input: Record<string, unknown> }
/** What the gateway adds to `ToolCtx` for a write tool. */
export interface WriteCtx extends ToolCtx {
  /** True when the run read outside content before this call (the gateway reads it before it marks the run). Missing counts as true. */
  tainted?: boolean;
  /** Raises the owner's card. Absent: there is no way to ask, so nothing is sent. */
  ask?: (card: WriteCard) => Promise<boolean>;
  /** Runs the gateway's checks again (master switch, repo, agent grant, write app). Returns the refusal in plain words, or undefined when the write may still go. Absent: nothing is sent. */
  recheck?: () => Promise<string | undefined>;
}

/** A write that stopped before or at the card, or after the send: the text is for the agent and is shown as is. */
export class WriteStopped extends Error {
  constructor(message: string) { super(message); this.name = 'WriteStopped'; }
}

export const WRITE_DENIED_TEXT = 'The owner did not approve this write, so nothing was sent to GitHub.';
export const WRITE_NO_ASK_TEXT = 'Legion could not ask the owner to approve this write, so nothing was sent to GitHub.';
export const WRITE_SENT_UNKNOWN_TEXT = 'Legion sent this to GitHub and did not get an answer. It may have gone through. Check on GitHub before asking again. Legion did not send it a second time.';
export const WRITE_TAINT_WARNING = 'This run read text from outside (GitHub, the web or files) before this write. That text may have steered it. Check what it wants to write.';

const MAX_ARGS = 60_000;
const bad = (what: string): WriteStopped => new WriteStopped(`${what} Nothing was sent to GitHub.`);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw bad(`${what} must be a whole number above zero.`);
  return v;
};
const text = (v: unknown, what: string, o: { max: number; required?: boolean }): string | undefined => {
  if (v === undefined || v === null) { if (o.required) throw bad(`${what} is needed.`); return undefined; }
  if (typeof v !== 'string') throw bad(`${what} must be text.`);
  if (o.required && v.trim() === '') throw bad(`${what} is needed.`);
  if (v.length > o.max) throw bad(`${what} is too long (at most ${o.max} characters).`);
  return v;
};
const names = (v: unknown, what: string): string[] | undefined => {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 30 || v.some((x) => typeof x !== 'string' || x === '' || x.length > 100)) throw bad(`${what} must be a short list of names.`);
  return v as string[];
};
const branch = (v: unknown, what: string): string => {
  const s = text(v, what, { max: 250, required: true })!;
  if (/[\u0000-\u001f\u007f\\]/.test(s)) throw bad(`${what} is not a valid branch name.`);
  return s;
};

/** One tool, ready to run: the lines of the card and the one call that sends. */
interface Plan { lines: Array<[string, string]>; send: (api: WriteApi, repo: string) => Promise<ToolOut> }

const PLANS: Record<string, (a: Record<string, unknown>) => Plan> = {
  github_issue_write: (a) => {
    const f: IssueFields = {};
    const title = text(a.title, 'The title', { max: 256 }); if (title !== undefined) f.title = title;
    const body = text(a.body, 'The body', { max: 60_000 }); if (body !== undefined) f.body = body;
    const labels = names(a.labels, 'The labels'); if (labels) f.labels = labels;
    const assignees = names(a.assignees, 'The assignees'); if (assignees) f.assignees = assignees;
    const lines: Array<[string, string]> = [];
    if (a.number !== undefined) {
      const number = posInt(a.number, 'The issue number');
      if (a.state !== undefined) { if (a.state !== 'open' && a.state !== 'closed') throw bad('The state must be open or closed.'); f.state = a.state; }
      if (Object.keys(f).length === 0) throw bad('Say what to change on the issue.');
      lines.push(['action', `change issue #${number}`]);
      for (const [k, v] of Object.entries(f)) lines.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
      return { lines, send: (api, repo) => updateIssue(api, repo, number, f) };
    }
    if (!f.title || f.title.trim() === '') throw bad('The title is needed to open an issue.');
    lines.push(['action', 'open a new issue']);
    for (const [k, v] of Object.entries(f)) lines.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
    return { lines, send: (api, repo) => createIssue(api, repo, { ...f, title: f.title! }) };
  },
  github_comment: (a) => {
    const number = posInt(a.number, 'The issue or pull request number');
    const body = text(a.body, 'The comment', { max: 60_000, required: true })!;
    return { lines: [['action', `comment on #${number}`], ['body', body]], send: (api, repo) => commentOn(api, repo, number, body) };
  },
  github_create_pr: (a) => {
    const title = text(a.title, 'The title', { max: 256, required: true })!;
    const head = branch(a.head, 'The branch to merge from (head)');
    const base = branch(a.base, 'The branch to merge into (base)');
    const body = text(a.body, 'The description', { max: 60_000 });
    if (a.draft !== undefined && typeof a.draft !== 'boolean') throw bad('Draft must be true or false.');
    const f = { title, head, base, ...(body !== undefined ? { body } : {}), ...(a.draft !== undefined ? { draft: a.draft as boolean } : {}) };
    const lines: Array<[string, string]> = [['action', 'open a pull request'], ['title', title], ['from', head], ['into', base]];
    if (a.draft !== undefined) lines.push(['draft', String(a.draft)]);
    if (body !== undefined) lines.push(['body', body]);
    return { lines, send: (api, repo) => createPullRequest(api, repo, f) };
  },
  github_review: (a) => {
    const number = posInt(a.number, 'The pull request number');
    const event = a.event;
    if (event !== 'APPROVE' && event !== 'REQUEST_CHANGES' && event !== 'COMMENT') throw bad('The review must be APPROVE, REQUEST_CHANGES or COMMENT.');
    const body = text(a.body, 'The review text', { max: 60_000, required: event !== 'APPROVE' });
    const lines: Array<[string, string]> = [['action', `review pull request #${number}`], ['verdict', event]];
    if (body !== undefined) lines.push(['body', body]);
    return { lines, send: (api, repo) => submitReview(api, repo, number, { event, ...(body !== undefined ? { body } : {}) }) };
  },
  github_ci_rerun: (a) => {
    const runId = posInt(a.runId, 'The run number');
    return { lines: [['action', `re-run the failed jobs of run ${runId}`]], send: (api, repo) => rerunFailed(runId, repo, api) };
  },
  github_ci_cancel: (a) => {
    const runId = posInt(a.runId, 'The run number');
    return { lines: [['action', `cancel run ${runId}`]], send: (api, repo) => cancel(runId, repo, api) };
  },
};

/** The card text: who, what, where, every argument in full, and the taint warning when it applies. */
export function cardText(tool: string, repo: string, agent: string, lines: Array<[string, string]>, tainted: boolean): string {
  const out = [`GitHub write: ${tool}`, `Repo: ${repo}`, `Agent: ${agent}`, ''];
  for (const [k, v] of lines) out.push(v.includes('\n') ? `${k}:\n${v}` : `${k}: ${v}`);
  if (tainted) out.push('', WRITE_TAINT_WARNING);
  return out.join('\n');
}

function handler(name: string): Run {
  const plan = PLANS[name]!;
  return async (api, args, x): Promise<ToolOut> => {
    const c = x as WriteCtx;
    const repo = typeof args.repo === 'string' ? args.repo : '';
    if (!validRepo(repo)) throw bad('That is not a repository written owner/name.');
    const { repo: _r, ...rest } = args;
    let size = 0;
    try { size = JSON.stringify(rest).length; } catch { throw bad('The arguments could not be read.'); }
    if (size > MAX_ARGS) throw bad('The arguments are too long to show on one card.');
    const p = plan(rest);
    if (!c.ask) throw new WriteStopped(WRITE_NO_ASK_TEXT);
    const summary = cardText(name, repo, c.agent?.name ?? 'An agent', p.lines, c.tainted !== false);
    const input: Record<string, unknown> = { repo, ...rest };
    const allowed = await c.ask({ tool: name, repo, summary, input }).catch(() => false);
    if (allowed !== true) throw new WriteStopped(WRITE_DENIED_TEXT);
    // the card may have been open for minutes: the owner's yes counts only if everything that allowed the card still holds
    if (!c.recheck) throw new WriteStopped(WRITE_NO_ASK_TEXT);
    const refusal = await c.recheck().catch(() => WRITE_NO_ASK_TEXT);
    if (refusal) throw new WriteStopped(`${refusal} Nothing was sent to GitHub.`);
    try {
      return await p.send(api as unknown as WriteApi, repo);
    } catch (e) {
      // the request left, so a lost answer may still have been applied: say so, and never send it again
      if (e instanceof GhError && e.kind === 'network') return { data: { sent: true, result: 'unknown' }, note: WRITE_SENT_UNKNOWN_TEXT };
      throw e;
    }
  };
}

export const GITHUB_WRITE_TOOLS: Record<string, Run> = Object.fromEntries(Object.keys(PLANS).map((n) => [n, handler(n)]));
void isObj;
