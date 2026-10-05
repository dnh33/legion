#!/usr/bin/env python3
"""
The 2D Order frame pipeline (build time only; nothing here runs inside the mod).

  python scripts/build-mod-frames.py                 build mod/art/<agent>.json for all 13 busts
  python scripts/build-mod-frames.py --review        also write the review sheets to claude/art-review/
  python scripts/build-mod-frames.py --only builder  one bust (faster while looking)

What it does, and the only things it does (the art rule: the painted art is untouchable, effects and logic only):
  1. Renders every painted layer of ui/src/mascot/data/<bust>.json (the Relic is relic.json, shown as Zealot) EXACTLY as the
     desktop draws it at rest: the same markup, the same defs, the desktop's static CSS rules (only the base eye set shows, the
     visor code is hidden), the Relic's runtime HIDE_ELEMENTS filter (engine.js:41-44, the dotted halo ring the owner removed),
     and SMIL frozen at t = 0 (the pose engine.js:354 holds). Headless Edge draws them at 8x (16x for the muster size) the ship
     size, one transparent sprite sheet per bust and size.
  2. The face layer is drawn once per eye set the desktop shows (mascot.css: base, narrow for hacking with the visor code, happy,
     wince, shut, angry, and the blink scaleY(.12)), each a full face plane, so the desktop's paint order inside L-face is kept.
  3. Each plane is reduced to the ship size by machine only:
       - colour: alpha-correct area average (premultiplied mean / coverage);
       - shape: a hard coverage threshold (the pixel-art look the owner asked for, 2026-10-05), or the smooth area average;
       - colour count: a posterised per-bust palette (median cut, a few entries reserved for the face light so the glow reads).
     No pixel is placed, moved or recoloured by hand. Re-run this script and the bytes come out the same.
  4. Writes mod/art/<agent>.json: per size the palette and, per plane, its id, kind, pivot (scaled), box and pixels
     (palette index + alpha, base64). The mod never imports these files; the lead loads one when the 2D Order is switched on.
"""
import argparse, base64, hashlib, html, json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'ui', 'src', 'mascot', 'data')
PERSONAS = os.path.join(ROOT, 'ui', 'src', 'mascot', 'personas')
OUT = os.path.join(ROOT, 'mod', 'art')
REVIEW = os.path.join(ROOT, 'claude', 'art-review')
EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
CACHE = os.path.join(tempfile.gettempdir(), 'legion-mod-frames')

# agent id -> art file. The Relic is Zealot's bust (busts.ts: zealot loads relic.json).
BUSTS = ['zealot', 'builder', 'scout', 'inquisitor', 'scribe', 'archivist', 'sentinel', 'forgemaster', 'exorcist',
         'preceptor', 'herald', 'assayer', 'sculptor']
ART_FILE = {'zealot': 'relic'}

# Ship sizes in terminal cells; one cell = one pixel wide, two tall (U+2580 upper half block).
SIZES = {'stage': (32, 18), 'muster': (10, 6)}
SUPER = {'stage': 8, 'muster': 16}
MARGIN = 2  # pixels drawn beyond the frame on every side, so a bob or a sway shows painted art, not a gap

# engine.js:41-44 HIDE_ELEMENTS (render-time filter of the desktop; the art files are untouched).
HIDE = {'relic': {'L-halo-back': ':scope > g', 'L-halo-front': ':scope > g'}}

# Face planes: (plane id, css class). mascot.css: hacking shows xe-narrow and the visor code, victory xe-happy, error xe-wince,
# sleeping xe-shut, annoyed xe-angry; the blink is .mx.blink { --bl: .12 } on the base set (scaleY about each eye's fill box).
FACES = [('face:base', ''), ('face:narrow', 'e-narrow'), ('face:hacking', 'e-narrow code'), ('face:happy', 'e-happy'),
         ('face:wince', 'e-wince'), ('face:shut', 'e-shut'), ('face:angry', 'e-angry'), ('face:blink', 'blink')]

# Filters the desktop applies to the face in each state (mascot.css), probed in Edge for the runtime's ground truth.
FILTER_PROBES = {
    'awaiting': 'sepia(1) saturate(3.4) hue-rotate(-14deg) brightness(1.12)',
    'error': 'sepia(1) saturate(6) hue-rotate(-48deg) brightness(.98)',
    'sleeping': 'brightness(.45) saturate(.6)',
    'listening': 'brightness(1.18)',
    'breathe': 'brightness(1.35)',
}

