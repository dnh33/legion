// Single source of truth for every time in the trailer. trailer.html imports it to drive the picture,
// render.mjs imports it to emit cues.json, and score.py reads cues.json, so picture and music share one clock.
//
// Editing rules this cut follows (see BRIEF.md):
//   1. Everything sits on a 96 BPM grid (beat 0.625 s, bar 2.5 s). Scene changes land on bar lines, reveals on beats.
//   2. No dead air: scenes overlap (dissolve) or cut hard on a downbeat. Black only at the very start and end.
//   3. The Relic is the anchor. It holds one screen position per act and moves between them on screen, never pops.
//   4. One idea per shot, and every line of text stays up long enough to read (>= 0.3 s per word + 0.8 s).
//   5. Pace tightens toward the climax, then the end card breathes. The title is revealed once, at the end.
export const FPS = 30;
export const BPM = 96;
export const BEAT = 60 / BPM;                 // 0.625
export const BAR = BEAT * 4;                  // 2.5
export const b = (bar, beat = 0) => +(bar * BAR + beat * BEAT).toFixed(4);

// Transition lengths by kind. CUTS below says which kind each scene change uses; edit-decisions.json
// (written by edit_judge.py from Jev's answers, if it was run) overrides the defaults.
export const TRANSITION = { hard: 0.06, dissolve: 0.5, match: 0.7 };

// Every scene change: when it happens, what it joins, and the default transition (principle-based).
export const CUTS = [
  { id: 'cold>awaken', at: b(2), kind: 'dissolve', from: 'Candle and two lines of text on black', to: 'Gothic arch fades up, the Relic asleep inside it' },
  { id: 'awaken>muster', at: b(4), kind: 'match', from: 'The Relic centred and awake, subtitle under it', to: 'The Relic moves to the right; three agent banners rise on the left' },
  { id: 'banners>roster', at: b(6), kind: 'dissolve', from: 'Three red agent banners', to: 'Roll call: a grid of thirteen named agent plaques, same Relic position' },
  { id: 'muster>field', at: b(8), kind: 'dissolve', from: 'Roster grid and the Relic', to: 'Full screenshot of the Legion app in a gold frame' },
  { id: 'field>slash', at: b(10, 3), kind: 'hard', from: 'App screenshot zoomed on the computer panel', to: 'Screenshot of the slash-command menu' },
  { id: 'slash>model', at: b(11, 3), kind: 'hard', from: 'Slash-command menu screenshot', to: 'Model picker screenshot' },
  { id: 'model>bsv', at: b(13), kind: 'hard', from: 'Model picker screenshot', to: 'BitcoinSV title card with a pulsing block chain, the Relic returns on the right' },
  { id: 'bsv>blender', at: b(14, 2), kind: 'dissolve', from: 'BitcoinSV chain card', to: 'Blender title card with a rotating wireframe, same Relic position' },
  { id: 'blender>vox', at: b(16), kind: 'hard', from: 'Blender wireframe card', to: 'Title "Command the whole order from Claude Code or Cowork" over a terminal driving Legion, same Relic position' },
  { id: 'vox>victory', at: b(20), kind: 'hard', from: 'Terminal ends on "sealed."', to: 'Flash; the Relic flies to the centre in victory' },
  { id: 'victory>end', at: b(21), kind: 'match', from: 'Relic centred, "The work is done."', to: 'Relic rises; the LEGION wordmark forges under it' },
];

// The order, as specced in claude/legion-muster-spec.md (roll call scene). hue = identity accent from the art constitution.
export const ROSTER = [
  ['Zealot', 'Lead', '#b3202f'], ['Builder', 'Builds, in its VM', '#3fa58f'], ['Scout', 'Research', '#7b8ea6'],
  ['Inquisitor', 'Review and audit', '#7a5cc4'], ['Scribe', 'Docs', '#5a6fc4'], ['Archivist', 'Memory', '#8a6a4a'],
  ['Sentinel', 'Watch and alerts', '#9fb3c0'], ['Forgemaster', 'Infra and deploys', '#a8683f'], ['Exorcist', 'Debugging', '#d8cfb8'],
  ['Preceptor', 'The craft pass', '#c9bfa6'], ['Herald', 'Comms drafts', '#a07aa0'], ['Assayer', 'BitcoinSV', '#6fa3d1'], ['Sculptor', 'Blender', '#cfcac0'],
];

