'use strict';
const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const MODES = {
  wood: { title: '一声木鱼，万念归寂', hint: '轻触木鱼，或按 <kbd>空格</kbd>', unit: '声', auto: '自动敲击', aria: '敲一下木鱼', mantra: '南无阿弥陀佛' },
  beads: { title: '一珠一念，念念相续', hint: '轻触或左右拖动念珠，或按 <kbd>空格</kbd>', unit: '颗', auto: '自动拨珠', aria: '拨动一颗念珠', mantra: '南无阿弥陀佛' },
  wheel: { title: '法轮常转，心境澄明', hint: '轻触或左右拖动法轮，或按 <kbd>空格</kbd>', unit: '圈', auto: '自动转动', aria: '转动法轮', mantra: '唵嘛呢叭咪吽' },
  breath: { title: '一呼一吸，安住当下', hint: '轻触圆环，或按 <kbd>空格</kbd> 开始／暂停', unit: '轮', auto: '开始观息', aria: '开始或暂停观息', mantra: '吸停呼停' }
};
const TRACK_NAMES = { kongshan: '空山', fanyin: '梵音', chenzhong: '晨钟' };
// 每个节律 32 步 = 8 拍；X 重击，x 轻击
const PATTERNS = {
  steady: { main: 'X...x...x...x...X...x...x...x...', extra: { qing: 'X...............................' } },
  chant: { main: 'X...x...x...x...x...x...x...x...', extra: { qing: 'X...............................', ling: '....................x...........' } },
  drum: {
    main: 'X.x.x.x.X.x.x.x.X.x.x.x.X.x.x.x.',
    extra: { drum: 'X.....x.X.......X.....x.X...x.x.', qing: 'X...............................', ling: '........x...............x.......' }
  }
};
const WORDS = ['一念清净', '心无挂碍', '万缘放下', '随缘自在', '当下即是', '念念分明', '如是如是'];
const BREATH_PHASES = ['吸气', '屏息', '呼气', '静候'];

/* ---------- 状态与设置 ---------- */

const prefs = Object.assign(
  { track: 'kongshan', pattern: 'chant', bpm: 60, ambient: 'none', music: 60, sfx: 80, amb: 50 },
  (() => { try { return JSON.parse(localStorage.getItem('yinian.prefs')) || {}; } catch { return {}; } })()
);
const savePrefs = () => { try { localStorage.setItem('yinian.prefs', JSON.stringify(prefs)); } catch {} };

let mode = 'wood', counts = { wood: 0, beads: 0, wheel: 0, breath: 0 };
let elapsed = 0, started = false, auto = false, musicOn = false, entered = false;
let angle = 0, targetAngle = 0, velocity = 0, drag = null, moved = false;
let breathTime = 0, breathPhase = -1, syllable = 0, chantActive = false;
let lastFrame = 0;

/* ---------- 声音接入 ---------- */

function wakeAudio() {
  if (Sound.ready) { Sound.init(); return true; }
  if (!Sound.init()) { toast('当前浏览器暂不支持音频'); return false; }
  Sound.setLevel('music', prefs.music / 100);
  Sound.setLevel('sfx', prefs.sfx / 100);
  Sound.setLevel('amb', prefs.amb / 100);
  Sound.setBpm(prefs.bpm);
  Sound.setWords(mode === 'wheel' ? 'mani' : 'amituofo');
  return true;
}

// 视觉事件按音频时间排队，让光与声同时到来
const queue = [];
function at(time, fn, tag) {
  let i = queue.length;
  while (i && queue[i - 1].time > time) i--;
  queue.splice(i, 0, { time, fn, tag });
}
function unqueue(tag) {
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].tag === tag) queue.splice(i, 1);
}
function drain() {
  const now = Sound.now() - Sound.latency();
  while (queue.length && queue[0].time <= now) {
    const e = queue.shift();
    e.fn(now - e.time > .3 || document.hidden);
  }
}
setInterval(drain, 40);

Sound.onStep((step, time) => {
  if (musicOn && step % 4 === 0) at(time, late => { if (!late) beatPulse(step % 32 === 0); });
  if (!auto || mode === 'breath') return;
  const p = PATTERNS[prefs.pattern] || PATTERNS.chant, i = step % 32;
  for (const [inst, row] of Object.entries(p.extra)) {
    if (row[i] !== '.') Sound.hit(inst, time, row[i] === 'X' ? 1 : .6);
  }
  const c = p.main[i];
  if (c === '.') return;
  const accent = c === 'X';
  mainSound(time, accent);
  at(time, late => effect({ accent: accent && p.extra.qing[i] !== '.', late }));
});

