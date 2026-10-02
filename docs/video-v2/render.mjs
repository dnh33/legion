#!/usr/bin/env node
// Deterministic frame-by-frame renderer for docs/video-v2/trailer.html.
//   node docs/video-v2/render.mjs                full render: mp4, gif, poster
//   node docs/video-v2/render.mjs --keys         key-frame PNGs only (for review), into <tmp>/legion-keys
//   node docs/video-v2/render.mjs --t=12.5,30    specific PNG frames
// Every frame calls window.render(t) and seeks all CSS animations, so nothing depends on wall-clock time.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
import { T, FPS, GIF_SEGMENTS, cues } from './timeline.mjs';
const FRAMES = Math.round(FPS * T.dur);
const GIF_FPS = Number(process.env.GIF_FPS || 12);
const POSTER_T = Number(process.env.POSTER_T || 97.4);
const KEYS = [3.5, 7.2, 14, 19.5, 23.5, 27, 31, 34.5, 40, 44, 48, 55, 58.5, 64, 70, 73, 76.5, 84, 87, 90.4, 97.4];
const args = process.argv.slice(2);
const WORKERS = Number(process.env.WORKERS || Math.min(2, os.cpus().length));
const TMP = process.env.VIDEO_TMP || path.join(os.tmpdir(), 'legion-video-v2');

