/**
 * What the BSV knowledge pack load did, in words for a toast. Shared so the UI stores and the tests use the same text.
 * The result is the body of POST /api/kg/seed/bsv or the `seed` field of POST /api/bsv.
 */
export interface SeedReport {
  status: 'loaded' | 'upgraded' | 'repaired' | 'already-loaded' | 'no-kg' | 'error';
  nodes?: number; from?: number; to?: number; created?: number; updated?: number; edges?: number;
  skippedEdited?: string[]; skippedRemoved?: string[]; restored?: string[]; error?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (ids: string[]) => (ids.length <= 4 ? ids.join(', ') : `${ids.slice(0, 3).join(', ')} and ${ids.length - 3} more`);

export function describeSeed(r: SeedReport): { text: string; level: 'info' | 'error' } {
  if (r.status === 'error') return { text: `The BSV knowledge pack did not load: ${r.error ?? 'unknown error'}`, level: 'error' };
  if (r.status === 'no-kg') return { text: 'The BSV knowledge pack could not be loaded: the knowledge graph is not available.', level: 'error' };
  const parts: string[] = [];
  const made = r.created ?? 0;
  const upd = r.updated ?? 0;
  const links = r.edges ?? 0;
  if (r.status === 'loaded') parts.push(`BSV knowledge pack loaded: ${plural(r.nodes ?? made, 'note')}${links ? `, ${plural(links, 'link')}` : ''}.`);
  else if (r.status === 'upgraded') parts.push(`BSV knowledge pack upgraded from version ${r.from ?? '?'} to ${r.to ?? '?'}: ${plural(upd, 'note')} updated, ${made} added, ${plural(links, 'link')} added.`);
  else if (r.status === 'repaired') parts.push(`BSV knowledge pack repaired: ${made} ${made === 1 ? 'note' : 'notes'} put back${r.restored?.length ? ` (${plural(r.restored.length, 'restore')})` : ''}, ${plural(links, 'link')} added.`);
  else parts.push(`BSV knowledge pack is already up to date (version ${r.to ?? r.from ?? '?'}).`);
  const edited = r.skippedEdited ?? [];
  const removed = r.skippedRemoved ?? [];
  if (r.status !== 'already-loaded' && edited.length) parts.push(`${plural(edited.length, 'note')} you edited ${edited.length === 1 ? 'was' : 'were'} left as they are (${names(edited)}).`.replace('1 note you edited was left as they are', '1 note you edited was left as it is'));
  if (removed.length) parts.push(`${plural(removed.length, 'note')} you deleted ${removed.length === 1 ? 'stays' : 'stay'} deleted (${names(removed)}); POST /api/kg/seed/bsv with {"restore":[ids]} brings one back.`);
  return { text: parts.join(' '), level: 'info' };
}
