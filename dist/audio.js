'use strict';
/*
 * 一念 · 声音引擎
 * 所有声音都在浏览器里实时合成，不依赖录音文件：
 *   - 法器（木鱼、磬、引磬、法鼓、颂钵、梵钟…）用模态合成预先算成采样；
 *   - 伴乐（空山、梵音、晨钟）是由同一个节拍时钟驱动的生成式乐段；
 *   - 殿堂混响用程序生成的脉冲响应。
 * 调式：D 羽调五声（D F G A C）。
 */
(function () {
  const TAU = Math.PI * 2;
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = list => list[Math.floor(Math.random() * list.length)];
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  let ctx = null, sr = 48000;
  let out, limiter, sfxBus, musicBus, ambBus, reverbIn, analyser;
  const buf = {};
  const cache = new Map();
  const levels = { music: .6, sfx: .8, amb: .5 };

  /* ---------- 初始化与总线 ---------- */

  function init() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return true;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC({ latencyHint: 'interactive' });
    sr = ctx.sampleRate;

    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 6;
    limiter.attack.value = .003;
    limiter.release.value = .25;
    out = ctx.createGain();
    out.gain.value = .9;
    out.connect(limiter);
    limiter.connect(ctx.destination);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    limiter.connect(analyser);

    const reverb = ctx.createConvolver();
    reverb.buffer = hallImpulse(5.5, 2.6);
    reverbIn = ctx.createGain();
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = .85;
    reverbIn.connect(reverb);
    reverb.connect(reverbOut);
    reverbOut.connect(out);

    sfxBus = makeBus(levels.sfx, .3);
    musicBus = makeBus(levels.music, .55);
    ambBus = makeBus(levels.amb, .06);
    buildSamples();
    return true;
  }

  function makeBus(level, send) {
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(out);
    const s = ctx.createGain();
    s.gain.value = send;
    g.connect(s);
    s.connect(reverbIn);
    return g;
  }

  // 殿堂混响：立体声衰减噪声，尾音逐渐变暗
  function hallImpulse(seconds, curve) {
    const len = Math.floor(sr * seconds), b = ctx.createBuffer(2, len, sr);
    const pre = Math.floor(sr * .018);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const t = (i - pre) / (len - pre);
        const k = .8 - .7 * t;
        lp += k * ((Math.random() * 2 - 1) - lp);
        const fadeIn = Math.min(1, (i - pre) / (sr * .01));
        d[i] = lp * Math.pow(1 - t, curve) * fadeIn;
      }
    }
    return b;
  }

  /* ---------- 采样合成工具 ---------- */

  function render(seconds, fill, peak = .9) {
    const len = Math.ceil(sr * seconds), b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
    fill(d, len);
    normalize(d, peak);
    return b;
  }

  function normalize(d, peak) {
    let m = 0;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
    if (m) for (let i = 0; i < d.length; i++) d[i] *= peak / m;
  }

  // 衰减正弦模态：用二阶谐振递推代替逐点 sin，计算很快
  function addModes(d, len, modes, attack = 0) {
    for (const [f, amp, decay] of modes) {
      if (f >= sr / 2) continue;
      const w = TAU * f / sr, r = Math.exp(-1 / (decay * sr));
      const a1 = 2 * r * Math.cos(w), a2 = r * r;
      let y1 = 0, y2 = 0;
      for (let i = 0; i < len; i++) {
        const y = (i === 0 ? amp * Math.sin(w) : 0) + a1 * y1 - a2 * y2;
        d[i] += y;
        y2 = y1;
        y1 = y;
      }
    }
    if (attack) for (let i = 0; i < len; i++) d[i] *= 1 - Math.exp(-i / (attack * sr));
  }

  // 带通噪声瞬态（击打的“咔”声）
  function addNoise(d, len, amp, tau, lo, hi, offset = 0) {
    const a = 1 - Math.exp(-TAU * hi / sr), b = 1 - Math.exp(-TAU * lo / sr);
    const n = Math.min(len - offset, Math.floor(tau * sr * 8));
    let l1 = 0, l2 = 0;
    for (let i = 0; i < n; i++) {
      const x = (Math.random() * 2 - 1) * amp * Math.exp(-i / (tau * sr));
      l1 += a * (x - l1);
      l2 += b * (l1 - l2);
      d[i + offset] += l1 - l2;
    }
  }

  // 每个分音加一个微微失谐的“孪生”分音，产生铜器特有的拍频
  function doublets(f, partials, split) {
    const modes = [];
    for (const [ratio, amp, decay] of partials) {
      modes.push([f * ratio, amp, decay]);
      modes.push([f * ratio * (1 + split), amp * .7, decay * .95]);
    }
    return modes;
  }

  function buildSamples() {
    // 木鱼：空腔木头，短促而有“笃”的音高
    buf.muyu = render(.7, (d, n) => {
      addModes(d, n, [[640, 1, .15], [1012, .32, .06], [1690, .18, .04], [2530, .09, .025], [212, .3, .05]], .0006);
      addNoise(d, n, .7, .004, 900, 5200);
    });
    // 念珠：两颗木珠相碰
    buf.bead = render(.16, (d, n) => {
      const click = (offset, gain) => {
        const tmp = new Float32Array(n);
        addModes(tmp, n, [[2350, 1, .012], [3900, .5, .007], [5600, .25, .004], [1150, .35, .016]], .0002);
        addNoise(tmp, n, .6, .0015, 1500, 8000);
        const o = Math.floor(offset * sr);
        for (let i = 0; i + o < n; i++) d[i + o] += tmp[i] * gain;
      };
      click(0, 1);
      click(.022, .38);
    });
    // 转经轮：一阵柔和的风声
    buf.whoosh = render(1.1, (d, n) => {
      let l1 = 0, l2 = 0;
      const a = 1 - Math.exp(-TAU * 1500 / sr), b = 1 - Math.exp(-TAU * 260 / sr);
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const env = (1 - Math.exp(-t / .09)) * Math.exp(-t / .32);
        l1 += a * ((Math.random() * 2 - 1) - l1);
        l2 += b * (l1 - l2);
        d[i] = (l1 - l2) * env;
      }
    }, .6);
    // 大磬：碗形铜磬，D4
    buf.qing = render(9, (d, n) => {
      addModes(d, n, doublets(293.66, [[1, 1, 7.5], [2.72, .5, 3.8], [5.04, .28, 2], [7.9, .12, 1], [11.3, .05, .5]], .0021), .0012);
      addNoise(d, n, .2, .003, 2000, 9000);
    });
    // 引磬：小而清亮，D6
    buf.ling = render(4, (d, n) => {
      addModes(d, n, doublets(1174.66, [[1, 1, 2.6], [2.32, .42, 1.3], [3.96, .22, .6], [5.9, .09, .3]], .0013), .0005);
      addNoise(d, n, .25, .0015, 3000, 12000);
    });
    // 法鼓：低沉的皮鼓，音高迅速下滑
    buf.drum = render(1.8, (d, n) => {
      let p1 = 0, p2 = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, f = 56 + 48 * Math.exp(-t / .035);
        p1 += TAU * f / sr;
        p2 += TAU * f * 1.52 / sr;
        d[i] = (Math.sin(p1) * Math.exp(-t / .5) + .28 * Math.sin(p2) * Math.exp(-t / .16)) * (1 - Math.exp(-t / .0015));
      }
      addNoise(d, n, .5, .012, 60, 700);
      addNoise(d, n, .15, .003, 800, 4000);
    });
    // 颂钵：软槌轻击，G3
    buf.bowl = render(11, (d, n) => {
      addModes(d, n, doublets(196, [[1, 1, 9], [2.81, .45, 4.5], [5.2, .18, 2.2], [8.1, .07, 1]], .0016), .012);
    });
    // 梵钟：撞木击大钟，打击音 D3，嗡音 D2
    buf.bell = render(14, (d, n) => {
      const f = 146.83;
      addModes(d, n, [
        [f * .5, .8, 13], [f * .5 * 1.003, .55, 12.5],
        [f, 1, 9], [f * 1.0035, .7, 8.5],
        [f * 1.19, .42, 6.5], [f * 1.5, .3, 5], [f * 2, .38, 4], [f * 2.004, .28, 3.8],
        [f * 2.52, .17, 2.6], [f * 3.01, .14, 2], [f * 4.1, .07, 1.3], [f * 5.3, .04, .9]
      ], .004);
      addNoise(d, n, .45, .03, 40, 400);
    });
    // 风铃：五声高音
    buf.chimes = [86, 89, 91, 93, 96].map(m => render(3, (d, n) => {
      const f = mtof(m);
      addModes(d, n, [[f, 1, 1.4], [f * 2.76, .35, .45], [f * 5.4, .12, .18]], .0003);
    }, .7));
  }

  // 古琴：Karplus–Strong 拨弦，按音高缓存
  function qin(m) {
    const key = 'qin' + m;
    if (cache.has(key)) return cache.get(key);
    const f = mtof(m), P = Math.max(2, Math.round(sr / f - .5)), fReal = sr / (P + .5);
    const len = Math.floor(sr * 6), b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
    const exc = new Float32Array(P);
    let lp = 0, mean = 0;
    for (let i = 0; i < P; i++) {
      lp += .45 * ((Math.random() * 2 - 1) - lp);
      exc[i] = lp;
      mean += lp / P;
    }
    const T60 = 3.6 + (72 - m) * .07;
    const g = Math.pow(.001, 1 / (fReal * T60));
    for (let i = 0; i < len; i++) {
      const a = i >= P ? d[i - P] : 0, c = i > P ? d[i - P - 1] : 0;
      d[i] = (i < P ? exc[i] - mean : 0) + g * .5 * (a + c);
    }
    for (let i = 0; i < 64 && i < len; i++) d[i] *= i / 64;
    normalize(d, .8);
    const note = { b, rate: f / fReal };
    cache.set(key, note);
    return note;
  }

  // 古琴泛音：清亮如钟
  function harmonic(m) {
    const key = 'fan' + m;
    if (!cache.has(key)) {
      const f = mtof(m);
      cache.set(key, render(4, (d, n) => {
        addModes(d, n, [[f, 1, 1.7], [f * 2, .22, .8], [f * 3, .07, .4]], .0015);
        addNoise(d, n, .05, .002, 1000, 6000);
      }, .7));
    }
    return cache.get(key);
  }

  // 环境噪声：可无缝循环的立体声
  function noise(kind) {
    const key = 'noise-' + kind;
    if (cache.has(key)) return cache.get(key);
    const len = Math.floor(sr * 9), fade = Math.floor(sr * .5);
    const b = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const raw = new Float32Array(len + fade);
      let b0 = 0, b1 = 0, b2 = 0, brown = 0;
      for (let i = 0; i < raw.length; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'brown') {
          brown = (brown + .02 * w) / 1.02;
          raw[i] = brown * 3.5;
        } else if (kind === 'pink') {
          b0 = .99765 * b0 + w * .099046;
          b1 = .963 * b1 + w * .2965164;
          b2 = .57 * b2 + w * 1.0526913;
          raw[i] = (b0 + b1 + b2 + w * .1848) * .2;
        } else raw[i] = w * .5;
      }
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = raw[i];
      for (let i = 0; i < fade; i++) d[i] = raw[i] * (i / fade) + raw[len + i] * (1 - i / fade);
    }
    cache.set(key, b);
    return b;
  }

  /* ---------- 播放 ---------- */

  function panner(value, dest) {
    if (!ctx.createStereoPanner) return dest;
    const p = ctx.createStereoPanner();
    p.pan.value = value;
    p.connect(dest);
    return p;
  }

  function play(b, { time = 0, gain = 1, rate = 1, pan = 0, dest = sfxBus } = {}) {
    if (!ctx || !b) return null;
    const t = Math.max(time, ctx.currentTime);
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(pan ? panner(pan, dest) : dest);
    src.start(t);
    src.onended = () => g.disconnect();
    return src;
  }

  const HITS = {
    muyu: { b: 'muyu', gain: .9, jitter: .02 },
    muyuAccent: { b: 'muyu', gain: 1.05, rate: .89, jitter: .01 },
    bead: { b: 'bead', gain: .6, jitter: .06 },
    whoosh: { b: 'whoosh', gain: .45, jitter: .08 },
    qing: { b: 'qing', gain: .5 },
    ling: { b: 'ling', gain: .3, jitter: .003 },
    drum: { b: 'drum', gain: .6, jitter: .015 },
    bowl: { b: 'bowl', gain: .4 },
    bowlLow: { b: 'bowl', gain: .34, rate: .75 },
    bell: { b: 'bell', gain: .6 }
  };

  function hit(name, time = 0, velocity = 1) {
    const h = HITS[name];
    if (!ctx || !h) return;
    const rate = (h.rate || 1) * (1 + (Math.random() * 2 - 1) * (h.jitter || 0));
    play(buf[h.b], { time, gain: h.gain * velocity, rate });
  }

  function osc(type, freq, detune = 0) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    return o;
  }

  function gainNode(value) {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  }

  function filter(type, freq, q = .7) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  function chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  function lfo(freq, depth, param) {
    const o = osc('sine', freq);
    const g = gainNode(depth);
    o.connect(g);
    g.connect(param);
    o.start();
    return o;
  }

  /* ---------- 节拍时钟 ---------- */

  const clock = { bpm: 60, step: 0, next: 0, timer: null };
  const stepListeners = [];
  const needs = new Set();
  const beat = () => 60 / clock.bpm;

  function tick() {
    if (!ctx) return;
    if (clock.next < ctx.currentTime - .25) clock.next = ctx.currentTime + .05;
    const ahead = ctx.currentTime + (document.hidden ? 1.5 : .15);
    while (clock.next < ahead) {
      for (const fn of stepListeners) {
        try { fn(clock.step, clock.next); } catch (e) { console.error(e); }
      }
      clock.next += beat() / 4;
      clock.step++;
    }
  }

  function need(key, on) {
    if (on) needs.add(key); else needs.delete(key);
    if (needs.size && !clock.timer && ctx) {
      clock.step = 0;
      clock.next = ctx.currentTime + .06;
      clock.timer = setInterval(tick, 25);
      tick();
    } else if (!needs.size && clock.timer) {
      clearInterval(clock.timer);
      clock.timer = null;
    }
  }

  /* ---------- 乐器：持续音、古琴、人声、笙、箫 ---------- */

  function drone(dest, notes, gains, cutoff = 520) {
    const lp = filter('lowpass', cutoff, .5);
    const g = gainNode(0);
    g.gain.setTargetAtTime(1, ctx.currentTime, 2.5);
    lp.connect(g);
    g.connect(dest);
    const nodes = [lfo(.035, cutoff * .4, lp.frequency), lfo(.06, .22, g.gain)];
    notes.forEach((m, i) => {
      for (const [type, det, k] of [['sine', 0, 1], ['triangle', 4, .45], ['sawtooth', -5, .1]]) {
        const o = osc(type, mtof(m), det);
        const og = gainNode(gains[i] * k);
        o.connect(og);
        og.connect(lp);
        o.start();
        nodes.push(o);
      }
    });
    return { stop(t) { nodes.forEach(n => n.stop(t)); } };
  }

  function qinNote(dest, m, time, gain, slide) {
    const q = qin(m);
    const src = ctx.createBufferSource();
    src.buffer = q.b;
    if (slide) {
      src.playbackRate.setValueAtTime(q.rate * Math.pow(2, -2 / 12), time);
      src.playbackRate.exponentialRampToValueAtTime(q.rate, time + .24);
    } else src.playbackRate.setValueAtTime(q.rate, time);
    // 吟：音头之后缓缓加入的揉弦
    const vib = osc('sine', rand(4, 5.5));
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0, time);
    vg.gain.linearRampToValueAtTime(q.rate * .0045, time + 1.2);
    vib.connect(vg);
    vg.connect(src.playbackRate);
    const body = filter('peaking', 260, 1);
    body.gain.value = 4;
    const g = gainNode(gain);
    chain(src, body, filter('lowpass', 3000), g, panner(rand(-.3, .3), dest));
    src.start(time);
    vib.start(time);
    src.stop(time + 6);
    vib.stop(time + 6);
    src.onended = () => g.disconnect();
  }

  // 人声：锯齿波经共振峰滤波，模拟低沉的僧众念诵
  const VOWELS = {
    a: [[700, 1], [1150, .5], [2600, .26]],
    o: [[430, 1], [780, .5], [2500, .12]],
    u: [[330, 1], [640, .2], [2400, .05]],
    i: [[300, 1], [2050, .22], [2800, .12]],
    e: [[460, 1], [1750, .3], [2600, .14]],
    m: [[260, 1], [1200, .05], [2400, .02]]
  };
  const WORDS = {
    amituofo: [['m', 'a'], ['m', 'o'], [null, 'a'], ['m', 'i'], [null, 'o'], ['u', 'o']],
    mani: [[null, 'o'], ['m', 'a'], ['m', 'i'], [null, 'a'], ['m', 'e'], ['u', 'u']]
  };
  let words = 'amituofo';

  function chantVoice(dest, m, time, dur, syllable, gain, attack = .12, release = .35) {
    const [cons, vow] = syllable, V = VOWELS[vow], C = cons ? VOWELS[cons] : V;
    const env = ctx.createGain();
    const held = time + Math.max(attack + .02, dur);
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(gain, time + attack);
    env.gain.linearRampToValueAtTime(gain * .8, held);
    env.gain.setTargetAtTime(0, held, release / 3);
    env.connect(dest);
    const src = gainNode(1);
    V.forEach(([fv, av], k) => {
      const bp = filter('bandpass', C[k][0], fv / [80, 110, 150][k]);
      const fg = ctx.createGain();
      fg.gain.setValueAtTime(C[k][1] * (cons ? .6 : 1), time);
      if (cons) {
        bp.frequency.setTargetAtTime(fv, time + .07, .035);
        fg.gain.setTargetAtTime(av, time + .07, .035);
      }
      chain(src, bp, fg, env);
    });
    const end = held + release * 2 + .3, f = mtof(m);
    for (const [oct, cents, g] of [[0, -7, 1], [0, 0, 1], [0, 6, 1], [-12, -4, .75], [-12, 5, .75]]) {
      const fr = f * Math.pow(2, oct / 12), t0 = time + Math.random() * .035;
      const o = osc('sawtooth', fr, cents);
      o.frequency.setValueAtTime(fr * .982, t0);
      o.frequency.exponentialRampToValueAtTime(fr, t0 + .09);
      const vib = osc('sine', rand(4.6, 5.6));
      const vg = ctx.createGain();
      vg.gain.setValueAtTime(0, t0);
      vg.gain.linearRampToValueAtTime(rand(6, 11), t0 + Math.min(dur, .9));
      vib.connect(vg);
      vg.connect(o.detune);
      chain(o, gainNode(g), src);
      o.start(t0);
      vib.start(t0);
      o.stop(end);
      vib.stop(end);
    }
    setTimeout(() => env.disconnect(), (end - ctx.currentTime) * 1000 + 300);
  }

  // 笙：簧片和声，缓起缓落
  function sheng(dest, notes, time) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(.05, time + 3.5);
    const lp = filter('lowpass', 1300, .6);
    lp.connect(g);
    g.connect(dest);
    const nodes = [];
    for (const m of notes) {
      for (const [type, det, k] of [['sawtooth', -5, .5], ['square', 6, .22]]) {
        const o = osc(type, mtof(m), det);
        chain(o, gainNode(k), lp);
        o.start(time);
        nodes.push(o);
      }
    }
    return {
      release(t) {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(.05, t);
        g.gain.setTargetAtTime(0, t, 1.8);
        nodes.forEach(o => o.stop(t + 10));
      }
    };
  }

  // 箫：气声与揉音
  function xiao(dest, m, time, dur) {
    const f = mtof(m), end = time + dur + 1.5;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(.075, time + .35);
    env.gain.linearRampToValueAtTime(.06, time + dur);
    env.gain.setTargetAtTime(0, time + dur, .25);
    chain(env, filter('lowpass', 2600), panner(rand(-.2, .2), dest));
    const o1 = osc('sine', f), o2 = osc('triangle', f * 2);
    chain(o1, env);
    chain(o2, gainNode(.06), env);
    const vib = osc('sine', rand(4.2, 5));
    const vg = ctx.createGain();
    vg.gain.setValueAtTime(0, time);
    vg.gain.linearRampToValueAtTime(f * .005, time + 1.2);
    vib.connect(vg);
    vg.connect(o1.frequency);
    const air = ctx.createBufferSource();
    air.buffer = noise('white');
    air.loop = true;
    chain(air, filter('bandpass', f * 2, 2.5), gainNode(.35), env);
    for (const n of [o1, o2, vib]) { n.start(time); n.stop(end); }
    air.start(time, Math.random() * 5);
    air.stop(end);
  }

  /* ---------- 伴乐曲目 ---------- */

  let chantListener = () => {};

  const TRACKS = {
    // 空山：低沉持续音、疏落的古琴与泛音、偶尔一声颂钵
    kongshan(o) {
      const bed = drone(o, [38, 45, 50], [.1, .05, .022]);
      const scale = [50, 53, 55, 57, 60, 62, 65, 67, 69, 72, 74];
      let rest = 1, left = 0, deg = 3;
      return {
        step(step, time) {
          if (step % 4) return;
          const n = step / 4;
          if (n % 32 === 16) play(buf.bowl, { time, gain: .22, rate: .75, dest: o });
          if (rest > 0) { rest--; return; }
          if (left <= 0) {
            left = 3 + Math.floor(Math.random() * 4);
            if (Math.random() < .5) qinNote(o, pick([38, 45]), time, .4, false);
          }
          deg = clamp(deg + pick([-2, -1, -1, 0, 1, 1, 2]), 0, scale.length - 1);
          if (Math.random() < .16) play(harmonic(scale[deg] + 12), { time, gain: .2, dest: o, pan: rand(-.3, .3) });
          else qinNote(o, scale[deg], time, .5, Math.random() < .22);
          left--;
          rest = left > 0 ? pick([0, 0, 1, 1, 2]) : 4 + Math.floor(Math.random() * 7);
        },
        stop(t) { bed.stop(t); }
      };
    },

    // 梵音：僧众低声念诵六字，一句八拍，唱三句歇一句
    fanyin(o) {
      const bed = drone(o, [38, 45], [.045, .022], 420);
      const phrases = [[57, 57, 60, 57, 55, 57], [57, 60, 62, 60, 57, 55], [62, 60, 57, 55, 53, 50], null];
      const lengths = [1, 1, 1, 1, 1, 3];
      return {
        step(step, time) {
          if (step % 32) return;
          const n = step / 32, b = beat();
          chantVoice(o, 50, time, b * 8, [null, 'u'], .05, 1.4, 1.6);
          const melody = phrases[n % phrases.length];
          if (!melody) {
            if (n % 8 === 7) play(buf.ling, { time: time + b * 4, gain: .12, dest: o });
            chantListener(-1, time);
            return;
          }
          let t = time;
          melody.forEach((m, i) => {
            const d = lengths[i] * b;
            chantVoice(o, m, t, d - .05, WORDS[words][i], .32);
            chantListener(i, t);
            t += d;
          });
        },
        stop(t) { bed.stop(t); chantListener(-1, t); }
      };
    },

    // 晨钟：梵钟一撞，笙簧缓起，风铃偶响，间或一段箫声
    chenzhong(o) {
      const chords = [[50, 57, 62, 67], [48, 55, 60, 65], [53, 57, 60, 65], [50, 55, 57, 62]];
      const notes = [62, 65, 67, 69, 72, 74];
      let pad = null, count = 0;
      const toll = time => {
        play(buf.bell, { time, gain: .6, dest: o });
        if (pad) pad.release(time + .4);
        pad = sheng(o, chords[count++ % chords.length], time + .4);
        if (Math.random() < .6) {
          let t = time + beat() * 4, deg = Math.floor(Math.random() * notes.length);
          for (let k = 3 + Math.floor(Math.random() * 2); k > 0; k--) {
            const d = beat() * pick([2, 3, 4]);
            xiao(o, notes[deg], t, d - .15);
            t += d + beat() * pick([0, 0, 1]);
            deg = clamp(deg + pick([-2, -1, 1, 1, 2]), 0, notes.length - 1);
          }
        }
      };
      toll(ctx.currentTime + .1);
      return {
        step(step, time) {
          if (step % 64 === 0 && step > 0) toll(time);
          if (step % 2 === 0 && Math.random() < .035) {
            play(pick(buf.chimes), { time, gain: rand(.07, .18), dest: o, pan: rand(-.7, .7) });
          }
        },
        stop(t) { if (pad) pad.release(t); }
      };
    }
  };

  let track = null;
  stepListeners.push((step, time) => { if (track) track.step(step, time); });

  function setTrack(name) {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (track) {
      const old = track;
      old.out.gain.cancelScheduledValues(now);
      old.out.gain.setValueAtTime(old.out.gain.value, now);
      old.out.gain.setTargetAtTime(0, now, .9);
      old.stop(now + 5);
      setTimeout(() => old.out.disconnect(), 6000);
      track = null;
    }
    if (!TRACKS[name]) { need('music', false); return; }
    const o = ctx.createGain();
    o.gain.value = 0;
    o.gain.setTargetAtTime(1, now, 1.2);
    o.connect(musicBus);
    need('music', true);
    track = TRACKS[name](o);
    track.out = o;
  }

  /* ---------- 声景 ---------- */

  function loop(b) {
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.loop = true;
    s.start(ctx.currentTime, Math.random() * b.duration);
    return s;
  }

  // 屋檐滴水
  function droplet(dest, time) {
    const f = rand(1400, 2600), o = osc('sine', f), g = ctx.createGain();
    o.frequency.setValueAtTime(f, time);
    o.frequency.exponentialRampToValueAtTime(f * .55, time + .05);
    g.gain.setValueAtTime(0, time);
    g.gain.linearRampToValueAtTime(rand(.02, .05), time + .004);
    g.gain.exponentialRampToValueAtTime(.0001, time + .08);
    chain(o, g, panner(rand(-.8, .8), dest));
    o.start(time);
    o.stop(time + .1);
  }

  const AMBIENTS = {
    rain(o) {
      const s1 = loop(noise('pink')), s2 = loop(noise('brown'));
      chain(s1, filter('highpass', 600), filter('lowpass', 6500), gainNode(.45), o);
      chain(s2, filter('lowpass', 380), gainNode(.35), o);
      let alive = true, timer;
      (function drip() {
        if (!alive) return;
        droplet(o, ctx.currentTime + .05);
        timer = setTimeout(drip, rand(500, 2200));
      })();
      return { stop() { alive = false; clearTimeout(timer); s1.stop(); s2.stop(); } };
    },
    wind(o) {
      const s1 = loop(noise('brown')), s2 = loop(noise('pink'));
      const bp = filter('bandpass', 500, .9), g = gainNode(.75);
      chain(s1, bp, g, o);
      const whistle = filter('bandpass', 1800, 4);
      chain(s2, whistle, gainNode(.05), o);
      const mods = [lfo(.055, 320, bp.frequency), lfo(.037, .35, g.gain), lfo(.08, 600, whistle.frequency)];
      return { stop() { [s1, s2, ...mods].forEach(n => n.stop()); } };
    },
    stream(o) {
      const s1 = loop(noise('pink')), s2 = loop(noise('pink')), s3 = loop(noise('brown'));
      chain(s1, filter('bandpass', 900, .6), gainNode(.55), o);
      const babble = gainNode(.18);
      chain(s2, filter('bandpass', 2600, 1.4), babble, o);
      chain(s3, filter('lowpass', 420), gainNode(.4), o);
      const mods = [lfo(1.3, .12, babble.gain), lfo(.37, .08, babble.gain)];
      return { stop() { [s1, s2, s3, ...mods].forEach(n => n.stop()); } };
    }
  };

  let ambience = null;

  function setAmbient(kind) {
    if (!ctx) return;
    if (ambience) {
      const old = ambience;
      old.out.gain.setTargetAtTime(0, ctx.currentTime, .5);
      setTimeout(() => { old.stop(); old.out.disconnect(); }, 2500);
      ambience = null;
    }
    if (!AMBIENTS[kind]) return;
    const o = ctx.createGain();
    o.gain.value = 0;
    o.gain.setTargetAtTime(1, ctx.currentTime, .8);
    o.connect(ambBus);
    ambience = AMBIENTS[kind](o);
    ambience.out = o;
  }

  /* ---------- 对外接口 ---------- */

  function setLevel(kind, value) {
    levels[kind] = value;
    if (!ctx) return;
    const bus = { music: musicBus, sfx: sfxBus, amb: ambBus }[kind];
    if (bus) bus.gain.setTargetAtTime(value, ctx.currentTime, .08);
  }

  function meter() {
    if (!analyser) return null;
    const d = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(d);
    let sum = 0, peak = 0;
    for (const v of d) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
    return { rms: 20 * Math.log10(Math.sqrt(sum / d.length) || 1e-9), peak: 20 * Math.log10(peak || 1e-9) };
  }

  window.Sound = {
    init,
    get ready() { return !!ctx; },
    now: () => (ctx ? ctx.currentTime : 0),
    latency: () => (ctx ? Math.min(.2, (ctx.outputLatency || 0) + (ctx.baseLatency || 0)) : 0),
    hit,
    setTrack,
    setAmbient,
    setLevel,
    setBpm(v) { clock.bpm = clamp(v, 30, 140); },
    setWords(w) { if (WORDS[w]) words = w; },
    need,
    onStep(fn) { stepListeners.push(fn); },
    onChant(fn) { chantListener = fn; },
    meter
  };
})();