export const LOG = [                          // command scene: a = start of typing, d = typing duration
  { a: b(17), d: .5, segs: [['> ', 'p'], ['claude  ', ''], ['(Claude Code, or Cowork)', 'd']] },
  { a: b(17, 2), d: .55, segs: [['● ', 'p'], ['legion_list_agents', ''], ['  → 13 agents', 'gr']] },
  { a: b(18), d: .55, segs: [['● ', 'p'], ['legion_vm ', ''], ['builder start', 'd'], ['  → ready', 'gr']] },
  { a: b(18, 2), d: 1.0, segs: [['● ', 'p'], ['legion_run ', ''], ['builder ', 'd'], ['"migrate auth to passkeys"', 'g']] },
  { a: b(19), d: .45, segs: [['  ← ', 'd'], ['"Passkeys live. 142 tests pass."', 'g']] },              // legion_run returns the answer…
  { a: b(19, 1), d: .4, segs: [['  ← ', 'd'], ['model ', 'd'], ['opus', 'gr'], ['  ·  $0.41  ·  task 7f3c', 'd']] }, // …plus model, cost and taskId
  { a: b(19, 2) - .3, d: .3, segs: [['  ++ ', 'd'], ['sealed.', 's']] },   // "sealed." lands exactly on b(19,2)
];

// Bars: cold 0-2 · awakening 2-4 · muster 4-8 · field 8-13 · forges 13-16 · command 16-20 · victory 20-21 · end 21-24
export const T = {
  dur: b(24),                                                     // 60 s
  cold: { candleIn: [0, .9], l1: [b(0, 1.5), b(0, 2.6), b(2), b(2, .8)], l2: [b(1), b(1, 1), b(2), b(2, .8)], candleOut: [b(1, 3.4), b(2, .8)], end: b(2) },
  awaken: { arch: [b(1, 3.2), b(2, 2.4)], wake: b(2, 2), sub: [b(2, 2.6), b(2, 3.4), b(3, 3.8), b(4, .5)], end: b(4) },
  muster: { banners: [b(4), b(4, 1), b(4, 2)], caption: [b(4, 2.2), b(4, 3), b(5, 3.8), b(6, .5)], roster: b(6), rosterStep: BEAT / 4, caption2: [b(6, 3), b(7), b(7, 3.6), b(8, .3)], end: b(8) },
  field: {
    in: b(8), out: b(10, 3),
    push: [b(8, .4), b(8, 1.4)],         // full app -> zoom on the approval card
    pan: [b(9, 1), b(9, 2.4)],           // approval card -> computer panel
    callouts: [b(8, 1.4), b(9, 2.6)],
    slash: [b(10, 3), b(11, 3)], model: [b(11, 3), b(13)],
    end: b(13),
  },
  forges: {
    a: { show: [b(13), b(14, 2)], pulses: [b(13, 2), b(14), b(14, 1.6)], period: 1.1 },
    b: { show: [b(14, 2), b(16)] },
    awaiting: [b(14), b(14, 2)],
    hackingFrom: b(14, 2),
    end: b(16),
  },
  vox: { term: [b(16), b(20)], title: [b(16), b(16, 1)], chips: b(16, 3), sealed: b(19, 2), end: b(20) },
  victory: { at: b(20), text: [b(20, 1), b(20, 1.8), b(21, .6), b(21, 1.2)], flash: [b(20), b(20) + .3], end: b(21) },   // clears before the wordmark draws
  end: { wmDraw: [b(21, 1.25), b(21, 3.75)], wmFill: [b(22), b(22, 1.4)], tag: b(22, 1.5), url: b(22, 2.5), print: b(22, 3.3), sigil: b(23), fadeOut: [b(23, 2.5), b(24)] },
  chapters: [],
  relic: [ // t, cx, cy, h, opacity. Three homes only: centre (awakening), right (muster, forges, command), centre-high (end).
    [0, 960, 400, 600, 0], [b(1, 3.6), 960, 400, 600, 0], [b(2, 2), 960, 400, 600, 1],
    [b(3, 3.6), 960, 400, 600, 1], [b(4, 1.6), 1555, 470, 560, 1],                     // match move into the muster
    [b(7, 3.4), 1555, 470, 560, 1], [b(8, .4), 1555, 470, 560, 0],                      // steps out for the app cutaway
    [b(13), 1555, 470, 560, 0], [b(13, 1.2), 1555, 470, 560, 1],                        // back in the same spot
    [b(20), 1555, 470, 560, 1], [b(20, 1.6), 960, 400, 640, 1],                          // victory: flies to centre
    [b(21), 960, 400, 640, 1], [b(21, 3), 960, 250, 420, 1], [90, 960, 250, 420, 1],     // rises over the wordmark
  ],
  // the Relic's expression over time: [from, state]
  states: [[0, 'sleeping'], [b(2, 2), 'idle'], [b(4), 'thinking'], [b(13), 'idle'], [b(14), 'awaiting'], [b(14, 2), 'hacking'], [b(20), 'victory'], [b(22, 2), 'idle']],
};