Sound.onChant((index, time) => at(time, () => {
  chantActive = index >= 0;
  if (mode !== 'breath') light(index);
}, 'chant'));

function mainSound(time, accent) {
  if (mode === 'wood') Sound.hit(accent ? 'muyuAccent' : 'muyu', time);
  else if (mode === 'beads') Sound.hit('bead', time, accent ? 1.1 : .9);
  else if (mode === 'wheel') Sound.hit('whoosh', time, accent ? 1.1 : .8);
}

/* ---------- 修行动作 ---------- */

function act() {
  wakeAudio();
  started = true;
  if (mode === 'breath') { setAuto(!auto); return; }
  mainSound(0, false);
  effect({ manual: true });
}

function effect({ accent = false, manual = false, late = false } = {}) {
  started = true;
  if (mode === 'wheel') {
    velocity = Math.min(14, velocity + (manual ? 2.4 : 1.2));
  } else if (mode !== 'breath') {
    counts[mode]++;
    if (mode === 'beads') targetAngle += TAU / 18;
    if (counts[mode] % 108 === 0) milestone();
    updateCount();
  }
  if (!chantActive && mode !== 'breath') light(syllable++ % 6);
  if (manual && navigator.vibrate) navigator.vibrate(8);
  if (late) return;
  strikeMotion(accent);
  if (manual ? Math.random() < .35 : accent) floatWord();
}

function milestone() {
  Sound.hit('qing', 0, 1.1);
  toast('一百零八 · 一轮圆满');
  ripple('grand');
}

function setAuto(on) {
  if (on) wakeAudio();
  auto = on;
  $('auto').setAttribute('aria-pressed', String(auto));
  $('play-icon').textContent = auto ? 'Ⅱ' : '▷';
  $('auto-text').textContent = auto ? '暂停' : MODES[mode].auto;
  if (mode === 'breath') {
    if (auto) { started = true; breathPhase = -1; }
    Sound.need('auto', false);
  } else {
    if (auto) started = true;
    if (Sound.ready) Sound.need('auto', auto);
  }
}

/* ---------- 伴乐 ---------- */

function setMusic(on) {
  if (on && !wakeAudio()) return;
  musicOn = on;
  unqueue('chant');
  chantActive = false;
  if (mode !== 'breath') light(-1);
  if (Sound.ready) Sound.setTrack(on ? prefs.track : 'none');
  $('music').setAttribute('aria-pressed', String(on));
  $('music-text').textContent = on ? TRACK_NAMES[prefs.track] : '伴乐';
}

function choose(group, value) {
  prefs[group] = value;
  savePrefs();
  syncChips();
  if (group === 'track') setMusic(true);
  if (group === 'ambient') { wakeAudio(); Sound.setAmbient(value); }
  if (group === 'pattern' && !auto && mode !== 'breath') setAuto(true);
}

function syncChips() {
  document.querySelectorAll('.chips').forEach(box => {
    const current = prefs[box.dataset.group];
    box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === current)));
  });
}

/* ---------- 修行方式 ---------- */