async function loadPlaywright() {
  try { return { pw: await import('playwright'), opts: {} }; } catch { /* fall through */ }
  const hint = process.env.PLAYWRIGHT_PATH;
  if (!hint) throw new Error('Playwright not found: npm i --no-save playwright, or set PLAYWRIGHT_PATH to a playwright package folder');
  const entry = ['index.mjs', 'index.js'].map((f) => path.join(hint, f)).find((f) => fs.existsSync(f));
  const opts = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
  return { pw: await import(entry), opts };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.jpg': 'image/jpeg' };
function serve() {
  const srv = http.createServer((req, res) => {
    const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

async function openPage(browser, port, gif = false) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: gif ? 0.5 : 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${port}/docs/video-v2/trailer.html${gif ? '?gif=1' : ''}`);
  await page.waitForFunction('window.__ready === true', null, { timeout: 60000 });
  // the painted mascots carry their own code-scroll text (art, untouchable); check only our own elements
  const txt = await page.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('.mx,svg,canvas,script').forEach((e) => e.remove()); document.body.appendChild(c); const t = c.innerText; c.remove(); return t; });
  for (const bad of ['OWNER', 'TODO', 'lorem', '(harness output missing)']) if (txt.includes(bad)) throw new Error(`placeholder "${bad}" on screen`);
  return page;
}
// Replay every frame up to `n` without screenshots so animation "born" times match a straight render.
async function prime(page, n) {
  await page.evaluate(({ n, fps }) => { for (let i = 0; i < n; i++) window.render(i / fps); }, { n, fps: FPS });
}

async function renderStills(browser, port, times, outDir, ext = 'png') {
  fs.mkdirSync(outDir, { recursive: true });
  const page = await openPage(browser, port);
  const out = [];
  let done = 0;                                   // replay frames incrementally: one pass over the timeline, not one per still
  for (const t of [...times].sort((a, b) => a - b)) {
    const n = Math.round(t * FPS);
    await page.evaluate(({ from, n, fps }) => { for (let i = from; i < n; i++) window.render(i / fps); }, { from: done, n, fps: FPS });
    done = n;
    await page.evaluate((t) => window.render(t), Math.round(t * FPS) / FPS);
    const f = path.join(outDir, `t${String(t).replace('.', '_')}.${ext}`);
    await page.screenshot({ path: f, type: 'png' });
    out.push(f);
  }
  await page.close();
  return out;
}

async function worker(browser, port, from, to, dir) {
  const page = await openPage(browser, port);
  await prime(page, from);
  for (let i = from; i < to; i++) {
    await page.evaluate((t) => window.render(t), i / FPS);
    await page.screenshot({ path: path.join(dir, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
    if (i % 90 === 0) console.log(`frame ${i}/${FRAMES}`);
  }
  await page.close();
}

// GIF pass: a ~16s highlight (cold open, title forge, banners, end card) at 960x540, 12fps, no grain, static camera.
// The full 30fps timeline is still replayed so animation phases match the MP4; only frames inside GIF_SEGMENTS are kept.
async function gifFrames(browser, port, dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const page = await openPage(browser, port, true);
  let k = 0, kept = 0;
  for (let i = 0; i < FRAMES; i++) {
    const t = i / FPS;
    const seg = GIF_SEGMENTS.find(([a, b]) => t >= a && t <= b);
    const last = seg === GIF_SEGMENTS[GIF_SEGMENTS.length - 1];         // the loop ends on the lit end card, no fade-out
    const first = seg === GIF_SEGMENTS[0];                                // …and starts lit (the README thumbnail)
    const fade = seg ? Math.max(0, 1 - Math.min(first ? 9 : t - seg[0], last ? 9 : seg[1] - t) / 0.3) : 0;
    await page.evaluate(({ t, fade }) => { window.__fade = fade; window.render(t); }, { t, fade });
    if (!seg) continue;
    if (kept >= Math.ceil(k * FPS / GIF_FPS)) { await page.screenshot({ path: path.join(dir, `g${String(k).padStart(5, '0')}.png`), type: 'png' }); k++; }
    kept++;
  }
  await page.close();
}

function writeCues() {
  const f = path.join(HERE, 'cues.json');
  fs.writeFileSync(f, JSON.stringify(cues(), null, 2) + '\n');
  return f;
}

function ff(argv) {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...argv], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + argv.join(' '));
}

/** Synthesise the original score from cues.json (score.py) and mux it in, loudness-normalised to -14 LUFS. */
function muxScore(mp4) {
  const py = spawnSync('python3', [path.join(HERE, 'score.py')], { stdio: 'inherit' });
  if (py.status !== 0) { console.warn('score.py failed; leaving the MP4 silent'); return; }
  const tmp = mp4.replace(/\.mp4$/, '.withaudio.mp4');
  ff(['-i', mp4, '-i', path.join(HERE, 'score.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp]);
  fs.renameSync(tmp, mp4);
}

function encodeGif(gdir, gif) {
  const raw = gif + '.raw.gif';
  ff(['-framerate', String(GIF_FPS), '-i', path.join(gdir, 'g%05d.png'), '-filter_complex',
    `split[a][b];[a]palettegen=max_colors=${process.env.GIF_COLORS || 128}:stats_mode=diff[p];[b][p]paletteuse=dither=${process.env.GIF_DITHER || 'sierra2_4a'}:diff_mode=rectangle`, '-loop', '0', raw]);
  // Budget is 8 MB. If gifsicle is installed, squeeze with progressively stronger lossy compression until it fits.
  const has = spawnSync('gifsicle', ['--version'], { stdio: 'ignore' }).status === 0;
  fs.copyFileSync(raw, gif);
  if (has) {
    for (const lossy of [40, 80, 120, 200]) {
      if (fs.statSync(gif).size <= 7.8e6) break;
      spawnSync('gifsicle', ['-O3', `--lossy=${lossy}`, raw, '-o', gif], { stdio: 'ignore' });
    }
  }
  fs.rmSync(raw);
}

const { pw, opts } = await loadPlaywright();
const srv = await serve();
const port = srv.address().port;
const browser = await pw.chromium.launch({ ...opts, args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
try {
  const tArg = args.find((a) => a.startsWith('--t='));
  if (args.includes('--keys') || tArg) {
    const times = tArg ? tArg.slice(4).split(',').map(Number) : KEYS;
    const files = await renderStills(browser, port, times, path.join(TMP, 'keys'));
    console.log(files.join('\n'));
  } else if (args.includes('--cues')) {
    console.log(writeCues());
  } else if (args.includes('--gif-only') || args.includes('--encode-gif')) {
    const gdir = path.join(TMP, 'gif'), gif = path.join(HERE, 'legion-trailer-v2.gif');
    if (!args.includes('--encode-gif')) await gifFrames(browser, port, gdir);
    encodeGif(gdir, gif);
    console.log(path.relative(ROOT, gif), (fs.statSync(gif).size / 1e6).toFixed(2) + ' MB');
  } else {
    const dir = path.join(TMP, 'frames');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    const per = Math.ceil(FRAMES / WORKERS);
    await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(browser, port, w * per, Math.min(FRAMES, (w + 1) * per), dir)));
    writeCues();
    const mp4 = path.join(HERE, 'legion-trailer-v2.mp4'), gif = path.join(HERE, 'legion-trailer-v2.gif');
    ff(['-framerate', String(FPS), '-i', path.join(dir, 'f%05d.jpg'), '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-maxrate', '3800k', '-bufsize', '8000k',
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', '-an', mp4]);
    muxScore(mp4);
    const gdir = path.join(TMP, 'gif');
    await gifFrames(browser, port, gdir);
    encodeGif(gdir, gif);
    const [poster] = await renderStills(browser, port, [POSTER_T], path.join(TMP, 'poster'));
    fs.copyFileSync(poster, path.join(HERE, 'poster-v2.png'));
    for (const f of [mp4, gif, path.join(HERE, 'poster-v2.png')]) console.log(path.relative(ROOT, f), (fs.statSync(f).size / 1e6).toFixed(2) + ' MB');
  }
} finally {
  await browser.close();
  srv.close();
}
