// Idle personality for the painted busts: weighted, cooldown-gated "verbs" built from a small shared set of
// primitives (lean, nod, scan, flutter, flare, wave). Every primitive is a CSS transform / filter / custom-property
// change on a layer the engine already has (rig, plume, halo, hang-N, token-N, face), played with the Web
// Animations API so the motion stays composited and never touches the painted art.
//
// A persona (ui/src/mascot/personas/<name>.json) lists verbs:
//   { "id": "re-file", "w": 3, "cd": 40, "when": "idle", "steps": [ { "p": "flutter", "target": "halo", "deg": 15, "keep": true, "dur": 1400 } ] }
//   w  = weight in the random pick, cd = cooldown in seconds for that verb, when = idle | quip | victory
//   every step may carry "at" (ms offset from the verb start); durations are multiplied by persona.tempo.
// Motion is solemn on purpose: small angles, ease-in-out, nothing faster than ~0.5 s.

export const PRIMITIVES = ['lean', 'nod', 'scan', 'flutter', 'flare', 'wave'];

/**
 * @param {{
 *   el: (target: string) => HTMLElement[],
 *   eyes: (set: string | null) => void,
 *   look: (x: number, y: number) => void,
 *   holdBlink: (ms: number) => void,
 *   later: (fn: () => void, ms: number) => unknown,
 *   cancelLater: (h: unknown) => void,
 *   haloStep: (deg: number) => void,
 *   reduced: boolean,
 * }} ctx
 * @param {{tempo?: number, verbs?: any[]}} persona
 */
