// Single source of truth for every time in trailer v2. trailer.html draws from it, render.mjs writes cues.json from it,
// score.py reads cues.json, check.mjs enforces the editing rules on it. Variant B of BRIEF.md section 3a (the project board is NEXT, text only).
//   1. 96 BPM grid: beat 0.625 s, bar 2.5 s. Scene changes on bar lines, reveals on beats.
//   2. No dead air: dissolve or hard cut, black only at the very start and end.
//   3. One anchor: the Relic. It lives in the right-hand column beside the UI shots and travels there on screen.
//   4. One idea per shot; text up >= 0.3 s per word + 0.8 s.
export const FPS = 30;
export const BPM = 96;
export const BEAT = 60 / BPM;
export const BAR = BEAT * 4;
export const b = (bar, beat = 0) => +(bar * BAR + beat * BEAT).toFixed(4);
export const TRANSITION = { hard: 0.06, dissolve: 0.5, match: 0.7 };

// ---- who is on the muster (names from src/core/roster.ts and the three defaults in store.ts) ----
export const ROSTER = [
  ['zealot', 'Zealot', 'Lead'], ['builder', 'Builder', 'Builds'], ['scout', 'Scout', 'Research'], ['inquisitor', 'Inquisitor', 'Review'],
  ['scribe', 'Scribe', 'Docs'], ['archivist', 'Archivist', 'Memory'], ['sentinel', 'Sentinel', 'Watch'], ['forgemaster', 'Forgemaster', 'Infra'],
  ['exorcist', 'Exorcist', 'Debugging'], ['preceptor', 'Preceptor', 'Craft'], ['herald', 'Herald', 'Drafts'], ['assayer', 'Assayer', 'BSV'], ['sculptor', 'Sculptor', 'Blender'],
];

// ---- scene bars ----
export const S = {
  cold: [0, 2], awaken: [2, 4], muster: [4, 7], approvals: [7, 10], rooms: [10, 11], library: [11, 14], projects: [14, 20],
  vm: [20, 24], bsv: [24, 27], blender: [27, 30], install: [30, 33], next: [33, 38], end: [38, 42],
};
export const KICKER = {
  approvals: 'APPROVALS AND TRUST', rooms: 'ROOMS', library: 'THE LIBRARY AND THE LATTICE', projects: 'PROJECTS',
  vm: 'CLOUD VMS AND MCP', bsv: 'BSV MODE', blender: 'BLENDER', install: 'INSTALL, UPDATE, TEST',
};

