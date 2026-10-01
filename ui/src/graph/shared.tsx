import { useStore } from '../store';
import { Bust } from '../mascot/Bust';
import { creatorName, scopeKind, scopeLabel, typeColor } from './palette';
import type { KgNodeType } from '../../../src/shared/kg';

export function useTheme() { return useStore((s) => s.theme); }
export function useAgentNames(): (id: string) => string | undefined {
  const agents = useStore((s) => s.agents);
  return (id) => agents.find((a) => a.id === id)?.name;
}

export function TypeDot({ type, size = 9 }: { type: KgNodeType | string; size?: number }) {
  const theme = useTheme();
  return <i className="lt-dot" style={{ width: size, height: size, background: typeColor(theme, type) }} aria-hidden="true" />;
}

export function ScopeTag({ scope }: { scope: string }) {
  const name = useAgentNames();
  const k = scopeKind(scope);
  return <span className={`lt-scope lt-scope-${k}`} title={`Scope: ${scope}`}><i aria-hidden="true" />{scopeLabel(scope, name)}</span>;
}

export function Creator({ id, size = 22, label = true }: { id: string; size?: number; label?: boolean }) {
  const name = useAgentNames();
  const isAgent = id !== 'human' && id !== 'system';
  return (
    <span className="lt-creator" title={`Created by ${creatorName(id, name)}`}>
      {isAgent ? <Bust agentId={id} size={size} className="lt-bust" /> : <span className="lt-bust lt-bust-g" style={{ width: size, height: size }}>{id === 'human' ? 'H' : 'S'}</span>}
      {label && <span>{creatorName(id, name)}</span>}
    </span>
  );
}
