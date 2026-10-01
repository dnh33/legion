import { useStore } from '../store';
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}><span title={t.text}>{t.text.length > 130 ? t.text.slice(0, 127).trimEnd() + '\u2026' : t.text}</span>{t.n > 1 && <span className="n">{'\u00d7'}{t.n}</span>}</div>)}
    </div>
  );
}