// ---- real-UI shots. img = file in docs/video-v2/shots/. cam keys: [t, zoom, cx, cy] (cx, cy = point of the shot in the middle of the frame, 0..1).
// marks: rings drawn on real UI elements [t, fx, fy]. Targets are set after reading each screenshot at full size. ----
export const SHOTS = [
  { id: 'approval', img: 'app-approval.png', in: b(7), out: b(8, 3), cam: [[b(7), 1, .5, .5], [b(7, 2), 1.55, .47, .57]], marks: [[b(7, 3), .233, .54]] },
  { id: 'inbox', img: 'library-inbox.png', in: b(8, 3), out: b(10), cam: [[b(8, 3), 1, .5, .5], [b(9, 1), 1.4, .58, .37], [b(10), 1.45, .58, .37]], marks: [[b(9, 2), .835, .18]] },
  { id: 'rooms', img: 'rooms.png', in: b(10), out: b(11), cam: [[b(10), 1, .5, .5], [b(11), 1.25, .6, .5]], marks: [] },
  { id: 'lattice', img: 'library-lattice.png', in: b(11), out: b(12, 3), cam: [[b(11), 1, .5, .5], [b(12, 3), 1.3, .55, .5]], marks: [] },
  { id: 'inbox2', img: 'library-inbox.png', in: b(12, 3), out: b(14), cam: [[b(12, 3), 1.5, .45, .4], [b(14), 1.6, .4, .38]], marks: [[b(13, 1), .29, .37]] },
  { id: 'projects', img: 'projects.png', in: b(14), out: b(15), cam: [[b(14), 1, .5, .5], [b(15), 1.45, .32, .45]], marks: [] },
  { id: 'boardA', img: 'board.png', in: b(15), out: b(16, 2), cam: [[b(15), 1, .5, .5], [b(16, 2), 1.6, .5, .38]], marks: [[b(15, 3), .375, .595]] },
  { id: 'boardB', img: 'board-guards.png', in: b(16, 2), out: b(17, 3), cam: [[b(16, 2), 1.3, .5, .3], [b(17, 3), 1.8, .5, .3]], marks: [[b(16, 3.5), .22, .263]] },
  { id: 'pmem', img: 'project-memory.png', in: b(17, 3), out: b(19), cam: [[b(17, 3), 1.2, .5, .4], [b(19), 1.6, .55, .35]], marks: [[b(18, 1), .717, .318]] },
  { id: 'vmpanel', img: 'app-approval.png', in: b(20), out: b(21, 2), cam: [[b(20), 1.5, .72, .45], [b(21, 2), 1.9, .75, .42]], marks: [] },
  { id: 'bsvA', img: 'bsv-status.png', in: b(24), out: b(25, 2), cam: [[b(24), 1, .5, .5], [b(25, 2), 1.5, .5, .34]], marks: [] },
  { id: 'bsvB', img: 'bsv-spend.png', in: b(25, 2), out: b(27), cam: [[b(25, 2), 1.2, .5, .42], [b(27), 1.7, .5, .36]], marks: [] },
  { id: 'blA', img: 'blender-chooser.png', in: b(27), out: b(28, 3), cam: [[b(27), 1, .5, .5], [b(28, 3), 1.6, .42, .45]], marks: [] },
  { id: 'blB', img: 'blender-get.png', in: b(28, 3), out: b(30), cam: [[b(28, 3), 1.1, .5, .5], [b(30), 1.5, .55, .55]], marks: [] },
  { id: 'upd', img: 'update-panel.png', in: b(31), out: b(32), cam: [[b(31), 1.05, .5, .5], [b(32), 1.35, .5, .5]], marks: [] },
];