function selectMode(next) {
  if (!MODES[next]) throw new Error('未知修行方式');
  setAuto(false);
  mode = next;
  const m = MODES[mode];
  document.body.className = document.body.className.replace(/\bmode-\w+/g, '').trim() + ' mode-' + mode;
  velocity = angle = targetAngle = 0;
  breathTime = 0;
  breathPhase = -1;
  syllable = 0;
  $('heading').textContent = m.title;
  $('hint').innerHTML = m.hint;
  $('count-unit').textContent = m.unit;
  $('auto-text').textContent = m.auto;
  $('instrument').setAttribute('aria-label', m.aria);
  $('wood-image').hidden = mode !== 'wood';
  $('canvas').hidden = !['beads', 'wheel'].includes(mode);
  $('breathing').hidden = mode !== 'breath';
  $('breath-label').textContent = BREATH_PHASES[0];
  setBreathScale(0);
  renderMantra(m.mantra);
  if (Sound.ready) Sound.setWords(mode === 'wheel' ? 'mani' : 'amituofo');
  document.querySelectorAll('[data-mode]').forEach(b => {
    b.classList.toggle('selected', b.dataset.mode === mode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  });
  updateCount();
  draw();
}

function renderMantra(text) {
  const box = $('mantra');
  box.textContent = '';
  [...text].forEach((ch, i) => {
    if (mode === 'breath' && i) {
      const s = document.createElement('span');
      s.className = 'sep';
      s.textContent = '·';
      box.append(s);
    }
    const s = document.createElement('span');
    s.className = 'syl';
    s.textContent = ch;
    box.append(s);
  });
}

function light(i) {
  document.querySelectorAll('#mantra .syl').forEach((s, k) => s.classList.toggle('lit', k === i));
}

function updateCount() {
  $('count').textContent = counts[mode];
}

/* ---------- 视觉 ---------- */

function strikeMotion(accent) {
  Atmos.stir(accent ? .9 : .4);
  if (reduceMotion) return;
  const lift = mode === 'wood' ? 'scale(.975) translateY(3px)' : 'scale(.985)';
  $('instrument').animate([{ transform: 'none' }, { transform: lift }, { transform: 'none' }], { duration: 240, easing: 'ease-out' });
  ripple(accent ? 'accent' : '');
  $('enso-wrap').animate(
    [{ opacity: .42 }, { opacity: accent ? .85 : .62 }, { opacity: .42 }],
    { duration: accent ? 1800 : 900, easing: 'ease-out' }
  );
}

function beatPulse(bar) {
  if (reduceMotion) return;
  $('enso-wrap').animate(
    [{ transform: 'translate(-50%,-50%) scale(1)' }, { transform: `translate(-50%,-50%) scale(${bar ? 1.018 : 1.007})` }, { transform: 'translate(-50%,-50%) scale(1)' }],
    { duration: 900, easing: 'ease-out', composite: 'replace' }
  );
  Atmos.stir(bar ? .25 : .08);
}

function ripple(kind) {
  if (reduceMotion) return;
  const r = document.createElement('span');
  r.className = 'ripple' + (kind ? ' ' + kind : '');
  $('ripples').append(r);
  r.addEventListener('animationend', () => r.remove());
  while ($('ripples').childElementCount > 7) $('ripples').firstElementChild.remove();
}

let lastWord = -1;
function floatWord() {
  if (reduceMotion || $('particles').childElementCount > 1) return;
  let k;
  do k = Math.floor(Math.random() * WORDS.length); while (k === lastWord);
  lastWord = k;
  const p = document.createElement('span');
  p.className = 'particle';
  p.textContent = WORDS[k];
  p.style.left = (45 + Math.random() * 10) + '%';
  $('particles').append(p);
  p.addEventListener('animationend', () => p.remove());
}

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}

/* ---------- 念珠与法轮 ---------- */

const canvas = $('canvas'), g = canvas.getContext('2d');

function draw() {
  g.clearRect(0, 0, 900, 720);
  g.save();
  g.translate(450, 360);
  if (mode === 'beads') drawBeads();
  else if (mode === 'wheel') drawWheel();
  g.restore();
}

function drawBeads() {
  const R = 212;
  g.rotate(angle);
  g.strokeStyle = 'rgba(160,128,84,.55)';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(0, 0, R, 0, TAU);
  g.stroke();
  for (let i = 0; i < 18; i++) {
    const a = i / 18 * TAU, x = Math.cos(a) * R, y = Math.sin(a) * R, head = i === 0;
    g.shadowColor = 'rgba(0,0,0,.8)';
    g.shadowBlur = 18;
    g.shadowOffsetY = 8;
    const grad = g.createRadialGradient(x - 10, y - 12, 2, x, y, 34);
    grad.addColorStop(0, head ? '#e0c386' : '#a87a49');
    grad.addColorStop(.35, head ? '#b28f52' : '#6f4c2f');
    grad.addColorStop(1, '#1d1610');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, head ? 36 : 31, 0, TAU);
    g.fill();
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
    g.strokeStyle = 'rgba(214,180,120,.12)';
    g.lineWidth = 1;
    g.stroke();
  }
  g.rotate(-angle);
  g.fillStyle = 'rgba(203,176,126,.55)';
  g.font = '300 24px "Noto Serif SC", serif';
  g.textAlign = 'center';
  g.fillText('念  念  相  续', 0, 9);
}

