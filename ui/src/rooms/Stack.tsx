import { useEffect, useRef, useState } from 'react';
import { Bust } from '../mascot/Bust';
import { useStore } from '../store';

/**
 * A bust inside a fixed-size rounded frame, so layout never depends on how the mascot renders.
 * Each live <Bust> runs its own animation engine, and a transcript can hold dozens of avatars, so the bust is only
 * mounted while its frame is (nearly) on screen; off screen it is the agent's emoji, which is also what Bust shows while loading.
 */
export function Face({ id, size = 24 }: { id: string; size?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  const emoji = useStore((s) => s.agents.find((a) => a.id === id)?.emoji ?? '\u25cf');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((e) => setNear(e[e.length - 1]!.isIntersecting), { rootMargin: '160px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <span ref={ref} className="rm-face" style={{ width: size, height: size, borderRadius: Math.round(size * 0.3) }} aria-hidden="true">
      {near ? <Bust agentId={id} size={Math.max(12, size - 4)} /> : <span className="rm-face-e" style={{ fontSize: Math.round(size * 0.5) }}>{emoji}</span>}
    </span>
  );
}

/** Overlapping faces (room avatar). */
export function Stack({ ids, size = 22, max = 3 }: { ids: string[]; size?: number; max?: number }) {
  const shown = ids.slice(0, max);
  return (
    <span className="rm-stack" style={{ height: size }} aria-hidden="true">
      {shown.map((id, i) => (
        <span key={id} className="rm-stack-i" style={{ marginLeft: i ? -size * 0.3 : 0, zIndex: shown.length - i }}>
          <Face id={id} size={size} />
        </span>
      ))}
      {ids.length > max && <span className="rm-stack-more">+{ids.length - max}</span>}
    </span>
  );
}
