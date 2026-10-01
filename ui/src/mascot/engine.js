// Legion mascot engine: framework-free, shared by the app and the demo page.
// Takes a mascot built by scripts/build-mascot.py (hand-painted layers, never redrawn) and
// stacks each layer as its own <svg> so motion is GPU-composited instead of repainting the art.
//
// Two ways to run it:
//   * stage (default): the Relic experience, one instance with per-instance timers. The painted art and its CSS are
//     unchanged; the engine only decides WHEN the art's built-in SMIL particles run (see SMIL_STATES below).
//   * rail ({rail:true}): head-and-shoulders crop (data.cropRail), no infinite animation while quiet, one shared
//     rAF loop + one shared timer for every bust on the page, idle verbs from a persona, paused when the window
//     is hidden. Awaiting-approval and error always animate; sleeping busts stop completely.

import { createVerbs } from './verbs.js';

export const STATES = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed'];

const RIG = new Set(['L-plume', 'L-helm', 'L-face']);
const SVGNS = 'http://www.w3.org/2000/svg';
/** States in which the halo turns continuously (rail and stepping halos); everywhere else it holds its angle. */
const HALO_SPIN = new Set(['thinking', 'hacking']);
/**
 * Stage SMIL. The Relic's painting carries about 67 SMIL elements (orbiting halo dots, aura spin, strand dash flow, seal
 * swing). SMIL forces a main-thread frame (style + paint + Layerize of every layer) on EVERY vsync for as long as it plays,
 * which measured 73 % main-thread busy for a mascot standing idle. So the engine plays it only in the states that carry
 * the art's motion on purpose, and only while the window is visible and focused. Everything else (bob, halo turn, plume and
 * strand sway, blinks, look-arounds, tricks) is CSS / JS and compositor-cheap, so an idle mascot still lives.
 */
export const SMIL_STATES = new Set(['thinking', 'hacking', 'awaiting', 'victory', 'error']);

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

/* ------------------------------------------------------------------------------------------------
 * Shared rail runtime: one rAF loop (pointer -> eyes), one timer queue (blinks, idle verbs), one
 * visibility switch, one IntersectionObserver. Nothing runs while no rail bust exists.
 * ---------------------------------------------------------------------------------------------- */
const RT = {
  items: new Set(),
  q: [], timer: 0, seq: 0,
  raf: 0, ptr: null, layout: 0,
  hiddenAt: 0, hidden: typeof document !== 'undefined' && document.hidden,
  busyUntil: 0, nextBlink: 0, bound: false, io: null,
  frames: 0, // rAF callbacks run since load (read by the perf probe)
};

const now = () => performance.now();

function rtArm() {
  clearTimeout(RT.timer); RT.timer = 0;
  if (RT.hidden || !RT.q.length) return;
  RT.timer = setTimeout(rtRun, Math.max(0, RT.q[0].at - now()));
}
function rtRun() {
  RT.timer = 0;
  const t = now();
  while (RT.q.length && RT.q[0].at <= t) { const e = RT.q.shift(); try { e.fn(); } catch (err) { console.error(err); } }
  rtArm();
}
function rtLater(fn, ms) {
  const e = { at: now() + ms, fn, id: ++RT.seq };
  let i = RT.q.length; while (i > 0 && RT.q[i - 1].at > e.at) i--;
  RT.q.splice(i, 0, e);
  if (i === 0) rtArm();
  return e.id;
}
function rtCancel(id) { const i = RT.q.findIndex((e) => e.id === id); if (i >= 0) RT.q.splice(i, 1); }