function drawWheel() {
  g.rotate(angle);
  g.shadowColor = 'rgba(174,131,67,.2)';
  g.shadowBlur = 30;
  [[214, '#c2a068', 10], [194, '#6e5d3b', 3], [162, '#a58650', 3], [58, '#d1b77c', 3]].forEach(([r, c, w]) => {
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.strokeStyle = c;
    g.lineWidth = w;
    g.stroke();
  });
  for (let i = 0; i < 8; i++) {
    g.save();
    g.rotate(i * TAU / 8);
    const grad = g.createLinearGradient(-10, 0, 10, 0);
    grad.addColorStop(0, '#5f4d31');
    grad.addColorStop(.5, '#d2b576');
    grad.addColorStop(1, '#7b603a');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(-8, -58);
    g.lineTo(-14, -162);
    g.lineTo(0, -186);
    g.lineTo(14, -162);
    g.lineTo(8, -58);
    g.closePath();
    g.fill();
    g.beginPath();
    g.arc(0, -214, 8, 0, TAU);
    g.fill();
    g.restore();
  }
  const hub = g.createRadialGradient(-10, -10, 0, 0, 0, 42);
  hub.addColorStop(0, '#cfb783');
  hub.addColorStop(1, '#5f4a2b');
  g.fillStyle = hub;
  g.beginPath();
  g.arc(0, 0, 42, 0, TAU);
  g.fill();
}

/* ---------- 观息 ---------- */

function setBreathScale(t) {
  const ease = x => .5 - .5 * Math.cos(Math.PI * x);
  const s = t < 4 ? .78 + .47 * ease(t / 4) : t < 6 ? 1.25 : t < 10 ? 1.25 - .47 * ease((t - 6) / 4) : .78;
  const c = $('breath-circle');
  c.style.transform = `scale(${s.toFixed(4)})`;
  c.style.opacity = (.45 + (s - .78) * 1.1).toFixed(3);
}

function stepBreath(dt) {
  breathTime += dt;
  if (breathTime >= 12) {
    breathTime -= 12;
    counts.breath++;
    updateCount();
  }
  const t = breathTime, phase = t < 4 ? 0 : t < 6 ? 1 : t < 10 ? 2 : 3;
  if (phase !== breathPhase) {
    breathPhase = phase;
    $('breath-label').textContent = BREATH_PHASES[phase];
    light(phase);
    if (phase === 0) { Sound.hit('bowl'); ripple('accent'); }
    if (phase === 2) { Sound.hit('bowlLow', 0, .8); ripple(''); }
  }
  setBreathScale(t);
}

/* ---------- 主循环 ---------- */

function frame(time) {
  const dt = lastFrame ? Math.min((time - lastFrame) / 1000, .08) : 0;
  lastFrame = time;
  drain();
  if (mode === 'beads' && Math.abs(targetAngle - angle) > .0005) {
    angle += (targetAngle - angle) * Math.min(1, dt * 9);
    draw();
  }
  if (mode === 'wheel' && velocity) {
    const before = Math.floor(angle / TAU);
    angle += velocity * dt;
    velocity *= Math.pow(.72, dt);
    if (velocity < .006) velocity = 0;
    const turns = Math.floor(angle / TAU) - before;
    if (turns > 0) {
      counts.wheel += turns;
      Sound.hit('ling', 0, .8);
      ripple('accent');
      if (counts.wheel % 108 === 0) milestone();
      updateCount();
    }
    draw();
  }
  if (mode === 'breath' && auto) stepBreath(dt);
  Atmos.frame(dt);
  requestAnimationFrame(frame);
}

/* ---------- 氛围：光尘与薄雾 ---------- */

