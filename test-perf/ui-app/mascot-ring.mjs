// Evidence for "which thin ring moves around the Relic": renders every layer and every L-aura child on its own
// (labelled contact sheet) plus a 4-frame time strip with the candidate highlighted.
//   node mascot-ring.mjs <outDir>      (default /home/claude/council/perf)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from '../../scripts/lib/load-playwright.mjs';
process.env.PLAYWRIGHT_PATH ||= '/opt/node-tools/node_modules/playwright';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || '/home/claude/council/perf';
const data = JSON.parse(fs.readFileSync(path.join(here, '../../ui/src/mascot/data/relic.json'), 'utf8'));
const [cx, cy, cw, ch] = data.crop; const vb = `${cx} ${cy} ${cw} ${ch}`;
const S = 0.5, W = Math.round(cw * S), H = Math.round(ch * S);

const browser = await launchChromium({});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
await page.setContent('<!doctype html><body style="margin:0;background:#0c0f13;color:#cfe;font:12px monospace"></body>');
const res = await page.evaluate(({ data, vb, W, H }) => {
  const NS = 'http://www.w3.org/2000/svg';
  document.body.insertAdjacentHTML('afterbegin', `<svg width="0" height="0" style="position:absolute">${data.defs}</svg>`);
  const cells = []; // {label, note, markup}
  const wrapSvg = (inner) => `<svg xmlns="${NS}" viewBox="${vb}" width="${W}" height="${H}" style="overflow:visible;display:block">${inner}</svg>`;
  // 1) all layers stacked (what the app composites, no CSS motion)
  cells.push({ label: 'ALL LAYERS stacked', note: 'composite at t=0', markup: data.layers.map((l) => l.markup).join('') });
  // 2) every layer alone
  for (const L of data.layers) cells.push({ label: L.id, note: `${L.markup.length} chars`, markup: L.markup });
  // 3) every direct child of the L-aura root group alone, and of the halo layers
  const kids = (L, prefix) => {
    const tmp = document.createElementNS(NS, 'svg'); tmp.innerHTML = L.markup;
    const root = tmp.firstElementChild; const open = root.cloneNode(false).outerHTML.replace(/\/>$/, '>').replace(/<\/g>$/, '');
    [...root.children].forEach((c, i) => {
      if (c.tagName === 'path' && c.id) return; // textPath guide, draws nothing
      const attrs = ['r', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity'].map((a) => (c.getAttribute?.(a) ?? c.firstElementChild?.getAttribute?.(a)) ? a.replace('stroke-', '') + '=' + (c.getAttribute(a) ?? c.firstElementChild.getAttribute(a)) : '').filter(Boolean).join(' ');
      const anim = c.querySelector('animateTransform,animate,animateMotion');
      const durs = [...c.querySelectorAll('animateTransform,animateMotion,animate')].map((a) => a.getAttribute('dur')).filter(Boolean);
      cells.push({ label: `${prefix}[${i}] <${c.tagName}${c.querySelector('[filter]') || c.getAttribute('filter') ? ' +glow' : ''}>`, note: `${attrs}${durs.length ? ' SMIL ' + [...new Set(durs)].join('/') : ''}`.slice(0, 60), markup: open + c.outerHTML + '</g>', id: `${prefix}[${i}]` });
    });
  };
  kids(data.layers.find((l) => l.id === 'L-aura'), 'aura');
  return { cells };
}, { data, vb, W, H });

// build the sheet
const html = `<div style="display:grid;grid-template-columns:repeat(6,${W + 14}px);gap:6px;padding:8px">${res.cells.map((c, i) => `<div style="border:1px solid #2a3340;padding:6px;background:#10151b"><div style="height:${H}px;width:${W}px;position:relative;background:#0c0f13" data-i="${i}"></div><div style="color:#7CFFB2;margin-top:4px">${c.label.replace(/</g, '&lt;')}</div><div style="color:#8a97a8;font-size:10px;height:26px;overflow:hidden">${c.note}</div></div>`).join('')}</div>`;
await page.evaluate(({ html, cells, vb, W, H }) => {
  const NS = 'http://www.w3.org/2000/svg';
  document.body.insertAdjacentHTML('beforeend', html);
  cells.forEach((c, i) => { document.querySelector(`[data-i="${i}"]`).innerHTML = `<svg xmlns="${NS}" viewBox="${vb}" width="${W}" height="${H}" style="overflow:visible;display:block">${c.markup}</svg>`; });
  document.querySelectorAll('svg').forEach((s) => s.pauseAnimations?.());
  document.querySelectorAll('svg').forEach((s) => s.setCurrentTime?.(0));
}, { html, cells: res.cells, vb, W, H });
await page.waitForTimeout(300);
fs.mkdirSync(out, { recursive: true });
await page.screenshot({ path: path.join(out, 'mascot-layers.png'), fullPage: true });
fs.writeFileSync(path.join(out, 'mascot-layers.cells.json'), JSON.stringify(res.cells.map(({ label, note }) => ({ label, note })), null, 1));

// time strip: full composite, candidate highlighted in magenta, at four SMIL times; second row: the candidate alone
const strip = async (hi, name, t, title) => {
  const p2 = await browser.newPage({ viewport: { width: 4 * (W + 20) + 20, height: 2 * (H + 50) + 40 }, deviceScaleFactor: 1 });
  await p2.setContent('<!doctype html><body style="margin:0;background:#0c0f13;color:#cfe;font:13px monospace"></body>');
  await p2.evaluate(({ data, vb, W, H, t, hi, title }) => {
    const NS = 'http://www.w3.org/2000/svg';
    document.body.insertAdjacentHTML('afterbegin', `<svg width="0" height="0" style="position:absolute">${data.defs}</svg>`);
    const mk = (markupFn) => t.map((tt) => `<div style="padding:6px"><div style="width:${W}px;height:${H}px">${'<svg viewBox="' + vb + '" width="' + W + '" height="' + H + '" style="overflow:visible;display:block">' + markupFn() + '</svg>'}</div><div style="color:#7CFFB2;margin-top:3px">t = ${tt} s</div></div>`).join('');
    const aura = data.layers.find((l) => l.id === 'L-aura');
    const tmp = document.createElementNS(NS, 'svg'); tmp.innerHTML = aura.markup;
    const root = tmp.firstElementChild; const kid = root.children[hi];
    const open = root.cloneNode(false).outerHTML.replace(/\/>$/, '>').replace(/<\/g>$/, '');
    const tint = (c) => { c.querySelectorAll('circle').forEach((e) => { e.setAttribute('stroke', '#ff2bd6'); e.setAttribute('stroke-width', String(Math.max(3.4, +e.getAttribute('stroke-width') * 1.6))); }); };
    const hiOnly = (() => { const c = kid.cloneNode(true); tint(c); return open + c.outerHTML + '</g>'; })();
    const auraTinted = (() => { const r2 = root.cloneNode(true); tint(r2.children[hi]); return r2.outerHTML; })();
    const full = data.layers.map((l) => (l.id === 'L-aura' ? auraTinted : l.markup)).join('');
    const hiMarkup = hiOnly;
    document.body.insertAdjacentHTML('beforeend', `<div style="padding:6px 10px;color:#fff">${title}</div><div style="display:grid;grid-template-columns:repeat(4,${W + 12}px);gap:8px;padding:0 8px">${mk(() => full)}${mk(() => hiMarkup)}</div>`);
    const svgs = [...document.querySelectorAll('body > div:last-child svg')];
    svgs.forEach((s, i) => { s.pauseAnimations(); s.setCurrentTime(t[i % 4]); });
  }, { data, vb, W, H, t, hi, title });
  await p2.waitForTimeout(300);
  await p2.screenshot({ path: path.join(out, name) });
  await p2.close();
};
// candidate = comet arc (L-aura child 2, stroke 2.2, 14 s turn, glow); also a strip for the dashed ring (child 1) for contrast
await strip(2, 'mascot-ring-strip.png', [0, 3.5, 7, 10.5], 'L-aura child[2]: circle r=168 stroke 2.2 (magenta in the top row), SMIL rotate 14 s. Top row: full mascot, bottom row: that element alone');
await strip(1, 'mascot-ring-strip-dashed.png', [0, 15, 30, 45], 'for contrast, L-aura child[1]: circle r=168 stroke 5 dashed, SMIL rotate 60 s');
await browser.close();
console.log('cells', res.cells.length);
