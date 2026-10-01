import type { KgNode, KgNodeType, KgScope } from '../../../src/shared/kg';

export const NODE_TYPES: KgNodeType[] = [
  'note', 'entity', 'concept', 'task', 'decision', 'source', 'code', 'person', 'lesson', 'question',
];

/** Type tints. Phosphor green is reserved for selection and paths, so no type uses it. */
export const TYPE_COLORS: Record<'dark' | 'light', Record<KgNodeType, string>> = {
  dark: {
    note: '#9FB0C9', entity: '#4FD1C5', concept: '#B79CFF', task: '#FF9F6B', decision: '#FF7A90',
    source: '#CDB694', code: '#A9E060', person: '#F59BD1', lesson: '#F2D16B', question: '#6BB6FF',
    mistake: '#FF6B6B', pattern: '#7FD6E8', project: '#E0A458', memory: '#C3A6E8', idea: '#F2B8D9', episode: '#8D9DB5',
  },
  light: {
    note: '#60759A', entity: '#0E8A80', concept: '#7650E8', task: '#CF5A18', decision: '#CC2F4F',
    source: '#8C7753', code: '#4F8A0C', person: '#BE3F90', lesson: '#A57800', question: '#1C6FCB',
    mistake: '#C93C3C', pattern: '#1A8BA3', project: '#B07318', memory: '#7A52B3', idea: '#B04C86', episode: '#5E6E88',
  },
};

export const typeColor = (theme: 'dark' | 'light', t: string): string => TYPE_COLORS[theme][t as KgNodeType] ?? TYPE_COLORS[theme].note;

export type ScopeKind = 'shared' | 'agent' | 'bsv';
export const scopeKind = (s: KgScope | string): ScopeKind => (s === 'bsv' ? 'bsv' : s === 'shared' ? 'shared' : 'agent');

export function scopeLabel(s: string, agentName?: (id: string) => string | undefined): string {
  if (s === 'shared') return 'Shared';
  if (s === 'bsv') return 'BSV pack';
  const id = s.replace(/^agent:/, '');
  return `Private · ${agentName?.(id) ?? id}`;
}

/** Edge tint by relation (everything else is the neutral line colour). */
export const REL_TINT: Record<string, 'danger' | 'warn' | 'accent'> = {
  contradicts: 'danger', supersedes: 'warn', blocks: 'warn',
};

export const isUntrusted = (n: Pick<KgNode, 'sources'>): boolean => !!n.sources?.some((s) => s.untrusted === true);

export function creatorName(id: string, agentName?: (id: string) => string | undefined): string {
  if (id === 'human') return 'You';
  if (id === 'system') return 'System';
  return agentName?.(id) ?? id;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