const Atmos = (() => {
  const c = $('atmos'), x = c.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  let w = 0, h = 0, energy = 0, still = false;
  const motes = [], fogs = [];
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 128;
  const sg = sprite.getContext('2d'), sgr = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
  sgr.addColorStop(0, 'rgba(190,178,150,1)');
  sgr.addColorStop(1, 'rgba(190,178,150,0)');
  sg.fillStyle = sgr;
  sg.fillRect(0, 0, 128, 128);

  function resize() {
    w = innerWidth;
    h = innerHeight;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function seed() {
    motes.length = fogs.length = 0;
    const n = Math.round(Math.min(60, w * h / 22000));
    for (let i = 0; i < n; i++) {
      motes.push({ x: Math.random() * w, y: Math.random() * h, r: .5 + Math.random() * 1.3, vy: 4 + Math.random() * 10, sway: 6 + Math.random() * 14, ph: Math.random() * TAU, a: .12 + Math.random() * .35 });
    }
    for (let i = 0; i < 6; i++) {
      fogs.push({ x: Math.random() * w, y: h * (.55 + Math.random() * .5), r: 220 + Math.random() * 320, vx: (Math.random() < .5 ? -1 : 1) * (3 + Math.random() * 6), a: .025 + Math.random() * .03 });
    }
  }
  let t = 0;
  function paint(dt) {
    t += dt;
    x.clearRect(0, 0, w, h);
    for (const f of fogs) {
      f.x += f.vx * dt;
      if (f.x < -f.r) f.x = w + f.r;
      if (f.x > w + f.r) f.x = -f.r;
      x.globalAlpha = f.a;
      x.drawImage(sprite, f.x - f.r, f.y - f.r * .45, f.r * 2, f.r * .9);
    }
    x.fillStyle = '#dcc393';
    for (const m of motes) {
      m.y -= m.vy * dt * (1 + energy * 1.5);
      if (m.y < -10) { m.y = h + 10; m.x = Math.random() * w; }
      const px = m.x + Math.sin(t * .3 + m.ph) * m.sway;
      x.globalAlpha = Math.min(1, m.a * (.6 + .4 * Math.sin(t * .8 + m.ph * 3)) * (1 + energy * 1.6));
      x.beginPath();
      x.arc(px, m.y, m.r, 0, TAU);
      x.fill();
    }
    x.globalAlpha = 1;
    energy *= Math.exp(-dt * 1.8);
  }
  resize();
  seed();
  addEventListener('resize', () => { resize(); seed(); if (still) paint(0); });
  if (reduceMotion) { still = true; paint(0); }
  return {
    frame(dt) { if (!still && !document.hidden) paint(dt); },
    stir(v) { energy = Math.min(2, energy + v); }
  };
})();

// 圆相：飞白的一笔
function drawEnso(cv) {
  const s = cv.width, x = cv.getContext('2d'), cx = s / 2, cy = s / 2, R = s * .4;
  const start = -Math.PI * .6, sweep = Math.PI * 1.84, steps = 600, bristles = 130;
  x.clearRect(0, 0, s, s);
  x.lineCap = 'round';
  x.lineJoin = 'round';
  for (let b = 0; b < bristles; b++) {
    const off = b / (bristles - 1) * 2 - 1 + (Math.random() - .5) * .03;
    // 越靠笔锋边缘越早枯，形成飞白
    const dry = .08 + .8 * Math.pow(1 - Math.abs(off), .7) * Math.random();
    const ink = .07 + Math.random() * .2;
    let inGap = false, drawing = false;
    x.beginPath();
    for (let k = 0; k <= steps; k++) {
      const p = k / steps, a = start + sweep * p;
      const width = s * .062 * (1 - p * .8) * Math.min(1, .3 + p * 16);
      const wob = Math.sin(p * 9 + 1.3) * s * .004 + Math.sin(p * 23) * s * .0015;
      const r = R + wob + off * width / 2;
      if (p > dry) inGap = inGap ? Math.random() > .08 : Math.random() < (p - dry) * .9;
      if (inGap) { drawing = false; continue; }
      const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      if (drawing) x.lineTo(px, py); else { x.moveTo(px, py); drawing = true; }
    }
    x.strokeStyle = `rgba(214,190,140,${ink.toFixed(3)})`;
    x.lineWidth = s * .0026 * (.6 + Math.random() * .9);
    x.stroke();
  }
}
document.querySelectorAll('.enso-canvas').forEach(drawEnso);

/* ---------- 入殿 ---------- */

function enter(withSound) {
  if (entered) return;
  entered = true;
  $('veil').classList.add('gone');
  if (withSound && wakeAudio()) {
    Sound.hit('qing', 0, .9);
    setTimeout(() => {
      setMusic(true);
      if (prefs.ambient !== 'none') Sound.setAmbient(prefs.ambient);
    }, 900);
  }
  scheduleIdle();
}
$('enter').onclick = () => enter(true);
$('enter-silent').onclick = () => enter(false);

/* ---------- 静：无操作时收起界面 ---------- */

let idleTimer;
function scheduleIdle() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (entered && $('panel').hidden) document.body.classList.add('idle');
  }, 7000);
}
['pointermove', 'pointerdown', 'wheel', 'keydown'].forEach(type => addEventListener(type, e => {
  if (type === 'keydown' && e.code === 'Space') return;
  if (e.target instanceof Element && e.target.closest('#instrument') && type !== 'pointermove') return;
  scheduleIdle();
}, { passive: true }));

/* ---------- 交互绑定 ---------- */

document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => selectMode(b.dataset.mode));
document.querySelectorAll('.chips').forEach(box => box.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) choose(box.dataset.group, b.dataset.value);
}));

