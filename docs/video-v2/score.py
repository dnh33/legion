#!/usr/bin/env python3
"""
Original score for the Legion trailer, synthesised from scratch (no samples, no third-party audio),
locked to the picture through docs/video-v2/cues.json (96 BPM grid).

    python3 docs/video-v2/score.py      -> docs/video-v2/score.wav (48 kHz stereo float32, pre-master)

The sound follows the app's two halves:
  gothic   pipe organ (8'/4'/2' ranks + mixture, wind chiff), a choir, a tolling bell, war drums
  hacker   a phosphor synth arpeggio (resonant saw, opens up toward the climax), data ticks,
           glitch stutters on the hard UI cuts, key clicks on the typed terminal lines

Form (D minor; i VI iv V; Picardy D major at the very end):
  cold        organ pedal fifth, hummed choir, candle crackle, one bell per line
  awaken      organ swell, the bell tolls as the relic wakes
  muster      soft war drums, a bell on the relic slot, a rising pluck per roster name
  UI scenes   one chord per bar, steady pulse, arpeggio from 'approvals' (cutoff opens), soft bells on marks,
              soft plucks on captions, confirm blips on chips, data ticks, key clicks, glitch on hard cuts
  next        cool sparse organ + bell, no arpeggio, no drums, a pluck per card
  silence     one beat gated under -50 dB with a reversed-reverb swell into it
  victory     tutti hit (organ, choir, bell, drums, sub), Picardy D major across the end card, fade
Dependencies: numpy, scipy.
"""
import json
import os
import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
CUES = json.load(open(os.path.join(HERE, 'cues.json')))
DUR = float(CUES['duration'])
BPM = float(CUES.get('bpm', 96))
BEAT = 60 / BPM
BAR = BEAT * 4
N = int(DUR * SR) + SR * 4
rng = np.random.default_rng(1977)

def ev(name):
    return [e['t'] for e in CUES['events'] if e['name'] == name]

def sec(name):
    s = next(x for x in CUES['sections'] if x['name'] == name)
    return s['start'], s['end']

def b(bar, beat=0.0):
    return bar * BAR + beat * BEAT

# ---------------------------------------------------------------- buses
BUS = {k: np.zeros((2, N)) for k in ('music', 'drums', 'fx')}
WET = np.zeros((2, N))

def place(sig, t, gain=1.0, pan=0.0, send=0.3, bus='music'):
    i = int(round(t * SR))
    if i >= N or len(sig) == 0:
        return
    if i < 0:
        sig = sig[-i:]; i = 0
    j = min(N, i + len(sig))
    s = sig[: j - i] * gain
    a = (pan + 1) * np.pi / 4
    l, r = np.cos(a), np.sin(a)
    BUS[bus][0, i:j] += s * l
    BUS[bus][1, i:j] += s * r
    WET[0, i:j] += s * l * send
    WET[1, i:j] += s * r * send

def tt(d):
    return np.arange(int(d * SR)) / SR

def env(n, a, r, curve=1.6):
    e = np.ones(n)
    na, nr = min(n, int(a * SR)), min(n, int(r * SR))
    if na: e[:na] = np.linspace(0, 1, na) ** curve
    if nr: e[-nr:] *= np.linspace(1, 0, nr) ** curve
    return e

def lp(x, f, order=2): return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, order=2): return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi, order=2): return sosfilt(butter(order, [lo, hi], 'band', fs=SR, output='sos'), x)
def noise(d): return rng.standard_normal(int(d * SR))
def midi(m): return 440.0 * 2 ** ((m - 69) / 12)

