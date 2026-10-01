#!/usr/bin/env python3
"""Builds the before/after contact sheets and the pixel statistics for mascot-shots.mjs output.
usage: mascot-sheet.py <shotsDir> <outDir> [prefix=mascot-states]
Per scheme: one PNG, 9 states across, rows = before (base) | after (new) | diff before/after x6 (ring region boxed).
Statistics (stdout + <outDir>/<prefix>-stats.json):
  ring_only   : pixels that differ (>12/255) between base and base-without-ring: all must lie in the ring band
  outside     : pixels that differ between base and new OUTSIDE the ring band (must be ~0 apart from sub-pixel glyph antialiasing)
  new_vs_noring_max / count>24 : new vs base-without-ring (should be identical up to the 0.3 px orbit-glyph antialiasing)"""
import json, math, sys
from PIL import Image, ImageChops, ImageDraw, ImageFont
shots, out = sys.argv[1], sys.argv[2]
prefix = sys.argv[3] if len(sys.argv) > 3 else 'mascot-states'
STATES = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed']
geo = json.load(open(f'{shots}/ring-geometry.json'))
stats = {}
def load(p): return Image.open(p).convert('RGB')
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 13)
except Exception: font = ImageFont.load_default()
for scheme in ('dark', 'light'):
    cells = []
    for st in STATES:
        b = load(f'{shots}/{scheme}-{st}-base.png'); n = load(f'{shots}/{scheme}-{st}-new.png'); z = load(f'{shots}/{scheme}-{st}-basenoring.png')
        g = geo[f'{scheme}-{st}']; cx, cy, r = g['cx'], g['cy'], g['r']
        scale = r / 168.0; band = 10.5 * scale  # 168 radius, stroke 2.2, glow blur 3 sigma
        def diffmask(a, c):
            d = ImageChops.difference(a, c).convert('L'); return d
        dbn = diffmask(b, n); dbz = diffmask(b, z); dnz = diffmask(n, z)
        W, H = b.size
        px_bn = dbn.load(); px_bz = dbz.load(); px_nz = dnz.load()
        ring_in = ring_out = out_bn = in_bn = nz_cnt = 0; nz_max = 0
        for y in range(H):
            for x in range(W):
                rr = math.hypot(x - cx, y - cy); inband = abs(rr - r) <= band
                v = px_bz[x, y]
                if v > 12:
                    if inband: ring_in += 1
                    else: ring_out += 1
                v2 = px_bn[x, y]
                if v2 > 12:
                    if inband: in_bn += 1
                    else: out_bn += 1
                v3 = px_nz[x, y]; nz_max = max(nz_max, v3)
                if v3 > 24: nz_cnt += 1
        stats[f'{scheme}-{st}'] = dict(size=[W, H], ring_diff_in_band=ring_in, ring_diff_outside_band=ring_out, base_vs_new_in_band=in_bn, base_vs_new_outside_band=out_bn, new_vs_noring_max=nz_max, new_vs_noring_over24=nz_cnt)
        amp = dbn.point(lambda v: min(255, v * 6)).convert('RGB')
        dr = ImageDraw.Draw(amp)
        for rr in (r - band, r + band): dr.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=(255, 60, 60))
        cells.append((st, b, n, amp))
    W, H = cells[0][1].size
    pad = 6; lab = 22; rowsN = 3
    sheet = Image.new('RGB', (len(cells) * (W + pad) + pad, rowsN * (H + pad + 0) + lab * 2 + pad), (24, 26, 30) if scheme == 'dark' else (214, 218, 224))
    d = ImageDraw.Draw(sheet); fg = (230, 236, 240) if scheme == 'dark' else (20, 24, 30)
    d.text((pad, 4), f'{scheme} theme: row 1 BEFORE (base: ring present), row 2 AFTER (ring hidden), row 3 diff x6 (red circles = ring band). Frames frozen at SMIL t=3.5 s.', fill=fg, font=font)
    for i, (st, b, n, amp) in enumerate(cells):
        x = pad + i * (W + pad)
        d.text((x, lab + 2), st, fill=fg, font=font)
        for j, im in enumerate((b, n, amp)):
            sheet.paste(im, (x, lab * 2 + j * (H + pad)))
    sheet.save(f'{out}/{prefix}-{scheme}.png'); print('wrote', f'{out}/{prefix}-{scheme}.png', sheet.size)
json.dump(stats, open(f'{out}/{prefix}-stats.json', 'w'), indent=1)
for k, v in stats.items(): print(k, v)
