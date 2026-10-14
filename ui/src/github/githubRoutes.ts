/**
 * The GitHub area's real routes, read and checked in one place (no React, no store, so the tests can import it).
 * Shapes are the ones src/core/connectors/github/area.ts and repo-admin.ts send. A reply that does not match throws a plain error:
 * the area never guesses at a shape it was not sent.
 */
import type { GithubActivityItem } from '../../../src/shared/github-area.js';
import type { GithubActivity, GithubProjectUse } from './types.js';

const BAD = 'Legion sent a reply it could not read.';
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): v is string => typeof v === 'string';

/** What agents did, with the agent's name. The core gives no link to the item, so there is none: the row is text, not a button. */
export function activityFrom(items: GithubActivityItem[] | undefined, agents: Array<{ id: string; name: string }>): GithubActivity[] {
  return (items ?? []).map((x, i) => ({
    id: `${x.at}-${x.agentId}-${x.repo}-${i}`,
    at: x.at,
    agent: agents.find((a) => a.id === x.agentId)?.name ?? 'An agent',
    kind: x.kind,
    repo: x.repo,
    ...(x.title ? { title: x.title } : {}),
  }));
}

/** GET /api/github/projects-using/:owner/:name answers { projects: [{ id, name, level }] }. */
export function parseProjectsUsing(v: unknown): GithubProjectUse[] {
  const list = rec(v)?.projects;
  if (!Array.isArray(list)) throw new Error(BAD);
  return list.map((p) => {
    const o = rec(p);
    if (!o || !str(o.id) || !str(o.name) || (o.level !== 'none' && o.level !== 'read' && o.level !== 'write')) throw new Error(BAD);
    return { id: o.id, name: o.name, level: o.level };
  });
}

export type CreateReply = { phase: 'needs-write'; message: string } | { phase: 'done'; fullName: string; htmlUrl: string; ticked: boolean };
/** POST /api/github/repos answers { phase: 'needs-write', message } or { phase: 'done', fullName, htmlUrl, ticked }. */
export function parseCreateReply(v: unknown): CreateReply {
  const o = rec(v);
  if (o?.phase === 'needs-write' && str(o.message)) return { phase: 'needs-write', message: o.message };
  if (o?.phase === 'done' && str(o.fullName) && str(o.htmlUrl) && typeof o.ticked === 'boolean') return { phase: 'done', fullName: o.fullName, htmlUrl: o.htmlUrl, ticked: o.ticked };
  throw new Error(BAD);
}

/** GET /api/github/orgs answers { orgs: [{ login }] }. */
export function parseOrgs(v: unknown): string[] {
  const list = rec(v)?.orgs;
  if (!Array.isArray(list)) throw new Error(BAD);
  return list.flatMap((o) => { const l = rec(o)?.login; return str(l) ? [l] : []; });
}

export type WriteFlow = { phase: 'pending'; userCode: string; verificationUri: string; expiresAt: number } | { phase: 'failed'; message: string } | { phase: 'idle' };
/** POST /api/github/apps/write/connect answers the sign-in as it stands. */
export function parseWriteFlow(v: unknown): WriteFlow {
  const o = rec(v);
  if (o?.phase === 'idle') return { phase: 'idle' };
  if (o?.phase === 'failed' && str(o.message)) return { phase: 'failed', message: o.message };
  if (o?.phase === 'pending' && str(o.userCode) && str(o.verificationUri) && typeof o.expiresAt === 'number') return { phase: 'pending', userCode: o.userCode, verificationUri: o.verificationUri, expiresAt: o.expiresAt };
  throw new Error(BAD);
}

/** Plain words for a failed call. The core's code words ("not-installed") never reach the screen. */
export function plainError(status: number, message: string): string {
  if (status === 0) return 'Legion\'s core did not answer. Check that Legion is running, then try again.';
  if (status === 404 && message === 'not-installed') return 'Legion is not installed on that repo. Choose it at GitHub first.';
  if (status === 409 && message === 'too-many-ticked') return 'Too many repos are on. Turn one off first.';
  if (status === 409 && message === 'not-available') return 'Signing in to Legion (write) is not available in this build.';
  if (status === 409 && message === 'needs-key') return 'Legion needs its secret key set up before it can keep a sign-in.';
  // a sentence from the core is already plain; a lone code word is not
  if (/\s/.test(message.trim()) && message.length < 200) return message;
  return 'Something went wrong.';
}
