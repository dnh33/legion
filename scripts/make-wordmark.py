#!/usr/bin/env python3
"""Builds the README wordmark SVGs (docs/images/legion-wordmark-{light,dark}.svg).

Dev-only. Needs `pip install fonttools brotli` (brotli reads the WOFF2 file). It is NOT a repo
dependency and nothing in package.json refers to it.

Run from the repo root:  python3 scripts/make-wordmark.py

Takes the glyph outlines of "Legion" from the bundled Grenze Gotisch (SIL OFL 1.1, see NOTICE),
at a heavy weight of its variable axis, and writes them as plain SVG paths, so the image needs
no font on GitHub.
"""
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

WORD, WEIGHT, WIDTH_PX, PAD = 'Legion', 800, 560, 40
FONT = 'ui/src/fonts/GrenzeGotisch.woff2'
INKS = {'light': '#1b1a17', 'dark': '#ece6d6'}

font = instantiateVariableFont(TTFont(FONT), {'wght': WEIGHT})
cmap, gs, hmtx = font.getBestCmap(), font.getGlyphSet(), font['hmtx']
x, parts = 0, []
for ch in WORD:
    g = cmap[ord(ch)]
    parts.append((g, x))
    x += hmtx[g][0]
bp = BoundsPen(gs)
for g, ox in parts:
    gs[g].draw(TransformPen(bp, (1, 0, 0, 1, ox, 0)))
x0, y0, x1, y1 = bp.bounds
path = SVGPathPen(gs, ntos=lambda v: f'{v:.1f}'.rstrip('0').rstrip('.'))
for g, ox in parts:
    # font y points up, SVG y points down: flip, then shift into the box
    gs[g].draw(TransformPen(path, (1, 0, 0, -1, ox - x0 + PAD, y1 + PAD)))
w, h = (x1 - x0) + 2 * PAD, (y1 - y0) + 2 * PAD
height_px = round(WIDTH_PX * h / w)
for name, ink in INKS.items():
    open(f'docs/images/legion-wordmark-{name}.svg', 'w').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH_PX}" height="{height_px}" '
        f'viewBox="0 0 {w:.0f} {h:.0f}" role="img"><title>Legion</title>'
        f'<path fill="{ink}" d="{path.getCommands()}"/></svg>\n')
print('wrote', WIDTH_PX, 'x', height_px)