# ---------------------------------------------------------------- harmony
NOTE = {'C': 0, 'C#': 1, 'D': 2, 'Eb': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'Ab': 8, 'A': 9, 'Bb': 10, 'B': 11}
def m(name, octv): return 12 * (octv + 1) + NOTE[name]
CH = {   # root (bass), upper voicing, arpeggio cell
    'Dm': (m('D', 2), [m('D', 3), m('F', 3), m('A', 3), m('D', 4)], [m('D', 4), m('A', 4), m('F', 4), m('D', 5)]),
    'Bb': (m('Bb', 1), [m('D', 3), m('F', 3), m('Bb', 3), m('D', 4)], [m('Bb', 3), m('F', 4), m('D', 4), m('Bb', 4)]),
    'Gm': (m('G', 1), [m('D', 3), m('G', 3), m('Bb', 3), m('D', 4)], [m('G', 3), m('D', 4), m('Bb', 3), m('G', 4)]),
    'A':  (m('A', 1), [m('E', 3), m('A', 3), m('C#', 4), m('E', 4)], [m('A', 3), m('E', 4), m('C#', 4), m('A', 4)]),
    'F':  (m('F', 1), [m('C', 3), m('F', 3), m('A', 3), m('C', 4)], [m('F', 3), m('C', 4), m('A', 3), m('F', 4)]),
    'D':  (m('D', 2), [m('D', 3), m('F#', 3), m('A', 3), m('D', 4)], [m('D', 4), m('A', 4), m('F#', 4), m('D', 5)]),
}
# one chord per bar of the 96 BPM grid: 0-3 cold/awaken on D, 4-6 muster, 7-35 i-VI-iv-V cycling, 36-39 Picardy D
CYC = ['Dm', 'Bb', 'Gm', 'A']
PROG = ['Dm'] * 4 + ['Dm', 'Bb', 'Gm'] + [CYC[(k - 7) % 4] for k in range(7, 36)] + ['D'] * 4
NBARS = int(round(DUR / BAR))
PROG = (PROG + ['D'] * NBARS)[:NBARS]

# ---------------------------------------------------------------- instruments
def organ(notes, d, ranks=(1, 2, 4), mixture=0.0, attack=0.07, release=0.45, chiff=0.5):
    """Pipe organ: each rank is a flue pipe (strong fundamental, quickly falling harmonics); wind chiff on attack."""
    t = tt(d); out = np.zeros_like(t)
    rank_gain = {1: 1.0, 2: 0.55, 4: 0.28, 3: 0.18, 6: 0.12}
    stops = list(ranks) + ([3, 6] if mixture > 0 else [])
    for n in notes:
        f0 = midi(n)
        for rk in stops:
            g = rank_gain[rk] * (mixture if rk in (3, 6) else 1.0)
            ff = f0 * rk * 2 ** (rng.uniform(-2.5, 2.5) / 1200)
            ph = rng.uniform(0, 2 * np.pi)
            for h, ha in ((1, 1.0), (2, .6), (3, .36), (4, .24), (5, .15), (6, .1), (7, .07), (8, .05), (10, .03)):
                fh = ff * h
                if fh > 11000: break
                out += g * ha * np.sin(2 * np.pi * fh * t + ph * h)
    out /= max(1, len(notes)) * 1.6
    out *= 1 + 0.012 * np.sin(2 * np.pi * 0.31 * t)            # wind sway
    e = env(len(t), attack, release, 1.3)
    if chiff > 0:
        k = int(0.05 * SR)
        ch = bp(noise(0.05), 1800, 4200) * np.exp(-tt(0.05) / 0.012) * chiff * 0.3
        out[:k] += ch[:k]
    return out * e

