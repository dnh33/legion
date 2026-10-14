import './settings.css';

/** `expanded` is for a switch that opens a question before it changes anything: aria-checked stays what is true (off), aria-expanded says the question is open. */
export function Switch({ on, label, disabled, onChange, id, expanded }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void; id: string; expanded?: boolean }) {
  return <button type="button" role="switch" id={id} className={'pg-sw' + (expanded ? ' asking' : '')} aria-checked={on} {...(expanded !== undefined ? { 'aria-expanded': expanded } : {})} aria-label={label} disabled={disabled} onClick={() => onChange(!on)} />;
}
