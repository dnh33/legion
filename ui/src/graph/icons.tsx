const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  minus: 'M6 12h12',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  pause: 'M8 5v14M16 5v14',
  play: 'M8 5l11 7-11 7z',
  relayout: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  panel: 'M4 5h16v14H4zM9 5v14',
  chevron: 'M9 6l6 6-6 6',
  down: 'M6 10l6 6 6-6',
  import: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  export: 'M12 15V4M7 9l5-5 5 5M5 20h14',
  path: 'M5 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM19 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7 15l10-4',
  expand: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  alert: 'M12 4l9 16H3zM12 10v4M12 17v.5',
  check: 'M5 12l5 5 9-10',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  swap: 'M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.5M4 12h.5M4 18h.5',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  warn: 'M12 3l9.5 17h-19zM12 10v5M12 17.5v.5',
  bolt: 'M13 3L5 14h6l-1 7 8-11h-6z',
};
export function GIcon({ name, size = 15 }: { name: keyof typeof P; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? ''} />
    </svg>
  );
}
