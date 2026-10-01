// Legion mascot engine: framework-free, shared by the app and the demo page.
// Takes a mascot built by scripts/build-mascot.py (hand-painted layers, never redrawn) and
// stacks each layer as its own <svg> so motion is GPU-composited instead of repainting the art.

export const STATES = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed'];

const RIG = new Set(['L-plume', 'L-helm', 'L-face']);
const SVGNS = 'http://www.w3.org/2000/svg';

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

/**
 * @param {HTMLElement} host
 * @param {{name:string,crop:number[],defs:string,layers:{id:string,pivot:number[]|null,z:string,markup:string}[],codeScroll:number}} data
 * @param {{quips?:string[], annoyedQuip?:string, track?:boolean, onPoke?:()=>void}} [opts]
 */
export function createMascot(host, data, opts = {}) {
  const [cx, cy, cw, ch] = data.crop;
  const pct = (p) => `${(((p[0] - cx) / cw) * 100).toFixed(3)}% ${(((p[1] - cy) / ch) * 100).toFixed(3)}%`;
  const vb = data.crop.join(' ');
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const root = el('div', `mx mx-${data.name} mxs-idle${reduced ? ' mx-rm' : ''}`);
  root.style.aspectRatio = `${cw} / ${ch}`;
  root.style.setProperty('--code', String(Math.round(data.codeScroll)));
  root.setAttribute('role', 'button');
  root.setAttribute('tabindex', '0');
  root.setAttribute('aria-label', 'Mascot. Click for a word of wisdom.');

  const defs = document.createElementNS(SVGNS, 'svg');
  defs.setAttribute('class', 'mx-defs');
  defs.setAttribute('aria-hidden', 'true');
  defs.innerHTML = data.defs; // trusted, generated at build time from our own art
  root.appendChild(defs);

  const float = el('div', 'mx-float', root);
  let rig = null;
  let hangIndex = 0;
  const halo = [];
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
    if (L.pivot) layer.style.transformOrigin = pct(L.pivot);
    if (kind === 'hang') layer.style.setProperty('--i', String(hangIndex++));
    if (kind === 'token') layer.style.setProperty('--i', L.id.split('-').pop());
    if (kind.startsWith('halo')) halo.push(L);
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', vb);
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = L.markup;
    layer.appendChild(svg);
  }

  // ---- overlay effects, positioned from the art's own pivots ----
  const hp = (data.layers.find((x) => x.id === 'L-halo-back')?.pivot) || [cx + cw / 2, cy + ch / 2];
  const helmP = (data.layers.find((x) => x.id === 'L-helm')?.pivot) || hp;
  const R = Math.min(cw, ch) * 0.36;
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
  fxm += `<g transform="translate(${(hp[0] + R * 0.78).toFixed(1)} ${topY.toFixed(1)})"><g class="fx-bang"><circle r="15"/><text y="7" text-anchor="middle">!</text></g></g>`;
  [[0.62, 0.92, 22], [0.78, 1.04, 17], [0.92, 1.14, 13]].forEach(([dx, dy, s], i) => {
    fxm += `<text class="fx-z" style="--d:${i * 700}ms" x="${(hp[0] + R * dx).toFixed(1)}" y="${(hp[1] - R * dy).toFixed(1)}" font-size="${s}">z</text>`;
  });
  for (const L of data.layers) {
    if (L.id.startsWith('L-token') && L.pivot) fxm += `<circle class="fx-alarm" cx="${L.pivot[0]}" cy="${L.pivot[1] + 6}" r="26"/>`;
  }
  fxm += `<g class="fx-cloud" transform="translate(${(hp[0] + R * 0.95).toFixed(1)} ${(helmP[1] + R * 0.55).toFixed(1)})"><path d="M-16,7 H16 A8,8 0 0 0 13,-8 A11,11 0 0 0 -7,-10 A9,9 0 0 0 -16,7Z"/></g>`;
  fx.innerHTML = fxm;
  root.appendChild(fx);

  const bubble = el('div', 'mx-quip', root);
  bubble.setAttribute('role', 'status');
  bubble.hidden = true;

  host.appendChild(root);

  // ---- state ----
  let state = 'idle';
  let annoyedUntil = 0; let before = 'idle';
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
  const pulse = (cls, ms) => { root.classList.remove(cls); void root.offsetWidth; root.classList.add(cls); later(() => root.classList.remove(cls), ms); };

  function setState(s) {
    if (!STATES.includes(s)) return;
    // while annoyed from pokes, remember the requested state and return to it afterwards
    if (s !== 'annoyed' && state === 'annoyed' && Date.now() < annoyedUntil) { before = s; return; }
    if (s === state) return;
    root.classList.remove(`mxs-${state}`);
    state = s;
    root.classList.add(`mxs-${state}`);
    root.dataset.state = s;
  }

  // life: blinks + (idle only) look-arounds and tricks
  let lifeT = 0; let lookT = 0; let trickT = 0;
  function loopBlink() { lifeT = later(() => { if (state !== 'sleeping') pulse('blink', 140); loopBlink(); }, 2200 + Math.random() * 4200); }
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
  if (!reduced) { loopBlink(); loopLook(); loopTrick(); }

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
  if (!reduced) {
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onLeaveDoc);
  }
  root.addEventListener('pointerenter', () => { hovering = true; root.classList.add('hover'); });
  root.addEventListener('pointerleave', () => { hovering = false; root.classList.remove('hover'); if (!raf) raf = requestAnimationFrame(apply); });

  // interaction: bonk + quip, double-click spin, 5 quick pokes = annoyed
  const quips = opts.quips || [];
  let lastQ = -1; let clicks = []; let quipT = 0;
  function say(text, ms = 3600) {
    bubble.textContent = text; bubble.hidden = false; pulse('quip-in', 300);
    clearTimeout(quipT); quipT = later(() => { bubble.hidden = true; }, ms);
  }
  function poke() {
    const now = Date.now();
    clicks = clicks.filter((t) => now - t < 2000); clicks.push(now);
    pulse('bonk', 520);
    opts.onPoke?.();
    if (clicks.length >= 5 && now > annoyedUntil) {
      clicks = []; before = state === 'annoyed' ? before : state; annoyedUntil = now + 2800;
      setState('annoyed'); say(opts.annoyedQuip || 'Stop poking. I am compiling.', 2800);
      later(() => { if (state === 'annoyed') setState(before); }, 2800);
      return;
    }
    if (!quips.length) return;
    let i = Math.floor(Math.random() * quips.length); if (i === lastQ) i = (i + 1) % quips.length; lastQ = i;
    say(quips[i]);
  }
  root.addEventListener('click', poke);
  root.addEventListener('dblclick', () => pulse('trick-spin', 2300));
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); poke(); } });

  return {
    el: root,
    get state() { return state; },
    setState,
    setVm(on) { root.classList.toggle('vm-on', !!on); },
    say,
    trick(name) { pulse(`trick-${name}`, 2300); },
    destroy() {
      timers.forEach(clearTimeout); timers.clear();
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeaveDoc);
      root.remove();
    },
  };
}