const inst = $('instrument');
inst.onclick = () => { if (!moved) act(); moved = false; };
inst.onpointerdown = e => {
  moved = false;
  if (!['beads', 'wheel'].includes(mode)) return;
  drag = { x: e.clientX, last: e.clientX, total: 0 };
  inst.setPointerCapture(e.pointerId);
};
inst.onpointermove = e => {
  if (!drag) return;
  const dx = e.clientX - drag.last;
  drag.last = e.clientX;
  drag.total += Math.abs(dx);
  if (drag.total < 8) return;
  moved = true;
  started = true;
  wakeAudio();
  if (mode === 'wheel') {
    velocity = Math.min(18, Math.max(0, velocity + Math.abs(dx) * .025));
  } else {
    targetAngle += Math.abs(dx) * .008;
    if (Math.abs(e.clientX - drag.x) > 26) {
      drag.x = e.clientX;
      Sound.hit('bead');
      counts.beads++;
      if (!chantActive) light(syllable++ % 6);
      if (counts.beads % 108 === 0) milestone();
      updateCount();
    }
  }
};
inst.onpointerup = () => { drag = null; };
inst.onpointercancel = () => { drag = null; moved = false; };

document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
  if (!entered) {
    if (e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); enter(true); }
    return;
  }
  if (e.code === 'Space' && !typing && e.target.tagName !== 'BUTTON') {
    e.preventDefault();
    if (!e.repeat) act();
  } else if (e.key === 'Escape') {
    if (!$('panel').hidden) togglePanel(false);
    else if (document.body.classList.contains('immersed')) toggleImmersion(false);
  } else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'a' || e.key === 'A') setAuto(!auto);
    if (e.key === 'm' || e.key === 'M') setMusic(!musicOn);
  }
});

$('auto').onclick = () => setAuto(!auto);
$('music').onclick = () => setMusic(!musicOn);

function togglePanel(force) {
  const open = force === undefined ? $('panel').hidden : force;
  $('panel').hidden = !open;
  $('panel-toggle').setAttribute('aria-expanded', String(open));
  if (open) document.body.classList.remove('idle');
}
$('panel-toggle').onclick = e => { e.stopPropagation(); togglePanel(); };
document.addEventListener('pointerdown', e => {
  if (!$('panel').hidden && !e.target.closest('#panel, #panel-toggle')) togglePanel(false);
});

$('bpm').value = prefs.bpm;
$('bpm-out').textContent = prefs.bpm;
$('bpm').oninput = () => {
  prefs.bpm = Number($('bpm').value);
  $('bpm-out').textContent = prefs.bpm;
  Sound.setBpm(prefs.bpm);
  savePrefs();
};
for (const kind of ['music', 'sfx', 'amb']) {
  const input = $('lv-' + kind);
  input.value = prefs[kind];
  input.oninput = () => {
    prefs[kind] = Number(input.value);
    Sound.setLevel(kind, prefs[kind] / 100);
    savePrefs();
  };
}

$('reset').onclick = () => {
  setAuto(false);
  counts = { wood: 0, beads: 0, wheel: 0, breath: 0 };
  elapsed = 0;
  started = false;
  $('timer').textContent = '00:00';
  selectMode(mode);
  toast('新的一念，从此刻开始');
};

function toggleImmersion(force) {
  const on = force === undefined ? !document.body.classList.contains('immersed') : force;
  document.body.classList.toggle('immersed', on);
  $('immersive').setAttribute('aria-pressed', String(on));
  $('immersive').querySelector('.label').textContent = on ? '退出' : '沉浸';
  try {
    if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  } catch {}
}
$('immersive').onclick = () => toggleImmersion();
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('immersed')) toggleImmersion(false);
});

setInterval(() => {
  if (!started || (document.hidden && !auto && !musicOn)) return;
  elapsed++;
  $('timer').textContent = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(elapsed % 60).padStart(2, '0');
}, 1000);

$('wood-image').onerror = () => toast('木鱼图像加载失败，仍可轻触敲击');

syncChips();
selectMode('wood');
requestAnimationFrame(frame);

if (document.modelContext?.registerTool) {
  try {
    document.modelContext.registerTool({
      name: 'select_meditation_practice',
      title: '切换修行方式',
      description: '切换到木鱼、念珠、法轮或观息（呼吸冥想），并暂停自动修行。',
      inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: Object.keys(MODES) } }, required: ['mode'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        if (!input || typeof input.mode !== 'string' || !MODES[input.mode]) throw new Error('无效的修行方式');
        selectMode(input.mode);
        return { mode, count: counts[mode], automatic: auto };
      }
    });
  } catch {}
}