FORMANTS_AH = [(700, 110, 1.0), (1150, 130, 0.55), (2650, 180, 0.22), (3400, 250, 0.1)]
FORMANTS_OO = [(320, 80, 1.0), (800, 100, 0.35), (2500, 180, 0.06)]
def choir(notes, d, attack=1.0, release=2.0, voices=4, vowel=FORMANTS_AH):
    t = tt(d); out = np.zeros_like(t)
    for n in notes:
        f = midi(n)
        for v in range(voices):
            ff = f * 2 ** (rng.uniform(-8, 8) / 1200)
            vib = 1 + 0.0045 * np.sin(2 * np.pi * (4.7 + rng.uniform(-.4, .4)) * t + rng.uniform(0, 6))
            ph = 2 * np.pi * np.cumsum(ff * vib) / SR
            for h in range(1, 40):
                fn = ff * h
                if fn > 5000: break
                a = sum(g * np.exp(-0.5 * ((fn - fc) / bw) ** 2) for fc, bw, g in vowel) + 0.015 / h
                out += a * np.sin(h * ph + rng.uniform(0, 6))
    out /= max(1, len(notes) * voices)
    return out * env(len(t), attack, release, 1.4)

def arp_note(n, d, cutoff, reso=2.2):
    """Phosphor arpeggio voice: two detuned saws through a resonant low-pass (additive, per-partial response)."""
    t = tt(d); out = np.zeros_like(t); f0 = midi(n)
    for c in (-6, 6):
        ff = f0 * 2 ** (c / 1200)
        for h in range(1, 40):
            fh = ff * h
            if fh > 9000: break
            resp = 1 / np.sqrt((1 - (fh / cutoff) ** 2) ** 2 + (fh / cutoff / reso) ** 2)
            out += (1 / h) * min(resp, 3.0) * np.sin(2 * np.pi * fh * t)
    out /= 2
    return out * np.exp(-t / (d * .45)) * env(len(t), .003, .03)

def bass_note(n, d):
    t = tt(d); f = midi(n)
    s = np.sin(2 * np.pi * f * t) + 0.35 * np.tanh(3 * np.sin(2 * np.pi * f * t)) * 0.6
    return s * env(len(t), .006, .08) * np.exp(-t / (d * 1.4))

def kick(d=0.7, f0=140, f1=64, decay=0.24):
    t = tt(d)
    f = f1 + (f0 - f1) * np.exp(-t / 0.045)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / decay)
    click = bp(noise(d), 2000, 9000) * np.exp(-t / 0.004) * 0.5
    return np.tanh((body + click) * 1.5)

def war_drum(d=1.6, f0=170, f1=68, decay=0.42):
    t = tt(d)
    f = f1 + (f0 - f1) * np.exp(-t / 0.06)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / decay)
    shell = np.sin(2 * np.pi * np.cumsum(f * 2.3) / SR) * np.exp(-t / (decay * .35)) * 0.45
    skin = bp(noise(d), 300, 4000) * np.exp(-t / 0.03) * 0.9
    return np.tanh((body + shell + skin) * 1.3)

def bell(n, d=6.0, bright=1.0):
    """Church bell: hum, prime, minor third, fifth, nominal, and a few inharmonic upper partials."""
    t = tt(d); f = midi(n)
    parts = [(0.5, .45, 5.0), (1.0, 1.0, 3.6), (1.19, .5, 2.6), (1.5, .35, 2.2), (2.0, .6, 2.0), (2.74, .25 * bright, 1.0), (3.76, .14 * bright, .6), (5.4, .07 * bright, .35)]
    s = sum(a * np.sin(2 * np.pi * f * k * t + rng.uniform(0, 6)) * np.exp(-t / dec) for k, a, dec in parts) / 2.6
    s += bp(noise(d), 1500, 5000) * np.exp(-t / 0.01) * 0.08            # strike
    return s

def pluck(n, d=1.2, bright=2600):
    t = tt(d); f = midi(n); out = np.zeros_like(t)
    for h in range(1, 24):
        fh = f * h
        if fh > 8000: break
        out += (1 / h) / (1 + (fh / bright) ** 2) * np.sin(2 * np.pi * fh * t) * np.exp(-t * (2.2 + h * .35))
    return out * env(len(t), .002, .05)

def glass(n, d=1.2):
    t = tt(d); f = midi(n)
    return (np.sin(2 * np.pi * f * t) + .3 * np.sin(2 * np.pi * f * 2.01 * t) + .12 * np.sin(2 * np.pi * f * 3.98 * t)) * np.exp(-t / 0.32) * env(len(t), .002, .05)

