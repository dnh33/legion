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
export function connectorsShellWarning(o: { connectors: boolean; approval: string; onProvider: boolean; vmOn: boolean }): string | undefined {
  if (!o.connectors || o.approval !== 'full') return undefined;
  const shell = !o.onProvider || o.vmOn;
  if (!shell) return undefined;
  return 'This agent can run shell commands and never asks. A shell runs as you, so it can read files Legion keeps on this computer, including the encrypted GitHub sign-in and the key that opens it. Legion does not hand tokens to agents, but it cannot stop code running as you from reading them. Use "Ask before Bash" for an agent that reads GitHub.';
}

/** One plain line for where the sign-in is kept. */
export function storageLine(s: GithubStatusView['storage']): string {
  switch (s) {
    case 'ok': return 'Kept encrypted on this computer.';
    case 'memory-only': return 'Kept in memory only: you sign in again each time Legion starts.';
    case 'sign-in-again': return 'The stored sign-in could not be read. Sign in again.';
    default: return '';
  }
}
