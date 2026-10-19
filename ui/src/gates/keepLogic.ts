// The pure part of the "Variables commands may keep" editor (Settings, Gates): what a typed name is checked against, the plain words an error uses,
// and the exact change an Add or a Remove sends. No store, no api: tests run it as it is.
//
// An error sentence never repeats what was typed. A person may paste NAME=value, and the value could be a secret.
import { ENV_KEEP_MAX, ENV_KEEP_NAME_MAX, ENV_KEEP_RE, ENV_NEVER_PASSED, ENV_NEVER_PASSED_PREFIX } from '../../../src/shared/gates-registry.js';
import type { GatesChangeRequest } from './gatesAction.js';

export type KeepCheck = { kind: 'empty' } | { kind: 'ok'; name: string } | { kind: 'error'; message: string };

export const KEEP_EMPTY_LINE = 'None are kept. Keys, tokens and passwords, and settings that make a program load other code, are held back from every command.';
export const KEEP_NOTE = "A kept name is passed to commands in every project and outside projects. Adding one asks you to confirm. Values are never shown here. In API key or cloud mode, Claude's own scrub may still hide a name from Claude's commands.";
export const KEEP_PROJECT_LINE = 'The variables kept for commands are the same in every project. Choose Everything above to change them.';

const bad = (message: string): KeepCheck => ({ kind: 'error', message });
const baseOf = (n: string): string => (n.endsWith('*') ? n.slice(0, -1) : n).toUpperCase();

/** Does a kept entry already pass this name? An entry ending in * passes every name that starts with the rest of it. */
const coveredBy = (name: string, entry: string): boolean => (entry.endsWith('*') ? baseOf(name).startsWith(baseOf(entry)) : !name.endsWith('*') && name.toUpperCase() === entry.toUpperCase());

/** The typed text, checked the way the core checks it, plus what only the window can say in words. */
export function checkKeepName(input: string, kept: readonly string[]): KeepCheck {
  const name = input.trim();
  if (name === '') return { kind: 'empty' };
  if (name.includes('=')) return bad('Type only the name, not a value. Legion never needs the value.');
  if (name.length > ENV_KEEP_NAME_MAX) return bad(`A name can be up to ${ENV_KEEP_NAME_MAX} characters.`);
  if (/[^A-Za-z0-9_*]/.test(name) || /^[0-9]/.test(name)) return bad('Use letters, digits and _ only, and start with a letter or _. A * is allowed only at the end.');
  if (name.indexOf('*') !== -1 && name.indexOf('*') !== name.length - 1) return bad('Put the * only at the end.');
  if (!ENV_KEEP_RE.test(name)) return bad('A name that ends in * needs at least 3 characters before the *, so it does not keep nearly everything.');
  const up = name.toUpperCase();
  if ((ENV_NEVER_PASSED as readonly string[]).includes(up) || baseOf(name).startsWith(ENV_NEVER_PASSED_PREFIX)) return bad("Legion never passes its own keys or LEGION_ settings to commands, so keeping this one would do nothing.");
  for (const e of kept) {
    if (e.toUpperCase() === up) return bad(`${name} is already on the list.`);
    if (coveredBy(name, e)) return bad(`${name} is already covered by ${e}.`);
  }
  if (kept.length >= ENV_KEEP_MAX) return bad(`The list holds ${ENV_KEEP_MAX} names. Remove one first.`);
  return { kind: 'ok', name };
}

/** Add: the whole list with the name at the end, as an app change. The core and the app's native dialog decide that this loosens. */
export const keepAddChange = (kept: readonly string[], name: string): GatesChangeRequest => ({ kind: 'app', patch: { envKeep: [...kept, name] } });
/** Remove: the list without the name. An empty list clears it. */
export const keepRemoveChange = (kept: readonly string[], name: string): GatesChangeRequest => ({ kind: 'app', patch: { envKeep: kept.filter((k) => k !== name) } });