// ---- captions. slot 'col' = right-hand column beside a UI shot; 'mid' = centred; a..b = fully visible window (fades are inside +- .35 s) ----
export const CAPS = [
  { id: 'l1', slot: 'cold1', text: 'A team of Claude agents.', a: b(0, 1), b: b(2, .4) },
  { id: 'l2', slot: 'cold2', text: 'On your own computer.', a: b(1, 1), b: b(2, .4) },
  { id: 'sub', slot: 'sub', text: 'Legion 0.2.0. Now in beta.', a: b(2, 3), b: b(3, 3.6) },
  { id: 'must', slot: 'mustcap', text: 'Thirteen bots. Each with its own role.', a: b(5, 2), b: b(6, 3.6) },
  { id: 'appr', slot: 'col', k: 'approvals', text: 'You approve the risky calls.', a: b(7, 1), b: b(8, 2.6) },
  { id: 'taint', slot: 'col', k: 'approvals', text: 'Web content is treated as untrusted.', a: b(8, 3.6), b: b(9, 3.6) },
  { id: 'room', slot: 'col', k: 'rooms', text: 'Rooms: bots and you.', a: b(10, .4), b: b(10, 3.6) },
  { id: 'lat', slot: 'col', k: 'library', text: 'A shared memory you can read.', a: b(11, .6), b: b(12, 2.6) },
  { id: 'acc', slot: 'col', k: 'library', text: 'Bots propose. You accept or reject.', a: b(12, 3.4), b: b(13, 3.6) },
  { id: 'proj', slot: 'col', k: 'projects', text: 'Projects: tasks, rooms, notes, agents.', a: b(14, .3), b: b(14, 3.8) },
  { id: 'brd', slot: 'col', k: 'projects', text: 'Agents work the board with you.', a: b(15, .4), b: b(16, 1.3) },
  { id: 'grd', slot: 'col', k: 'projects', text: 'You mark Done. You approve deletes.', a: b(16, 2.5), b: b(17, 2.9) },
  { id: 'pm', slot: 'col', k: 'projects', text: 'Save what you learned.', a: b(18, .4), b: b(18, 3.6) },
  { id: 'mem', slot: 'digest', text: 'Runs start with the board.', a: b(19, .5), b: b(19, 3.8) },
  { id: 'vm', slot: 'col', k: 'vm', text: 'Their own cloud computer, when you want one.', a: b(20, .5), b: b(21, 2.4) },
  { id: 'mcp', slot: 'termcap', text: 'Drive it from Claude Code or Cowork.', a: b(21, 3), b: b(23, 3.6) },
  { id: 'bsv1', slot: 'col', k: 'bsv', text: 'BSV mode. Off by default.', a: b(24, .5), b: b(25, 2.2) },
  { id: 'bsv2', slot: 'col', k: 'bsv', text: 'A spend tool, behind your own confirmations.', a: b(25, 3), b: b(26, 3.6) },
  { id: 'bl1', slot: 'col', k: 'blender', text: 'Blender, with the Sculptor. It runs here first.', a: b(27, .5), b: b(28, 2.4) },
  { id: 'bl2', slot: 'col', k: 'blender', text: 'One pinned Blender, only after you say yes.', a: b(28, 3.4), b: b(29, 3.9) },
  { id: 'rtA', slot: 'routeA', text: 'No Node. No Git. No npm.', a: b(30, .3), b: b(30, 3.9) },
  { id: 'rtB', slot: 'routeB', text: 'Or from source: setup.cmd.', a: b(30, 1.5), b: b(30, 3.9) },
  { id: 'upd', slot: 'col', k: 'install', text: 'Updates only when you click.', a: b(31, .5), b: b(31, 3.7) },
  { id: 'loop', slot: 'loopcap', text: 'Listens here only. Testable with fakes.', a: b(32, .2), b: b(32, 3.9) },
];
// Captions in one slot must not share a frame, fades included (0.35 s each side): trim an earlier caption's end so the gap is 0.72 s.
for (const slot of new Set(CAPS.map((c) => c.slot))) {
  const L = CAPS.filter((c) => c.slot === slot).sort((x, y) => x.a - y.a);
  for (let i = 1; i < L.length; i++) if (L[i].a - L[i - 1].b < 0.72) L[i - 1].b = +(L[i].a - 0.72).toFixed(3);
}
// each chip belongs to its scene; "not tried" chips are mandatory for BUILT-NOT-TRIED scenes (check.mjs)
export const CHIPS = [
  { id: 'c-board', slot: 'col', text: 'Built and tested. Not yet tried on a real PC.', a: b(15, 1.5), b: b(18, 3.6), needs: 'F29' },
  { id: 'c-bsv', slot: 'col', text: 'Built against fakes. Not tried with real funds.', a: b(25, 0), b: b(26, 3.7), needs: 'F12' },
  { id: 'c-bl', slot: 'col', text: 'Not yet tried on a real Blender.', a: b(27, 2), b: b(29, 3.7), needs: 'F13' },
  { id: 'c-pkg', slot: 'routes-a', text: 'Built by script. Not yet run on Windows.', a: b(30, 1), b: b(30, 3.8), needs: 'F16' },
  { id: 'c-upd', slot: 'col', text: 'Built. Not yet tried.', a: b(31, 1), b: b(31, 3.8), needs: 'F18' },
];