PAGE_CSS = """
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
.t{position:absolute;overflow:hidden}
.t>svg{position:absolute;left:0;top:0;display:block;overflow:hidden}
.defs{position:absolute;width:0;height:0;overflow:hidden}
.t .xe:not(.xe-base){display:none}
.t .x-code{display:none}
.t.e-narrow .xe-base,.t.e-happy .xe-base,.t.e-wince .xe-base,.t.e-shut .xe-base,.t.e-angry .xe-base{display:none}
.t.e-narrow .xe-narrow,.t.e-happy .xe-happy,.t.e-wince .xe-wince,.t.e-shut .xe-shut,.t.e-angry .xe-angry{display:inline}
.t.code .x-code{display:inline}
.t.blink .xe-base{transform-box:fill-box;transform-origin:center;transform:scaleY(.12)}
"""

PAGE_JS = """
const HIDE = %s;
for (const s of document.querySelectorAll('svg[data-layer]')) {
  const h = (HIDE[s.dataset.bust] || {})[s.dataset.layer];
  if (h) s.querySelectorAll(h).forEach((e) => e.remove());
}
for (const s of document.querySelectorAll('svg')) if (s.pauseAnimations) { s.pauseAnimations(); s.setCurrentTime(0); }
document.body.dataset.ready = '1';
"""


def geometry(crop, cols, rows):
    """Fit the rail crop into cols x (2 rows) pixels: top aligned, centred, the box extended to fill (the desktop stage lets
    the painted body spill below the rail crop, Bust.tsx). Returns (scale px/unit, render box in doc units incl. margin)."""
    cx, cy, cw, ch = crop
    W, H = cols, rows * 2
    s = min(W / cw, H / ch)
    x0 = cx + cw / 2 - W / (2 * s)
    y0 = cy
    m = MARGIN / s
    return s, (x0 - m, y0 - m, (W + 2 * MARGIN) / s, (H + 2 * MARGIN) / s)


def planes_of(data):
    """The planes to render, in the desktop's paint order. Face planes replace L-face."""
    out = []
    for L in data['layers']:
        if L['id'] == 'L-face':
            for pid, cls in FACES:
                out.append({'id': pid, 'layer': L, 'cls': cls})
        else:
            out.append({'id': L['id'], 'layer': L, 'cls': ''})
    return out


def kind_of(pid):
    if pid.startswith('face:'):
        return 'face'
    k = pid[2:]
    for p in ('hang', 'token'):
        if k.startswith(p + '-'):
            return p
    return k  # aura, halo-back, body, plume, helm, front, halo-front


