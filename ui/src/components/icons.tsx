const P: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  sidebar: 'M4 5h16v14H4zM15 5v14',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  moon: 'M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z',
  check: 'M5 12l5 5 9-10',
  minus: 'M6 12h12',
  x: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  chevron: 'M9 6l6 6-6 6',
  send: 'M5 12l14-7-5 14-2-6-7-1z',
  stop: 'M7 7h10v10H7z',
  tool: 'M14 6a4 4 0 0 0 4 4l-9 9a2 2 0 0 1-3-3l9-9a4 4 0 0 0-1-1zM15 3l2 2',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  play: 'M8 5l11 7-11 7z',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  down: 'M6 10l6 6 6-6',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  terminal: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
};
export function Icon({ name, size = 16 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] ?? ''} />
    </svg>
  );
}