function rtFrame() {
  RT.raf = 0; RT.frames++;
  if (RT.hidden) return;
  for (const it of RT.items) it.pointerFrame();
}
function rtPointer(e) {
  RT.ptr = { x: e.clientX, y: e.clientY };
  if (!RT.raf && !RT.hidden) RT.raf = requestAnimationFrame(rtFrame);
}
function rtLeave() { RT.ptr = null; if (!RT.raf && !RT.hidden) RT.raf = requestAnimationFrame(rtFrame); }
function rtLayout() { RT.layout++; }
function rtVisibility() {
  const hide = document.hidden;
  if (hide === RT.hidden) return;
  RT.hidden = hide;
  if (hide) {
    RT.hiddenAt = now();
    clearTimeout(RT.timer); RT.timer = 0;
    if (RT.raf) { cancelAnimationFrame(RT.raf); RT.raf = 0; }
  } else {
    const d = now() - RT.hiddenAt;
    RT.q.forEach((e) => { e.at += d; }); // the clock stood still while hidden
    rtArm();
  }
  for (const it of RT.items) it.root.classList.toggle('mxs-paused', RT.hidden);
}
function rtJoin(it) {
  RT.items.add(it);
  if (RT.bound) return;
  RT.bound = true;
  window.addEventListener('pointermove', rtPointer, { passive: true });
  document.documentElement.addEventListener('mouseleave', rtLeave);
  window.addEventListener('resize', rtLayout, { passive: true });
  window.addEventListener('scroll', rtLayout, { passive: true, capture: true });
  document.addEventListener('visibilitychange', rtVisibility);
  if (typeof IntersectionObserver === 'function') {
    RT.io = new IntersectionObserver((entries) => {
      for (const en of entries) { const x = en.target.__mxItem; if (x) { x.vis = en.isIntersecting; x.root.classList.toggle('mxs-off', !en.isIntersecting); } }
    });
  }
}
function rtLeaveItem(it) {
  RT.items.delete(it);
  RT.io?.unobserve(it.root);
  if (RT.items.size || !RT.bound) return;
  RT.bound = false;
  window.removeEventListener('pointermove', rtPointer);
  document.documentElement.removeEventListener('mouseleave', rtLeave);
  window.removeEventListener('resize', rtLayout);
  window.removeEventListener('scroll', rtLayout, true);
  document.removeEventListener('visibilitychange', rtVisibility);
  RT.io?.disconnect(); RT.io = null;
  if (RT.raf) { cancelAnimationFrame(RT.raf); RT.raf = 0; }
  clearTimeout(RT.timer); RT.timer = 0; RT.q.length = 0;
}

/** Counters for the perf probe (window.__mascotRuntime in dev tools). */
export function runtimeStats() {
  return { items: RT.items.size, queued: RT.q.length, frames: RT.frames, hidden: RT.hidden, rafPending: !!RT.raf };
}

function readAngle(e) {
  const m = getComputedStyle(e).transform;
  if (!m || m === 'none') return 0;
  const v = m.match(/matrix\(([^)]+)\)/);
  if (!v) return 0;
  const [a, b] = v[1].split(',').map(Number);
  return (Math.atan2(b, a) * 180) / Math.PI;
}

/**
 * @param {HTMLElement} host
 * @param {{name:string,crop:number[],cropRail?:number[],badge?:number[],vm?:number[],defs:string,layers:{id:string,pivot:number[]|null,z:string,markup:string,alarm?:number[],flip?:string}[],codeScroll:number}} data
 * @param {{quips?:string[], annoyedQuip?:string, track?:boolean, onPoke?:()=>void, rail?:boolean, railCrop?:boolean, cropRail?:number[], persona?:any, hoverEl?:HTMLElement}} [opts]
 *   rail      performance mode for the agent rail (implies the rail crop, no pokes, shared loop)
 *   railCrop  use the head-and-shoulders crop with the full stage behaviour (Ops panel busts)
 *   cropRail  explicit rail crop (used by the Relic, whose art file declares none)
 *   persona   tempo, quips, flare/halo options and idle verbs (ui/src/mascot/personas/<name>.json)
 */