// README GIF: a ~16 s highlight (cold open, the roll call, BitcoinSV, end card). Starts on a lit frame (the GIF's thumbnail).
export const GIF_SEGMENTS = [[1.7, 4.9], [b(6), b(7, 3)], [b(13, .4), b(14, 2)], [b(22), b(23, 2)]];

const r3 = (x) => +x.toFixed(3);
export function cues(decisions = null) {
  const A = T.forges.a;
  const sections = [
    ['cold-open', 0, T.cold.end], ['awakening', T.cold.end, T.awaken.end], ['muster', T.awaken.end, T.muster.end],
    ['field', T.muster.end, T.field.end], ['forges', T.field.end, T.forges.end], ['vox', T.forges.end, T.victory.at],
    ['victory', T.victory.at, T.victory.end], ['end', T.victory.end, T.dur],
  ].map(([name, start, end]) => ({ name, start: r3(start), end: r3(end) }));
  const ev = [];
  const e = (t, name, extra = {}) => ev.push({ t: r3(t), name, ...extra });
  e(T.cold.l1[0], 'line1'); e(T.cold.l2[0], 'line2');
  e(T.awaken.wake, 'relic_wake'); e(T.awaken.sub[0], 'subtitle');
  T.muster.banners.forEach((t, i) => e(t, 'banner', { n: i + 1 }));
  e(T.muster.caption[0], 'caption');
  ROSTER.forEach((r, i) => e(T.muster.roster + i * T.muster.rosterStep, 'roster', { n: i + 1 }));
  e(T.muster.caption2[0], 'caption2');
  T.field.callouts.forEach((t, i) => e(t, 'callout', { n: i + 1 }));
  e(T.field.push[0], 'push'); e(T.field.pan[0], 'pan');
  e(T.field.slash[0], 'shot', { n: 1 }); e(T.field.model[0], 'shot', { n: 2 });
  e(A.show[0], 'bsv_in');
  A.pulses.forEach((t, i) => e(t, 'chain_pulse', { n: i + 1 }));
  e(T.forges.awaiting[0], 'bsv_approval');
  e(T.forges.b.show[0], 'blender_in');
  e(T.vox.term[0], 'vox_in'); e(T.vox.chips, 'chips');
  LOG.forEach((L, i) => {
    e(L.a, 'vox_line', { n: i + 1 });
    if (L.segs.some(([, c]) => c === 'gr')) e(L.a + L.d, 'vox_ok');
  });
  e(T.vox.sealed, 'vox_sealed');
  e(T.victory.at, 'victory');
  e(T.end.wmDraw[0], 'wm_draw'); e(T.end.wmFill[0], 'wm_fill');
  e(T.end.tag, 'tag'); e(T.end.url, 'url'); e(T.end.sigil, 'sigil'); e(T.end.print, 'print');
  e(T.end.fadeOut[0], 'fade_out'); e(T.dur, 'end');
  ev.sort((a, b2) => a.t - b2.t);
  const typing = LOG.map((L) => ({ start: r3(L.a), end: r3(L.a + L.d), chars: L.segs.reduce((n, s) => n + s[0].length, 0) }));
  const cuts = CUTS.map((c) => ({ id: c.id, t: r3(c.at), kind: (decisions && decisions[c.id]) || c.kind }));
  return { duration: r3(T.dur), fps: FPS, bpm: BPM, sections, events: ev, typing, cuts };
}
