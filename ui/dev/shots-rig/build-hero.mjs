// Builds the LinkedIn project hero from Legion's own art: the real relic.svg, the real wordmark,
// the real design tokens. No new artwork, no invented palette.
// Usage: node build-hero.mjs <out.png>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pw from 'file:///D:/bots/legion/node_modules/playwright-core/index.js';

const R = 'D:/bots/legion';
const out = process.argv[2] ?? join(R, 'docs/images/linkedin-00-hero.png');

const relic = readFileSync(join(R, 'docs/art/relic.svg'), 'utf8');
const wordmark = readFileSync(join(R, 'docs/images/legion-wordmark-dark.svg'), 'utf8');
// strip width/height so CSS can size them
const relicInline = relic.replace(/^<svg[^>]*?viewBox="([^"]*)"[^>]*>/, '<svg viewBox="$1" preserveAspectRatio="xMidYMid meet">');
const wmInline = wordmark.replace(/^<svg[^>]*?viewBox="([^"]*)"[^>]*>/, '<svg viewBox="$1" preserveAspectRatio="xMinYMid meet">');

// LinkedIn project cover: 1120 x 644 is the documented size.
const W = 1120, H = 644;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  :root {
    --bg: #0b0d10; --surface: #12151a; --line: #1e232b; --line-strong: #2a313b;
    --text: #e6e9ef; --muted: #8a93a3; --faint: #7d8797;
    --accent: #7CFFB2; --accent-ink: #04140b; --accent-soft: rgba(124,255,178,.10);
    --accent-line: rgba(124,255,178,.35);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body {
    background: var(--bg); color: var(--text);
    font-family: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    position: relative;
  }
  /* the grid + fade the app itself uses, so this reads as the same product */
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(var(--line) 1px, transparent 1px),
      linear-gradient(90deg, var(--line) 1px, transparent 1px);
    background-size: 48px 48px;
    opacity: .5;
    mask-image: radial-gradient(120% 90% at 22% 45%, #000 0%, rgba(0,0,0,.35) 55%, transparent 100%);
  }
  .glow {
    position: absolute; left: -6%; top: 50%; width: 780px; height: 780px;
    transform: translateY(-50%);
    background: radial-gradient(circle, rgba(124,255,178,.13) 0%, rgba(124,255,178,.05) 38%, transparent 66%);
    pointer-events: none;
  }
  .stage { position: absolute; inset: 0; display: flex; align-items: center; }
  .copy { position: relative; z-index: 2; width: 620px; padding-left: 60px; }
  .wm { width: 268px; height: auto; display: block; }
  .rule { width: 46px; height: 2px; background: var(--accent); margin: 26px 0 24px; }
  h1 {
    font-size: 40px; line-height: 1.14; font-weight: 600; letter-spacing: -.015em;
    max-width: 15ch;
  }
  h1 em { font-style: normal; color: var(--accent); }
  p.sub {
    margin-top: 18px; font-size: 16.5px; line-height: 1.5; color: var(--muted); max-width: 46ch;
  }
  .chips { margin-top: 26px; display: flex; gap: 8px; flex-wrap: wrap; }
  .chip {
    font: 500 12px/1 'JetBrains Mono', ui-monospace, Consolas, monospace;
    letter-spacing: .02em; color: var(--muted);
    border: 1px solid var(--line-strong); border-radius: 6px; padding: 7px 10px;
    background: rgba(18,21,26,.72);
  }
  .chip b { color: var(--accent); font-weight: 500; }
  /* the relic, from the repo's own painted file */
  /* relic.svg already paints its own archway, floor and vignette. Do not mask it: a fade here
     cuts real artwork. Let it sit whole and bleed off the right edge, the way the app does. */
  .relic {
    position: absolute; right: 26px; top: 50%; transform: translateY(-50%);
    height: ${Math.round(H * 0.94)}px; width: ${Math.round(H * 0.94 * 0.75)}px; z-index: 1;
  }
  .relic svg { width: 100%; height: 100%; display: block; }
  .foot {
    position: absolute; left: 60px; right: 40px; bottom: 24px; z-index: 3;
    display: flex; justify-content: space-between; align-items: baseline;
    font: 400 11.5px/1 'JetBrains Mono', ui-monospace, Consolas, monospace;
    color: var(--faint); letter-spacing: .03em;
  }
  .foot .ok { color: var(--accent); }
</style></head>
<body>
  <div class="grid"></div>
  <div class="glow"></div>
  <div class="stage">
    <div class="copy">
      <div class="wm">${wmInline}</div>
      <div class="rule"></div>
      <h1>A fleet of Claude agents, <em>one project</em>.</h1>
      <p class="sub">Twelve of them on your desktop, each with its own scope, its own approvals and its own VM when the work needs one. Research, code, 3D and deploy without leaving the app.</p>
      <div class="chips">
        <span class="chip"><b>12</b> agents</span>
        <span class="chip"><b>local</b> by default</span>
        <span class="chip">headless <b>Blender</b></span>
        <span class="chip"><b>MCP</b> both ways</span>
      </div>
    </div>
  </div>
  <div class="relic">${relicInline}</div>
  <div class="foot">
    <span>Apache-2.0 &middot; Node &middot; Electron &middot; TypeScript</span>
    <span class="ok">v0.2.3</span>
  </div>
</body></html>`;

const tmp = join(process.env.TMPDIR || 'C:/Users/Danie/AppData/Local/Temp', 'legion-hero.html');
writeFileSync(tmp, html, 'utf8');

const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.goto('file:///' + tmp.replace(/\\/g, '/'));
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(700);
await page.screenshot({ path: out });
await browser.close();
console.log('hero written:', out, `${W}x${H} @2x`);