export const NEXT_CARDS = [
  { id: 'n1', title: 'More model providers.', sub: '', a: 83.75, b: 85.15 },
  { id: 'n2', title: 'A knowledge-graph audit button.', sub: 'Refreshes stale notes.', a: 85.15, b: 88.25 },
  { id: 'n3', title: 'The Sentinel scheduler.', sub: '', a: 88.25, b: 89.75 },
  { id: 'n4', title: 'An optional lighter package.', sub: '', a: 89.75, b: 91.35 },
  { id: 'n5', title: 'More browser engines, optional.', sub: '', a: 91.35, b: 93.0 },
  { id: 'n6', title: 'Real-wallet BSV checks.', sub: '', a: 93.0, b: 94.4 },
];

export const CUTS = [
  { id: 'cold>awaken', at: b(2), kind: 'dissolve' },
  { id: 'awaken>muster', at: b(4), kind: 'match' },
  { id: 'muster>approval', at: b(7), kind: 'dissolve' },
  { id: 'approval>inbox', at: b(8, 3), kind: 'hard' },
  { id: 'inbox>rooms', at: b(10), kind: 'dissolve' },
  { id: 'rooms>lattice', at: b(11), kind: 'dissolve' },
  { id: 'lattice>inbox2', at: b(12, 3), kind: 'hard' },
  { id: 'inbox2>projects', at: b(14), kind: 'dissolve' },
  { id: 'projects>boardA', at: b(15), kind: 'hard' },
  { id: 'boardA>boardB', at: b(16, 2), kind: 'hard' },
  { id: 'boardB>pmem', at: b(17, 3), kind: 'hard' },
  { id: 'pmem>digest', at: b(19), kind: 'hard' },
  { id: 'digest>vm', at: b(20), kind: 'dissolve' },
  { id: 'vm>term', at: b(21, 2), kind: 'hard' },
  { id: 'term>bsvA', at: b(24), kind: 'dissolve' },
  { id: 'bsvA>bsvB', at: b(25, 2), kind: 'hard' },
  { id: 'bsvB>blA', at: b(27), kind: 'dissolve' },
  { id: 'blA>blB', at: b(28, 3), kind: 'hard' },
  { id: 'blB>routes', at: b(30), kind: 'dissolve' },
  { id: 'routes>upd', at: b(31), kind: 'hard' },
  { id: 'upd>loop', at: b(32), kind: 'hard' },
  { id: 'loop>next', at: b(33), kind: 'dissolve' },
  { id: 'next>end', at: b(38), kind: 'hard' },
];

// ---- terminal (MCP). Real tool names from src/core/mcp-tools.ts; outputs only fields the tools return (names, state, status, model). ----
export const LOG = [
  { a: b(21, 3), d: .5, segs: [['> ', 'p'], ['claude  ', ''], ['(Claude Code, or Cowork)', 'd']] },
  { a: b(22, 1), d: .5, segs: [['● ', 'p'], ['legion_list_agents', ''], ['  → 13 agents', 'gr']] },
  { a: b(22, 2), d: .5, segs: [['● ', 'p'], ['legion_projects', ''], ['  → your projects', 'gr']] },
  { a: b(22, 3), d: .5, segs: [['● ', 'p'], ['legion_vm ', ''], ['builder start', 'd'], ['  → ready', 'gr']] },
  { a: b(23), d: .9, segs: [['● ', 'p'], ['legion_run ', ''], ['builder ', 'd'], ['"fix the failing test"', 'g']] },
  { a: b(23, 2.6), d: .5, segs: [['  ← ', 'd'], ['done', 'gr'], ['  ·  model ', 'd'], ['sonnet', 'gr']] },
  { a: b(23, 3.1), d: .45, segs: [['  ', 'd'], ['approvals still happen in the app', 's']] },
];

