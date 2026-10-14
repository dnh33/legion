import { Bust } from '../../mascot/Bust';

/**
 * A resting bust on its tile (a still, never a live engine at rest). `runs` shows the run count badge at 2 or more; `dot` marks a
 * working member in the side column. The tile has a name only when `name` is given, else it is decoration.
 */
export function AgentBust({ agentId, size, runs = 0, dot = false, name }: { agentId: string; size: number; runs?: number; dot?: boolean; name?: string }) {
  return (
    <span className={`pg-bust${runs >= 2 ? ' rc-wrap' : ''}`} style={{ width: size, height: size }} {...(name ? { role: 'img', 'aria-label': name } : { 'aria-hidden': true })}>
      <Bust agentId={agentId} size={size} />
      {runs >= 2 && <span className="pg-rc" aria-hidden="true" title={`${runs} live runs`}>{runs}</span>}
      {dot && <i className="pg-dot" aria-hidden="true" />}
    </span>
  );
}
