/**
 * Pure view logic for the GitHub area: which state the panel is in (design 5.4), the chip dot, the create form's rules and words, and the repo list.
 * No React and no store here, so the tests can import it. Every string is plain English with no dashes as punctuation.
 */
import { validCreateName } from '../../../src/shared/github-area.js';
import type { GithubAreaView, GithubRepoRow } from '../../../src/shared/github-area.js';

/** The area view without the activity list (the panel gives that its own shape). */
export type AreaViewLike = Omit<GithubAreaView, 'activity'>;

export type AreaStateId = 'load-failed' | 'loading' | 'not-registered' | 'signing-in' | 'auth-ended' | 'not-connected' | 'rate-limited' | 'offline' | 'nothing-installed' | 'all-repos' | 'none-ticked' | 'ready';
export type AreaTone = 'idle' | 'ok' | 'warn' | 'bad';
export type AreaActionId = 'connect' | 'sign-in' | 'retry' | 'choose-at-github' | 'change-at-github';
export interface AreaState {
  id: AreaStateId;
  tone: AreaTone;
  /** The line shown in the state banner. Empty when the area is simply ready. */
  text: string;
  action?: { id: AreaActionId; label: string };
  /** GitHub buttons (Open on GitHub, Re-run, Create) wait while this is true. */
  disableGithubButtons: boolean;
  /** The list of repos is still shown under the banner (offline and rate limited keep what Legion last had). */
  keepsList: boolean;
}

export interface AreaCtx { /** The read sign-in is waiting for the owner on github.com. */ signingIn?: boolean; /** The first read failed and nothing is cached: the plain reason. */ failed?: string; /** First load, nothing cached yet. */ loading?: boolean }

const st = (id: AreaStateId, tone: AreaTone, text: string, action?: AreaState['action'], more: Partial<AreaState> = {}): AreaState => ({ id, tone, text, ...(action ? { action } : {}), disableGithubButtons: false, keepsList: false, ...more });

/** "14:32" in the viewer's own clock. */
export function clockTime(iso: string | undefined, fallback = 'a little while'): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return fallback;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function areaState(view: AreaViewLike | null, ctx: AreaCtx = {}): AreaState {
  if (!view && ctx.failed) return st('load-failed', 'warn', `Legion could not load GitHub. ${ctx.failed}`, { id: 'retry', label: 'Try again' });
  if (!view || ctx.loading) return st('loading', 'idle', 'Loading your repos.');
  if (!view.registered.read) return st('not-registered', 'idle', 'GitHub sign-in is not available in this build yet.');
  // a read sign-in that ended still counts as signed in on the core's side: Sign in must still show its code
  if (ctx.signingIn && (!view.signedIn.read || view.problem?.kind === 'auth-expired')) return st('signing-in', 'idle', 'Waiting for you to approve Legion on GitHub.');
  const p = view.problem;
  if (p?.kind === 'auth-expired') return st('auth-ended', 'warn', 'Your GitHub sign-in ended. Sign in again.', { id: 'sign-in', label: 'Sign in' });
  if (!view.signedIn.read || p?.kind === 'not-connected') return st('not-connected', 'idle', 'GitHub is not connected. Connect it to choose which repos Legion can use.', { id: 'connect', label: 'Connect GitHub' });
  if (p?.kind === 'rate-limited') return st('rate-limited', 'warn', p.resetAt ? `GitHub asks you to wait until ${clockTime(p.resetAt)}.` : 'GitHub asks you to wait a little.', undefined, { disableGithubButtons: true, keepsList: true });
  if (p?.kind === 'network') return st('offline', 'warn', 'Legion could not reach GitHub. Showing the last list.', { id: 'retry', label: 'Try again' }, { keepsList: true });
  if (view.repos.length === 0) return st('nothing-installed', 'idle', 'GitHub is connected. Install Legion (read) at GitHub once and pick its repos there; after that you choose repos here.', { id: 'choose-at-github', label: 'Install at GitHub' });
  if (view.selection === 'all') return st('all-repos', 'warn', 'Legion can reach every repo on this account. Narrow it at GitHub.', { id: 'change-at-github', label: 'Change at GitHub' }, { keepsList: true });
  if (!view.repos.some((r) => r.ticked)) return st('none-ticked', 'idle', 'No repo is turned on. Agents cannot see any repo until you turn one on.', undefined, { keepsList: true });
  return st('ready', 'ok', '', undefined, { keepsList: true });
}

/** Grey = not connected, green = connected, amber = needs a look. */
export function chipTone(view: AreaViewLike | null): 'idle' | 'ok' | 'warn' {
  if (!view || !view.signedIn.read) return 'idle';
  const p = view.problem?.kind;
  if (p === 'not-connected') return 'idle';
  if (p || view.selection === 'all') return 'warn';
  return 'ok';
}

export function chipLabel(view: AreaViewLike | null): string {
  const tone = chipTone(view);
  const how = tone === 'ok' ? 'connected' : tone === 'warn' ? 'needs a look' : 'not connected';
  return `GitHub, ${how}`;
}

