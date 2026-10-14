/* Legion "lore" sound packs, round 3. Original synthesis, no samples. Built to lore/SOUND-BRIEF.md.
   forge     iron-plate strikes + relay body, in a short iron chamber (feedback-delay space, RT60 0.3 s).
   reliquary hand-bell strikes + a low toll, in a small stone hall (feedback-delay space, RT60 0.75 s).
   One key for both packs: D (D, F, A, C). One attack shape: 2-4 ms raised-cosine strike, exponential decay,
   cosine release (never a hard cut). Recipes are plain data; LORE.render(pack,cue,sr) returns
   {left,right,sampleRate,duration,peak} like uisfx.renderRecipe. */
(function (g) {
  var TAU = Math.PI * 2;
  function hash(s) { var a = 2166136261; for (var i = 0; i < s.length; i++) { a ^= s.charCodeAt(i); a = Math.imul(a, 16777619); } return a >>> 0; }
  function rng(seed) { var a = seed >>> 0; return function () { a += 1831565813; var n = a; n = Math.imul(n ^ n >>> 15, n | 1); n ^= n + Math.imul(n ^ n >>> 7, n | 61); return ((n ^ n >>> 14) >>> 0) / 4294967296; }; }

  // partial tables: [ratio, amplitude, decay multiplier]
  var IRON = [[1, 1, 1], [2, .3, .5], [2.756, .3, .4], [5.404, .12, .2], [8.933, .05, .1]];     // struck iron bar: free-bar mode ratios, octave anchors the pitch
  var BELL = [[.5, .25, 1.4], [1, 1, 1], [1.002, .3, 1.2], [1.183, .45, .8], [1.506, .25, .6], [2, .35, .5], [2.514, .12, .3], [2.662, .08, .25], [3.011, .06, .2], [4.166, .03, .1]]; // bronze hand bell: slow beating pair, minor-third tierce
  var SOFT = [[1, 1, 1], [2, .15, .5], [3, .04, .3]];
  var HUM = [[1, 1, 1], [2, .5, .8], [3, .25, .6], [4, .12, .5]];                               // band-limited buzz, saturated softly

  function T(t, len, f, dec, g, parts, o) { var l = { k: 'tone', t: t, len: len, f: f, dec: dec, g: g, parts: parts }; for (var x in o) l[x] = o[x]; return l; }
  function N(t, len, fc, q, g, dec, o) { var l = { k: 'noise', type: 'bp', t: t, len: len, fc: fc, q: q, g: g, dec: dec }; for (var x in o) l[x] = o[x]; return l; }
  function H(t, f0, f1, dec, g, o) { var l = { k: 'thud', t: t, f0: f0, f1: f1, dec: dec, g: g }; for (var x in o) l[x] = o[x]; return l; }
  function flat(arr) { var o = []; arr.forEach(function (x) { if (Array.isArray(x)) o = o.concat(x); else o.push(x); }); return o; }
  // relay clunk: soft low body plus a dull band-passed knock (nothing above 1.5 kHz)
  function CL(t, g) { return [H(t, 120, 55, .05, g), N(t, .03, 1300, 1.2, g * .5, .01, { att: .002 })]; }
  // servo tick: tiny band-passed noise burst, low-passed by the band itself
  function TK(t, fc, g) { return N(t, .02, fc, 3, g, .005, { att: .0015 }); }

  // strike transient: a 12 ms band-passed tick under a struck note (richer attack, nothing above ~1.4 kHz)
  function S(t, f, g) { return N(t, .012, Math.min(1400, f * 2.2), 2.5, g, .004, { att: .0015 }); }
  // vox-caster chant: a short burst of tiny chirps, bit 1 = D5, bit 0 = A4 (the key's own notes), band-limited by the low-pass
  function CH_(t, bits, g) { // humanised: fixed per-chirp timing (+-3 ms), pitch (+-1.2%) and level (+-15%) offsets so it sounds spoken, not sequenced
    var JT = [.002, -.003, .003, -.001, .002], JF = [1.006, .994, 1.01, .99, 1.004], JG = [1, .85, 1.1, .9, 1], a = [], i;
    for (i = 0; i < bits.length; i++) a.push(T(t + i * .034 + JT[i % 5], .026, (bits[i] === '1' ? 587.3 : 440) * JF[i % 5], .012, g * JG[i % 5], SOFT, { att: .003, lp: 1600, pan: i % 2 ? .12 : -.12 }));
    return a;
  }
  // choir-like pad: two slightly detuned voices, partials weighted by an "ah" vowel (formants near 700 and 1100 Hz)
  function CHOIR(t, len, f, g, o) {
    var parts = [], k, m = 0; for (k = 1; k <= 8; k++) { var fk = f * k, a = Math.exp(-Math.pow((fk - 700) / 280, 2)) + .6 * Math.exp(-Math.pow((fk - 1100) / 320, 2)) + (k === 1 ? .35 : .02); parts.push([k, a, 1]); m = Math.max(m, a); }
    parts.forEach(function (p) { p[1] /= m; });
    var oo = { att: .05, lp: 1500 }; for (var x in o) oo[x] = o[x];
    var o1 = {}, o2 = {}; for (var y in oo) { o1[y] = oo[y]; o2[y] = oo[y]; } o1.pan = -.3; o2.pan = .3;
    return [T(t, len, f * 1.004, len * .4, g * .5, parts, o1), T(t, len, f / 1.004, len * .4, g * .5, parts, o2)];
  }
  // level per cue in dB against the attention cue (RMS over the cue's active window; see render)
  var LOUD = { notification: -12.5, complete: -16, error: -16.5, blocked: -17.5, queued: -18, success: -20, cancel: -21, check: -22, deselect: -22 };
  var SEND = { notification: .30, error: .1, complete: .1, queued: .04, cancel: .02, success: .015, check: .01, deselect: .01, blocked: .012 };
  var CUE_LP = { notification: 4500, error: 1800, complete: 2600, queued: 1800, cancel: 1800, success: 1800, check: 1800, deselect: 1800, blocked: 1500 };

  // ---------- spaces: 4 damped combs + 2 allpasses per channel, fed mono. Same room for every cue of a pack.
  var SPACE = {
    forge: { pre: .006, rt: .3, damp: 5200, L: [.0097, .0131, .0169, .0193], R: [.0107, .0143, .0157, .0211] },     // iron chamber: tight, bright, metallic
    reliquary: { pre: .014, rt: .75, damp: 3200, L: [.0297, .0371, .0411, .0437], R: [.0313, .0353, .0427, .0461] }  // small stone hall: longer, dark
  };

  var R = { forge: {}, reliquary: {} };
  var F = R.forge, B = R.reliquary;

  // ---------- Forge: forge-temple machinery. Iron-plate strikes and relay bodies, a vox-caster, servo motors.
  // The only sub-bass is notification and error. Meanings follow the order's world (Marshal, Forgemaster, Herald...).
  F.notification = flat([                                       // vox-caster hail: binary chant, then an iron bell calls twice (rising fifth)
    CH_(0, '1011', .35),
    T(.13, .5, 293.7, .17, .9, IRON, { pan: -.18 }), S(.13, 293.7, .25),   // D4
    T(.33, .62, 440, .2, .8, IRON, { pan: .18 }), S(.33, 440, .22),        // A4
    T(.1, .7, 73.4, .5, .28, HUM, { att: .12, lp: 300, sat: 1.5 })   // D2 hum of the machine waking: weight
  ]);
  F.complete = flat([                                           // a cogitator finishes its rite: three ticks climb, relay settles, consonant ring
    TK(0, 1100, .4), TK(.075, 1300, .4), TK(.15, 1500, .4),
    T(0, .2, 293.7, .06, .7, IRON, { pan: -.2 }), T(.075, .2, 440, .06, .7, IRON),
    CL(.15, .3),
    T(.15, .4, 587.3, .12, .9, IRON, { pan: .2 })
  ]);
  F.error = flat([                                              // a machine spirit's discontent: low, dull growl, falling minor third. No grind
    H(0, 120, 73.4, .2, .8),
    T(0, .36, 174.6, .12, .7, IRON, { lp: 900, sat: 1.4 }),          // F3
    T(.13, .42, 146.8, .14, .85, IRON, { lp: 900, sat: 1.4 }),       // D3 (falls)
    T(0, .4, 73.4, .2, .35, HUM, { lp: 400, sat: 1.4, am: [26, .35], att: .02 }),
    N(0, .1, 500, 1, .2, .04, { att: .003 })
  ]);
  F.success = flat([                                            // Allow: a seal pressed, an iron latch drops. One stamped note
    H(0, 140, 80, .025, .5), N(0, .02, 1200, 1.5, .3, .008, { att: .002 }),
    T(.002, .11, 440, .035, .8, IRON)
  ]);
  F.cancel = flat([                                             // Deny: a gate shuts. Servo spin-down, a falling fifth, a soft bar thud
    T(0, .13, 440, .05, .6, HUM, { lp: 1400, glide: -7, gt: .1, sat: 1.3, att: .004 }),
    H(.09, 100, 60, .03, .3)
  ]);
  F.blocked = flat([                                            // refused: the barred gate, two dull knocks on one pitch, no ring
    H(0, 110, 70, .045, 1), H(.07, 110, 70, .05, 1),
    T(0, .08, 146.8, .03, .4, HUM, { lp: 700, sat: 1.3 }), T(.07, .09, 146.8, .03, .4, HUM, { lp: 700, sat: 1.3 }),
    N(0, .03, 700, 1.5, .2, .012, { att: .002 }), N(.07, .03, 700, 1.5, .2, .012, { att: .002 })
  ]);
  F.check = flat([                                              // lever thrown on: two tiny strikes, D5 to A5
    TK(0, 900, .2),
    T(0, .06, 587.3, .02, .6, IRON, { att: .002 }), T(.026, .08, 880, .025, .7, IRON, { att: .002 })
  ]);
  F.deselect = flat([                                           // lever thrown off: the same, falling
    TK(0, 900, .2),
    T(0, .06, 880, .02, .6, IRON, { att: .002 }), T(.026, .08, 587.3, .025, .7, IRON, { att: .002 })
  ]);
  F.queued = flat([                                             // servo wake: two ticks, a low motor rising D3 to A3
    TK(0, 900, .5), TK(.05, 1200, .5),
    T(.08, .22, 146.8, .09, .7, HUM, { att: .03, lp: 600, glide: 7, gt: .18, sat: 1.3 })
  ]);

  // ---------- Reliquary: a sacred hall. Hand bells, a low toll, a choir-like pad. Same key, same shapes.
  B.notification = flat([                                       // the hall calls: a bell, an answering bell a fifth up, a breath of choir under them
    TK(0, 1400, .1),
    CHOIR(0, .8, 293.7, .35, { att: .07 }), CHOIR(.02, .8, 440, .28, { att: .07 }),   // open fifth D4 + A4
    T(0, .9, 146.8, .35, .4, BELL, { lp: 900 }),                     // low toll D3 (weight)
    T(0, .55, 587.3, .18, .8, BELL, { pan: -.2 }), S(0, 587.3, .12),     // D5
    T(.22, .7, 880, .22, .7, BELL, { pan: .2 }), S(.22, 880, .1)         // A5
  ]);
  B.complete = flat([                                           // the litany ends: three bells climb and a short choir breath settles
    T(0, .2, 293.7, .06, .7, BELL, { pan: -.2 }), S(0, 293.7, .12), T(.09, .2, 440, .06, .7, BELL), T(.18, .38, 587.3, .115, .85, BELL, { pan: .2 }),
    CHOIR(.18, .3, 293.7, .22, { att: .04 })
  ]);
  B.error = flat([                                              // the choir drops a minor third and the low bell tolls twice: displeasure, not alarm
    H(0, 100, 73.4, .16, .6),
    T(0, .4, 174.6, .12, .8, BELL, { lp: 700 }),                     // F3
    T(.14, .42, 146.8, .13, 1, BELL, { lp: 700 }),                    // D3 (falls)
    CHOIR(0, .45, 146.8, .2, { lp: 600, att: .04 })
  ]);
  B.success = flat([                                            // Allow: a wax seal pressed, one small bell tap
    H(0, 110, 70, .02, .3),
    T(0, .11, 440, .035, .8, BELL, { lp: 2200 })
  ]);
  B.cancel = flat([                                             // Deny: a reliquary door closes. Falling fifth, a soft thud
    T(0, .1, 440, .04, .6, BELL, { lp: 1500 }),
    T(.07, .1, 293.7, .04, .6, BELL, { lp: 1400 }),
    H(.07, 90, 60, .03, .25)
  ]);
  B.blocked = flat([                                            // refused: two muffled knocks on the barred door
    H(0, 90, 60, .04, .4), H(.075, 90, 60, .04, .4),
    T(0, .07, 146.8, .025, .9, BELL, { lp: 600 }), T(.075, .09, 146.8, .03, .9, BELL, { lp: 600 })
  ]);
  B.check = flat([                                              // a reliquary lever, on: wooden tick, small bells rising
    TK(0, 700, .12),
    T(0, .06, 587.3, .02, .6, BELL, { att: .002 }), T(.028, .08, 880, .025, .7, BELL, { att: .002 })
  ]);
  B.deselect = flat([                                           // the lever, off: falling
    TK(0, 700, .12),
    T(0, .06, 880, .02, .6, BELL, { att: .002 }), T(.028, .08, 587.3, .025, .7, BELL, { att: .002 })
  ]);
  B.queued = flat([                                             // a censer's hum wakes: low choir fifth D3 to A3, no strike
    CHOIR(0, .25, 146.8, .5, { att: .04, lp: 700 }), CHOIR(.08, .25, 220, .5, { att: .04, lp: 700 })
  ]);

  // ---------- renderer
  function addS(b, i, v, pl, pr) { if (i < 0 || i >= b.n) return; b.L[i] += v * pl; b.R[i] += v * pr; }
  function pans(p) { return [Math.cos((p + 1) * Math.PI / 4), Math.sin((p + 1) * Math.PI / 4)]; }
  function ramp(x, att) { return x < att ? .5 - .5 * Math.cos(Math.PI * x / att) : 1; }   // raised-cosine attack

  function tone(b, l) {
    var sr = b.sr, s0 = Math.round(l.t * sr), n = Math.round(l.len * sr), att = Math.max(.002, l.att || .003), gl = l.glide || 0, gt = l.gt || l.len,
      ph = 0, lp = 0, lpA = l.lp ? 1 - Math.exp(-TAU * l.lp / sr) : 1, pp = pans(l.pan || 0), relN = Math.max(2, Math.round(Math.min(.06, l.len * .3) * sr)),
      am = l.am || 0, sat = l.sat || 0, satN = sat ? 1 / Math.tanh(sat) : 1, parts = l.parts;
    for (var i = 0; i < n; i++) {
      var x = i / sr, fr = l.f * Math.pow(2, gl / 12 * Math.min(1, x / gt)); ph += TAU * fr / sr;
      var v = 0;
      for (var j = 0; j < parts.length; j++) { var pt = parts[j]; if (fr * pt[0] > sr * .45) continue; v += Math.sin(ph * pt[0]) * pt[1] * Math.exp(-x / (l.dec * pt[2])); }
      if (sat) v = Math.tanh(v * sat) * satN;                                     // soft saturation, then the low-pass tames what it made
      v *= ramp(x, att) * (n - i < relN ? .5 - .5 * Math.cos(Math.PI * (n - i) / relN) : 1) * l.g;
      if (am) v *= 1 - am[1] + am[1] * (.5 + .5 * Math.sin(TAU * am[0] * x));
      if (lpA < 1) { lp += (v - lp) * lpA; v = lp; }
      addS(b, s0 + i, v, pp[0], pp[1]);
    }
  }
  function noise(b, l) { // state-variable filtered noise, never raw
    var sr = b.sr, s0 = Math.round(l.t * sr), n = Math.round(l.len * sr), att = Math.max(.0015, l.att || .0015), pp = pans(l.pan || 0), r = b.rnd,
      lo = 0, bd = 0, q = 1 / (l.q || 1), relN = Math.max(2, Math.round(Math.min(.01, l.len / 3) * sr)),
      f = 2 * Math.sin(Math.PI * Math.min(l.fc, sr * .24) / sr);
    for (var i = 0; i < n; i++) {
      var x = i / sr, w = r() * 2 - 1, hi = w - lo - q * bd; bd += f * hi; lo += f * bd;
      var v = (l.type === 'lp' ? lo : bd * Math.sqrt(q)) * ramp(x, att) * Math.exp(-x / l.dec) * (n - i < relN ? .5 - .5 * Math.cos(Math.PI * (n - i) / relN) : 1) * l.g;
      addS(b, s0 + i, v, pp[0], pp[1]);
    }
  }
  function thud(b, l) { // sine body with a fast pitch drop, softly saturated
    var sr = b.sr, s0 = Math.round(l.t * sr), len = l.len || l.dec * 3, n = Math.round(len * sr), pk = l.pk || .02, ph = 0, pp = pans(l.pan || 0), relN = Math.max(2, Math.round(Math.min(.03, len * .3) * sr));
    for (var i = 0; i < n; i++) {
      var x = i / sr, f = l.f1 + (l.f0 - l.f1) * Math.exp(-x / pk); ph += TAU * f / sr;
      var v = Math.tanh(Math.sin(ph) * 1.4) * ramp(x, .003) * Math.exp(-x / l.dec) * (n - i < relN ? .5 - .5 * Math.cos(Math.PI * (n - i) / relN) : 1) * l.g;
      addS(b, s0 + i, v, pp[0], pp[1]);
    }
  }
  function lowpass2(a, sr, fc) { var k = 1 - Math.exp(-TAU * fc / sr), s1 = 0, s2 = 0; for (var i = 0; i < a.length; i++) { s1 += (a[i] - s1) * k; s2 += (s1 - s2) * k; a[i] = s2; } }
  function space(inp, out, sr, S, send, n) { // out += reverb(inp)
    var pre = Math.round(S.pre * sr), damp = 1 - Math.exp(-TAU * S.damp / sr);
    [S.L, S.R].forEach(function (set, ch) {
      var dst = out[ch], combs = set.map(function (d) { var len = Math.round(d * sr); return { buf: new Float32Array(len), len: len, pos: 0, lp: 0, g: Math.pow(10, -3 * d / S.rt) }; });
      var ap = [Math.round((ch ? .0043 : .0051) * sr), Math.round((ch ? .0014 : .0017) * sr)].map(function (len) { return { buf: new Float32Array(len), len: len, pos: 0 }; });
      for (var i = 0; i < n; i++) {
        var x = i >= pre ? inp[i - pre] * send : 0, y = 0;
        for (var c = 0; c < 4; c++) {
          var cb = combs[c], d = cb.buf[cb.pos]; cb.lp += (d - cb.lp) * damp;
          cb.buf[cb.pos] = x + cb.lp * cb.g; cb.pos = (cb.pos + 1) % cb.len; y += d;
        }
        y *= .5;
        for (var a = 0; a < 2; a++) { var A = ap[a], z = A.buf[A.pos]; A.buf[A.pos] = y + z * .5; y = z - y * .5; A.pos = (A.pos + 1) % A.len; }
        dst[i] += y;
      }
    });
  }
  // loudness = loudest 150 ms RMS (momentary), 10 ms hop
  function analyse(L, R, sr) {
    var win = Math.round(.15 * sr), hop = Math.round(.01 * sr), n = L.length, best = 0, j, ss;
    for (var st = 0; st < Math.max(1, n - win + hop); st += hop) { ss = 0; var e = Math.min(n, st + win); for (j = st; j < e; j++) ss += (L[j] * L[j] + R[j] * R[j]) / 2; best = Math.max(best, Math.sqrt(ss / win)); }
    return { rms: best };
  }
  var PEAK_CAP = .7; // -3.1 dBFS; peaks are soft-clipped under it

  function render(pack, cue, sr) {
    sr = sr || 44100;
    var layers = R[pack] && R[pack][cue]; if (!layers) throw new Error('Unknown lore cue: ' + pack + '/' + cue);
    var S = SPACE[pack], send = SEND[cue], end = 0, i;
    layers.forEach(function (l) { end = Math.max(end, l.t + (l.len || l.dec * 3)); });
    var tail = Math.min(S.rt * .9, .03 + send * 2.4);
    var n = Math.ceil((end + tail) * sr);
    var b = { sr: sr, n: n, L: new Float32Array(n), R: new Float32Array(n), rnd: rng(hash(pack + ':' + cue)) };
    layers.forEach(function (l) { (l.k === 'tone' ? tone : l.k === 'noise' ? noise : thud)(b, l); });
    lowpass2(b.L, sr, CUE_LP[cue]); lowpass2(b.R, sr, CUE_LP[cue]);          // keeps 2-5 kHz out of frequent cues
    var mono = new Float32Array(n); for (i = 0; i < n; i++) mono[i] = (b.L[i] + b.R[i]) / 2;
    space(mono, [b.L, b.R], sr, S, send * 2, n);
    var fade = Math.min(n, Math.round(.04 * sr));                             // final raised-cosine fade: ends at exactly zero
    for (i = 0; i < fade; i++) { var w = .5 + .5 * Math.cos(Math.PI * (i + 1) / fade); b.L[n - fade + i] *= w; b.R[n - fade + i] *= w; }
    var tgt = Math.pow(10, LOUD[cue] / 20), k = tgt / analyse(b.L, b.R, sr).rms, L2, R2, pk = 0;
    for (var it = 0; it < 10; it++) { // soft-clip under the peak cap, nudge the gain until the loudest 150 ms hits the target
      L2 = new Float32Array(n); R2 = new Float32Array(n);
      for (i = 0; i < n; i++) { L2[i] = PEAK_CAP * Math.tanh(b.L[i] * k / PEAK_CAP); R2[i] = PEAK_CAP * Math.tanh(b.R[i] * k / PEAK_CAP); }
      var got = analyse(L2, R2, sr).rms; if (Math.abs(got / tgt - 1) < .01) break; k *= tgt / got;
    }
    for (i = 0; i < n; i++) { if (!isFinite(L2[i]) || !isFinite(R2[i])) { L2[i] = 0; R2[i] = 0; } pk = Math.max(pk, Math.abs(L2[i]), Math.abs(R2[i])); }
    return { sampleRate: sr, duration: n / sr, left: L2, right: R2, peak: pk };
  }
  g.LORE = { packs: ['forge', 'reliquary'], cues: Object.keys(F), recipes: R, render: render, has: function (p, c) { return !!(R[p] && R[p][c]); }, level: LOUD };
})(typeof window !== 'undefined' ? window : globalThis);
