#!/usr/bin/env node
// Editing-rule checks on timeline.mjs (no rendering needed):  node docs/video/check.mjs
//   - every line of text is at full opacity for >= 0.3 s per word + 0.8 s (minus 0.5 s grace for its fades)
//   - every cut sits on the beat grid
//   - the end card holds the call to action for at least 2 s before the fade
import { T, CUTS, BEAT, LOG } from './timeline.mjs';

const words = (s) => s.trim().split(/\s+/).length;
const need = (s) => 0.3 * words(s) + 0.8;
const F = T.field, M = T.muster, A = T.awaken, C = T.cold, V = T.victory;
const TEXT = [
  ['In the grim darkness of your backlog…', C.l1[1], C.l1[2]],
  ['…there is only work.', C.l2[1], C.l2[2]],
  ['An order of Claude agents. Yours to command.', A.sub[1], A.sub[2]],
  ['Sonnet for the line. Opus for the war council.', M.caption[1], M.caption[2]],
  ['Thirteen offices. One order.', M.caption2[1], M.caption2[2]],
  ['Nothing ships unsealed', F.callouts[0] + .35, F.pan[0] - .1],
  ['Every agent gets a forge-machine', F.callouts[1] + .35, F.out],
  ["Slash commands. Yours, and Claude Code's.", F.slash[0], F.slash[1]],
  ['Auto routing, or any model.', F.model[0], F.model[1]],
  ['Command the whole order from Claude Code or Cowork.', T.vox.title[1], T.vox.term[1]],
  ['The work is done.', V.text[1], V.text[2]],
  ['Local. Claude-native. Open source.', T.end.tag + .7, T.end.fadeOut[0]],
  ['Coming soon.', T.end.url + .7, T.end.fadeOut[0]],
];
let bad = 0;
for (const [s, a, b] of TEXT) {
  const full = b - a, req = need(s) - 0.5, ok = full >= req;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'SHORT'} ${full.toFixed(2)}s full / ${req.toFixed(2)}s needed  ${s}`);
}
for (const c of CUTS) {
  const beats = c.at / BEAT, on = Math.abs(beats - Math.round(beats)) < 1e-6;
  if (!on) bad++;
  console.log(`${on ? 'ok  ' : 'OFF '} cut ${c.id} at ${c.at}s (beat ${beats.toFixed(2)})`);
}
const sealed = LOG[LOG.length - 1].a + LOG[LOG.length - 1].d;
console.log(`${Math.abs(sealed - T.vox.sealed) < 1e-6 ? 'ok  ' : 'OFF '} "sealed." lands at ${sealed.toFixed(3)}s`);
process.exit(bad ? 1 : 0);
