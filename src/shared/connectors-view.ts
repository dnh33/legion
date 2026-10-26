import { agentGithubLevel, normRepo } from './github-area.js';

/** Shapes and wording the Settings, Connectors page and the agent editor share with the core (plain data, no UI). */

export type ConnectorFlowView =
  | { phase: 'idle' }
  | { phase: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { phase: 'failed'; reason: string; message: string };

export interface GithubStatusView {
  /** False while the Legion GitHub App is not registered in this build: the sign-in cannot start. */
  available: boolean;
  key: 'installed' | 'missing';
  storage: 'ok' | 'empty' | 'sign-in-again' | 'memory-only' | 'unavailable';
  signedIn: boolean;
  flow: ConnectorFlowView;
  revokeUrl: string;
}

export interface GithubConnectionView {
  auth: 'github-app' | 'pat' | 'anonymous';
  login?: string;
  needsSignIn?: boolean;
  permissions?: Record<string, 'read' | 'write'>;
  rate: { limit: number; remaining: number; resetAt: string };
}

/**
 * The warning for the agent editor (design 4.4 H2): an agent with connectors AND full approval AND a shell can read what the OS lets the
 * same user read, including the token store, so Legion cannot promise the token stays out of its reach. A Claude agent always has Bash;
 * an agent on another provider has a shell only when its VM is on (vm_exec). Returns undefined when there is nothing to warn about.
 */
export function connectorsShellWarning(o: { connectors: boolean; approval: string; /** The mode the agent's runs are judged by (project preset, ceiling) where the caller knows it; else the stored mode decides. */ resolved?: string; onProvider: boolean; vmOn: boolean }): string | undefined {
  if (!o.connectors || (o.resolved ?? o.approval) !== 'full') return undefined;
  const shell = !o.onProvider || o.vmOn;
  if (!shell) return undefined;
  return 'This agent can run shell commands and never asks. A shell runs as you, so it can read files Legion keeps on your computer, including the encrypted GitHub sign-in and the key that opens it. Legion does not hand tokens to agents, but it cannot stop code running as you from reading them. Set an agent that reads GitHub to Ask.';
}

/** One plain line for where the sign-in is kept. */
export function storageLine(s: GithubStatusView['storage']): string {
  switch (s) {
    case 'ok': return 'Kept encrypted on your computer.';
    case 'memory-only': return 'Kept in memory only: you sign in again each time Legion starts.';
    case 'sign-in-again': return 'The stored sign-in could not be read. Sign in again.';
    default: return '';
  }
}

/** Refusals the gateway gives an agent (plain words, shared with the UI tests). */
export const GITHUB_UNTICKED_TEXT = 'That repo is not turned on in Legion. Turn it on in the GitHub area.';
export const GITHUB_AGENTS_OFF_TEXT = 'GitHub is switched off for agents in Legion. The owner turns it on in the GitHub area.';
export const GITHUB_WRITE_NOT_GRANTED_TEXT = 'This agent may not write to that repo. The owner allows it with the project page\'s "let agents write" button, or in the agent\'s settings (Connectors). Turning on Write for the repo in the GitHub area is not enough on its own.';
export const GITHUB_NOT_SIGNED_FOR_WRITE_TEXT = 'Legion (write) is not signed in to GitHub, so nothing can be written. The owner signs in from the GitHub area.';
export const GITHUB_WRITE_NEEDS_ACCESS_TEXT = 'Legion (write) does not have write access for that on GitHub. The owner checks the install in the GitHub area.';

/** The tag on an agent card: "GitHub: read", "GitHub: write, 2 repos", or nothing for level None. */
export function githubLevelTag(a: { connectors?: string[]; githubWrite?: string[] }): string {
  const lvl = agentGithubLevel(a);
  if (lvl === 'none') return '';
  if (lvl === 'read') return 'GitHub: read';
  const n = new Set((a.githubWrite ?? []).map(normRepo)).size;
  return `GitHub: write, ${n} ${n === 1 ? 'repo' : 'repos'}`;
}
