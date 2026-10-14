/** The page's 16 px status and action icons (strokes in currentColor). Decorative: aria-hidden. */
const D: Record<string, string> = {
  back: 'M10 3 5 8l5 5',
  chev: 'm4 6 4 4 4-4',
  plus: 'M8 3v10M3 8h10',
  hand: 'M8 4.8v3.6',
  check: 'm3.5 8.3 2.8 2.8 6.2-6.4',
  close: 'm4 4 8 8m0-8-8 8',
};
export type PIconName = 'back' | 'chev' | 'more' | 'plus' | 'hand' | 'run' | 'queue' | 'review' | 'pause' | 'x' | 'ok' | 'coin' | 'archive' | 'check' | 'close';

export function PIcon({ name, size = 16, className = '' }: { name: PIconName; size?: number; className?: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  let body: React.ReactElement;
  switch (name) {
    case 'more': body = <><circle cx="3.5" cy="8" r="1.3" fill="currentColor" /><circle cx="8" cy="8" r="1.3" fill="currentColor" /><circle cx="12.5" cy="8" r="1.3" fill="currentColor" /></>; break;
    case 'hand': body = <><circle cx="8" cy="8" r="6.2" {...common} /><path d={D.hand} {...common} strokeWidth={1.6} /><circle cx="8" cy="10.9" r=".95" fill="currentColor" /></>; break;
    case 'run': body = <><circle cx="8" cy="8" r="6.2" {...common} strokeDasharray="3 2.2" /><circle cx="8" cy="8" r="2.2" fill="currentColor" /></>; break;
    case 'queue': body = <><circle cx="8" cy="8" r="6.2" {...common} /><path d="M8 4.6V8l2.4 1.6" {...common} /></>; break;
    case 'review': body = <><path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8 11.9 12.2 8 12.2 1.8 8 1.8 8Z" {...common} /><circle cx="8" cy="8" r="1.8" fill="currentColor" /></>; break;
    case 'pause': body = <><circle cx="8" cy="8" r="6.2" {...common} /><path d="M6.4 5.6v4.8M9.6 5.6v4.8" {...common} strokeWidth={1.6} /></>; break;
    case 'x': body = <><circle cx="8" cy="8" r="6.2" {...common} /><path d="m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2" {...common} strokeWidth={1.6} /></>; break;
    case 'ok': body = <><circle cx="8" cy="8" r="6.2" {...common} /><path d="m5.3 8.2 1.9 1.9 3.6-3.9" {...common} strokeWidth={1.6} /></>; break;
    case 'coin': body = <><circle cx="8" cy="8" r="6.2" {...common} /><path d="M8 4.6v6.8M10 6.2C9.6 5.6 8.9 5.3 8 5.3c-1.1 0-1.9.5-1.9 1.3 0 1.9 3.9 1 3.9 2.9 0 .8-.8 1.3-2 1.3-.9 0-1.7-.4-2.1-1" {...common} strokeWidth={1.3} /></>; break;
    case 'archive': body = <><rect x="2" y="3" width="12" height="3" rx="1" {...common} /><path d="M3 6v6.2c0 .5.4.8.8.8h8.4c.4 0 .8-.3.8-.8V6M6.5 8.7h3" {...common} /></>; break;
    default: body = <path d={D[name]} {...common} strokeWidth={name === 'check' ? 1.7 : 1.6} />;
  }
  return <svg className={className} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">{body}</svg>;
}
