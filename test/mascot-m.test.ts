/**
 * Perf round M (mascot): the Doctor button icon is static, the thin comet ring around the Relic is gone (one constant brings it back),
 * and the stage plays its painted SMIL motion from a scripted 12 Hz clock that lands on exactly the same poses as the browser's SMIL.
 * Docs: /home/claude/council/perf/mascot-perf.md.
 *
 * The first block reads files and needs no browser. The second block drives real Chromium (Playwright is not a Legion dependency:
 * it is skipped when Playwright or a browser is missing, like the icon and screenshot scripts).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// dist/test/mascot-m.test.js -> repo root
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = join(ROOT, 'ui', 'src');
const read = (p: string) => readFileSync(join(UI, p), 'utf8');

// ---------------------------------------------------------------------------------------------- (A) Doctor icon, file level

test('A: no stylesheet rule animates the Doctor button or its icon, and the heartbeat keyframes are gone', () => {
  const css = read('styles/app.css');
  assert.equal(/@keyframes\s+heartbeat/.test(css), false, 'the heartbeat keyframes are removed');
  assert.equal(/heartbeat/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), false, 'nothing refers to a heartbeat any more');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)].filter((m) => /tb-doctor/.test(m[1]));
  assert.ok(rules.length >= 3, 'the Doctor rules still exist');
  for (const [, sel, body] of rules) {
    assert.equal(/\banimation(-[a-z-]+)?\s*:/.test(body), false, `${sel.trim()} must not animate`);
  }
  assert.match(css, /\.tb-doctor\.good \.icon\s*\{[^}]*color:\s*var\(--accent\)/, 'a healthy Doctor icon is the accent (green) colour');
});

test('A: the title bar keeps the pulse icon in the Doctor button and the good/bad classes that colour it', () => {
  const tsx = read('components/TitleBar.tsx');
  assert.match(tsx, /tb-doctor\$\{bad \? ' bad' : doctor \? ' good' : ''\}/);
  assert.match(tsx, /<Icon name="pulse" size=\{14\} \/> Doctor/);
});

// ---------------------------------------------------------------------------------------------- engine constants, no DOM needed

interface HideEntry { bust: string; layer: string; selector: string; why?: string }
interface EngineMod { HIDE_ELEMENTS: HideEntry[]; STAGE_MOTION_HZ: number; createMascot: (host: HTMLElement, data: unknown, opts?: Record<string, unknown>) => { el: HTMLElement; setState(s: string): void; motionAt(t: number): number; readonly motion: { tracks: number; native: number; hz: number }; destroy(): void } }
const engineUrl = pathToFileURL(join(UI, 'mascot', 'engine.js')).href;

test('B: the L-halo ring is hidden by one exported constant that names bust, layer and selector (empty it to revert)', async () => {
  const eng = (await import(engineUrl)) as EngineMod;
  assert.ok(Array.isArray(eng.HIDE_ELEMENTS), 'HIDE_ELEMENTS is exported');
  assert.equal(eng.HIDE_ELEMENTS.length, 2, 'exactly two things are hidden: the back and the front half of the halo');
  assert.deepEqual(eng.HIDE_ELEMENTS.map((h) => [h.bust, h.layer]), [['relic', 'L-halo-back'], ['relic', 'L-halo-front']]);
});

test('B: the painted art is not edited (relic.json keeps its hash, see mascot.test.ts) and the halo is still in the art', () => {
  const relic = JSON.parse(readFileSync(join(UI, 'mascot', 'data', 'relic.json'), 'utf8')) as { layers: { id: string; markup: string }[] };
  const aura = relic.layers.find((l) => l.id === 'L-aura')!.markup;
  assert.match(aura, /stroke-width="2\.2"[^>]*stroke-dasharray="242\.8 1055\.6"/, 'the comet arc is painted and is rendered');
  for (const id of ['L-halo-back', 'L-halo-front']) assert.match(relic.layers.find((l) => l.id === id)!.markup, /stroke-dasharray="2 6"/, `${id} is still in the data`);
});

// ---------------------------------------------------------------------------------------------- browser block

type Page = { route(u: string, f: (r: { fulfill(o: { body: Buffer | string; contentType?: string; status?: number }): Promise<void>; request(): { url(): string } }) => unknown): Promise<void>; goto(u: string): Promise<unknown>; evaluate<T>(f: string | ((a: never) => T), a?: unknown): Promise<T> };
let browser: { newPage(o?: object): Promise<Page>; close(): Promise<void> } | null = null;
let why = '';
try {
  const lp = (await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'load-playwright.mjs')).href)) as { launchChromium(o?: object): Promise<typeof browser> };
  // Resolution (load-playwright.mjs): an installed `playwright` package first, else $PLAYWRIGHT_PATH. The old CI image keeps one at
  // /opt/node-tools; that path is only offered where it exists, so Windows and a normal checkout fall through to the skip reason.
  const legacy = '/opt/node-tools/node_modules/playwright';
  if (!process.env.PLAYWRIGHT_PATH && existsSync(legacy)) process.env.PLAYWRIGHT_PATH = legacy;
  browser = await lp.launchChromium({});
} catch (e) { why = `Playwright or Chromium not available: ${(e as Error).message.split('\n')[0]}`; }
const skip = browser ? false : why;

const FILES: Record<string, [string, string]> = {
  '/engine.js': [join(UI, 'mascot', 'engine.js'), 'text/javascript'],
  '/verbs.js': [join(UI, 'mascot', 'verbs.js'), 'text/javascript'],
  '/relic.json': [join(UI, 'mascot', 'data', 'relic.json'), 'application/json'],
  '/tokens.css': [join(UI, 'styles', 'tokens.css'), 'text/css'],
  '/app.css': [join(UI, 'styles', 'app.css'), 'text/css'],
  '/mascot.css': [join(UI, 'mascot', 'mascot.css'), 'text/css'],
};
async function openPage(html: string): Promise<Page> {
  const p = await browser!.newPage({ viewport: { width: 900, height: 900 } });
  await p.route('http://t.local/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ body: html, contentType: 'text/html' });
    const f = FILES[path];
    if (!f) return route.fulfill({ body: 'no', status: 404 });
    return route.fulfill({ body: readFileSync(f[0]), contentType: f[1] });
  });
  await p.goto('http://t.local/');
  return p;
}

test('A (DOM): the Doctor icon has no animation in any theme or state; healthy is green, failing is warn', { skip }, async () => {
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"></head><body>
    <div class="tb-right"><button id="good" class="tb-doctor good"><svg class="icon" width="14" height="14"><path d="M0 0"/></svg> Doctor</button>
    <button id="bad" class="tb-doctor bad"><svg class="icon" width="14" height="14"><path d="M0 0"/></svg> Doctor<b>2 to fix</b></button>
    <button id="idle" class="tb-doctor"><svg class="icon" width="14" height="14"><path d="M0 0"/></svg> Doctor</button></div></body></html>`;
  const p = await openPage(html);
  for (const theme of ['dark', 'light']) {
    const r = await p.evaluate(`(async () => {
      document.documentElement.setAttribute('data-theme', '${theme}');
      document.documentElement.setAttribute('data-win', 'active');
      await new Promise((r) => setTimeout(r, 700));
      const out = {};
      const accent = (() => { const e = document.createElement('i'); e.style.color = 'var(--accent)'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })();
      const warn = (() => { const e = document.createElement('i'); e.style.color = 'var(--warn)'; document.body.append(e); const c = getComputedStyle(e).color; e.remove(); return c; })();
      for (const id of ['good', 'bad', 'idle']) {
        const b = document.getElementById(id); const i = b.querySelector('.icon');
        out[id] = { anim: getComputedStyle(i).animationName, animBtn: getComputedStyle(b).animationName, running: b.getAnimations({ subtree: true }).length, css: b.getAnimations({ subtree: true }).filter((a) => a.constructor.name === 'CSSAnimation').length, color: getComputedStyle(b.querySelector('.icon')).color, btnColor: getComputedStyle(b).color };
      }
      return { out, accent, warn };
    })()`) as { out: Record<string, { anim: string; animBtn: string; running: number; css: number; color: string; btnColor: string }>; accent: string; warn: string };
    for (const id of ['good', 'bad', 'idle']) {
      assert.equal(r.out[id].anim, 'none', `${theme} ${id}: icon animation-name`);
      assert.equal(r.out[id].animBtn, 'none', `${theme} ${id}: button animation-name`);
      assert.equal(r.out[id].css, 0, `${theme} ${id}: no CSS animation in the button`);
      assert.equal(r.out[id].running, 0, `${theme} ${id}: nothing (not even a settling transition) is running in the button`);
    }
    assert.equal(r.out.good.color, r.accent, `${theme}: healthy icon is the accent colour`);
    assert.equal(r.out.bad.color, r.warn, `${theme}: failing icon is the warn colour`);
    assert.notEqual(r.out.idle.color, r.accent, `${theme}: unknown state is not painted green`);
  }
  await (p as unknown as { close(): Promise<void> }).close();
});

const STAGE_HTML = `<!doctype html><html><head><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/mascot.css"></head><body style="margin:0"><div id="host" style="width:452px"></div><div id="host2" style="width:452px"></div></body></html>`;

test('B (DOM): the L-halo ring and its glyphs are not rendered; the aura (with its comet arc) and every other layer are; emptying HIDE_ELEMENTS brings the halo back', { skip }, async () => {
  const p = await openPage(STAGE_HTML);
  const r = await p.evaluate(`(async () => {
    const eng = await import('/engine.js'); const data = await (await fetch('/relic.json')).json();
    const count = (h) => { const aura = h.el.querySelector('.mx-L-aura svg'); const hb = h.el.querySelector('.mx-L-halo-back'); const hf = h.el.querySelector('.mx-L-halo-front');
      return { circles: aura.querySelectorAll('circle').length, comet: aura.querySelectorAll('circle[stroke-width="2.2"]').length, dashed: aura.querySelectorAll('circle[stroke-width="5"]').length, text: aura.querySelectorAll('text').length, disc: aura.querySelectorAll('circle[r="210"]').length,
        haloPaths: h.el.querySelectorAll('.mx-L-halo-back path, .mx-L-halo-front path').length, haloGlyphs: h.el.querySelectorAll('.mx-L-halo-back text, .mx-L-halo-front text').length, haloMotion: h.el.querySelectorAll('.mx-L-halo-back animateMotion, .mx-L-halo-front animateMotion').length,
        backDisplay: getComputedStyle(hb).display, frontDisplay: getComputedStyle(hf).display };};
    const hidden = eng.createMascot(document.getElementById('host'), data, { motionHz: 0 });
    const a = count(hidden); hidden.destroy();
    const saved = eng.HIDE_ELEMENTS.splice(0);
    const shown = eng.createMascot(document.getElementById('host'), data, { motionHz: 0 });
    const b = count(shown); shown.destroy(); eng.HIDE_ELEMENTS.push(...saved);
    const again = eng.createMascot(document.getElementById('host'), data, { motionHz: 0 });
    const helm = again.el.querySelector('.mx-L-helm svg').innerHTML === (() => { const t = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); t.innerHTML = data.layers.find((l) => l.id === 'L-helm').markup; return t.innerHTML; })();
    const aura = again.el.querySelector('.mx-L-aura svg').innerHTML === (() => { const t = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); t.innerHTML = data.layers.find((l) => l.id === 'L-aura').markup; return t.innerHTML; })();
    again.destroy();
    return { a, b, helm, aura };
  })()`) as { a: Record<string, number | string>; b: Record<string, number | string>; helm: boolean; aura: boolean };
  assert.ok((r.b.haloPaths as number) >= 2 && r.b.haloGlyphs === 20 && r.b.haloMotion === 20, 'with the constant emptied the halo ellipse and its 20 orbiting glyphs are in the DOM');
  assert.equal(r.b.backDisplay, 'block', 'and the layers are shown');
  assert.deepEqual([r.a.haloPaths, r.a.haloGlyphs, r.a.haloMotion], [0, 0, 0], 'the halo ellipse, its glyphs and their animateMotion are not rendered');
  assert.equal(r.a.backDisplay, 'none');
  assert.equal(r.a.frontDisplay, 'none', 'an emptied layer is display:none (no compositor layer)');
  for (const k of ['circles', 'comet', 'dashed', 'text', 'disc']) assert.equal(r.a[k], r.b[k], `aura ${k} is untouched (comet arc, background disc, dashed ring, binary text)`);
  assert.equal(r.a.comet, 1, 'the 2.2 px comet arc is rendered exactly as painted');
  assert.equal(r.helm, true, 'other layers are the painted markup untouched');
  assert.equal(r.aura, true, 'the aura layer is byte-identical to the painted art');
  await (p as unknown as { close(): Promise<void> }).close();
});

test('M (DOM): the scripted clock is the same motion as SMIL: every animated element has the same transform / dash offset at 12 sample times', { skip }, async () => {
  const p = await openPage(STAGE_HTML);
  const r = await p.evaluate(`(async () => {
    const eng = await import('/engine.js'); const data = await (await fetch('/relic.json')).json();
    const native = eng.createMascot(document.getElementById('host'), data, { motionHz: 0 });
    const script = eng.createMascot(document.getElementById('host2'), data, {});
    const info = script.motion;
    const times = [0, 0.37, 1.1, 2.6, 3.9, 5.5, 7.25, 11.9, 14, 26.3, 47.2, 91.5];
    const sig = (svg) => {
      const out = [];
      svg.querySelectorAll('*').forEach((e, i) => {
        if (e.tagName === 'animateTransform' || e.tagName === 'animateMotion' || e.tagName === 'animate' || e.tagName === 'mpath') return;
        const m = e.getScreenCTM && e.getScreenCTM() && svg.getScreenCTM().inverse().multiply(e.getScreenCTM()); // relative to the layer: CSS bob/spin and page position drop out
        const cs = getComputedStyle(e);
        out.push([i, m ? [m.a, m.b, m.c, m.d, m.e, m.f] : null, cs.strokeDashoffset]);
      });
      return out;
    };
    let worst = 0; let worstOrbit = 0; let compared = 0; let dashDiff = 0; let who = '';
    const layersN = [...native.el.querySelectorAll('.mx-layer > svg')]; const layersS = [...script.el.querySelectorAll('.mx-layer > svg')];
    for (const t of times) {
      layersN.forEach((s) => { s.pauseAnimations(); s.setCurrentTime(t); });
      script.motionAt(t);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      layersN.forEach((sn, li) => {
        const a = sig(sn); const b = sig(layersS[li]);
        // the scripted copy has no <animate*> children, so compare by the elements both have: walk both lists without the animation tags (filtered above)
        if (a.length !== b.length) { who = 'length ' + li; worst = 1e9; return; }
        a.forEach((x, k) => {
          const y = b[k]; compared++;
          const orbit = /halo/.test(sn.parentElement.className);
          if (x[1] && y[1]) for (let q = 0; q < 6; q++) { const d = Math.abs(x[1][q] - y[1][q]); if (orbit) { if (d > worstOrbit) worstOrbit = d; } else if (d > worst) { worst = d; who = sn.parentElement.className + ' @' + t; } }
          if (x[2] !== y[2]) { const d = Math.abs(parseFloat(x[2]) - parseFloat(y[2])); if (d > dashDiff) dashDiff = d; }
        });
      });
    }
    native.destroy(); script.destroy();
    return { info, worst, worstOrbit, compared, dashDiff, who };
  })()`) as { info: { tracks: number; native: number; hz: number }; worst: number; worstOrbit: number; compared: number; dashDiff: number; who: string };
  assert.equal(r.info.hz, 12, 'the stage clock runs at 12 Hz');
  assert.equal(r.info.native, 0, 'no SMIL element is left to the browser (all of them were understood)');
  assert.equal(r.info.tracks, 27, '3 aura (dashed ring, comet arc, binary text) + 1 plume + 7 hang swings + 7 dash flows + 9 token swings = 27 tracks (the halo and its 20 glyphs are hidden)');
  assert.ok(r.compared > 1000, `compared ${r.compared} elements`);
  assert.ok(r.worst < 0.02, `max matrix difference ${r.worst} at ${r.who}`);
  // the browser's own arc-length walk along the elliptical orbit differs from getPointAtLength by up to 0.3 px (0.07 % of the stage); the glyphs are 13 to 17 px
  assert.ok(r.worstOrbit < 0.35, `max orbit difference ${r.worstOrbit}`);
  assert.ok(r.dashDiff < 0.02, `max dash-offset difference ${r.dashDiff}`);
  await (p as unknown as { close(): Promise<void> }).close();
});

test('M (DOM): the clock only runs while a SMIL state is shown, holds its place when paused, and stops on destroy', { skip }, async () => {
  const p = await openPage(STAGE_HTML);
  const r = await p.evaluate(`(async () => {
    const eng = await import('/engine.js'); const data = await (await fetch('/relic.json')).json();
    const h = eng.createMascot(document.getElementById('host'), data, {});
    const rot = () => h.el.querySelector('.mx-L-hang-3 svg g[transform^="rotate"]')?.getAttribute('transform');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(300); const idleA = rot(); await sleep(400); const idleB = rot();
    h.setState('thinking'); await sleep(900); const t1 = rot(); await sleep(700); const t2 = rot();
    h.setState('idle'); await sleep(150); const held1 = rot(); await sleep(500); const held2 = rot();
    h.setState('hacking'); await sleep(500); const t3 = rot();
    h.destroy();
    return { idleA, idleB, t1, t2, held1, held2, t3 };
  })()`) as Record<string, string | undefined>;
  assert.equal(r.idleA, r.idleB, 'idle: nothing moves');
  assert.notEqual(r.t1, r.t2, 'thinking: the strand swings');
  assert.equal(r.held1, r.held2, 'back to idle: it holds its pose');
  assert.notEqual(r.held2, r.t3, 'hacking resumes from there');
  await (p as unknown as { close(): Promise<void> }).close();
});

test('R (DOM): rail avatars are stills: no running animation in any state, no timers, no shared runtime, no listeners; the stage mascot still lives', { skip }, async () => {
  const p = await openPage(STAGE_HTML);
  const r = await p.evaluate(`(async () => {
    const eng = await import('/engine.js'); const data = await (await fetch('/relic.json')).json();
    let ptrListeners = 0; const add = window.addEventListener.bind(window);
    window.addEventListener = (t, ...a) => { if (t === 'pointermove') ptrListeners++; return add(t, ...a); };
    const host = document.getElementById('host');
    const rail = eng.createMascot(host, data, { rail: true });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { states: {} };
    for (const st of ['idle', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping']) {
      rail.setState(st); await sleep(250);
      out.states[st] = host.getAnimations({ subtree: true }).length;
    }
    rail.setState('idle'); await sleep(300);
    out.stills = host.querySelector('.mx').classList.contains('mxs-still');
    out.runtime = eng.runtimeStats ? eng.runtimeStats() : null;
    out.ptr = ptrListeners;
    const x = rail.el.querySelector('.mx-layer'); out.willChange = x ? getComputedStyle(x).willChange : '';
    rail.destroy();
    const host2 = document.getElementById('host2');
    const stage = eng.createMascot(host2, data, {});
    stage.setState('thinking'); await sleep(900);
    out.stageMotionTracks = stage.motion.tracks;
    out.stageClock = stage.motion.hz;
    stage.destroy();
    return out;
  })()`) as { states: Record<string, number>; stills: boolean; runtime: { items: number; queued: number; rafPending: boolean } | null; ptr: number; stageMotionTracks: number; stageClock: number };
  for (const [st, n] of Object.entries(r.states)) assert.equal(n, 0, `rail ${st}: ${n} animations running (a still tile runs none)`);
  assert.equal(r.stills, true, 'the tile is marked mxs-still');
  assert.equal(r.runtime?.items, 0, 'a rail tile does not join the shared runtime');
  assert.equal(r.runtime?.queued, 0, 'no blink or idle-verb timer is queued');
  assert.equal(r.runtime?.rafPending, false, 'no pointer loop');
  assert.equal(r.ptr, 0, 'no global pointermove listener for a rail tile');
  assert.equal(r.stageMotionTracks, 27, 'the stage mascot still plays its motion');
  assert.equal(r.stageClock, 12);
  await (p as unknown as { close(): Promise<void> }).close();
});

test.after(async () => { await browser?.close(); });
