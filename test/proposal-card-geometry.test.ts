/**
 * Geometry of the proposal card at rest, in the real stylesheets, measured in headless Edge at the Legion window size: 960x600 CSS px shown at
 * 1.5x (a 1440x900 window). At rest "More" sits above the action row, the action row is whole and inside the region, and the card's content fits
 * (nothing is hidden under the row or clipped by the body). Skipped where Edge is not installed (the CI runner).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const css = (p: string): string => `<link rel=stylesheet href="${pathToFileURL(join(process.cwd(), p)).href}">`;
const LONG = 'The current email stacks the order table above the delivery block, which pushes the return instructions below the fold on most phones. Proposal: move the delivery estimate beside the order number, collapse the line items to a three-row summary with a link to the full order, and give the return instructions their own short block with a single button. This keeps the whole message above the fold on a 360 px wide screen.';

function page(theme: 'light' | 'dark'): string {
  return `<!doctype html><html data-theme="${theme}"><head><meta charset=utf-8>${css('ui/src/styles/tokens.css')}${css('ui/src/styles/app.css')}</head>
<body style="margin:0;background:var(--bg)"><div style="height:60px"></div>
<div class="proposal-cards" id="region" role="region" aria-label="Board proposals waiting for you">
<div class="approval" tabindex="0" data-proposal-id="a" role="group" aria-label="Board proposal">
<div class="proposal-body" id="body">
<div class="approval-head"><span>Needs your OK</span><b class="approval-tool">board item</b></div>
<p class="proposal-title">Forgemaster proposes a board item in Blog: <b>Rework the checkout confirmation email so the order summary, delivery estimate and return instructions all fit one screen</b></p>
<p class="muted-s">Suggested by Forgemaster. Not reviewed.</p>
<p class="proposal-desc" id="desc">${LONG}</p>
<button type="button" class="link-btn" id="more">More</button>
</div>
<div class="proposal-fade" aria-hidden="true"></div>
<div class="approval-actions proposal-actions" id="actions"><button class="btn primary">Accept</button><button class="btn">Reject</button><button class="btn-ghost">Open on board</button></div>
</div></div>
<pre id="out" style="display:none"></pre>
<script>
const q = (s) => document.querySelector(s);
const r = (e) => e.getBoundingClientRect();
const d = getComputedStyle(q('#desc'));
const lh = parseFloat(d.lineHeight) || parseFloat(d.fontSize) * 1.2;
const out = { iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio,
  moreTop: r(q('#more')).top, moreBottom: r(q('#more')).bottom,
  actionsTop: r(q('#actions')).top, actionsBottom: r(q('#actions')).bottom,
  bodyBottom: r(q('#body')).bottom, bodyScrollH: q('#body').scrollHeight, bodyClientH: q('#body').clientHeight,
  regionTop: r(q('#region')).top, regionBottom: r(q('#region')).bottom,
  descH: r(q('#desc')).height, lh };
q('#out').textContent = JSON.stringify(out);
</script></body></html>`;
}

function measure(theme: 'light' | 'dark'): Record<string, number> {
  const file = join(tmpdir(), `legion-proposal-geometry-${theme}.html`);
  writeFileSync(file, page(theme));
  const url = pathToFileURL(file).href;
  const flags = ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=984,692', '--force-device-scale-factor=1.5', '--virtual-time-budget=3000'];
  const dom = spawnSync(EDGE, [...flags, '--dump-dom', url], { encoding: 'utf8', timeout: 90000 }).stdout ?? '';
  const m = /<pre id="out"[^>]*>([\s\S]*?)<\/pre>/.exec(dom);
  assert.ok(m, 'the page reported its geometry');
  spawnSync(EDGE, [...flags, `--screenshot=${join(tmpdir(), `legion-proposal-card-${theme}.png`)}`, url], { timeout: 90000 });
  return JSON.parse(m[1]!);
}

for (const theme of ['light', 'dark'] as const) {
  test(`the proposal card at rest, ${theme} (960x600 at 1.5x): More and the whole action row are visible, and nothing is hidden under the row`, (t) => {
    if (!existsSync(EDGE)) { t.skip('Microsoft Edge is not installed here'); return; }
    const g = measure(theme);
    t.diagnostic(`shot: ${join(tmpdir(), `legion-proposal-card-${theme}.png`)}`);
    t.diagnostic(JSON.stringify(g));
    assert.equal(g.iw, 960, 'the page is 960 css px wide');
    assert.equal(g.ih, 600, 'and 600 css px high');
    assert.equal(g.dpr, 1.5, 'shown at 1.5x');
    assert.ok(g.moreBottom <= g.actionsTop + 0.5, `More (bottom ${g.moreBottom}) is above the action row (top ${g.actionsTop})`);
    assert.ok(g.moreBottom <= g.bodyBottom + 0.5, 'More is inside the card body, so it can be clicked');
    assert.ok(g.bodyScrollH <= g.bodyClientH + 0.5, `the card content fits at rest (${g.bodyScrollH} of ${g.bodyClientH})`);
    assert.ok(g.actionsTop >= g.regionTop - 0.5 && g.actionsBottom <= g.regionBottom + 0.5, 'the action row is whole inside the region');
    const lines = g.descH / g.lh;
    assert.ok(Math.abs(lines - Math.round(lines)) < 0.05, `the description is whole lines (${lines.toFixed(2)} lines)`);
  });
}