export function createVerbs(ctx, persona) {
  const tempo = persona.tempo && persona.tempo > 0 ? persona.tempo : 1;
  const verbs = (persona.verbs || []).map((v) => ({ ...v, last: -1e9 }));
  const live = new Set();
  const handles = new Set();

  const T = (ms) => Math.round(ms * tempo);
  const later = (fn, ms) => { const h = ctx.later(() => { handles.delete(h); fn(); }, ms); handles.add(h); return h; };

  function anim(els, keyframes, o) {
    const made = [];
    for (const e of els) {
      if (!e || !e.animate) continue;
      const a = e.animate(keyframes, { fill: 'none', easing: 'ease-in-out', composite: 'add', ...o });
      live.add(a); made.push(a);
      const done = () => live.delete(a);
      a.addEventListener('finish', done); a.addEventListener('cancel', done);
    }
    return made;
  }

  // oscillation with decay, in degrees: 0, +d, -.7d, +.4d, 0
  const osc = (deg, cycles) => {
    const frames = [{ transform: 'rotate(0deg)' }];
    let amp = 1;
    for (let i = 0; i < cycles; i++) {
      frames.push({ transform: `rotate(${(deg * amp).toFixed(2)}deg)` });
      frames.push({ transform: `rotate(${(-deg * amp * 0.7).toFixed(2)}deg)` });
      amp *= 0.55;
    }
    frames.push({ transform: 'rotate(0deg)' });
    return frames;
  };

  const P = {
    // rig leans through a list of angles (e.g. [-1, 1, 0]) and holds at each
    lean(s) {
      const seq = Array.isArray(s.deg) ? s.deg : [s.deg ?? 2];
      const dur = T(s.dur ?? 1800);
      const frames = [{ transform: 'rotate(0deg)', offset: 0 }];
      seq.forEach((d, i) => {
        const a = (i + 1) / (seq.length + 1);
        frames.push({ transform: `rotate(${d}deg)`, offset: Math.min(0.98, a - 0.12 / seq.length) });
        frames.push({ transform: `rotate(${d}deg)`, offset: Math.min(0.98, a + 0.12 / seq.length) });
      });
      frames.push({ transform: 'rotate(0deg)', offset: 1 });
      anim(ctx.el(s.target || 'rig'), frames, { duration: dur });
      return dur;
    },
    // one small dip of the head (percent of the bust height), optionally dimming the face and repeating
    nod(s) {
      const dur = T(s.dur ?? 1400);
      const times = s.times || 1;
      const y = s.y ?? 1.5; const deg = s.deg ?? 0;
      const frames = [{ transform: 'translateY(0) rotate(0deg)' }];
      for (let i = 0; i < times; i++) {
        frames.push({ transform: `translateY(${y}%) rotate(${deg}deg)` });
        frames.push({ transform: 'translateY(0) rotate(0deg)' });
      }
      anim(ctx.el('rig'), frames, { duration: dur });
      if (s.dim) P.flare({ target: 'face', to: s.dim, dur: s.dur ?? 1400 });
      return dur;
    },
    // eyes slide along a list of [x, y] offsets (viewBox units), optionally behind an eye set (narrow, shut ...)
    scan(s) {
      const dur = T(s.dur ?? 2400);
      const pts = s.look && s.look.length ? s.look : [[-6, 0], [6, 0]];
      if (s.eyes) ctx.eyes(s.eyes);
      ctx.holdBlink(dur + 600);
      pts.forEach((p, i) => later(() => ctx.look(p[0], p[1]), Math.round((i * dur) / pts.length)));
      later(() => { ctx.look(0, 0); if (s.eyes) ctx.eyes(null); }, dur);
      return dur;
    },
    // a layer (plume, token, hang-N, halo, rig) rocks and settles; keep:true turns it one fixed step and leaves it there
    flutter(s) {
      const dur = T(s.dur ?? 1000);
      const target = s.target || 'plume';
      if (s.keep && target === 'halo') {
        // the turn is played as an additive animation; once it ends the new angle is committed to the layer and the animation dropped
        const made = anim(ctx.el('halo'), [{ transform: 'rotate(0deg)' }, { transform: `rotate(${s.deg ?? 12}deg)` }], { duration: dur, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' });
        later(() => { ctx.haloStep(s.deg ?? 12); made.forEach((a) => a.cancel()); }, dur + 20);
        return dur + 40;
      }
      anim(ctx.el(target), osc(s.deg ?? 3, s.cycles || 1), { duration: dur });
      return dur;
    },
    // brightness pulse (peak > 1) or dim-and-return (to < 1) on face, plume or rig
    flare(s) {
      const dur = T(s.dur ?? 900);
      const v = s.to ?? s.peak ?? 1.2;
      anim(ctx.el(s.target || 'face'), [{ filter: 'brightness(1)' }, { filter: `brightness(${v})`, offset: 0.4 }, { filter: 'brightness(1)' }], { duration: dur, composite: 'replace' });
      return dur;
    },
    // flutter run across the hangs one after another (left to right unless order:"rtl")
    wave(s) {
      const dur = T(s.dur ?? 900);
      const els = ctx.el(s.targets || 'hangs');
      const order = s.order === 'rtl' ? els.slice().reverse() : els;
      const gap = T(s.stagger ?? 180);
      let end = 0;
      order.forEach((e, i) => {
        anim([e], osc(s.deg ?? 4, s.cycles || 1), { duration: dur, delay: i * gap });
        end = i * gap + dur;
      });
      return end;
    },
  };

  /** Plays a verb; resolves to its total length in ms (for rail-wide spacing). */
  function play(verb) {
    if (ctx.reduced || !verb) return 0;
    verb.last = performance.now();
    let total = 0;
    for (const s of verb.steps || []) {
      const fn = P[s.p];
      if (!fn) continue;
      const at = T(s.at || 0);
      if (at === 0) total = Math.max(total, fn(s));
      else { later(() => fn(s), at); total = Math.max(total, at + T(s.dur ?? 1000) * (s.p === 'wave' ? 2 : 1)); }
    }
    if (verb.noBlink) ctx.holdBlink(T(verb.noBlink));
    return total;
  }

  /** Weighted pick among verbs for a trigger that are off cooldown. */
  function pick(when = 'idle', now = performance.now()) {
    const ok = verbs.filter((v) => (v.when || 'idle') === when && now - v.last >= (v.cd ?? 30) * 1000);
    if (!ok.length) return null;
    let r = Math.random() * ok.reduce((n, v) => n + (v.w ?? 1), 0);
    for (const v of ok) { r -= v.w ?? 1; if (r <= 0) return v; }
    return ok[ok.length - 1];
  }

  function cancel() {
    live.forEach((a) => { try { a.cancel(); } catch { /* already finished */ } }); live.clear();
    handles.forEach((h) => ctx.cancelLater(h)); handles.clear();
    ctx.look(0, 0); ctx.eyes(null);
  }

  return {
    verbs, pick, play, cancel, tempo,
    get busy() { return live.size > 0 || handles.size > 0; },
    byId: (id) => verbs.find((v) => v.id === id) || null,
    hasHaloStep: verbs.some((v) => (v.steps || []).some((s) => s.p === 'flutter' && s.keep && (s.target || '') === 'halo')),
  };
}
