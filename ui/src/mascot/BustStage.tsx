import { useStore } from '../store';
import { modelLabel } from '../models';
import { Bust } from './Bust';
import { STATE_LABEL } from './useRelicState';
import { useBustState } from './useBustState';
import './relic.css';

/** The Ops-panel stage for every agent except Zealot (whose stage stays the exact Relic): same frame, mood label and Lab. */
export function BustStage({ agentId, width = 210 }: { agentId: string; width?: number }) {
  const force = useStore((s) => s.mascotForce);
  const forceVm = useStore((s) => s.mascotVm);
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const catalog = useStore((s) => s.catalog);
  const derived = useBustState(agentId);
  const state = force ?? derived.state;
  const vm = forceVm ?? derived.vm;
  const note = agent && state !== 'sleeping' && state !== 'idle' ? `${agent.name} · ${modelLabel(catalog, agent.model)}` : null;
  return (
    <div className="relic-wrap">
      <div style={{ width }}>
        <Bust agentId={agentId} size={Math.round(width * 1.44)} width={width} stage state={state} vm={vm} />
      </div>
      <div className={`mood-label ml-${state}`}>
        <i />{STATE_LABEL[state]}
        {note ? <em> {'·'} {note}</em> : null}
        {vm && <span className="vm-tag">VM</span>}
      </div>
    </div>
  );
}