export const T = {
  dur: b(42),
  cold: { candleIn: [0, .9], candleOut: [b(1, 3.4), b(2, .8)] },
  muster: { rise: b(4, 1), step: BEAT / 2, grid: b(4, 1) },
  victory: { at: b(38), flash: [b(38), b(38) + .3] },
  end: { wmDraw: [b(38, 1), b(39)], wmFill: [b(39), b(39, 2)], tag: b(39, 1.5), print: b(40), sigil: b(40, 2), fadeOut: [b(41, 2), b(42)] },
  next: { head: b(33, 1), silence: b(37, 3) },
  term: [b(21, 2), b(24)],
  // Relic homes: centre (awakening), grid slot 1 (muster), column bottom-right (UI scenes, NEXT), centre-high (end card)
  relic: [
    [0, 960, 400, 600, 0], [b(1, 3.6), 960, 400, 600, 0], [b(2, 2), 960, 400, 600, 1], [b(3, 3.6), 960, 400, 600, 1],
    [b(4, 1.2), 174, 300, 270, 1], [b(6, 3.5), 174, 300, 270, 1],                            // into Zealot's place in the muster grid
    [b(7, 1.5), 1650, 850, 340, 1], [b(33), 1650, 850, 340, 1], [b(33, 3), 1530, 520, 520, 1],
    [b(37, 3), 1530, 520, 520, .0], [b(38), 960, 400, 640, 1], [b(39), 960, 400, 640, 1], [b(40, 2), 960, 250, 420, 1], [200, 960, 250, 420, 1],
  ],
  states: [[0, 'sleeping'], [b(2, 2), 'idle'], [b(4), 'thinking'], [b(7), 'awaiting'], [b(8, 3), 'idle'], [b(11), 'thinking'], [b(14), 'idle'], [b(20, 1), 'hacking'], [b(24), 'awaiting'],
    [b(27), 'hacking'], [b(30), 'idle'], [b(38), 'victory'], [b(40), 'idle']],
};

// README GIF: ~15 s highlight (muster, approval, the memory layer, NEXT, end card)
export const GIF_SEGMENTS = [[b(5), b(6, 3)], [b(7, 1), b(8, 2)], [b(15, 1), b(16, 2)], [b(34, 2), b(35, 3)], [b(39), b(41)]];

const r3 = (x) => +x.toFixed(3);
export function cues() {
  const sections = Object.entries(S).map(([name, [a, z]]) => ({ name, start: r3(a * BAR), end: r3(z * BAR) }));
  const ev = []; const e = (t, name, extra = {}) => ev.push({ t: r3(t), name, ...extra });
  CAPS.forEach((c, i) => e(c.a, 'caption', { id: c.id }));
  CHIPS.forEach((c) => e(c.a, 'chip', { id: c.id }));
  ROSTER.forEach(([id], i) => e(T.muster.rise + i * T.muster.step, i === 0 ? 'relic_slot' : 'roster', { n: i + 1 }));
  SHOTS.forEach((s) => s.marks.forEach(([t]) => e(t, 'mark', { id: s.id })));
  NEXT_CARDS.forEach((c) => e(c.a, 'next_card', { id: c.id }));
  e(T.next.head, 'next_head'); e(T.next.silence, 'silence');
  LOG.forEach((L, i) => { e(L.a, 'vox_line', { n: i + 1 }); if (L.segs.some(([, c]) => c === 'gr')) e(L.a + L.d, 'vox_ok'); });
  e(T.victory.at, 'victory'); e(T.end.wmDraw[0], 'wm_draw'); e(T.end.wmFill[0], 'wm_fill'); e(T.end.tag, 'tag'); e(T.end.sigil, 'sigil');
  e(T.end.fadeOut[0], 'fade_out'); e(T.dur, 'end');
  ev.sort((x, y) => x.t - y.t);
  const typing = LOG.map((L) => ({ start: r3(L.a), end: r3(L.a + L.d), chars: L.segs.reduce((n, s) => n + s[0].length, 0) }));
  const cuts = CUTS.map((c) => ({ id: c.id, t: r3(c.at), kind: c.kind }));
  return { duration: r3(T.dur), fps: FPS, bpm: BPM, sections, events: ev, typing, cuts };
}