def tick(f=5200, d=0.035):
    t = tt(d)
    return bp(noise(d), f * .7, min(f * 1.4, 15000)) * np.exp(-t / 0.006)

def keyclick():
    d = 0.045; t = tt(d); f = rng.uniform(1800, 3000)
    return (bp(noise(d), f * .6, f * 1.5) + 0.3 * lp(noise(d), 380)) * np.exp(-t / 0.005)

def crackle(d):
    out = np.zeros(int(d * SR))
    for _ in range(int(d * 9)):
        i = rng.integers(0, len(out) - 900)
        out[i:i + 900] += hp(noise(900 / SR), 1400) * np.exp(-np.arange(900) / 90) * rng.uniform(.2, 1)
    return out

def swell(d, lo=400, hi=6000):
    """Filtered-noise swell (reverse-cymbal feel) peaking at its end, band-limited to stay soft."""
    t = tt(d); x = noise(d)
    out = lp(bp(x, lo, hi), 7000)
    return out * (t / d) ** 2.6

def whoosh(d=0.8):
    t = tt(d)
    return lp(bp(noise(d), 300, 2600), 3500) * np.sin(np.pi * t / d) ** 2

def riser(d, f0, f1):
    t = tt(d)
    f = f0 * (f1 / f0) ** (t / d)
    tone = sum(np.sin(2 * np.pi * np.cumsum(f * k) / SR) / k for k in (1, 2, 3))
    return (tone * .5 + swell(d) * .8) * (t / d) ** 2.2

def sub(n, d, a=0.02, r=2.0):
    t = tt(d); f = midi(n)
    return np.sin(2 * np.pi * f * t) * env(len(t), a, r, 1.5)

def glitch(src_note, d=0.24):
    """Stutter: a bit-crushed synth fragment retriggered in 1/32s, plus a band-limited noise burst."""
    frag = arp_note(src_note, 0.05, 2600)
    out = np.zeros(int(d * SR)); step = int(BEAT / 8 * SR)
    for k in range(0, len(out) - len(frag), step):
        out[k:k + len(frag)] += frag * (1 - k / len(out))
    out = np.round(out * 6) / 6                                           # bit crush
    out += bp(noise(d), 900, 4800) * np.exp(-tt(d) / 0.05) * 0.5
    return out * env(len(out), .001, .04)