/** The "writes off" notice. Only when the owner is signed in for reading and the write app is not. */
export function writesOffText(view: AreaViewLike): string | null {
  if (!view.signedIn.read || view.signedIn.write) return null;
  return 'Agents cannot write. Turn on writes to let chosen agents comment, open issues and pull requests, and re-run CI. Every write asks you first.';
}

/* ---------- create a repo ---------- */
export const CREATE_DEFAULTS = { private: true, readme: false, tick: false } as const;

export function createNameError(name: string): string | null {
  if (!name.trim()) return 'Give the repo a name.';
  return validCreateName(name) ? null : 'Use letters, numbers, dots, dashes and underscores.';
}

export function createConfirmLine(owner: string, name: string, priv: boolean): string {
  if (!owner) return priv ? `This creates the private repo ${name} in your own account on GitHub.` : `This creates the public repo ${name} in your own account on GitHub. Anyone can see it.`;
  return priv ? `This creates the private repo ${owner}/${name} on GitHub.` : `This creates the public repo ${owner}/${name} on GitHub. Anyone can see it.`;
}

export type CreateFailure = 'sign-in' | 'busy' | 'unsure' | 'unavailable' | 'name-taken' | 'no-right' | 'org-approval' | 'network' | 'rate-limited' | 'unknown';

export function createFailureKind(status: number, message = ''): CreateFailure {
  if (status === 422) return 'name-taken';
  if (status === 429) return 'rate-limited';
  if (status === 0) return 'network';
  if (status === 401) return 'sign-in';
  if (status === 409) return 'busy';
  if (status === 502) return 'unsure';
  if (status === 404 && !/^GitHub did not find/i.test(message)) return 'unavailable';
  if (status === 403 && /approv|oauth app access|saml|sso/i.test(message)) return 'org-approval';
  if (status === 403 || status === 404) return 'no-right';
  return 'unknown';
}

export function createFailureText(kind: CreateFailure): string {
  switch (kind) {
    case 'sign-in': return 'Your write sign-in ended. Turn on writes again, then try again. Nothing was created.';
    case 'busy': return 'Another repo is being created. Wait a moment, then try again.';
    case 'unsure': return 'Legion could not confirm what GitHub did. Check your repos at GitHub before you try again, so you do not make it twice.';
    case 'unavailable': return 'This version of Legion cannot create repos yet. Create it at GitHub instead.';
    case 'name-taken': return 'That name is taken. Pick another one.';
    case 'no-right': return 'GitHub says you cannot create repos here. Try your own account, or ask an owner of the organisation.';
    case 'org-approval': return 'The organisation must approve Legion before it can create repos there. Ask an owner to approve it at GitHub, then try again.';
    case 'network': return 'Legion could not reach GitHub. Nothing was created. Check your connection and try again.';
    case 'rate-limited': return 'GitHub asks you to wait a little. Nothing was created. Try again in a few minutes.';
    default: return 'GitHub did not create the repo. Nothing was changed. Try again, or create it at GitHub.';
  }
}

/* ---------- the repo list ---------- */
export const PAGE = 100;

export function listRepos(repos: GithubRepoRow[], query: string, shown: number): { rows: GithubRepoRow[]; more: number; total: number } {
  const q = query.trim().toLowerCase();
  const all = repos
    .filter((r) => !q || r.fullName.toLowerCase().includes(q))
    .sort((a, b) => Number(b.ticked) - Number(a.ticked) || a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase()));
  return { rows: all.slice(0, shown), more: Math.max(0, all.length - shown), total: all.length };
}

export const rateLine = (view: AreaViewLike): string | null => (view.rate ? `${view.rate.remaining.toLocaleString('en-US')} GitHub requests left until ${clockTime(view.rate.resetAt, 'later')}.` : null);

/* ---------- what agents did ---------- */
export type ActivityKind = 'comment' | 'issue' | 'pull-request' | 'rerun';
/** `titled` false: the core gave no title, so the line ends at the verb. */
export const activityVerb = (k: ActivityKind, titled = true): string => (k === 'comment' ? (titled ? 'commented on' : 'commented') : k === 'issue' ? (titled ? 'opened the issue' : 'opened an issue') : k === 'pull-request' ? (titled ? 'opened the pull request' : 'opened a pull request') : (titled ? 're-ran CI for' : 're-ran CI'));

/** The owner to send for a new repo: only a picked organisation or login. Empty means the personal account (the core then uses /user/repos). */
export const createOwner = (picked: string): string | undefined => (picked ? picked : undefined);

/** GitHub's own install page for Legion (read) (docs: Installing a GitHub App from a third party). Keep in step with GITHUB_APP_SLUGS in hosts.ts. */
export const READ_APP_INSTALL_URL = 'https://github.com/apps/legion-read/installations/new';
/** Where the banner's GitHub button goes: with nothing installed, the install page (a first install can only happen there); otherwise that installation's settings. */
export const githubActionUrl = (view: AreaViewLike | null): string => view?.repos[0]?.installationSettingsUrl ?? READ_APP_INSTALL_URL;
