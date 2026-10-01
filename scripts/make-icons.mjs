// Dev-only generator (needs Playwright, see CONTRIBUTING.md): renders docs/art/relic-icon.svg with Playwright into assets/*.png and a multi-size icon.ico.
// Outputs are committed; end users never run this.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './lib/load-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'assets');
mkdirSync(out, { recursive: true });
const svg = readFileSync(join(root, 'docs', 'art', 'relic-icon.svg'), 'utf8');

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });

async function shot(html, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${html}`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  if (file) writeFileSync(join(out, file), buf);
  return buf;
}

const scaled = (size) => svg.replace(/width="512" height="512"/, `width="${size}" height="${size}"`);

await shot(svg, 512, 'icon.png');
await shot(scaled(256), 256, 'icon-256.png');

// Tray: simplified helm silhouette with a green visor on transparent, legible at 16-32px.
const trayArt = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<path d="M14 6 L50 6 Q53 6 53 9 L53 44 Q53 54 46 60 L18 60 Q11 54 11 44 L11 9 Q11 6 14 6 Z" fill="#dfe5ee"/>
<path d="M32 6 L50 6 Q53 6 53 9 L53 44 Q53 54 46 60 L32 60 Z" fill="#9aa4b4"/>
<path d="M11 14 L53 14 L53 18 L11 18 Z" fill="#e8cf7f"/>
<path d="M13 23 L51 23 L51 35 L38 35 L38 56 L26 56 L26 35 L13 35 Z" fill="#0b0d10"/>
<path d="M16 26 L48 26 L48 32 L35 32 L35 54 L29 54 L29 32 L16 32 Z" fill="#7CFFB2"/>
</svg>`;
await shot(trayArt, 32, 'tray.png');
await shot(trayArt, 64, 'tray@2x.png');

// ICO with PNG entries.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of sizes) pngs.push(await shot(s === 256 ? scaled(256) : scaled(s), s));
await browser.close();

const hdr = Buffer.alloc(6);
hdr.writeUInt16LE(1, 2); hdr.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
writeFileSync(join(out, 'icon.ico'), Buffer.concat([hdr, ...entries, ...pngs]));
console.log('wrote icon.png, icon-256.png, tray.png, tray@2x.png, icon.ico');