# ---------------------------------------------------------------- section helpers
def bar_of(t): return int(t // BAR)
S = {x['name']: (x['start'], x['end']) for x in CUES['sections']}
s_cold, s_awake, s_muster, s_appr = S['cold'], S['awaken'], S['muster'], S['approvals']
s_vm, s_next, s_end = S['vm'], S['next'], S['end']
vic = ev('victory')[0]
sil = ev('silence')[0]
fade_out = ev('fade_out')[0]; end = ev('end')[0]
silence = (sil, vic)                                           # one beat of near-silence
NEXT_B0, VIC_B = bar_of(s_next[0]), bar_of(vic)               # 31, 36

# ---------------------------------------------------------------- organ + choir bed, bar by bar
def bar_plan(k):
    """(ranks, mixture, organ gain, choir gain) for bar k."""
    t = b(k)
    if k < 2:   return (1,), 0.0, .10, .00
    if k < 4:   return (1, 2), 0.0, .17, .09                          # awaken
    if t < s_appr[0]: return (1, 2), 0.0, .15, .09                    # muster
    if k < NEXT_B0:                                                   # UI scenes: slowly fuller
        u = (t - s_appr[0]) / (s_next[0] - s_appr[0])
        return ((1, 2) if u < .3 else (1, 2, 4)), 0.0, .11 + .05 * u, .05 + .04 * u
    if k < VIC_B: return (1, 2), 0.0, .07, .0                          # next: cool and sparse
    if k == VIC_B: return (1, 2, 4), 0.7, .40, .30                     # the hit
    return (1, 2, 4), 0.35, .22, .16                                   # end card
for k in range(0, NBARS):
    ranks, mix, g, cg = bar_plan(k)
    root, upper, _ = CH[PROG[k]]
    t0 = b(k); last = (k == NBARS - 1)
    d = BAR + (3.5 if last else 0.5)
    notes = upper + [root + 12]
    if k < 2: notes = [m('D', 2) + 12, m('A', 2) + 12, m('D', 3) + 12]
    if NEXT_B0 <= k < VIC_B: notes = upper[1:]                          # cool: no low voices
    place(organ(notes, d, ranks, mix, attack=0.9 if k < 2 else (0.5 if NEXT_B0 <= k < VIC_B else 0.12),
                release=3.0 if last else 0.7), t0 - 0.02, g, 0, 0.55)
    if not (NEXT_B0 <= k < VIC_B):
        place(organ([root + 12], d, (1, 2), 0, attack=0.25, release=0.6), t0, g * 0.38, 0, 0.35)       # 8' pedal
        place(lp(organ([root], d, (1,), 0, attack=0.3, release=0.6), 220), t0, g * 0.16, 0, 0.2)      # quiet 16'
    if cg > 0:
        voc = FORMANTS_OO if k < 7 else FORMANTS_AH
        place(choir(upper[1:], d + 0.4, attack=0.7, release=1.0, vowel=voc), t0, cg * 1.8, 0, 0.75)
place(choir([m('D', 3), m('A', 3)], b(2) - b(1) + 1.0, attack=1.6, release=1.2, vowel=FORMANTS_OO), b(1), 0.09, 0, 0.8)

# ---------------------------------------------------------------- cold open
place(crackle(s_cold[1] + 1.0), 0.3, 0.10, 0, 0.2, 'fx')
for t1, n in zip([e['t'] for e in CUES['events'] if e['name'] == 'caption' and e['t'] < s_cold[1]], (m('D', 3), m('A', 2))):
    place(bell(n, 7, .5), t1, 0.24, 0, 0.7, 'fx')

# ---------------------------------------------------------------- awaken: the relic wakes
wake = s_awake[0]
place(swell(1.6, 300, 4000), wake - 1.6, 0.12, 0, 0.5, 'fx')
place(bell(m('D', 3), 8, .8), wake, 0.40, 0, 0.75, 'fx')
place(glass(m('D', 6), 2.0) + 0.5 * glass(m('A', 5), 2.0), wake, 0.12, 0, 0.7, 'fx')
place(war_drum(2.0, 130, 66, .7), wake, 0.40, 0, 0.4, 'drums')
for e in CUES['events']:
    if e['name'] == 'caption' and e['id'] == 'sub':
        place(bell(m('A', 3), 6, .6), e['t'], 0.26, 0.15, 0.7, 'fx')

# ---------------------------------------------------------------- muster
place(war_drum(1.8, 150, 66, .6), s_muster[0], 0.45, 0, 0.4, 'drums')
for e in CUES['events']:
    if e['name'] == 'relic_slot':
        place(bell(m('A', 4), 5, .9), e['t'], 0.28, 0, 0.7, 'fx')
        place(war_drum(1.8, 140, 66, .6), e['t'], 0.40, 0, 0.4, 'drums')
scale = [m(x, o) for x, o in (('D', 4), ('E', 4), ('F', 4), ('G', 4), ('A', 4), ('Bb', 4), ('C', 5), ('D', 5), ('E', 5), ('F', 5), ('G', 5), ('A', 5), ('D', 6))]
for i, tr in enumerate(ev('roster')):
    pn = -0.5 + (i % 4) / 3
    place(pluck(scale[min(i + 1, len(scale) - 1)], 1.4, 3000), tr, 0.17, pn, 0.5)
    place(tick(4200), tr, 0.09, pn, 0.15, 'fx')

# ---------------------------------------------------------------- UI scenes: arpeggio, pulse, ticks
def arp_cutoff(t):
    u = min(1, max(0, (t - s_appr[0]) / (s_next[0] - s_appr[0])))
    return 1300 + 5600 * u ** 1.5
def arp_gain(t):
    u = min(1, max(0, (t - s_appr[0]) / (s_next[0] - s_appr[0])))
    return 0.07 + 0.11 * u
t0 = s_appr[0]; k = 0
while t0 < s_next[0] - 1e-6:
    dense = t0 >= s_vm[0] - 10                                           # 16ths from the projects scene
    if dense or k % 2 == 0:
        cell = CH[PROG[bar_of(t0)]][2]
        n = cell[k % 4] + (12 if (k // 4) % 4 == 3 else 0)
        place(arp_note(n, BEAT / 2, arp_cutoff(t0)), t0, arp_gain(t0) * (1 if dense else 1.15), -0.35 if k % 2 else 0.35, 0.3)
    t0 += BEAT / 4; k += 1

kicks = []
t0 = s_muster[0]; k = 0
while t0 < s_next[0] - 1e-6:
    ui = t0 >= s_appr[0]
    u = min(1, max(0, (t0 - s_appr[0]) / (s_next[0] - s_appr[0])))
    if k % 8 == 0 or (ui and k % 8 == 4):
        place(kick(), t0, (0.34 + 0.22 * u) if ui else 0.30, 0, 0.12, 'drums'); kicks.append(t0)
    if ui and k % 8 == 7 and u > .55:
        place(kick(0.4, 120, 66, .12), t0, 0.16, 0, 0.1, 'drums')          # ghost
    if ui and k % 2 == 0:
        root = CH[PROG[bar_of(t0)]][0]
        place(lp(bass_note(root + 12, BEAT / 2 * 0.95), 900), t0, 0.12 + 0.05 * u, 0, 0.05)
    if ui and (k % 2 == 1 or u > .4):
        place(tick(9500 if k % 4 == 1 else 8000), t0, 0.05 + 0.06 * u, 0.4 if k % 2 else -0.4, 0.15, 'fx')
    t0 += BEAT / 4; k += 1

# captions: soft pluck; marks: soft bell; chips: confirm blip; cuts
cap_n = [m('A', 4), m('D', 5), m('F', 5), m('A', 5)]
ci = 0
for e in CUES['events']:
    if s_appr[0] <= e['t'] < s_next[0]:
        if e['name'] == 'caption':
            place(pluck(cap_n[ci % 4], 1.0, 2200), e['t'], 0.07, -0.2 + 0.4 * (ci % 2), 0.4); ci += 1
        elif e['name'] == 'mark':
            place(bell(m('D', 5) if ci % 2 else m('A', 4), 3.0, .5), e['t'], 0.10, 0.2, 0.55, 'fx')
        elif e['name'] == 'chip':
            place(glass(m('A', 6), 0.25), e['t'], 0.09, 0.25, 0.3, 'fx')
            place(glass(m('E', 7), 0.25), e['t'] + 0.07, 0.07, 0.25, 0.3, 'fx')
vl = ev('vox_line')
for i, tv in enumerate(vl):
    place(tick(2800 + 450 * i, 0.05) * 1.6, tv, 0.10, 0.1, 0.2, 'fx')
for tok in ev('vox_ok'):
    place(glass(m('A', 6), 0.25), tok, 0.10, 0.2, 0.3, 'fx')
    place(glass(m('E', 7), 0.25), tok + 0.07, 0.08, 0.2, 0.3, 'fx')
for ty in CUES['typing']:
    n = int(ty['chars']); a, z = ty['start'], ty['end']
    for c in range(n):
        place(keyclick(), a + (z - a) * (c + rng.uniform(-.3, .3)) / max(1, n), 0.07, rng.uniform(-.25, .25), 0.08, 'fx')
for c in CUES.get('cuts', []):
    if c['kind'] == 'hard' and c['t'] < vic - 1:
        place(glitch(m('D', 5)), c['t'] - 0.02, 0.20, 0, 0.12, 'fx')
    elif c['kind'] in ('dissolve', 'match') and c['t'] > 3:
        place(whoosh(0.9), c['t'] - 0.6, 0.05, 0, 0.35, 'fx')

# ---------------------------------------------------------------- next: cool, sparse
place(bell(m('D', 4), 7, .5), ev('next_head')[0], 0.14, 0, 0.7, 'fx')
npent = [m('A', 4), m('C', 5), m('D', 5), m('F', 5), m('G', 5), m('A', 5)]
for i, tn in enumerate(ev('next_card')):
    place(pluck(npent[i % len(npent)], 1.8, 2400), tn, 0.15, -0.3 + 0.12 * i, 0.55)
    place(glass(npent[i % len(npent)] + 12, 1.0), tn, 0.03, -0.3 + 0.12 * i, 0.7, 'fx')
for k in range(NEXT_B0, VIC_B, 2):
    place(bell(m('A', 3) if k % 4 == 1 else m('D', 4), 6, .4), b(k), 0.10, 0, 0.75, 'fx')

# reversed-reverb swell into the silence: a bell + choir chord, reverberated, flipped, ends at the gap
def cathedral_ir(d=4.2, predelay=0.03):
    t = tt(d); irs = []
    for ch in range(2):
        n = lp(rng.standard_normal(len(t)), 6000)
        ir = n * np.exp(-t / 1.05)
        ir[: int(predelay * SR)] = 0
        for _ in range(12):
            i = int((predelay + rng.uniform(0.008, 0.09)) * SR)
            ir[i] += rng.uniform(.3, .7) * (1 if rng.random() > .5 else -1)
        irs.append(ir / np.sqrt(np.sum(ir ** 2)))
    return irs
ir = cathedral_ir()
src_rv = bell(m('A', 3), 1.5, .6)[:int(1.2 * SR)] * 0.8 + choir([m('A', 3), m('E', 4), m('A', 4)], 1.2, attack=.02, release=.5)[:int(1.2 * SR)] * 0.7
src_rv = src_rv + 0.5 * swell(1.2, 300, 4500)[::-1]
rv_len = int(2.0 * SR)
for c in range(2):
    tail = fftconvolve(src_rv, ir[c])[:rv_len]
    tail /= np.max(np.abs(tail)) + 1e-9
    rvs = tail[::-1] * env(rv_len, .2, .015, 1.0)
    i0 = int((silence[0] - 0.02) * SR) - rv_len
    BUS['fx'][c, i0:i0 + rv_len] += rvs * 0.30
place(riser(sil - 3.0, 200, 1400), sil - 3.0, 0.05, 0, 0.3, 'fx')

# ---------------------------------------------------------------- victory: the tutti hit
place(war_drum(2.6, 170, 62, .9), vic, 0.80, 0, 0.4, 'drums')
place(kick(1.2, 130, 64, .5), vic, 0.5, 0, 0.1, 'drums')
place(sub(m('D', 2), 3.5, 0.005, 3.0), vic, 0.22, 0, 0.0, 'drums')            # sub only on the hit
place(bell(m('D', 3), 9, 1.0), vic, 0.45, 0, 0.75, 'fx')
place(bell(m('D', 4), 7, 0.8), vic + BEAT, 0.20, 0.2, 0.75, 'fx')
place(glass(m('D', 6), 2.0) + 0.5 * glass(m('F#', 6), 2.0), vic, 0.10, 0, 0.7, 'fx')
place(lp(swell(1.4, 300, 5000)[::-1], 6000), vic, 0.08, 0, 0.6, 'fx')

# ---------------------------------------------------------------- end card
wd, wf = ev('wm_draw')[0], ev('wm_fill')[0]
place(swell(wf - wd, 300, 4500), wd, 0.09, 0, 0.45, 'fx')
place(war_drum(2.2, 130, 66, .8), wf, 0.45, 0, 0.45, 'drums')
place(bell(m('A', 3), 6, 0.7), ev('tag')[0], 0.20, -0.2, 0.7, 'fx')
place(bell(m('F#', 4), 6, 0.6), ev('tag')[0] + BEAT, 0.12, 0.2, 0.7, 'fx')
place(bell(m('D', 4), 8, 0.8), ev('sigil')[0], 0.24, 0.1, 0.75, 'fx')
place(choir([m('D', 3), m('F#', 3), m('A', 3), m('D', 4)], end - b(NBARS - 1) + 1, attack=0.6, release=2.5), b(NBARS - 1), 0.20, 0, 0.8)

# ---------------------------------------------------------------- mix: sidechain, reverb, gap, arc, master
duck = np.ones(N)
for kt in kicks:
    i = int(kt * SR); n = int(0.22 * SR)
    if i + n < N: duck[i:i + n] = np.minimum(duck[i:i + n], 1 - 0.35 * np.exp(-np.arange(n) / (0.07 * SR)))
music = BUS['music'] * duck
drums = np.stack([hp(BUS['drums'][c], 45, 2) for c in range(2)]) * 0.42
fx = BUS['fx']
rev = np.stack([fftconvolve(WET[c], ir[c])[:N] for c in range(2)]) * 0.55
mix = music + drums + fx + rev
if os.environ.get('DUMP'): np.savez(os.path.join(os.environ['DUMP'], 'buses.npz'), music=music, drums=drums, fx=fx, rev=rev)
mix = np.stack([hp(mix[c], 38, 3) for c in range(2)])

# arc trim (dB per section, linear-interpolated at section midpoints) set from measurements
TRIM = {'cold': 0, 'awaken': -1.5, 'muster': 0.5, 'approvals': 2.2, 'rooms': 2.0, 'library': 1.5, 'projects': 0.8,
        'vm': 0, 'bsv': 0, 'blender': 0, 'install': 0, 'next': 3.5, 'end': 0}
TRIM.update(json.loads(os.environ.get('TRIM', '{}')))
xs = [(x['start'] + x['end']) / 2 for x in CUES['sections']]
ys = [TRIM[x['name']] for x in CUES['sections']]
tgrid = np.arange(N) / SR
trim = 10 ** (np.interp(tgrid, [0] + xs + [DUR], [ys[0]] + ys + [ys[-1]]) / 20)
trim[int(vic * SR):] = 1.0                                                   # the hit and end card stay untouched
mix = mix * trim

# one beat of near-silence: gate everything (reverb tails too) with short ramps, hit lands on the first sample
gap = np.ones(N)
i0, i1 = int(silence[0] * SR), int(vic * SR)
r0 = int(0.02 * SR)
gap[i0 - r0:i0] = np.linspace(1, 0.0015, r0); gap[i0:i1] = 0.0015
mix = mix * gap

n_end = int(end * SR)
fade = np.ones(N)
f0 = int(fade_out * SR)
fade[f0:n_end] = np.linspace(1, 0, n_end - f0) ** 1.4
fade[n_end:] = 0
fi = int(0.2 * SR); fade[:fi] *= np.linspace(0, 1, fi)
mix = (mix * fade)[:, :n_end]
mix -= mix.mean(axis=1, keepdims=True)
peak = np.max(np.abs(mix))
mix = np.tanh(mix / peak * 1.25) / np.tanh(1.25) * 0.89

from scipy.io import wavfile
out = os.path.join(HERE, 'score.wav')
wavfile.write(out, SR, mix.T.astype(np.float32))
print('wrote', out, f'{mix.shape[1] / SR:.2f}s')
