/**
 * Switching the reads grant on and off (spec 4.8): one gate rule. Each change is one call to the core's add/remove-rule endpoint, which edits the rules as
 * stored at that moment, so a gates edit made elsewhere in between is never lost. Only the Confirm step calls `grantReads`.
 */
import { api } from '../../api';
import { setState, toast, errText } from '../../store';
import { findReadsGrant, readsGrantRule, staleReadsGrants } from './settingsLogic';

type Proj = { id: string; folder: string };
const emptyGates = { rules: [], presetsVersion: 0 };

async function edit(change: Parameters<typeof api.editGateRules>[0]): Promise<void> {
  setState({ settings: await api.editGateRules(change) });
}

export async function grantReads(project: Proj): Promise<boolean> {
  try {
    const gates = (await api.settings()).gates ?? emptyGates;
    if (findReadsGrant(gates.rules, project)) return true;
    await edit({ add: [readsGrantRule(project)] });
    return true;
  } catch (e) { toast(errText(e), 'error'); return false; }
}

export async function revokeReads(project: Proj): Promise<boolean> {
  try {
    const gates = (await api.settings()).gates ?? emptyGates;
    const mine = findReadsGrant(gates.rules, project);
    if (!mine) return true;
    await edit({ remove: [mine.id] });
    return true;
  } catch (e) { toast(errText(e), 'error'); return false; }
}

/**
 * After a folder change: the project's reads rule for the OLD folder is removed. It is not moved to the new folder, because the owner agreed to reads in
 * that folder, not in the next one; the Safety switch shows off and asking again is one click. Only narrows what agents may do.
 */
export async function dropStaleReads(project: Proj): Promise<void> {
  try {
    const gates = (await api.settings()).gates ?? emptyGates;
    const stale = staleReadsGrants(gates.rules, project);
    if (stale.length) await edit({ remove: stale.map((r) => r.id) });
  } catch (e) { toast(errText(e), 'error'); }
}
