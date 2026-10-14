/** Switching the reads grant on and off (spec 4.8): one gate rule, read first so no other rule is lost. Only the Confirm step calls `grantReads`. */
import { api } from '../../api';
import { saveSettings, toast, errText } from '../../store';
import { findReadsGrant, readsGrantRule } from './settingsLogic';

type Proj = { id: string; folder: string };
const emptyGates = { rules: [], presetsVersion: 0 };

export async function grantReads(project: Proj): Promise<boolean> {
  try {
    const gates = (await api.settings()).gates ?? emptyGates;
    if (findReadsGrant(gates.rules, project)) return true;
    await saveSettings({ gates: { ...gates, rules: [...gates.rules, readsGrantRule(project)] } }, true);
    return true;
  } catch (e) { toast(errText(e), 'error'); return false; }
}

export async function revokeReads(project: Proj): Promise<boolean> {
  try {
    const gates = (await api.settings()).gates ?? emptyGates;
    const mine = findReadsGrant(gates.rules, project);
    if (!mine) return true;
    await saveSettings({ gates: { ...gates, rules: gates.rules.filter((r) => r.id !== mine.id) } }, true);
    return true;
  } catch (e) { toast(errText(e), 'error'); return false; }
}
