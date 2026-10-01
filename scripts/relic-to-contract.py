#!/usr/bin/env python3
"""One-off: regroup the approved concept docs/art/relic.svg into the layer contract
(docs/art/MASCOT_CONTRACT.md) -> docs/art/relic.layered.svg. Pure regrouping: no path is changed."""
import os, xml.etree.ElementTree as ET
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NS = 'http://www.w3.org/2000/svg'; ET.register_namespace('', NS); ET.register_namespace('xlink', 'http://www.w3.org/1999/xlink')
q = lambda t: '{%s}%s' % (NS, t)
src = ET.parse(os.path.join(ROOT, 'docs/art/relic.svg')).getroot(); k = list(src)
helm = k[75]; hk = list(helm); htf = helm.get('transform')          # translate(300 245)

def G(id_, *els, pivot=None, tf=None):
    g = ET.Element(q('g'), {'id': id_})
    if pivot: g.set('data-pivot', '%g %g' % pivot)
    tgt = g
    if tf:
        tgt = ET.SubElement(g, q('g'), {'transform': tf})
    for e in els: tgt.append(e)
    return g

out = ET.Element(q('svg'), {'viewBox': src.get('viewBox') or '0 0 600 800', 'data-crop': '96 0 452 650'})
out.append(k[1])                                                    # defs
out.append(G('L-aura', k[73]))
out.append(G('L-halo-back', k[74], pivot=(300, 300)))
out.append(G('L-plume', hk[0], pivot=(300, 99), tf=htf))
FACE = [32, 33, 34, 35, 36, 37, 94]
out.append(G('L-helm', *[e for i, e in enumerate(hk) if i != 0 and i not in FACE], pivot=(300, 362), tf=htf))
vis = ET.Element(q('path'), {'id': 'L-visor-shape', 'd': hk[35].get('d'), 'fill': 'none'})
eyes = hk[94]; eyes.set('id', 'L-eyes')
out.append(G('L-face', *[hk[i] for i in FACE[:-1]], vis, eyes, pivot=(300, 362), tf=htf))
for n, i in enumerate(range(103, 110), 1):
    x = float(list(k[i].iter(q('path')))[0].get('d').split()[0][1:].split(',')[0])
    out.append(G('L-hang-%d' % n, k[i], pivot=(x, 362)))
out.append(G('L-front', *[k[i] for i in range(110, 115)]))
for n, (i, p) in enumerate([(115, (216, 349)), (116, (370, 347)), (117, (398, 257))], 1):
    out.append(G('L-token-%d' % n, k[i], pivot=p))
out.append(G('L-halo-front', k[118], pivot=(300, 300)))
ET.ElementTree(out).write(os.path.join(ROOT, 'docs/art/relic.layered.svg'), encoding='unicode')
print('ok')