def render_sheet(name, art, data, planes, size_key, extra_tiles):
    cols, rows = SIZES[size_key]
    ss = SUPER[size_key]
    crop = geometry_crop(name, data, size_key)
    s, (rx, ry, rw, rh) = geometry(crop, cols, rows)
    TW, TH = (cols + 2 * MARGIN) * ss, (rows * 2 + 2 * MARGIN) * ss
    vb = f'{rx:.4f} {ry:.4f} {rw:.4f} {rh:.4f}'
    tiles = []
    for p in planes:
        L = p['layer']
        tiles.append((p['id'], p['cls'], [L]))
    tiles += extra_tiles
    ncol = 6
    parts = [f'<svg class="defs" aria-hidden="true">{data["defs"]}</svg>']
    for i, (tid, cls, layers, *style) in enumerate(tiles):
        x, y = (i % ncol) * TW, (i // ncol) * TH
        st = style[0] if style else ''
        svgs = ''.join(
            f'<svg data-bust="{art}" data-layer="{L["id"]}" width="{TW}" height="{TH}" viewBox="{vb}" preserveAspectRatio="none" '
            f'xmlns="http://www.w3.org/2000/svg">{L["markup"]}</svg>' for L in layers)
        parts.append(f'<div class="t {cls}" data-tile="{html.escape(tid)}" style="left:{x}px;top:{y}px;width:{TW}px;height:{TH}px;{st}">{svgs}</div>')
    nrow = (len(tiles) + ncol - 1) // ncol
    W, H = ncol * TW, nrow * TH
    doc = (f'<!doctype html><html><head><meta charset="utf-8"><style>{PAGE_CSS}</style></head><body>' + ''.join(parts) +
           f'<script>{PAGE_JS % json.dumps(HIDE)}</script></body></html>')
    png = edge_shot(doc, W, H)
    sheet = np.asarray(Image.open(png).convert('RGBA')).astype(np.float64)
    out = {}
    for i, (tid, *_r) in enumerate(tiles):
        x, y = (i % ncol) * TW, (i // ncol) * TH
        out[tid] = sheet[y:y + TH, x:x + TW]
    return out, s, (rx, ry), ss


MUSTER_CROP = 'head'
HEAD_KINDS = ('halo-back', 'halo-front', 'plume', 'helm')
_head = {}


def geometry_crop(name, data, size_key='stage'):
    persona = load_persona(name)
    rail = persona.get('cropRail') or data.get('cropRail') or data['crop']
    if size_key != 'muster' or MUSTER_CROP != 'head':
        return rail
    # the muster tile is ~10 px wide: crop to the head (the halo, plume, helm and face as painted), found by machine from the
    # stage planes' coverage, so the identity (halo shape, crest, visor) gets the pixels instead of the shoulders
    if name not in _head:
        b = build_size(name, 'stage', 'smooth', 0, 0)
        s = b['scale']; rx, ry = b['origin']
        ys, xs = [], []
        for pl in b['planes']:
            pid = pl['p']['id']
            if kind_of(pid) in HEAD_KINDS or pid == 'face:base':
                yy, xx = np.nonzero(pl['alpha'] >= 128)
                ys += list(yy); xs += list(xx)
        x0, x1 = rx + min(xs) / s, rx + (max(xs) + 1) / s
        y0, y1 = ry + min(ys) / s, ry + (max(ys) + 1) / s
        # keep it inside the rail crop's sides, a little headroom
        x0, x1 = max(x0, rail[0]), min(x1, rail[0] + rail[2])
        y0 = max(y0 - 0.02 * (y1 - y0), rail[1])
        _head[name] = [x0, y0, x1 - x0, y1 - y0]
    return _head[name]


def edge_shot(doc, W, H):
    os.makedirs(CACHE, exist_ok=True)
    key = hashlib.sha256((doc + f'{W}x{H}').encode()).hexdigest()[:24]
    png = os.path.join(CACHE, key + '.png')
    if os.path.exists(png):
        return png
    page = os.path.join(CACHE, key + '.html')
    with open(page, 'w', encoding='utf-8') as f:
        f.write(doc)
    prof = os.path.join(CACHE, 'profile')
    cmd = [EDGE, '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
           '--default-background-color=00000000', f'--user-data-dir={prof}', '--virtual-time-budget=3000',
           f'--window-size={W},{H}', f'--screenshot={png}', 'file:///' + page.replace('\\', '/')]
    subprocess.run(cmd, check=True, capture_output=True, timeout=180)
    if not os.path.exists(png):
        raise SystemExit(f'edge wrote no screenshot for {page}')
    im = Image.open(png)
    if im.size != (W, H):
        raise SystemExit(f'edge screenshot is {im.size}, wanted {(W, H)}: {page}')
    return png


def load_persona(name):
    with open(os.path.join(PERSONAS, name + '.json'), encoding='utf-8') as f:
        return json.load(f)


# ---------------------------------------------------------------------------------------------------------------------
# Reduction to the ship size
# ---------------------------------------------------------------------------------------------------------------------

def reduce_smooth(tile, ss):
    """Alpha-correct area average: mean of premultiplied colour, divided by the mean coverage."""
    h, w = tile.shape[0] // ss, tile.shape[1] // ss
    a = tile[..., 3:4] / 255.0
    pm = np.concatenate([tile[..., :3] * a, a], axis=2).reshape(h, ss, w, ss, 4).mean(axis=(1, 3))
    cov = pm[..., 3]
    rgb = np.where(cov[..., None] > 1e-6, pm[..., :3] / np.maximum(cov[..., None], 1e-6), 0)
    return rgb, cov


def reduce_samples(tile, ss):
    """The ss x ss samples of each ship pixel: (h, w, ss*ss, 4)."""
    h, w = tile.shape[0] // ss, tile.shape[1] // ss
    return tile.reshape(h, ss, w, ss, 4).transpose(0, 2, 1, 3, 4).reshape(h, w, ss * ss, 4)


def median_cut(colors, weights, k):
    """Median cut over weighted RGB colours, then a few Lloyd steps. Deterministic."""
    if len(colors) == 0:
        return np.zeros((0, 3))
    boxes = [np.arange(len(colors))]
    while len(boxes) < k:
        best, bi, bax = -1, -1, 0
        for i, b in enumerate(boxes):
            if len(b) < 2:
                continue
            c = colors[b]
            rng = c.max(axis=0) - c.min(axis=0)
            ax = int(rng.argmax())
            score = rng[ax] * np.sqrt(weights[b].sum())
            if score > best:
                best, bi, bax = score, i, ax
        if bi < 0:
            break
        b = boxes.pop(bi)
        order = b[np.argsort(colors[b, bax], kind='stable')]
        cw = np.cumsum(weights[order])
        cut = int(np.searchsorted(cw, cw[-1] / 2)) + 1
        cut = min(max(cut, 1), len(order) - 1)
        boxes += [order[:cut], order[cut:]]
    pal = np.array([np.average(colors[b], axis=0, weights=weights[b]) for b in boxes])
    for _ in range(6):
        idx = nearest(colors, pal)
        for j in range(len(pal)):
            m = idx == j
            if m.any():
                pal[j] = np.average(colors[m], axis=0, weights=weights[m])
    return pal


def nearest(colors, pal):
    d = ((colors[:, None, :] - pal[None, :, :]) ** 2).sum(axis=2)
    return d.argmin(axis=1)


FACE_THRESHOLD = 0.3


def plane_threshold(pid, cov, threshold):
    """The coverage a ship pixel needs to be drawn. The face light is the soul of each bust and is often a thin slit: it keeps a
    pixel from 30 % coverage, and a face that would vanish entirely keeps its strongest pixels (half its best coverage)."""
    if not pid.startswith('face:'):
        return threshold
    t = FACE_THRESHOLD
    mx = float(cov.max()) if cov.size else 0.0
    if mx < t:
        t = max(mx * 0.5, 1e-3)
    return t


def build_size(name, size_key, mode, k_body, k_face, threshold=0.5):
    art = ART_FILE.get(name, name)
    with open(os.path.join(DATA, art + '.json'), encoding='utf-8') as f:
        data = json.load(f)
    planes = planes_of(data)
    ref_layers = [L for L in data['layers']]
    tiles, s, (rx, ry), ss = render_sheet(name, art, data, planes, size_key, [('ref', '', ref_layers)])
    cols, rows = SIZES[size_key]
    reduced = {}
    for p in planes:
        rgb, cov = reduce_smooth(tiles[p['id']], ss)
        reduced[p['id']] = (rgb, cov)
    ref = reduce_smooth(tiles['ref'], ss)

    # palette: k_body entries from every non-face plane, k_face from the face planes (the light must keep its own colours)
    def gather(ids):
        cs, ws = [], []
        for pid in ids:
            rgb, cov = reduced[pid]
            m = cov >= plane_threshold(pid, cov, threshold) if mode != 'smooth' else cov > 0.02
            w = cov[m]
            if pid.startswith('face:'):
                # the face light is a few bright pixels (eye cores) inside a large visor: weight brightness so the cores keep an entry
                lum = rgb[m].max(axis=1) / 255.0
                w = w * (0.3 + 3.0 * lum ** 4)
            cs.append(rgb[m]); ws.append(w)
        return np.concatenate(cs) if cs else np.zeros((0, 3)), np.concatenate(ws) if ws else np.zeros(0)
    face_ids = [p['id'] for p in planes if p['id'].startswith('face:')]
    body_ids = [p['id'] for p in planes if not p['id'].startswith('face:')]
    if mode == 'smooth':
        pal = None
    else:
        bc, bw = gather(body_ids)
        fc, fw = gather(face_ids)
        fpal = median_cut(fc, fw, k_face)
        if len(fc):
            # the brightest face light (the eye cores) always has its own entry
            hot = fc[(fc.sum(axis=1)).argmax()]
            j = ((fpal - hot) ** 2).sum(axis=1).argmin()
            if ((fpal[j] - hot) ** 2).sum() > 12 ** 2:
                fpal[((fpal - fpal.mean(axis=0)) ** 2).sum(axis=1).argmin()] = hot
        bpal = median_cut(bc, bw, k_body)
        # small painted accents (a red seal, a brass pin) would merge into a big neighbour: each non-face plane's own mean colour
        # gets an entry when nothing in the palette is near it, replacing the most redundant entry
        for pid in body_ids:
            rgb, cov = reduced[pid]
            m = cov >= threshold
            if m.sum() < 1:
                continue
            anchor = np.average(rgb[m], axis=0, weights=cov[m])
            if ((bpal - anchor) ** 2).sum(axis=1).min() <= 36 ** 2:
                continue
            dd = ((bpal[:, None] - bpal[None]) ** 2).sum(axis=2) + np.eye(len(bpal)) * 1e9
            bpal[dd.min(axis=1).argmin()] = anchor
        pal = np.concatenate([bpal, fpal])
        pal = np.clip(np.round(pal), 0, 255)

    out_planes = []
    quant_err = []
    for p in planes:
        rgb, cov = reduced[p['id']]
        if mode == 'smooth':
            alpha = np.clip(np.round(cov * 255), 0, 255)
            col = rgb
            idx = None
        else:
            alpha = np.where(cov >= plane_threshold(p['id'], cov, threshold), 255, 0)
            if mode == 'mode':
                # majority sampling: map every opaque sample to the palette, keep the most frequent entry per pixel
                smp = reduce_samples(tiles[p['id']], ss)
                h, w = smp.shape[:2]
                flat = smp.reshape(-1, 4)
                op = flat[:, 3] >= 128
                si = np.full(len(flat), -1)
                if op.any():
                    si[op] = nearest(flat[op, :3], pal)
                si = si.reshape(h, w, ss * ss)
                idx = np.zeros((h, w), dtype=int)
                avg_idx = nearest(rgb.reshape(-1, 3), pal).reshape(h, w)
                for yy in range(h):
                    for xx in range(w):
                        v = si[yy, xx]
                        v = v[v >= 0]
                        idx[yy, xx] = np.bincount(v, minlength=len(pal)).argmax() if len(v) else avg_idx[yy, xx]
            else:
                idx = nearest(rgb.reshape(-1, 3), pal).reshape(rgb.shape[:2])
            col = pal[idx]
            m = alpha > 0
            if m.any():
                quant_err.append(np.abs(col[m] - rgb[m]).mean())
        out_planes.append({'p': p, 'alpha': alpha, 'col': col, 'idx': idx})
    return {'name': name, 'art': art, 'data': data, 'planes': out_planes, 'pal': pal, 'scale': s, 'origin': (rx, ry),
            'cols': cols, 'rows': rows, 'ref': ref, 'quant_err': float(np.mean(quant_err)) if quant_err else 0.0, 'mode': mode}


OUTLINE_SKIP = ('aura', 'halo-back', 'halo-front')


def composite(built, face='face:base', outline=False):
    """Static idle composite (straight 'over', the same order and rule as compose.ts), cropped to the frame. RGBA float.
    outline: False, 'all' (every plane's silhouette) or 'body' (aura and halo rings left as painted, only the figure outlined)."""
    H, W = built['rows'] * 2 + 2 * MARGIN, built['cols'] + 2 * MARGIN
    acc = np.zeros((H, W, 3)); a = np.zeros((H, W)); body = np.zeros((H, W), dtype=bool)
    bacc = np.zeros((H, W, 3))
    for pl in built['planes']:
        pid = pl['p']['id']
        if pid.startswith('face:') and pid != face:
            continue
        al = pl['alpha'] / 255.0
        acc = pl['col'] * al[..., None] + acc * (1 - al[..., None])
        a = al + a * (1 - al)
        if kind_of(pid) not in OUTLINE_SKIP:
            bacc = np.where(al[..., None] >= 0.5, pl['col'], bacc)
            body |= al >= 0.5
    rgb = np.where(a[..., None] > 0, acc / np.maximum(a[..., None], 1e-9), 0)
    if outline == 'body':
        rgb, a = add_outline(rgb, a, body, bacc)
    elif outline:
        rgb, a = add_outline(rgb, a)
    m = MARGIN
    return rgb[m:H - m, m:W - m], a[m:H - m, m:W - m]


def outline_color(c):
    """A darker shade of the same hue, never pure black (kodawari art rule). Mirrors compose.ts outlineOf."""
    r, g, b = c / 255.0
    mx, mn = max(r, g, b), min(r, g, b)
    k = 0.42
    out = np.array([r, g, b]) * k
    floor = 0.07
    if out.max() < floor:
        out = out + (floor - out.max())
    return np.round(out * 255)


def add_outline(rgb, a, src=None, src_rgb=None):
    H, W = a.shape
    op = a >= 0.5 if src is None else src
    if src_rgb is None:
        src_rgb = rgb
    full = a >= 0.5
    out_rgb = rgb.copy(); out_a = a.copy()
    for y in range(H):
        for x in range(W):
            if op[y, x] or full[y, x]:
                continue
            for dy, dx in ((1, 0), (-1, 0), (0, -1), (0, 1)):
                yy, xx = y + dy, x + dx
                if 0 <= yy < H and 0 <= xx < W and op[yy, xx]:
                    out_rgb[y, x] = outline_color(src_rgb[yy, xx]); out_a[y, x] = 1.0
                    break
    return out_rgb, out_a


# ---------------------------------------------------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------------------------------------------------

def encode_size(built):
    pal = built['pal']
    planes = []
    s = built['scale']; rx, ry = built['origin']
    for pl in built['planes']:
        p = pl['p']; L = p['layer']
        alpha = pl['alpha'].astype(int)
        ys, xs = np.nonzero(alpha)
        if len(ys) == 0:
            continue
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        idx = pl['idx'][y0:y1, x0:x1].astype(np.uint8)
        al = alpha[y0:y1, x0:x1].astype(np.uint8)
        idx = np.where(al > 0, idx, 0).astype(np.uint8)
        buf = np.stack([idx, al], axis=2).reshape(-1).tobytes()
        piv = L.get('pivot')
        entry = {'id': p['id'], 'kind': kind_of(p['id']), 'x': int(x0), 'y': int(y0), 'w': int(x1 - x0), 'h': int(y1 - y0),
                 'px': base64.b64encode(buf).decode('ascii')}
        if piv:
            entry['pivot'] = [round((piv[0] - rx) * s, 2), round((piv[1] - ry) * s, 2)]
        if L.get('flip'):
            entry['flip'] = L['flip']
        planes.append(entry)
    return {'cols': built['cols'], 'rows': built['rows'], 'margin': MARGIN,
            'palette': base64.b64encode(bytes(int(v) for v in pal.reshape(-1))).decode('ascii'),
            'faceFrom': len(pal) - built['kface'], 'planes': planes}


PERSONA_KEYS = ('name', 'tempo', 'haloFlare', 'haloMotion', 'plumeSway', 'plumeLight', 'sleepPlume')


def write_art(name, sizes):
    art = ART_FILE.get(name, name)
    src = os.path.join(DATA, art + '.json')
    with open(src, 'rb') as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    persona = load_persona(name)
    doc = {
        'v': 1,
        'agent': name,
        'source': f'ui/src/mascot/data/{art}.json',
        'sourceSha256': digest,
        'note': 'Machine-made by scripts/build-mod-frames.py from the painted layers. Never edit by hand; re-run the script.',
        'persona': {k: persona[k] for k in PERSONA_KEYS if k in persona} | {'verbs': persona.get('verbs', [])},
        'sizes': {k: encode_size(b) for k, b in sizes.items()},
    }
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name + '.json')
    text = json.dumps(doc, separators=(',', ':'), ensure_ascii=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text + '\n')
    return path, len(text) + 1


def probe_filters():
    """Ground truth for the runtime's face recolour: Edge draws swatches through each desktop filter; the spec compares."""
    rng = np.random.default_rng(7)
    base = [[124, 255, 178], [185, 255, 216], [255, 255, 255], [230, 255, 241], [4, 20, 11], [40, 120, 80], [0, 0, 0],
            [90, 200, 140], [20, 60, 40], [200, 210, 220]]
    cols = base + [list(map(int, rng.integers(0, 256, 3))) for _ in range(22)]
    S = 8
    names = list(FILTER_PROBES)
    parts = []
    for r, n in enumerate(names):
        for c, col in enumerate(cols):
            parts.append(f'<div style="position:absolute;left:{c*S}px;top:{r*S}px;width:{S}px;height:{S}px;'
                         f'background:rgb({col[0]},{col[1]},{col[2]});filter:{FILTER_PROBES[n]}"></div>')
    doc = '<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body>' + ''.join(parts) + '</body></html>'
    png = edge_shot(doc, len(cols) * S, len(names) * S)
    im = np.asarray(Image.open(png).convert('RGBA'))
    out = {'source': 'scripts/build-mod-frames.py probe_filters: Edge drawing mascot.css face filters over solid swatches',
           'filters': FILTER_PROBES, 'inputs': cols, 'outputs': {}}
    for r, n in enumerate(names):
        out['outputs'][n] = [list(map(int, im[r * S + S // 2, c * S + S // 2, :3])) for c in range(len(cols))]
    path = os.path.join(ROOT, 'mod', 'test', 'node', 'art', 'fixtures', 'filter-truth.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, indent=1)
        f.write('\n')
    return path


# ---------------------------------------------------------------------------------------------------------------------
# Review sheets (kodawari: look at it at the size it ships)
# ---------------------------------------------------------------------------------------------------------------------
DARK, LIGHT = (0x12, 0x15, 0x1a), (0xff, 0xff, 0xff)


def cells_image(rgb, a, panel, z=8):
    """Simulates the half-block cell drawing: each pixel a z x z block (one cell = z wide, 2z tall), over the panel colour."""
    bg = np.array(panel, dtype=float)
    img = rgb * a[..., None] + bg * (1 - a[..., None])
    img = np.clip(np.round(img), 0, 255).astype(np.uint8)
    return Image.fromarray(img, 'RGB').resize((img.shape[1] * z, img.shape[0] * z), Image.NEAREST)


def label(im, text):
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    d.text((4, 2), text, fill=(150, 160, 170))
    return im


def sheet(images, ncol, pad=12, bg=(40, 44, 52), top=14):
    w = max(i.size[0] for i in images); h = max(i.size[1] for i in images)
    nrow = (len(images) + ncol - 1) // ncol
    out = Image.new('RGB', (ncol * (w + pad) + pad, nrow * (h + pad + top) + pad), bg)
    for i, im in enumerate(images):
        out.paste(im, (pad + (i % ncol) * (w + pad), pad + top + (i // ncol) * (h + pad + top)))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', action='append')
    ap.add_argument('--review', action='store_true')
    ap.add_argument('--compare', action='store_true', help='write the style comparison sheets (smooth vs pixel variants)')
    ap.add_argument('--mode', default='pixel', choices=['pixel', 'mode', 'smooth'])
    ap.add_argument('--kbody', type=int, default=14)
    ap.add_argument('--kface', type=int, default=8)
    ap.add_argument('--no-write', action='store_true')
    args = ap.parse_args()
    names = args.only or BUSTS
    os.makedirs(REVIEW, exist_ok=True)
    report = {}
    for name in names:
        sizes = {}
        for sk in SIZES:
            b = build_size(name, sk, args.mode, args.kbody, args.kface)
            b['kface'] = args.kface
            sizes[sk] = b
            # reference check (renderer, not style): the whole bust drawn at once with the desktop's static CSS vs the planes
            # reduced smooth and composited (catches a missing def, a stray eye set or a lost filter)
            sm = build_size(name, sk, 'smooth', 0, 0)
            rgb, a = composite(sm)
            rrgb, ra = sm['ref']
            m = MARGIN
            rrgb, ra = rrgb[m:-m, m:-m], ra[m:-m, m:-m]
            fg = (a > 0.02) | (ra > 0.02)
            prem = np.abs(rgb * a[..., None] - rrgb * ra[..., None])[fg].mean() if fg.any() else 0
            report.setdefault(name, {})[sk] = {'refMeanAbsErr': round(float(prem), 2), 'refMaxAbsErr': round(float(np.abs(rgb * a[..., None] - rrgb * ra[..., None]).max()), 1),
                                               'quantMeanAbsErr': round(b['quant_err'], 2),
                                               'paletteSize': 0 if b['pal'] is None else len(b['pal'])}
        if args.compare:
            write_compare(name)
        if not args.no_write and args.mode != 'smooth':
            path, n = write_art(name, sizes)
            report[name]['bytes'] = n
        print(name, json.dumps(report[name]))
    if not args.no_write:
        print('filter truth ->', probe_filters())
    if args.review:
        write_review()
    with open(os.path.join(REVIEW, 'build-report.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(report, f, indent=1)
        f.write('\n')


def draw_cells(cells, cols, rows, default, z=8):
    """Draws packed Raster cells as the terminal would: z px wide, 2z tall, U+2580 top = fg, bottom = bg."""
    raw = base64.b64decode(cells)
    v = np.frombuffer(raw, dtype='<u4').reshape(rows, cols, 3)
    img = np.zeros((rows * 2, cols, 3), dtype=np.uint8)
    d = np.array(default, dtype=np.uint8)
    def col(c):
        return d if c == 0x01000000 else np.array([(c >> 16) & 255, (c >> 8) & 255, c & 255], dtype=np.uint8)
    for r in range(rows):
        for c in range(cols):
            cp, fg, bg = (int(x) for x in v[r, c])
            if cp == 0x20:
                top = bot = d
            elif cp == 0x2580:
                top, bot = col(fg), col(bg)
            elif cp == 0x2584:
                top, bot = col(bg), col(fg)
            else:
                raise SystemExit(f'unexpected code point {cp:#x}')
            img[2 * r, c] = top; img[2 * r + 1, c] = bot
    return Image.fromarray(img, 'RGB').resize((cols * z, rows * 2 * z), Image.NEAREST)


MOODS = ['idle', 'listening', 'thinking', 'hacking', 'awaiting', 'victory', 'error', 'sleeping', 'annoyed']


def write_review():
    """Review sheets drawn from the REAL runtime's packed cells (mod/test/node/art/preview-dump.ts)."""
    from PIL import ImageDraw
    work = os.path.join(CACHE, 'preview.json')
    subprocess.run(['node', '--experimental-transform-types', '--no-warnings', 'mod/test/node/art/preview-dump.ts', work],
                   cwd=ROOT, check=True, capture_output=True, timeout=300)
    with open(work, encoding='utf-8') as f:
        pv = json.load(f)
    def titled(ims, ncol, titles, path):
        sh = sheet(ims, ncol)
        d = ImageDraw.Draw(sh)
        w = ims[0].size[0] + 12
        for i, t in enumerate(titles[:ncol]):
            d.text((12 + i * w, 2), t, fill=(220, 225, 230))
        sh.save(os.path.join(REVIEW, path))
    for agent, e in pv.items():
        cols, rows, mc, mr = e['cols'], e['rows'], e['mcols'], e['mrows']
        ims = []
        for tag, panel in (('dark', DARK), ('light', LIGHT)):
            ims += [draw_cells(e[f'stage-{tag}'][m], cols, rows, panel) for m in MOODS]
        titled(ims, len(MOODS), MOODS, f'bust-{agent}.png')
        ims = []
        for tag, panel in (('dark', DARK), ('light', LIGHT)):
            ims += [draw_cells(e[f'muster-{tag}'][m], mc, mr, panel, z=12) for m in MOODS]
        titled(ims, len(MOODS), MOODS, f'muster-{agent}.png')
        fr = e['idle-dark']
        titled([draw_cells(x['cells'], cols, rows, DARK) for x in fr], max(1, len(fr)), [f't={x["t"]}ms' for x in fr], f'idle-frames-{agent}.png')
    for tag, panel in (('dark', DARK), ('light', LIGHT)):
        for flat in ('', '-flat'):
            ims = [draw_cells(pv[a][f'stage-{tag}{flat}']['idle'], pv[a]['cols'], pv[a]['rows'], panel) for a in pv]
            titled(ims, 7, list(pv)[:7], f'contact-stage-{tag}{flat}.png')
        ims = [draw_cells(pv[a][f'muster-{tag}']['idle'], pv[a]['mcols'], pv[a]['mrows'], panel, z=8) for a in pv]
        titled(ims, 13, [a[:6] for a in pv], f'contact-muster-{tag}.png')
    # panel mode vs terminal mode when the terminal's own background is NOT the panel colour (Campbell #0c0c0c, a light #f2f2f2)
    ims, titles = [], []
    for a in ('zealot', 'builder', 'scout', 'herald'):
        for tag, term in (('dark', (0x0c, 0x0c, 0x0c)), ('light', (0xf2, 0xf2, 0xf2))):
            for mode in ('stage', 'stage-term'):
                ims.append(draw_cells(pv[a][f'{mode}-{tag}']['idle'], pv[a]['cols'], pv[a]['rows'], term))
                titles.append(f'{a} {tag} {"panel" if mode == "stage" else "terminal"}')
    sh = sheet(ims, 4)
    d = ImageDraw.Draw(sh)
    w, h = ims[0].size[0] + 12, ims[0].size[1] + 26
    for i, t in enumerate(titles):
        d.text((12 + (i % 4) * w, 2 + (i // 4) * h), t, fill=(220, 225, 230))
    sh.save(os.path.join(REVIEW, 'transparency-modes.png'))
    print('review sheets ->', REVIEW)


def write_compare(name):
    """Smooth downscale vs the pixel-art variants, at ship size, dark and light panel, with and without the outline."""
    variants = [('smooth', 'smooth', 16, 6, False), ('pixel 14+8', 'pixel', 14, 8, False), ('pixel 10+6', 'pixel', 10, 6, False),
                ('mode 14+8', 'mode', 14, 8, False), ('pixel 14+8 +outline all', 'pixel', 14, 8, 'all'),
                ('pixel 14+8 +outline body', 'pixel', 14, 8, 'body')]
    from PIL import ImageDraw
    for sk in SIZES:
        z = 8 if sk == 'stage' else 12
        built = {}
        rows = {DARK: [], LIGHT: []}
        for title, mode, kb, kf, ol in variants:
            key = (mode, kb, kf)
            if key not in built:
                built[key] = build_size(name, sk, mode, kb, kf)
            rgb, a = composite(built[key], outline=ol)
            for panel in (DARK, LIGHT):
                rows[panel].append(cells_image(rgb, a, panel, z=z))
        sh = sheet(rows[DARK] + rows[LIGHT], len(variants))
        d = ImageDraw.Draw(sh)
        w = rows[DARK][0].size[0] + 12
        for i, (title, *_r) in enumerate(variants):
            d.text((12 + i * w, 2), title, fill=(220, 225, 230))
        sh.save(os.path.join(REVIEW, f'compare-{name}-{sk}.png'))


if __name__ == '__main__':
    main()
