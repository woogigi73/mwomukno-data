/* 뭐 먹노? 연출 엔진: 효과음(외부 파일 없이 합성), 폭죽·불꽃·연기 입자, 화면 흔들림, 번쩍임, "당첨!" 도장.
 * 저사양 폰을 위해 입자 수를 제한하고, '동작 줄이기' 설정이면 시각 효과를 끈다.
 */
'use strict';
(function () {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let muted = (() => { try { return localStorage.getItem('mm.mute') === '1'; } catch (e) { return false; } })();

  // ------------------------------------------------------------ 효과음
  let ac = null;
  function audio() {
    if (muted) return null;
    if (!ac) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { ac = new C(); } catch (e) { return null; }
    }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  }
  function tone(freq, dur, type, vol, when, slide) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + (when || 0);
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(vol || 0.08, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(a.destination);
    o.start(t); o.stop(t + dur + 0.03);
  }
  let noiseBuf = null;
  function noise(dur, vol, when, lp) {
    const a = audio(); if (!a) return;
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t = a.currentTime + (when || 0);
    const s = a.createBufferSource(); s.buffer = noiseBuf;
    const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp || 1200;
    const g = a.createGain();
    g.gain.setValueAtTime(vol || 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(a.destination);
    s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.03);
  }
  let lastTick = 0;
  const sfx = {
    tick() { const n = performance.now(); if (n - lastTick < 28) return; lastTick = n; tone(1500, 0.025, 'square', 0.035); },
    tock(p) { tone(520 * (p || 1), 0.06, 'triangle', 0.09); },
    whoosh() { noise(0.35, 0.16, 0, 2600); },
    thunk() { tone(150, 0.14, 'sine', 0.28, 0, 0.5); noise(0.07, 0.18, 0, 900); },
    pop() { tone(420, 0.16, 'sine', 0.22, 0, 2.6); },
    boom() { noise(1.1, 0.7, 0, 650); tone(80, 0.7, 'sine', 0.45, 0, 0.35); },
    hoof() { noise(0.035, 0.12, 0, 500); },
    drum(n) { for (let i = 0; i < (n || 10); i++) noise(0.05, 0.08 + i * 0.012, i * 0.055, 1600); },
    count() { tone(440, 0.13, 'square', 0.06); },
    go() { tone(880, 0.3, 'square', 0.07); tone(1320, 0.3, 'square', 0.04, 0.02); },
    beep(p) { tone(980 * (p || 1), 0.05, 'square', 0.05); },
    fanfare() {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, 'triangle', 0.13, i * 0.1));
      tone(1047, 0.6, 'triangle', 0.13, 0.42); tone(1319, 0.6, 'triangle', 0.09, 0.42); tone(1568, 0.6, 'triangle', 0.06, 0.42);
    },
  };

  // ------------------------------------------------------------ 입자
  let cv = null, g = null, parts = [], raf = 0, W = 0, H = 0;
  function ensure() {
    if (cv) return;
    cv = document.createElement('canvas'); cv.className = 'fxcanvas'; cv.setAttribute('aria-hidden', 'true');
    document.body.append(cv); g = cv.getContext('2d'); resize();
    addEventListener('resize', resize);
  }
  function resize() {
    if (!cv) return;
    const d = Math.min(2, devicePixelRatio || 1); W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * d); cv.height = Math.round(H * d); g.setTransform(d, 0, 0, d, 0, 0);
  }
  function star(s) {
    g.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? s * 0.22 : s * 0.55, a = i * Math.PI / 5 - Math.PI / 2; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill();
  }
  let prev = 0;
  function loop(now) {
    const dt = Math.min(0.05, prev ? (now - prev) / 1000 : 1 / 60); prev = now;
    g.clearRect(0, 0, W, H);
    parts = parts.filter((p) => now - p.t0 < p.life);
    for (const p of parts) {
      p.vx *= p.drag; p.vy = p.vy * p.drag + p.gv * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      const left = 1 - (now - p.t0) / p.life;
      g.globalAlpha = Math.max(0, Math.min(1, left * 1.6)) * (p.a || 1);
      g.fillStyle = p.c;
      g.save(); g.translate(p.x, p.y); g.rotate(p.rot);
      if (p.shape === 'rect') g.fillRect(-p.s / 2, -p.s * 0.3, p.s, Math.max(1, p.s * 0.6 * Math.abs(Math.cos(p.rot * 2))));
      else if (p.shape === 'star') star(p.s);
      else { g.beginPath(); g.arc(0, 0, p.s / 2 * (p.grow ? 1 + (1 - left) * p.grow : 1), 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
    g.globalAlpha = 1;
    if (parts.length) raf = requestAnimationFrame(loop); else { raf = 0; prev = 0; g.clearRect(0, 0, W, H); }
  }
  function emit(list) {
    if (reduce) return;
    ensure();
    parts.push(...list);
    if (parts.length > 420) parts.splice(0, parts.length - 420);
    if (!raf) raf = requestAnimationFrame(loop);
  }
  const COLORS = ['#FFC21A', '#E4473A', '#3E6BE0', '#1C9A55', '#F08A24', '#8A4FD0', '#149E9E', '#D64C8A', '#FFFFFF'];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  function P(x, y, vx, vy, o) {
    return Object.assign({
      x, y, vx, vy, gv: 900, drag: 0.985, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14,
      s: 8 + Math.random() * 7, c: pick(COLORS), shape: Math.random() < 0.25 ? 'star' : 'rect',
      life: 2200 + Math.random() * 900, t0: performance.now(),
    }, o || {});
  }
  // 양쪽 아래에서 쏘아 올리는 축하 폭죽
  function cannons(n) {
    const l = [], k = n || 60;
    for (let i = 0; i < k; i++) {
      const sp = 650 + Math.random() * 750;
      const a1 = -Math.PI / 2 + 0.3 + Math.random() * 0.55, a2 = -Math.PI / 2 - 0.3 - Math.random() * 0.55;
      l.push(P(0, innerHeight, Math.cos(a1) * sp, Math.sin(a1) * sp));
      l.push(P(innerWidth, innerHeight, Math.cos(a2) * sp, Math.sin(a2) * sp));
    }
    emit(l);
  }
  // 한 점에서 터지는 불꽃
  function burst(x, y, n, opt) {
    const l = [];
    for (let i = 0; i < (n || 40); i++) {
      const a = Math.random() * Math.PI * 2, sp = 180 + Math.random() * 520;
      l.push(P(x, y, Math.cos(a) * sp, Math.sin(a) * sp, Object.assign({ gv: 520, life: 1000 + Math.random() * 700 }, opt || {})));
    }
    emit(l);
  }
  function sparkle(x, y, c) {
    emit([P(x, y, (Math.random() - 0.5) * 140, (Math.random() - 0.5) * 140 - 40,
      { gv: 160, s: 5 + Math.random() * 6, shape: 'star', c: c || '#FFE27A', life: 450 + Math.random() * 300 })]);
  }
  function smoke(x, y, n) {
    const l = [];
    for (let i = 0; i < (n || 14); i++) {
      l.push(P(x, y, (Math.random() - 0.5) * 280, -Math.random() * 220,
        { gv: -70, drag: 0.94, shape: 'circle', s: 16 + Math.random() * 26, grow: 1.6, a: 0.55, c: pick(['#8a8f98', '#a7acb4', '#6f747c']), life: 900 + Math.random() * 600, vr: 0 }));
    }
    emit(l);
  }
  function dust(x, y) {
    emit([P(x, y, -60 - Math.random() * 120, -Math.random() * 60,
      { gv: 120, drag: 0.95, shape: 'circle', s: 6 + Math.random() * 8, grow: 1.2, a: 0.6, c: '#B89C74', life: 500 + Math.random() * 300, vr: 0 })]);
  }

  // ------------------------------------------------------------ 화면 연출
  function shake(el, px, ms) {
    if (reduce || !el || !el.animate) return;
    const k = px || 10, frames = [];
    for (let i = 0; i < 7; i++) {
      const f = 1 - i / 7;
      frames.push({ transform: 'translate(' + ((Math.random() - 0.5) * k * 2 * f).toFixed(1) + 'px,' + ((Math.random() - 0.5) * k * f).toFixed(1) + 'px) rotate(' + ((Math.random() - 0.5) * k * 0.15 * f).toFixed(2) + 'deg)' });
    }
    frames.push({ transform: 'none' });
    el.animate(frames, { duration: ms || 420, easing: 'ease-out' });
  }
  function flash(color, ms) {
    if (reduce) return;
    const f = document.createElement('div'); f.className = 'fxflash'; f.style.background = color || '#fff';
    document.body.append(f);
    const an = f.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: ms || 380, easing: 'ease-out' });
    an.onfinish = () => f.remove();
  }
  function stamp(text, small) {
    if (reduce) return;
    const s = document.createElement('div'); s.className = 'fxstamp' + (small ? ' small' : ''); s.textContent = text;
    document.body.append(s);
    const an = s.animate([
      { transform: 'translate(-50%,-50%) scale(3.2) rotate(-18deg)', opacity: 0 },
      { transform: 'translate(-50%,-50%) scale(.92) rotate(-8deg)', opacity: 1, offset: 0.16 },
      { transform: 'translate(-50%,-50%) scale(1.06) rotate(-8deg)', opacity: 1, offset: 0.24 },
      { transform: 'translate(-50%,-50%) scale(1) rotate(-8deg)', opacity: 1, offset: 0.86 },
      { transform: 'translate(-50%,-50%) scale(1.25) rotate(-8deg)', opacity: 0 },
    ], { duration: small ? 1100 : 2300, easing: 'cubic-bezier(.2,.9,.3,1)' });
    an.onfinish = () => s.remove();
  }
  // 큰 숫자 카운트다운 (3, 2, 1, 출발!)
  function countdown(steps, gap, onEach) {
    steps.forEach((t, i) => setTimeout(() => {
      if (onEach && onEach(t, i) === false) return;
      if (i === steps.length - 1) sfx.go(); else sfx.count();
      if (reduce) return;
      const s = document.createElement('div'); s.className = 'fxcount'; s.textContent = t; document.body.append(s);
      const an = s.animate([{ transform: 'translate(-50%,-50%) scale(2.4)', opacity: 0 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 1, offset: 0.35 },
        { transform: 'translate(-50%,-50%) scale(.85)', opacity: 0 }], { duration: gap * 0.95, easing: 'ease-out' });
      an.onfinish = () => s.remove();
    }, i * gap));
  }
  // 이름 글자를 하나씩 튀어나오게
  function popText(el) {
    if (reduce || !el) return;
    const text = el.textContent; el.textContent = '';
    [...text].forEach((ch, i) => {
      const sp = document.createElement('span'); sp.className = 'fxch'; sp.textContent = ch;
      sp.style.animationDelay = (i * 0.045).toFixed(3) + 's';
      el.append(sp);
    });
  }

  function setMuted(v) { muted = !!v; try { localStorage.setItem('mm.mute', muted ? '1' : '0'); } catch (e) { /* 무시 */ } }
  // iOS 등에서 첫 터치 때 소리를 깨워 둔다
  addEventListener('pointerdown', () => { if (!muted) audio(); }, { once: true });

  window.MMFX = { sfx, cannons, burst, sparkle, smoke, dust, shake, flash, stamp, countdown, popText, setMuted, isMuted: () => muted, reduce };
})();
