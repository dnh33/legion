/** Signatures for the repos turned on in Legion (design 6.2). Filled by the allowlist unit. */
export interface Allowlist { v: 1; ticked: string[]; agentsEnabled: boolean }
export function readAllowlist(_dataDir: string): Allowlist { throw new Error('not implemented'); }
export function setTicked(_dataDir: string, _fullName: string, _on: boolean): Allowlist { throw new Error('not implemented'); }
export function isTicked(_dataDir: string, _fullName: string): boolean { throw new Error('not implemented'); }
export function masterOn(_dataDir: string): boolean { throw new Error('not implemented'); }
export function setMaster(_dataDir: string, _on: boolean): Allowlist { throw new Error('not implemented'); }