export function createMascot(host, data, opts = {}) {
  const rail = !!opts.rail;
  const persona = opts.persona || null;
  const useRail = rail || !!opts.railCrop;
  const [cx, cy, cw, ch] = useRail ? (opts.cropRail || data.cropRail || data.crop) : data.crop;
  const [dcx, dcy, dcw, dch] = data.crop; // fx anchors are computed on the full crop whichever frame is shown
  const pct = (p) => `${(((p[0] - cx) / cw) * 100).toFixed(3)}% ${(((p[1] - cy) / ch) * 100).toFixed(3)}%`;
  const vb = [cx, cy, cw, ch].join(' ');
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const root = el('div', `mx mx-${data.name} mxs-idle${reduced ? ' mx-rm' : ''}${rail ? ' mxs-rail' : ''}`);
  root.style.aspectRatio = `${cw} / ${ch}`;
  root.style.setProperty('--code', String(Math.round(data.codeScroll)));
  if (rail) {
    root.setAttribute('aria-hidden', 'true'); // decorative inside the agent button
  } else {
    root.setAttribute('role', 'button');
    root.setAttribute('tabindex', '0');
    root.setAttribute('aria-label', 'Mascot. Click for a word of wisdom.');
  }

  // persona options map to namespaced classes / custom properties (CSS lives in mascot.css)
  if (persona) {
    if (persona.haloFlare) {
      root.classList.add('mxs-flaresoft');
      root.style.setProperty('--flare', String(persona.haloFlare));
      root.style.setProperty('--flare-end', String(1 + (persona.haloFlare - 1) / 2));
    }
    if (persona.haloMotion === 'swing') root.classList.add('mxs-hswing');
    if (persona.plumeLight) root.classList.add('mxs-plumelight');
    if (persona.plumeSway && persona.plumeSway < 1) root.classList.add('mxs-plumesoft');
    if (persona.sleepPlume != null) { root.classList.add('mxs-sleepplume'); root.style.setProperty('--sleep-plume', `${persona.sleepPlume}deg`); }
  }

  const defs = document.createElementNS(SVGNS, 'svg');
  defs.setAttribute('class', 'mx-defs');
  defs.setAttribute('aria-hidden', 'true');
  defs.innerHTML = data.defs; // trusted, generated at build time from our own art
  root.appendChild(defs);

  const float = el('div', 'mx-float', root);
  let rig = null;
  let hangIndex = 0;
  const halo = [];
  const layerEls = {};
  const smilSvgs = []; // stage only: the layers' <svg> roots whose SMIL timeline the engine pauses and resumes
  for (const L of data.layers) {
    let parent = float;
    if (RIG.has(L.id)) {
      if (!rig) {
        rig = el('div', 'mx-rig', float);
        const helm = data.layers.find((x) => x.id === 'L-helm');
        rig.style.transformOrigin = pct(helm?.pivot || [cx + cw / 2, cy + ch / 2]);
      }
      parent = rig;
    }
    const kind = L.id.replace(/^L-/, '').replace(/-\d+$/, '');
    const layer = el('div', `mx-layer mx-${kind} mx-${L.id}`, parent);
    if (L.flip === 'none') layer.classList.add('mxs-noflip'); // text/sigil tokens only rock in victory, never mirror
    if (L.pivot) layer.style.transformOrigin = pct(L.pivot);
    if (kind === 'hang') layer.style.setProperty('--i', String(hangIndex++));
    if (kind === 'token') layer.style.setProperty('--i', L.id.split('-').pop());
    if (kind.startsWith('halo')) halo.push(L);
    layerEls[L.id] = layer;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', vb);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = L.markup;
    layer.appendChild(svg);
    // the Relic's painting carries SMIL particles that would repaint it every frame: rail busts hold still, the stage plays them only in SMIL_STATES
    if (svg.pauseAnimations) { svg.pauseAnimations(); if (!rail) smilSvgs.push(svg); }
  }
  // Rail: eye offsets and blinks are custom properties, and an inherited custom property changed on the root
  // restyles every element of the bust (thousands of SVG nodes) per blink or pointer move. Scope them to the
  // eyes group instead (about 100 nodes). Stage busts keep them on the root exactly as before.
  const eyesEl = rail ? root.querySelector('[id$="L-eyes"]') : null;
  const evar = eyesEl || root;
  const haloEls = Object.keys(layerEls).filter((k) => k.startsWith('L-halo')).map((k) => layerEls[k]);

  // ---- overlay effects, positioned from the art's own pivots ----
  const hp = (data.layers.find((x) => x.id === 'L-halo-back')?.pivot) || [dcx + dcw / 2, dcy + dch / 2];
  const helmP = (data.layers.find((x) => x.id === 'L-helm')?.pivot) || hp;
  const R = Math.min(dcw, dch) * 0.36;
  const fx = document.createElementNS(SVGNS, 'svg');
  fx.setAttribute('viewBox', vb);
  fx.setAttribute('class', 'mx-fx');
  fx.setAttribute('aria-hidden', 'true');
  const spark = 'M0,-7 L1.6,-1.6 L7,0 L1.6,1.6 L0,7 L-1.6,1.6 L-7,0 L-1.6,-1.6Z';
  let fxm = '';
  [-150, -115, -70, -30, 20, 200, 235].forEach((a, i) => {
    const r = R * (1.02 + (i % 3) * 0.08);
    const x = hp[0] + Math.cos((a * Math.PI) / 180) * r;
    const y = hp[1] - 40 + Math.sin((a * Math.PI) / 180) * r;
    fxm += `<g transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(1.3 - (i % 3) * 0.2).toFixed(2)})"><path class="fx-spark" style="--d:${i * 60}ms" d="${spark}"/></g>`;
  });
  const topY = hp[1] - R * 1.05;
  const bp = (data.badge || [hp[0] + R * 0.78, topY]).slice(); // art may move the "!" off a wide crest (data-badge)
  const bs = rail ? (cw / 300) * 1.9 : 1; // rail: the badge is drawn larger so it reads at ~44 px (relative to the frame width)
  if (useRail) { // inside a tight frame the default spot can fall outside it: keep the whole badge visible
    const m = 15 * bs + 2;
    bp[0] = Math.min(cx + cw - m, Math.max(cx + m, bp[0])); bp[1] = Math.min(cy + ch - m, Math.max(cy + m, bp[1]));
  }
  if (rail) root.style.setProperty('--bs', bs.toFixed(2));
  fxm += `<g transform="translate(${bp[0].toFixed(1)} ${bp[1].toFixed(1)})"><g class="fx-bang"><circle r="15"/><text y="7" text-anchor="middle">!</text></g></g>`;
  [[0.62, 0.92, 22], [0.78, 1.04, 17], [0.92, 1.14, 13]].forEach(([dx, dy, s], i) => {
    fxm += `<text class="fx-z" style="--d:${i * 700}ms" x="${(hp[0] + R * dx).toFixed(1)}" y="${(hp[1] - R * dy).toFixed(1)}" font-size="${s}">z</text>`;
  });
  for (const L of data.layers) {
    if (L.id.startsWith('L-token') && L.pivot) {
      const a = L.alarm || [L.pivot[0], L.pivot[1] + 6]; // default: just below the swing pivot; art can pin it (data-alarm)
      fxm += `<circle class="fx-alarm" cx="${a[0]}" cy="${a[1]}" r="26"/>`;
    }
  }
  const vmp = data.vm || [hp[0] + R * 0.95, helmP[1] + R * 0.55];
  fxm += `<g class="fx-cloud" transform="translate(${vmp[0].toFixed(1)} ${vmp[1].toFixed(1)})"><path d="M-16,7 H16 A8,8 0 0 0 13,-8 A11,11 0 0 0 -7,-10 A9,9 0 0 0 -16,7Z"/></g>`;
  fx.innerHTML = fxm;
  root.appendChild(fx);

  const bubble = rail ? null : el('div', 'mx-quip', root);
  if (bubble) { bubble.setAttribute('role', 'status'); bubble.hidden = true; }

  host.appendChild(root);

  // ---- state ----
  let state = 'idle';
  let annoyedUntil = 0; let before = 'idle';
  const timers = new Set();
  // rail busts schedule on the shared queue; stage busts keep their own timers exactly as before
  const later = rail
    ? (fn, ms) => { const t = rtLater(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; }
    : (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const unlater = rail ? (t) => { rtCancel(t); timers.delete(t); } : (t) => { clearTimeout(t); timers.delete(t); };
  const pulse = (cls, ms) => { root.classList.remove(cls); void root.offsetWidth; root.classList.add(cls); later(() => root.classList.remove(cls), ms); };

  // stage SMIL: playing only in SMIL_STATES, only while the window is visible and focused (CSS motion is unaffected by blur)
  let smilOn = false; let winVisible = typeof document === 'undefined' || !document.hidden; let winFocused = typeof document === 'undefined' || document.hasFocus();
  function syncSmil() {
    if (rail || !smilSvgs.length) return;
    const want = !reduced && winVisible && winFocused && SMIL_STATES.has(state);
    if (want === smilOn) return;
    smilOn = want;
    for (const v of smilSvgs) { if (want) v.unpauseAnimations(); else v.pauseAnimations(); }
  }
  const onVis = () => { winVisible = !document.hidden; syncSmil(); };
  const onBlur = () => { winFocused = false; syncSmil(); };
  const onFocus = () => { winFocused = true; syncSmil(); };

  // halo: rail busts and stepping halos hold a fixed angle between states (no endless spin), so the angle is tracked here
  let verbsApi = null;
  let haloAngle = 0;
  const haloManaged = () => rail || !!(verbsApi && verbsApi.hasHaloStep);
  const setHaloAngle = (a) => { haloAngle = ((a % 360) + 360) % 360; haloEls.forEach((h) => { h.style.transform = haloAngle ? `rotate(${haloAngle.toFixed(2)}deg)` : ''; }); };

  function setState(s) {
    if (!STATES.includes(s)) return;
    // while annoyed from pokes, remember the requested state and return to it afterwards
    if (s !== 'annoyed' && state === 'annoyed' && Date.now() < annoyedUntil) { before = s; return; }
    if (s === state) return;
    if (haloManaged() && haloEls.length) {
      if (HALO_SPIN.has(state)) setHaloAngle(readAngle(haloEls[0])); // leaving a spin: keep where it got to
      if (HALO_SPIN.has(s)) { haloEls.forEach((h) => { h.style.transform = ''; }); haloAngle = 0; } // entering a spin: start from 0 so every turn loops cleanly
    }
    if (s !== 'idle') verbsApi?.cancel();
    const prev = state;
    root.classList.remove(`mxs-${state}`);
    state = s;
    root.classList.add(`mxs-${state}`);
    root.dataset.state = s;
    syncSmil();
    if (verbsApi && prev === 'victory' && s === 'idle') afterVerb('victory');
  }

  // eye helpers shared by life loops and verbs
  const setLook = (x, y) => { evar.style.setProperty('--lx', `${x}px`); evar.style.setProperty('--ly', `${y}px`); };
  let eyeSet = null;
  const setEyes = (name) => {
    if (eyeSet) root.classList.remove(`mxs-eyes-${eyeSet}`);
    eyeSet = name || null;
    if (eyeSet) root.classList.add(`mxs-eyes-${eyeSet}`);
  };
  let blinkHoldUntil = 0;

  // ---- persona verbs ----
  const layerSel = (t) => {
    const all = Object.keys(layerEls);
    const byKind = (k) => all.filter((id) => id.startsWith(`L-${k}`)).map((id) => layerEls[id]);
    if (t === 'rig') return rig ? [rig] : [];
    if (t === 'halo') return haloEls;
    if (t === 'hangs') return byKind('hang-').sort((a, b) => hangX(a) - hangX(b));
    if (t === 'token') return byKind('token-');
    if (Array.isArray(t)) return t.flatMap(layerSel);
    const m = /^(hang|token)-(\d+)\.\.(\d+)$/.exec(t);
    if (m) { const out = []; for (let i = +m[2]; i <= +m[3]; i++) { const e = layerEls[`L-${m[1]}-${i}`]; if (e) out.push(e); } return out.sort((a, b) => hangX(a) - hangX(b)); }
    const one = layerEls[`L-${t}`];
    return one ? [one] : [];
  };
  const pivotX = {}; for (const L of data.layers) pivotX[`mx-${L.id}`] = L.pivot ? L.pivot[0] : 0;
  const hangX = (e) => { const c = [...e.classList].find((k) => /^mx-L-/.test(k)); return pivotX[c] ?? 0; };

  if (persona && persona.verbs && persona.verbs.length) {
    verbsApi = createVerbs({
      el: layerSel, eyes: setEyes, look: setLook,
      holdBlink: (ms) => { blinkHoldUntil = Math.max(blinkHoldUntil, performance.now() + ms); },
      later, cancelLater: unlater,
      haloStep: (d) => setHaloAngle(haloAngle + d),
      reduced,
    }, persona);
  }
  const verbReady = () => verbsApi && !reduced && state === 'idle' && !hovering;
  function afterVerb(when) {
    if (!verbReady() || (rail && (!item.vis || RT.hidden))) return;
    const v = verbsApi.pick(when);
    if (v) verbsApi.play(v);
  }

  // life: blinks + (idle only) look-arounds and tricks
  let lifeT = 0; let lookT = 0; let trickT = 0; let verbT = 0;
  const blinkNow = () => {
    if (state === 'sleeping' || performance.now() < blinkHoldUntil) return;
    if (!rail) { pulse('blink', 140); return; }
    // rail: a blink is two instant class flips (no forced layout, no transition), at most one every 700 ms across the whole rail
    if (!item.vis || RT.hidden || now() < RT.nextBlink) return;
    RT.nextBlink = now() + 700;
    evar.style.setProperty('--bl', '.12'); later(() => evar.style.removeProperty('--bl'), 140);
  };
  function loopBlink() { lifeT = later(() => { blinkNow(); loopBlink(); }, rail ? 9000 + Math.random() * 12000 : 2200 + Math.random() * 4200); }
  function loopLook() {
    lookT = later(() => {
      if (state === 'idle' && !hovering) {
        root.style.setProperty('--lx', `${(Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 2)}px`);
        root.style.setProperty('--ly', `${(Math.random() - 0.5) * 3}px`);
        later(() => { root.style.setProperty('--lx', '0px'); root.style.setProperty('--ly', '0px'); }, 1200);
      }
      loopLook();
    }, 5000 + Math.random() * 6000);
  }
  function loopTrick() {
    trickT = later(() => {
      if (state === 'idle') { const t = ['trick-spin', 'trick-nod', 'trick-flicker'][Math.floor(Math.random() * 3)]; pulse(t, 2300); }
      loopTrick();
    }, 18000 + Math.random() * 20000);
  }
  // persona busts replace the generic tricks with their own verbs (rail: 14 to 30 s per bust, one at a time rail-wide)
  function loopVerb() {
    const tempo = verbsApi.tempo;
    const span = rail ? [14000, 30000] : [10000, 22000];
    verbT = later(() => {
      if (verbReady() && (!rail || (item.vis && !RT.hidden && now() >= RT.busyUntil))) {
        const v = verbsApi.pick('idle');
        if (v) { const len = verbsApi.play(v); if (rail) RT.busyUntil = now() + len + 2500; }
      }
      loopVerb();
    }, (span[0] + Math.random() * (span[1] - span[0])) * tempo);
  }
  if (!reduced) {
    loopBlink();
    if (verbsApi) loopVerb();
    if (!rail) {
      loopLook();
      if (!verbsApi) loopTrick();
    }
  }

  // pointer tracking (eyes follow the cursor anywhere on the page) + hover lean
  let hovering = false; let raf = 0; let mx = null; let my = null;
  const apply = () => {
    raf = 0;
    if (mx === null || opts.track === false) { root.style.setProperty('--ex', '0px'); root.style.setProperty('--ey', '0px'); root.style.setProperty('--lean', '0deg'); return; }
    const r = root.getBoundingClientRect();
    const dx = mx - (r.left + r.width / 2); const dy = my - (r.top + r.height * 0.36);
    const k = (v, s) => Math.max(-1, Math.min(1, v / s));
    root.style.setProperty('--ex', `${(k(dx, 320) * 6).toFixed(2)}px`);
    root.style.setProperty('--ey', `${(k(dy, 320) * 4).toFixed(2)}px`);
    root.style.setProperty('--lean', hovering ? `${(k(dx, 160) * 3).toFixed(2)}deg` : '0deg');
  };
  const onMove = (e) => { mx = e.clientX; my = e.clientY; if (!raf) raf = requestAnimationFrame(apply); };
  const onLeaveDoc = () => { mx = null; if (!raf) raf = requestAnimationFrame(apply); };
  const hoverHost = opts.hoverEl || root;
  const onEnter = () => { hovering = true; root.classList.add('hover'); };
  const onLeave = () => { hovering = false; root.classList.remove('hover'); if (rail) { item.pointerFrame(true); } else if (!raf) raf = requestAnimationFrame(apply); };

  // rail item: the shared loop drives this instead of per-instance listeners
  let item = null;
  if (rail) {
    let rect = null; let rv = -1; let lastEx = NaN; let lastEy = NaN; let lastLean = NaN; let lastLeanSet = 0;
    item = {
      root, vis: true,
      pointerFrame(force) {
        if (reduced || !item.vis || state === 'sleeping' || opts.track === false) return;
        if (rect === null || rv !== RT.layout) { rect = root.getBoundingClientRect(); rv = RT.layout; }
        const p = RT.ptr;
        let ex = 0; let ey = 0; let ln = 0;
        if (p) {
          const dx = p.x - (rect.left + rect.width / 2); const dy = p.y - (rect.top + rect.height * 0.36);
          const k = (v, s) => Math.max(-1, Math.min(1, v / s));
          ex = k(dx, 320) * 6; ey = k(dy, 320) * 4; ln = hovering ? k(dx, 160) * 3 : 0;
        }
        if (!force && Math.abs(ex - lastEx) < 0.15 && Math.abs(ey - lastEy) < 0.15 && Math.abs(ln - lastLean) < 0.2) return;
        lastEx = ex; lastEy = ey; lastLean = ln;
        evar.style.setProperty('--ex', `${ex.toFixed(2)}px`); evar.style.setProperty('--ey', `${ey.toFixed(2)}px`);
        if (ln !== lastLeanSet) { lastLeanSet = ln; (rig || root).style.setProperty('--lean', `${ln.toFixed(2)}deg`); }
      },
    };
    root.__mxItem = item;
    rtJoin(item);
    RT.io?.observe(root);
    if (RT.hidden) root.classList.add('mxs-paused');
  } else if (!reduced) {
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeaveDoc);
  }
  if (!rail) {
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
  }

  hoverHost.addEventListener('pointerenter', onEnter);
  hoverHost.addEventListener('pointerleave', onLeave);

  // interaction: bonk + quip, double-click spin, 5 quick pokes = annoyed (stage only: rail busts live inside a button)
  const quips = opts.quips || [];
  let lastQ = -1; let clicks = []; let quipT = 0;
  function say(text, ms = 3600) {
    if (!bubble) return;
    bubble.textContent = text; bubble.hidden = false; pulse('quip-in', 300);
    clearTimeout(quipT); quipT = later(() => { bubble.hidden = true; }, ms);
  }
  function poke() {
    const now_ = Date.now();
    clicks = clicks.filter((t) => now_ - t < 2000); clicks.push(now_);
    pulse('bonk', 520);
    opts.onPoke?.();
    if (clicks.length >= 5 && now_ > annoyedUntil) {
      clicks = []; before = state === 'annoyed' ? before : state; annoyedUntil = now_ + 2800;
      setState('annoyed'); say(opts.annoyedQuip || 'Stop poking. I am compiling.', 2800);
      later(() => { if (state === 'annoyed') setState(before); }, 2800);
      return;
    }
    if (!quips.length) return;
    let i = Math.floor(Math.random() * quips.length); if (i === lastQ) i = (i + 1) % quips.length; lastQ = i;
    say(quips[i]);
    // a bust with a persona answers its own quip with a verb ("cocked brow"), when it has one for that
    if (verbsApi) { const v = verbsApi.pick('quip'); if (v && state === 'idle') verbsApi.play(v); }
  }
  if (!rail) {
    root.addEventListener('click', poke);
    root.addEventListener('dblclick', () => pulse('trick-spin', 2300));
    root.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); poke(); } });
  }

  return {
    el: root,
    get state() { return state; },
    setState,
    setVm(on) { root.classList.toggle('vm-on', !!on); },
    say,
    trick(name) { pulse(`trick-${name}`, 2300); },
    /** Plays a persona verb by id (lab and tests); returns false when the persona has no such verb. */
    play(id) { const v = verbsApi?.byId(id); if (!v) return false; verbsApi.play(v); return true; },
    get verbs() { return verbsApi ? verbsApi.verbs.map((v) => v.id) : []; },
    destroy() {
      verbsApi?.cancel();
      timers.forEach((t) => (rail ? rtCancel(t) : clearTimeout(t))); timers.clear();
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(quipT);
      if (rail) { rtLeaveItem(item); }
      else {
        window.removeEventListener('pointermove', onMove);
        document.documentElement.removeEventListener('mouseleave', onLeaveDoc);
        document.removeEventListener('visibilitychange', onVis);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('focus', onFocus);
      }
      hoverHost.removeEventListener('pointerenter', onEnter);
      hoverHost.removeEventListener('pointerleave', onLeave);
      root.remove();
    },
  };
}
