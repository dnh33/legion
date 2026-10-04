import type { CatalogCommand } from '../../src/shared/types';
import { api, openExternal } from './api';
import { resolveModel, modelLabel } from './models';
import { compactNow, errText, getState, newTask, openDoctor, selectAgent, setModelChoice, toast, vmAction } from './store';

export interface LegionCommand { name: string; description: string; argumentHint: string; /** true when it needs an argument before it can run */ needsArg: boolean; /** hidden from the empty-query list to keep it short; still found by typing */ rare?: boolean }

/** Commands Legion handles itself in the UI; they are never sent to the agent. */
export const LEGION_COMMANDS: LegionCommand[] = [
  { name: 'new', description: 'Start a new task', argumentHint: '', needsArg: false },
  { name: 'model', description: 'Set the model (Auto or a name)', argumentHint: '<auto|model>', needsArg: true },
  { name: 'opus', rare: true, description: 'Use Opus, or add a message for one-off', argumentHint: '[message]', needsArg: false },
  { name: 'sonnet', rare: true, description: 'Use Sonnet, or add a message for one-off', argumentHint: '[message]', needsArg: false },
  { name: 'vm', description: 'Control this agent’s VM', argumentHint: '<start|stop|desktop>', needsArg: true },
  { name: 'compact', description: 'Compact this conversation now, with an optional focus', argumentHint: '[focus]', needsArg: false },
  { name: 'doctor', description: 'Open sign-in and setup checks', argumentHint: '', needsArg: false },
  { name: 'agent', description: 'Switch to another agent', argumentHint: '<name>', needsArg: true },
  { name: 'clear', description: 'Clear draft', argumentHint: '', needsArg: false },
];
const LEGION_NAMES = new Set(LEGION_COMMANDS.map((c) => c.name));

export interface Parsed { name: string; arg: string }
export function parseSlash(text: string): Parsed | null {
  const m = /^\/([A-Za-z0-9:_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), arg: (m[2] ?? '').trim() } : null;
}

/**
 * Runs a Legion command. Returns 'handled' (consumed), 'send' (forward the text to the agent verbatim, the
 * core understands /model, /opus, /sonnet prefixes) or 'none' (not a Legion command).
 */
export async function runLegionCommand(text: string): Promise<'handled' | 'send' | 'none'> {
  const p = parseSlash(text);
  if (!p || !LEGION_NAMES.has(p.name)) return 'none';
  const s = getState();
  const agent = s.agents.find((a) => a.id === s.selectedAgentId);
  switch (p.name) {
    case 'new': newTask(); return 'handled';
    case 'clear': return 'handled';
    case 'doctor': openDoctor(); return 'handled';
    case 'compact': {
      const t = s.selectedTaskId;
      if (!t) { toast('Open a conversation to compact it.', 'error'); return 'handled'; }
      try { const r = await compactNow(t, p.arg || undefined); toast(r.detail || 'Compaction finished'); }
      catch (e) { toast(errText(e), 'error'); }
      return 'handled';
    }
    case 'opus': case 'sonnet':
      if (p.arg) return 'send';
      setModelChoice(p.name); toast(`Model set to ${modelLabel(s.catalog, p.name)}`); return 'handled';
    case 'model': {
      if (!p.arg) { window.dispatchEvent(new Event('legion:model-picker')); return 'handled'; }
      const [first, ...rest] = p.arg.split(/\s+/);
      const value = resolveModel(s.catalog, first);
      if (!value) { toast(`Unknown model “${first}”`, 'error'); return 'handled'; }
      if (rest.length) return 'send';
      setModelChoice(value); toast(`Model set to ${modelLabel(s.catalog, value)}`); return 'handled';
    }
    case 'agent': {
      const q = p.arg.toLowerCase();
      const hit = s.agents.find((a) => a.id === q || a.name.toLowerCase() === q) ?? s.agents.find((a) => a.name.toLowerCase().startsWith(q) || a.id.startsWith(q));
      if (!q || !hit) { toast(q ? `No agent named “${p.arg}”` : 'Usage: /agent <name>', 'error'); return 'handled'; }
      selectAgent(hit.id); return 'handled';
    }
    case 'vm': {
      const act = p.arg.toLowerCase();
      if (!agent?.vm.enabled) { toast('This agent has no VM. Enable it in agent settings.', 'error'); return 'handled'; }
      if (act === 'start' || act === 'stop') { void vmAction(agent.id, act); return 'handled'; }
      if (act === 'desktop') {
        api.desktop(agent.id).then((r) => openExternal(r.url)).catch((e) => toast(e instanceof Error ? e.message : 'Could not open desktop', 'error'));
        return 'handled';
      }
      toast('Usage: /vm start | stop | desktop', 'error'); return 'handled';
    }
  }
  return 'none';
}

export interface MenuItem { key: string; group: 'Legion' | 'Claude Code'; name: string; hint: string; description: string; alias?: string; immediate: boolean; kind?: 'builtin' | 'skill'; costly?: boolean }

const score = (c: { name: string; aliases?: string[]; description: string }, q: string): number => {
  if (!q) return 1;
  const n = c.name.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 80;
  if (c.aliases?.some((a) => a.toLowerCase().startsWith(q))) return 70;
  if (n.includes(q)) return 50;
  if (c.aliases?.some((a) => a.toLowerCase().includes(q))) return 40;
  if (q.length >= 3 && c.description.toLowerCase().includes(q)) return 10;
  return 0;
};

/** One short sentence: drops source suffixes like "(user)" or "(dynamic workflow)" and anything after the first sentence. */
export function cleanDescription(d: string): string {
  let t = d.replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*\((?:user|project|plugin[^)]*|dynamic workflow|bundled|builtin|built-in|skill)\)\s*$/i, '');
  const m = /^(.*?[.!?])(?:\s|$)/.exec(t);
  if (m && m[1].length >= 12) t = m[1];
  t = t.replace(/[.]$/, '');
  return t.length > 110 ? t.slice(0, 107).trimEnd() + '\u2026' : t;
}

/** True for commands that do not make sense from Legion (internal, removed, terminal-session-only). */
export function hiddenCommand(c: CatalogCommand): boolean {
  return c.name.startsWith('__') || /\(removed\)|sessions? only/i.test(c.description) || LEGION_NAMES.has(c.name);
}
export const isCostly = (description: string) => /\$|\bUSD\b/.test(description);

export function buildMenu(query: string, catalog: CatalogCommand[]): MenuItem[] {
  const q = query.toLowerCase();
  const legion = LEGION_COMMANDS.filter((c) => q || !c.rare).map((c) => ({ c, sc: score(c, q) })).filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc)
    .map(({ c }): MenuItem => ({ key: 'l:' + c.name, group: 'Legion', name: c.name, hint: c.argumentHint, description: c.description, immediate: !c.needsArg && !c.argumentHint }));
  const cc = catalog.filter((c) => !hiddenCommand(c)).map((c) => ({ c, sc: score(c, q) })).filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc || Number(!!b.c.builtin) - Number(!!a.c.builtin) || a.c.name.localeCompare(b.c.name))
    .map(({ c }): MenuItem => ({
      key: 'c:' + c.name, group: 'Claude Code', name: c.name, hint: c.argumentHint, description: cleanDescription(c.description), immediate: false,
      kind: c.builtin ? 'builtin' : 'skill', costly: isCostly(c.description),
      alias: c.aliases?.find((a) => q && a.toLowerCase().startsWith(q) && !c.name.toLowerCase().startsWith(q)),
    }));
  return [...legion, ...cc];
}
