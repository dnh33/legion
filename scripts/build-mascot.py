#!/usr/bin/env python3
"""
Build a live mascot from a layered, hand-painted SVG (see docs/art/MASCOT_CONTRACT.md).

  python3 scripts/build-mascot.py docs/art/relic.layered.svg relic
  -> ui/src/mascot/data/relic.json

No painted path is modified. The script only:
  * splits the top-level L-* groups into separate layer documents (stacked + GPU-composited at runtime),
  * wraps the original pixel eyes as the "base" set and adds alternate eye sets on the SAME 4px grid,
  * adds a visor "code scroll" clipped to L-visor-shape (hidden unless the state shows it),
  * prefixes every id so several mascots can live on one page.
Dev-time only (Python 3). Output is committed.
"""
import json, os, re, sys, random, xml.etree.ElementTree as ET

NS = 'http://www.w3.org/2000/svg'; XL = 'http://www.w3.org/1999/xlink'
ET.register_namespace('', NS); ET.register_namespace('xlink', XL)
q = lambda t: '{%s}%s' % (NS, t)

EYES = {  # 7 cols x 4 rows, left eye; right eye mirrored. '#' core, '+' glow.
    'narrow': ['.......', '+######', '.+++++.', '.......'],
    'happy':  ['...#...', '..#+#..', '.#+.+#.', '#+...+#'],
    'wince':  ['##.....', '.+##+..', '.+##+..', '##.....'],
    'shut':   ['.......', '.......', '+#####+', '.......'],
    'angry':  ['##.....', '.+###..', '..####+', '..++++.'],
}

def main(src, name):
    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    tree = ET.parse(os.path.join(root_dir, src) if not os.path.isabs(src) else src)
    svg = tree.getroot()
    crop = [float(v) for v in svg.get('data-crop').split()]
    prefix = name[:1] + 'x-'

    # ---- eyes: wrap base, add expression sets ----
    eyes = svg.find('.//*[@id="L-eyes"]')
    rects = [r for r in eyes.iter(q('rect'))]
    xs = sorted(float(r.get('x')) for r in rects)
    mid = (xs[0] + xs[-1]) / 2
    left = [r for r in rects if float(r.get('x')) < mid]
    lx = min(float(r.get('x')) for r in left); ly = min(float(r.get('y')) for r in rects)
    rx_max = max(float(r.get('x')) for r in rects)
    right_x0 = rx_max - 6 * 4
    base = ET.Element(q('g'), {'class': 'xe xe-base'})
    for c in list(eyes):
        eyes.remove(c); base.append(c)
    eyes.append(base)
    for ename, pat in EYES.items():
        g = ET.SubElement(eyes, q('g'), {'class': 'xe xe-' + ename})
        for r_, row in enumerate(pat):
            for c_, ch in enumerate(row):
                if ch == '.': continue
                fill = '#ffffff' if ch == '#' else '#b9ffd8'
                for x in (lx + c_ * 4, right_x0 + (6 - c_) * 4):
                    ET.SubElement(g, q('rect'), {'x': '%g' % x, 'y': '%g' % (ly + r_ * 4), 'width': '4', 'height': '4', 'fill': fill})

    # ---- visor code scroll, clipped to the visor opening (same coordinate frame) ----
    parent_of = {c: p for p in svg.iter() for c in p}
    vshape = svg.find('.//*[@id="L-visor-shape"]')
    vparent = parent_of[vshape]
    defs = svg.find(q('defs'))
    cp = ET.SubElement(defs, q('clipPath'), {'id': 'visorclip'})
    ET.SubElement(cp, q('path'), {'d': vshape.get('d'), 'transform': vshape.get('transform', '')})
    code = ET.Element(q('g'), {'class': 'x-code', 'clip-path': 'url(#visorclip)'})
    roll = ET.SubElement(code, q('g'), {'class': 'x-code-roll'})
    # visor bounds from the path numbers
    nums = [float(n) for n in re.findall(r'-?\d+\.?\d*', vshape.get('d'))]
    vx = nums[0::2]; vy = nums[1::2]
    x0, x1, y0, y1 = min(vx), max(vx), min(vy), max(vy)
    rnd = random.Random(7)
    h = y1 - y0
    y = y0 - h
    while y < y1 + h:
        x = x0
        while x < x1:
            w = rnd.choice([4, 6, 8, 10, 14, 18])
            if rnd.random() < 0.7:
                ET.SubElement(roll, q('rect'), {'x': '%g' % x, 'y': '%g' % y, 'width': str(w), 'height': '2', 'rx': '1',
                                                  'fill': '#e6fff1' if rnd.random() < .2 else '#7CFFB2', 'opacity': '.6'})
            x += w + 3
        y += 5
    idx = list(vparent).index(vshape)
    vparent.insert(idx + 1, code)
    code_h = h  # scroll distance

    # ---- collect layers in paint order ----
    layers = []
    for el in list(svg):
        lid = el.get('id', '')
        if not lid.startswith('L-'):
            continue
        piv = el.get('data-pivot')
        inner = ''.join(ET.tostring(c, encoding='unicode') for c in el)
        layers.append({'id': lid, 'pivot': [float(v) for v in piv.split()] if piv else None,
                       'z': el.get('data-z', ''), 'markup': inner})
    defs_xml = ET.tostring(defs, encoding='unicode')

    # ---- prefix ids everywhere ----
    ids = set(re.findall(r'\bid="([^"]+)"', defs_xml))
    for L in layers: ids |= set(re.findall(r'\bid="([^"]+)"', L['markup']))
    ids.discard('')
    def pre(s):
        s = re.sub(r'\bid="([^"]+)"', lambda m: 'id="%s%s"' % (prefix, m.group(1)) if m.group(1) in ids else m.group(0), s)
        s = re.sub(r'url\(#([^)]+)\)', lambda m: 'url(#%s%s)' % (prefix, m.group(1)) if m.group(1) in ids else m.group(0), s)
        s = re.sub(r'(href)="#([^"]+)"', lambda m: '%s="#%s%s"' % (m.group(1), prefix, m.group(2)) if m.group(2) in ids else m.group(0), s)
        s = re.sub(r'\s*xmlns(:\w+)?="[^"]+"', '', s)
        s = s.replace('ns0:', '').replace('xlink:href', 'href')
        return re.sub(r'>\s+<', '><', s)
    for L in layers: L['markup'] = pre(L['markup'])
    defs_xml = pre(defs_xml)

    out = {'name': name, 'crop': crop, 'defs': defs_xml, 'layers': layers, 'codeScroll': code_h}
    dst = os.path.join(root_dir, 'ui', 'src', 'mascot', 'data', name + '.json')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(out, f, separators=(',', ':'))
    print('wrote', dst, os.path.getsize(dst) // 1024, 'KB', [L['id'] for L in layers])

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
