/**
 * Animated bot bust: the agent's painted bust (ui/src/mascot/data/<id>.json, built from the maker's layered SVG)
 * driven by the shared mascot engine, or the agent's emoji for custom agents.
 *
 * <Bust agentId size state? /> contract is unchanged. Extras, all optional:
 *   state / vm   force the pose instead of deriving it from the store (Mascot Lab, tests)
 *   stage        full behaviour (hover, pokes, quips, all layers live) instead of the agent-rail performance mode
 *
 * At rest (any bust that has a pre-rendered still, unless `stage`) the bust is a picture: no engine, no SVG, no JSON parse.
 * The live engine mounts on pointer hover or keyboard focus of the bust (or of its agent row) and is destroyed on leave.
 *   width        box width for stage use (the bust is fitted inside width x size)
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type RelicState } from '../store';
import { createMascot, type MascotHandle } from './engine.js';
import { hasStill, stillUrl, warmStills } from './stills';
import { stillState } from './stillsLogic';
import { hasBust, loadBust, type LoadedBust } from './busts';
import { useBustState } from './useBustState';
import './mascot.css';
import './bust.css';

export interface BustProps { agentId: string; size?: number; className?: string; state?: RelicState; vm?: boolean; stage?: boolean; width?: number }

export const Bust = memo(function Bust({ agentId, size = 40, className, state: forced, vm: forcedVm, stage = false, width }: BustProps) {
  const emoji = useStore((s) => s.agents.find((a) => a.id === agentId)?.emoji ?? '●');
  const theme = useStore((s) => s.theme);
  const builtIn = hasBust(agentId);
  const rest = !stage && hasStill(agentId);
  const root = useRef<HTMLSpanElement>(null);
  // awake = the pointer is over the bust (or its agent row) or keyboard focus is inside it; only then does a resting bust go live
  const [awake, setAwake] = useState(false);
  const active = !rest || awake;
  useEffect(() => {
    if (!rest) { setAwake(false); return; }
    warmStills(theme);
    const el = root.current?.closest<HTMLElement>('.agent') ?? root.current;
    if (!el) return;
    let hovered = false, focused = false;
    const sync = () => setAwake(hovered || focused);
    const enter = () => { hovered = true; sync(); };
    const leave = () => { hovered = false; sync(); };
    const focusIn = (e: FocusEvent) => { if ((e.target as HTMLElement).matches(':focus-visible')) { focused = true; sync(); } };
    const focusOut = (e: FocusEvent) => { if (!el.contains(e.relatedTarget as Node | null)) { focused = false; sync(); } };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('focusin', focusIn);
    el.addEventListener('focusout', focusOut);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('focusin', focusIn);
      el.removeEventListener('focusout', focusOut);
    };
  }, [rest, theme]);

  const [asset, setAsset] = useState<LoadedBust | null>(null);
  useEffect(() => {
    setAsset(null);
    if (!builtIn || !active) return;
    let dead = false;
    loadBust(agentId).then((a) => { if (!dead) setAsset(a); }).catch(() => { /* keep the still or the emoji */ });
    return () => { dead = true; };
  }, [agentId, builtIn, active]);

  const derived = useBustState(agentId, builtIn && forced === undefined);
  const state = forced ?? derived.state;
  const vm = forcedVm ?? derived.vm;

  const host = useRef<HTMLSpanElement>(null);
  const [live, setLive] = useState(false); // the engine has painted: the still can step aside
  const m = useRef<MascotHandle | null>(null);
  // fit the frame (rail crop) inside width x size; on the stage the frame keeps 80% of the height so the painted body can spill
  // below it and fade out above the mood label, and the stage is always exactly width x size tall (no layout shift between agents)
  const box = useMemo(() => {
    if (!asset) return null;
    const f = asset.persona.cropRail || asset.data.cropRail || asset.data.crop;
    const s = Math.min((width ?? size) / f[2], (stage ? size * 0.8 : size) / f[3]);
    return { w: Math.round(f[2] * s), h: Math.round(f[3] * s) };
  }, [asset, size, width, stage]);

  useEffect(() => {
    const h = host.current;
    if (!h || !asset) return;
    const p = asset.persona;
    m.current = createMascot(h, asset.data, {
      rail: !stage, railCrop: stage, cropRail: p.cropRail, persona: p, quips: p.quips, annoyedQuip: p.annoyedQuip,
      hoverEl: (h.closest('.agent') as HTMLElement | null) ?? undefined,
    });
    // the still stays under the live bust until the engine has had two frames to paint, so waking never flashes an empty tile
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setLive(true)); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); m.current?.destroy(); m.current = null; setLive(false); };
  }, [asset, stage]);
  useEffect(() => { m.current?.setState(state); }, [state, asset, stage]);
  useEffect(() => { m.current?.setVm(vm); }, [vm, asset, stage]);

  const w = width ?? size;
  if (rest) {
    const needs = state === 'awaiting';
    return (
      <span ref={root} className={`bust bust-rest${needs ? ' needs' : ''}${className ? ` ${className}` : ''}`} style={{ width: w, height: size }} data-bust={agentId} data-state={state} data-rest={live ? 'live' : 'still'}>
        {!live && <img className="bust-still" src={stillUrl(agentId, stillState(state), theme)} width={size} height={size} alt="" decoding="async" draggable={false} />}
        {asset && box && <span ref={host} className="bust-host" style={{ width: box.w, height: box.h }} />}
      </span>
    );
  }
  return (
    <span className={`bust${stage ? ' bust-stage' : ''}${className ? ` ${className}` : ''}`} style={{ width: w, height: size }} data-bust={agentId} data-state={asset ? state : undefined}>
      {asset && box
        ? <span ref={host} className="bust-host" style={{ width: box.w, height: box.h }} />
        : <span className="bust-fallback" style={{ fontSize: Math.round(size * 0.5) }}>{emoji}</span>}
    </span>
  );
});
