#!/usr/bin/env node
// Editing-rule and honesty checks on timeline.mjs (no rendering):  node docs/video-v2/check.mjs
//  - every caption is fully visible >= 0.3 s per word + 0.8 s (minus 0.5 s grace for its fades)
//  - every cut sits on the beat grid
//  - every BUILT-NOT-TRIED scene has its "not tried" chip, visible for the whole scene
//  - no banned word anywhere in the on-screen text (BRIEF.md section 5)
//  - no two captions in the same slot overlap in time; the NEXT block has no UI shot in it
import { T, CUTS, BEAT, CAPS, CHIPS, NEXT_CARDS, SHOTS, LOG, S, b } from './timeline.mjs';

const words = (s) => s.trim().split(/\s+/).length;
const need = (s) => 0.3 * words(s) + 0.8;
let bad = 0;
const fail = (m) => { bad++; console.log('FAIL ' + m); };
for (const c of CAPS) {
  const full = c.b - c.a, req = need(c.text) - 0.5, ok = full >= req;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'SHORT'} ${full.toFixed(2)}s / ${req.toFixed(2)}s  ${c.text}`);
}
for (const c of NEXT_CARDS) {
  const txt = c.title + ' ' + c.sub, full = c.b - c.a, req = need(txt) - 0.5, ok = full >= req;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'SHORT'} ${full.toFixed(2)}s / ${req.toFixed(2)}s  NEXT ${txt}`);
}
for (const c of CUTS) { const bt = c.at / BEAT, on = Math.abs(bt - Math.round(bt)) < 1e-6; if (!on) fail(`cut ${c.id} off the beat grid`); }
const scene = { 'F12': S.bsv, 'F13': S.blender, 'F16': [b(31), b(32)], 'F18': [b(32), b(33)], 'F21': [b(29), b(31)], 'F29': [b(14), b(18)] };
for (const [row, [a, z]] of Object.entries(scene)) {
  const ch = CHIPS.find((c) => c.needs === row);
  if (!ch) { fail(`${row}: no chip`); continue; }
  const bars = row === 'F12' || row === 'F13'; const lo = bars ? a * BEAT * 4 : a, hi = bars ? z * BEAT * 4 : z;
  if (ch.a > lo + 2 * BEAT * 2 || ch.b < hi - BEAT * 1.5) fail(`${row}: chip "${ch.text}" does not cover its scene (${ch.a}-${ch.b} vs ${lo}-${hi})`);
  else console.log(`ok   ${row} chip covers its scene: ${ch.text}`);
}
const BANNED = /\b(safe|safely|secure|secured|security|verified|bypass|bypassed|young|guaranteed|unbreakable|fully|openai|codex|opencode|openrouter|ollama|lightpanda|agent-browser|todo|lorem|owner)\b/i;
const allText = [...CAPS.map((c) => c.text), ...CHIPS.map((c) => c.text), ...NEXT_CARDS.flatMap((c) => [c.title, c.sub]), ...LOG.flatMap((L) => L.segs.map((s) => s[0]))];
for (const t of allText) if (BANNED.test(t)) fail(`banned word in "${t}"`);
if (/\b20\d\d\b|\bQ[1-4]\b|\bsoon\b/i.test(allText.join(' '))) fail('a date or "soon" on screen');
const nextA = b(33), nextZ = b(38);
for (const s of SHOTS) if (s.in < nextZ && s.out > nextA) fail(`UI shot ${s.id} overlaps the NEXT block (planned items get text cards only)`);
for (const slot of new Set(CAPS.map((c) => c.slot))) {
  const L = CAPS.filter((c) => c.slot === slot).sort((x, y) => x.a - y.a);
  for (let i = 1; i < L.length; i++) if (L[i].a - L[i - 1].b < 0.7) fail(`captions overlap (fades included) in slot ${slot}: ${L[i - 1].id} / ${L[i].id} gap ${(L[i].a - L[i - 1].b).toFixed(2)}s`);
}
console.log(`${Math.abs(T.dur - 100) < 1e-6 ? 'ok  ' : 'NOTE'} duration ${T.dur}s`);
process.exit(bad ? 1 : 0);
