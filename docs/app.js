/* 뭐 먹노? — 친구·동료용 식당 고르기 (웹)
 * 서버 없음. 식당 데이터는 같은 사이트의 v1/ 폴더에서 읽고, 위치·기록은 이 브라우저에만 저장한다.
 * 보안: 외부 스크립트 없음, 데이터 문자열은 textContent 또는 esc()로만 화면에 넣는다.
 */
'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const WALK = 67; // 직선거리 기준 도보 m/분 (골목 우회 감안)
  const NEW_DAYS = 90;
  const DAY = 864e5;
  const COLORS = ['#E4473A', '#3E6BE0', '#1C9A55', '#F08A24', '#8A4FD0', '#149E9E', '#D64C8A', '#6B7A1E'];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ------------------------------------------------------------ 저장 (실패해도 동작)
  const store = {
    get(k, d) { try { const v = localStorage.getItem('mm.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('mm.' + k, JSON.stringify(v)); } catch (e) { /* 저장 불가 */ } },
  };
  let visits = store.get('visits', []);         // [[id, name, time]]
  let fav = new Set(store.get('fav', []));
  let hidden = store.get('hidden', {});          // {id: [until(0=계속), name]}
  const settings = Object.assign({ minutes: 10, exclude: true, shake: true, onboarded: false }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  // ------------------------------------------------------------ 상태
  const hour = new Date().getHours();
  const S = {
    meal: hour < 15 ? 'lunch' : 'dinner',
    round: 1,
    kinds: new Set(),
    cats: new Set(),
    minutes: settings.minutes,
    center: store.get('center', { lat: 35.1577, lng: 129.0592 }),
    myLoc: null,
    mine: false,
    journey: [],
    regions: [],
    loaded: new Map(),
    all: [],
    pool: [],
    area: '',
    state: 'idle',
    error: '',
  };
  const defaultKinds = (round, dinner) => round === 1 ? (dinner ? ['b', 's'] : ['b']) : round === 2 ? (dinner ? ['s'] : ['c']) : ['s', 'c'];
  S.kinds = new Set(defaultKinds(1, S.meal === 'dinner'));

  // ------------------------------------------------------------ 거리·날짜
  function dist(a, lat, lng) {
    const r = 6371000, p1 = a.lat * Math.PI / 180, p2 = lat * Math.PI / 180;
    const dp = p2 - p1, dl = (lng - a.lng) * Math.PI / 180;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  const walkMin = (m) => Math.max(1, Math.round(m / WALK));
  const todayYmd = (() => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
  function ymdToTime(ymd) { return new Date(Math.floor(ymd / 10000), Math.floor(ymd / 100) % 100 - 1, ymd % 100).getTime(); }
  const isNew = (r) => r.open > 19000101 && r.open <= todayYmd && (Date.now() - ymdToTime(r.open)) / DAY <= NEW_DAYS;

  // ------------------------------------------------------------ 종류(빠른 고르기)
  const CATS = [
    ['국물', (r) => /국밥|탕|국수|칼국수|찌개|곰탕|해장|라멘|우동|쌀국수|짬뽕|전골|순대|수제비|냉면|밀면/.test(r.name) || ['탕', '냉면'].includes(r.cat)],
    ['한식', (r) => ['한식', '탕', '냉면', '김밥'].includes(r.cat)],
    ['중식', (r) => r.cat === '중식' || /반점|짬뽕|마라|양꼬치|중화/.test(r.name)],
    ['일식', (r) => r.cat === '일식' || /스시|초밥|돈까스|돈카츠|라멘|우동|이자카야|규동|텐동/.test(r.name)],
    ['양식', (r) => ['양식', '레스토랑', '세계음식', '패스트푸드'].includes(r.cat) || /파스타|피자|버거|스테이크|브런치/.test(r.name)],
    ['분식', (r) => ['분식', '김밥'].includes(r.cat) || /떡볶이|김밥|분식/.test(r.name)],
    ['고기', (r) => r.cat === '고기구이' || /고기|갈비|삼겹|곱창|막창|대창|한우|족발|보쌈|오리/.test(r.name)],
    ['회·해물', (r) => ['횟집', '복어'].includes(r.cat) || /회센터|횟집|해물|조개|장어|아구|아귀|대게|물회/.test(r.name)],
    ['치킨·호프', (r) => ['치킨', '호프'].includes(r.cat) || /치킨|통닭|호프|비어/.test(r.name)],
  ];
  const catFn = new Map(CATS);

  // ------------------------------------------------------------ 후보 계산
  function recentIds() {
    const now = Date.now();
    return new Set(visits.filter((v) => now - v[2] < 7 * DAY).map((v) => v[0]));
  }
  function regulars() {
    const now = Date.now(), cnt = {};
    for (const v of visits) if (now - v[2] < 60 * DAY) cnt[v[0]] = (cnt[v[0]] || 0) + 1;
    const out = new Set(fav);
    for (const k in cnt) if (cnt[k] >= 3) out.add(k);
    return out;
  }
  function isHidden(id) {
    const h = hidden[id];
    return !!h && (h[0] === 0 || h[0] > Date.now());
  }
  const kindOk = (k) => (k === 'b' && S.kinds.has('b')) || (k === 's' && S.kinds.has('s')) ||
    (k === 'bs' && (S.kinds.has('b') || S.kinds.has('s'))) || (k === 'c' && S.kinds.has('c'));
  function catOk(r) {
    if (!S.cats.size) return true;
    for (const c of S.cats) if (catFn.get(c)(r)) return true;
    return false;
  }
  function computePool() {
    const limit = S.minutes * WALK;
    const dLat = limit / 111000, dLng = limit / (111000 * Math.max(0.2, Math.cos(S.center.lat * Math.PI / 180)));
    const ex = new Set();
    if (settings.exclude) for (const id of recentIds()) ex.add(id);
    S.journey.slice(0, S.round - 1).forEach((r) => ex.add(r.id));
    const out = [], seen = new Set(), excluded = [];
    for (const r of S.all) {
      if (r.lat < S.center.lat - dLat || r.lat > S.center.lat + dLat || r.lng < S.center.lng - dLng || r.lng > S.center.lng + dLng) continue;
      if (!kindOk(r.kind) || isHidden(r.id) || !catOk(r)) continue;
      const m = dist(S.center, r.lat, r.lng);
      if (m > limit) continue;
      if (ex.has(r.id)) { excluded.push({ r, m }); continue; }
      const key = r.name + '@' + Math.round(r.lat * 5000) + ',' + Math.round(r.lng * 5000);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ r, m });
    }
    out.sort((a, b) => a.m - b.m);
    S.pool = out;
    S.excluded = excluded;
  }

  // ------------------------------------------------------------ 데이터
  async function loadManifest(force) {
    const res = await fetch('v1/manifest.json', { cache: force ? 'reload' : 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const m = await res.json();
    S.regions = (m.regions || []).filter((x) => /^\d{7}$/.test(x.c) && Array.isArray(x.b) && x.b.length === 4).map((x) => ({
      code: x.c, name: String(x.n || '').slice(0, 30), count: x.cnt | 0, sha: String(x.sha || ''),
      minLat: x.b[0] / 1e6, minLng: x.b[1] / 1e6, maxLat: x.b[2] / 1e6, maxLng: x.b[3] / 1e6,
    }));
    S.generated = String(m.generated || '').slice(0, 10);
  }
  async function sha256(buf) {
    if (!(crypto && crypto.subtle)) return null;
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\ufeff]/g, '').trim().slice(0, n);
  function parseRegion(data, region) {
    const out = [];
    for (const f of data.r || []) {
      if (!Array.isArray(f) || f.length < 11) continue;
      const kind = String(f[2]);
      if (!['b', 's', 'bs', 'c'].includes(kind)) continue;
      const lat = Number(f[4]) / 1e6, lng = Number(f[5]) / 1e6;
      if (!(lat > 32 && lat < 39.5 && lng > 124 && lng < 132.5)) continue;
      const name = clip(f[1], 60).replace(/^(주식회사|유한회사|농업회사법인|\(주\)|㈜)\s*/, '').replace(/\s*(주식회사|\(주\)|㈜)$/, '').slice(0, 40);
      if (!name) continue;
      out.push({
        id: clip(f[0], 60), name, kind, cat: clip(f[3], 12) || '음식점', lat, lng, addr: clip(f[6], 90),
        tel: clip(f[7], 14).replace(/[^\d-]/g, ''), open: Number(f[8]) || 0, model: (Number(f[9]) & 1) === 1,
        kakao: clip(f[10], 20).replace(/\D/g, ''), food: clip(f[11], 20), region: region.name,
      });
    }
    return out;
  }
  async function loadRegion(region) {
    if (S.loaded.has(region.code)) return S.loaded.get(region.code);
    const url = 'v1/r/' + region.code + '.json?v=' + region.sha.slice(0, 16);
    let res = await fetch(url);
    let buf = await res.arrayBuffer();
    const h = await sha256(buf);
    if (h && region.sha && h !== region.sha) { // 저장본이 깨졌거나 오래됨 → 다시 받기
      res = await fetch(url, { cache: 'reload' });
      buf = await res.arrayBuffer();
    }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const list = parseRegion(JSON.parse(new TextDecoder().decode(buf)), region);
    S.loaded.set(region.code, list);
    return list;
  }
  let loadToken = 0;
  async function loadAround() {
    const token = ++loadToken;
    setState('loading');
    try {
      if (!S.regions.length) await loadManifest(false);
    } catch (e) {
      S.error = e.message || String(e);
      setState('offline');
      return;
    }
    const pad = 0.025, cosLat = Math.max(0.2, Math.cos(S.center.lat * Math.PI / 180));
    const near = S.regions.filter((r) => S.center.lat >= r.minLat - pad && S.center.lat <= r.maxLat + pad &&
      S.center.lng >= r.minLng - pad / cosLat && S.center.lng <= r.maxLng + pad / cosLat)
      .sort((a, b) => dist(S.center, (a.minLat + a.maxLat) / 2, (a.minLng + a.maxLng) / 2) - dist(S.center, (b.minLat + b.maxLat) / 2, (b.minLng + b.maxLng) / 2))
      .slice(0, 6);
    if (!near.length) { S.all = []; S.area = ''; setState('nodata'); return; }
    const keep = new Set(near.map((r) => r.code));
    for (const k of [...S.loaded.keys()]) if (!keep.has(k) && S.loaded.size > 8) S.loaded.delete(k);
    let ok = 0;
    for (const r of near) {
      try { await loadRegion(r); ok++; } catch (e) { S.error = e.message || String(e); }
      if (token !== loadToken) return;
    }
    const ids = new Set(), all = [];
    for (const r of near) for (const x of S.loaded.get(r.code) || []) if (!ids.has(x.id)) { ids.add(x.id); all.push(x); }
    S.all = all;
    // 지역 이름: 중심에서 가장 가까운 식당이 속한 시·군·구
    let best = null, bd = Infinity;
    for (const x of all) {
      if (Math.abs(x.lat - S.center.lat) > 0.02 || Math.abs(x.lng - S.center.lng) > 0.025) continue;
      const d = dist(S.center, x.lat, x.lng);
      if (d < bd) { bd = d; best = x; }
    }
    S.area = best ? best.region : near[0].name;
    setState(ok ? 'ready' : 'offline');
  }

  // ------------------------------------------------------------ 위치
  function locate(ask) {
    if (!('geolocation' in navigator)) { toast('이 브라우저는 위치를 지원하지 않아요. 지역을 골라 주세요.'); loadAround(); return; }
    setState('locating');
    navigator.geolocation.getCurrentPosition((p) => {
      S.myLoc = { lat: p.coords.latitude, lng: p.coords.longitude };
      moveCenter(S.myLoc, false);
    }, (err) => {
      if (err && err.code === 1) {
        toast('위치 권한이 없어요. 지역을 골라 주세요.');
        if (ask) openRegions();
      } else toast('위치를 찾지 못했어요. 지역을 골라 주세요.');
      loadAround();
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 });
  }
  function moveCenter(c, announce) {
    S.center = { lat: c.lat, lng: c.lng };
    S.mine = !!S.myLoc && dist(S.myLoc, c.lat, c.lng) < 30;
    store.set('center', S.center);
    if (announce) toast('이 지점을 중심으로 다시 찾았어요');
    loadAround();
  }
  async function pickRegion(region) {
    closeSheet();
    setState('loading');
    let target = { lat: (region.minLat + region.maxLat) / 2, lng: (region.minLng + region.maxLng) / 2 };
    try {
      const list = await loadRegion(region);
      const cell = 0.004, cnt = new Map();
      for (const x of list) { const k = Math.floor(x.lat / cell) + ':' + Math.floor(x.lng / cell); cnt.set(k, (cnt.get(k) || 0) + 1); }
      let best = null, bc = 0;
      for (const [k, v] of cnt) if (v > bc) { bc = v; best = k; }
      if (best) {
        const inCell = list.filter((x) => Math.floor(x.lat / cell) + ':' + Math.floor(x.lng / cell) === best);
        target = { lat: inCell.reduce((s, x) => s + x.lat, 0) / inCell.length, lng: inCell.reduce((s, x) => s + x.lng, 0) / inCell.length };
      }
    } catch (e) { /* 가운데로 */ }
    moveCenter(target, false);
  }

  // ------------------------------------------------------------ 화면: 상태
  function setState(s) {
    S.state = s;
    const box = $('#status');
    const msg = {
      locating: '내 위치를 찾는 중…',
      loading: '주변 식당을 불러오는 중…',
      nodata: '이 지역은 식당 정보를 준비 중이에요.\n위쪽 지역 이름을 눌러 다른 곳을 골라 보세요.',
      offline: '인터넷 연결을 확인해 주세요.',
    }[s];
    box.textContent = '';
    if (msg) {
      box.hidden = false;
      const t = document.createElement('div');
      t.textContent = msg;
      t.style.whiteSpace = 'pre-line';
      box.append(t);
      if (s === 'offline') {
        if (S.error) { const sm = document.createElement('small'); sm.textContent = S.error; box.append(sm); }
        const b = document.createElement('button');
        b.className = 'btn primary sm';
        b.textContent = '다시 시도';
        b.onclick = () => { S.regions = []; loadAround(); };
        box.append(b);
      }
    } else box.hidden = true;
    render();
  }

  // ------------------------------------------------------------ 화면: 지도
  const canvas = $('#map');
  const ctx = canvas.getContext('2d');
  let view = null; // 좌표 변환 정보
  function drawMap() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const radiusM = S.minutes * WALK, radiusPx = Math.min(w, h) / 2 * 0.84, mpp = radiusM / radiusPx;
    const cosLat = Math.cos(S.center.lat * Math.PI / 180);
    const cx = w / 2, cy = h / 2;
    const toPx = (lat, lng) => [cx + (lng - S.center.lng) * 111320 * cosLat / mpp, cy - (lat - S.center.lat) * 110540 / mpp];
    view = { toPx, mpp, cx, cy, cosLat, w, h };
    const P = { map: css('--map'), line: css('--line'), muted: css('--muted'), accent: css('--accent'), ring: css('--ring'), ink: css('--ink'),
      surface: css('--surface'), bg: css('--bg'), b: css('--meal'), s: css('--drink'), bs: css('--both'), c: css('--cafe') };
    ctx.fillStyle = P.map; ctx.fillRect(0, 0, w, h);
    const grid = 100 / mpp;
    if (grid > 12) {
      ctx.strokeStyle = P.line; ctx.globalAlpha = 0.45; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = cx % grid; x < w; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = cy % grid; y < h; y += grid) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    ctx.font = '700 11px ' + css('--font');
    ctx.setLineDash([4, 4]); ctx.strokeStyle = P.muted; ctx.globalAlpha = 0.4;
    for (const m of [5, 10, 15]) {
      if (m >= S.minutes) continue;
      const rr = m * WALK / mpp;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = P.muted; ctx.globalAlpha = 0.8; ctx.fillText(m + '분', cx + 4, cy - rr - 4); ctx.globalAlpha = 0.4;
    }
    ctx.globalAlpha = 1; ctx.setLineDash([]);
    ctx.fillStyle = P.accent; ctx.globalAlpha = 0.16; ctx.beginPath(); ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    ctx.setLineDash([11, 6]); ctx.lineWidth = 2.5; ctx.strokeStyle = P.ring; ctx.beginPath(); ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = P.muted; ctx.textAlign = 'center'; ctx.fillText('도보 ' + S.minutes + '분', cx, cy - radiusPx - 8);
    // 흐린 점: 화면 안 가게들
    const poolIds = new Set(S.pool.map((c) => c.r.id));
    const halfLat = (h / 2 * mpp) / 110540 * 1.1, halfLng = (w / 2 * mpp) / (111320 * cosLat) * 1.1;
    ctx.fillStyle = P.muted; ctx.globalAlpha = 0.28;
    let n = 0;
    for (const r of S.all) {
      if (Math.abs(r.lat - S.center.lat) > halfLat || Math.abs(r.lng - S.center.lng) > halfLng || poolIds.has(r.id)) continue;
      const [x, y] = toPx(r.lat, r.lng);
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      if (++n > 4000) break;
    }
    ctx.globalAlpha = 1;
    // 이번 주에 간 곳
    for (const e of S.excluded || []) {
      const [x, y] = toPx(e.r.lat, e.r.lng);
      ctx.fillStyle = P.surface; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = P.muted; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.stroke();
    }
    // 후보
    const regs = regulars();
    const showNames = S.pool.length <= 18;
    for (const c of S.pool) {
      const [x, y] = toPx(c.r.lat, c.r.lng);
      ctx.fillStyle = P.surface; ctx.beginPath(); ctx.arc(x, y, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = P[c.r.kind] || P.b; ctx.beginPath(); ctx.arc(x, y, 5.8, 0, Math.PI * 2); ctx.fill();
      if (regs.has(c.r.id) || c.r.model) { ctx.strokeStyle = P.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (showNames) {
      ctx.font = '700 11px ' + css('--font'); ctx.textAlign = 'center';
      for (const c of S.pool) {
        const [x, y] = toPx(c.r.lat, c.r.lng);
        const t = c.r.name.length > 10 ? c.r.name.slice(0, 9) + '…' : c.r.name;
        ctx.lineWidth = 3; ctx.strokeStyle = P.map; ctx.strokeText(t, x, y + 20);
        ctx.fillStyle = P.ink; ctx.fillText(t, x, y + 20);
      }
    }
    // 여정
    S.journey.forEach((r, i) => {
      const [x, y] = toPx(r.lat, r.lng);
      ctx.fillStyle = P.ink; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = P.bg; ctx.font = '900 13px ' + css('--font'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 1); ctx.textBaseline = 'alphabetic';
    });
    // 내 위치
    if (S.myLoc && !S.mine) {
      const [x, y] = toPx(S.myLoc.lat, S.myLoc.lng);
      ctx.fillStyle = 'rgba(47,123,246,.25)'; ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2F7BF6'; ctx.beginPath(); ctx.arc(x, y, 4.3, 0, Math.PI * 2); ctx.fill();
    }
    // 중심
    ctx.fillStyle = P.accent; ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = P.ink; ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = P.ink; ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.textAlign = 'left'; ctx.fillStyle = P.muted; ctx.font = '700 11px ' + css('--font'); ctx.fillText('N ↑', w - 34, h - 62);
    canvas.setAttribute('aria-label', '도보 ' + S.minutes + '분 반경 지도, 후보 ' + S.pool.length + '곳');
  }
  canvas.addEventListener('click', (e) => {
    if (!view) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 22;
    for (const c of S.pool) {
      const [px, py] = view.toPx(c.r.lat, c.r.lng);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = c.r; }
    }
    if (best) { openDetail(best); return; }
    const lat = S.center.lat + (view.cy - y) * view.mpp / 110540;
    const lng = S.center.lng + (x - view.cx) * view.mpp / (111320 * view.cosLat);
    moveCenter({ lat, lng }, true);
  });

  // ------------------------------------------------------------ 화면: 패널
  const GAMES = [
    ['roulette', '룰렛', '돌려서 뽑기', '<circle cx="16" cy="17" r="12" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M16 17V5M16 17l10.4 6M16 17L5.6 23" stroke="currentColor" stroke-width="2.6"/>'],
    ['ladder', '사다리', '번호 골라 타기', '<path d="M7 4v24M16 4v24M25 4v24M7 10h9M16 16h9M7 22h9" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'],
    ['pirate', '해적 룰렛', '튀어나오면 당첨', '<path d="M7 14q-2 8 0 15h18q2-7 0-15z" fill="currentColor"/><circle cx="16" cy="8" r="5" fill="currentColor"/><path d="M2 20l9 1" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'],
    ['race', '경마', '역전의 레이스', '<path d="M2 8h28M2 16h28M2 24h28" stroke="currentColor" stroke-width="1.5" opacity=".4"/><circle cx="10" cy="8" r="3.5" fill="currentColor"/><circle cx="18" cy="16" r="3.5" fill="currentColor"/><circle cx="25" cy="24" r="3.5" fill="currentColor"/>'],
    ['cup', '식당 월드컵', '둘 중 하나 고르기', '<path d="M8 4h16q0 14-8 15Q8 18 8 4z" fill="currentColor"/><path d="M16 19v6M10 28h12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>'],
    ['bomb', '폭탄 돌리기', '폰 넘기며 복불복', '<circle cx="14" cy="19" r="10" fill="currentColor"/><path d="M20 10l6-6" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'],
    ['slot', '바로 뽑기', '1초 결정', '<path d="M18 2L6 18h9l-2 12 13-17h-9z" fill="currentColor"/>'],
    ['shake', '흔들어 뽑기', '폰을 흔들면 끝', '<rect x="10" y="3" width="12" height="26" rx="3" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M4 12v8M28 12v8" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'],
  ];
  function buildStatic() {
    const g = $('#games');
    for (const [id, t, d, icon] of GAMES) {
      const b = document.createElement('button');
      b.className = 'game' + (id === 'slot' ? ' hot' : '');
      b.dataset.g = id;
      b.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true">' + icon + '</svg><b>' + esc(t) + '</b><small>' + esc(d) + '</small>';
      g.append(b);
    }
    const cats = $('#cats');
    for (const [name] of [['전체'], ...CATS]) {
      const b = document.createElement('button');
      b.dataset.cat = name;
      b.textContent = name;
      cats.append(b);
    }
  }
  function render() {
    computePool();
    $('#mLunch').setAttribute('aria-pressed', S.meal === 'lunch');
    $('#mDinner').setAttribute('aria-pressed', S.meal === 'dinner');
    $('#tMeal').setAttribute('aria-pressed', S.kinds.has('b'));
    $('#tDrink').setAttribute('aria-pressed', S.kinds.has('s'));
    $('#tCafe').setAttribute('aria-pressed', S.kinds.has('c'));
    $('#tExcl').setAttribute('aria-pressed', settings.exclude);
    const rounds = $('#rounds'); rounds.textContent = '';
    for (const n of [1, 2, 3]) {
      const b = document.createElement('button'); b.dataset.r = n; b.textContent = n + '차';
      b.setAttribute('aria-pressed', S.round === n); rounds.append(b);
    }
    const rad = $('#radius'); rad.textContent = '';
    for (const m of [5, 10, 15, 20]) {
      const b = document.createElement('button'); b.dataset.m = m; b.textContent = m + '분';
      b.setAttribute('aria-pressed', S.minutes === m); rad.append(b);
    }
    for (const b of $('#cats').children) {
      const on = b.dataset.cat === '전체' ? S.cats.size === 0 : S.cats.has(b.dataset.cat);
      b.setAttribute('aria-pressed', on);
    }
    $('#count').textContent = '후보 ' + S.pool.length.toLocaleString('ko-KR') + '곳';
    $('#areaBtn').textContent = (S.mine ? '내 위치 · ' : '') + (S.area || '지역 선택');
    $('#locBtn').classList.toggle('mine', S.mine);
    const j = $('#journey'); j.textContent = '';
    S.journey.forEach((r, i) => {
      const b = document.createElement('button'); b.className = 'jchip'; b.textContent = (i + 1) + '차 ' + r.name;
      b.onclick = () => openDetail(r); j.append(b);
    });
    if (S.journey.length) {
      const b = document.createElement('button'); b.className = 'jchip strong'; b.textContent = '처음부터';
      b.onclick = resetJourney; j.append(b);
    }
    const nx = $('#next'); nx.textContent = '';
    const decided = S.journey[S.round - 1];
    if (decided && S.round < 3) {
      nx.hidden = false;
      const sp = document.createElement('span'); sp.textContent = S.round + '차 ' + decided.name + ' 결정';
      const b = document.createElement('button'); b.className = 'btn ink sm'; b.textContent = (S.round + 1) + '차 고르기 →';
      b.onclick = nextRound; nx.append(sp, b);
    } else nx.hidden = true;
    drawMap();
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t || t.closest('.overlay') || t.closest('.sheet')) return;
    if (t.id === 'mLunch' || t.id === 'mDinner') {
      S.meal = t.id === 'mLunch' ? 'lunch' : 'dinner';
      S.kinds = new Set(defaultKinds(S.round, S.meal === 'dinner')); render();
    } else if (t.id === 'tMeal' || t.id === 'tDrink' || t.id === 'tCafe') {
      const k = { tMeal: 'b', tDrink: 's', tCafe: 'c' }[t.id];
      if (S.kinds.has(k)) { if (S.kinds.size > 1) S.kinds.delete(k); } else S.kinds.add(k);
      render();
    } else if (t.id === 'tExcl') { settings.exclude = !settings.exclude; saveSettings(); render(); }
    else if (t.dataset.r) { S.round = +t.dataset.r; S.kinds = new Set(defaultKinds(S.round, S.meal === 'dinner')); render(); }
    else if (t.dataset.m) { S.minutes = +t.dataset.m; settings.minutes = S.minutes; saveSettings(); render(); }
    else if (t.dataset.cat) {
      const c = t.dataset.cat;
      if (c === '전체') S.cats.clear(); else if (S.cats.has(c)) S.cats.delete(c); else S.cats.add(c);
      render();
    } else if (t.dataset.g) startGame(t.dataset.g);
    else if (t.id === 'locBtn') locate(true);
    else if (t.id === 'areaBtn') openRegions();
    else if (t.id === 'searchBtn') openSearch();
    else if (t.id === 'setBtn') openSettings();
  });

  function nextRound() {
    const last = S.journey[S.round - 1];
    if (!last) return;
    S.round = Math.min(3, S.round + 1);
    S.kinds = new Set(defaultKinds(S.round, S.meal === 'dinner'));
    S.minutes = Math.min(S.minutes, 10);
    toast(S.round + '차: 「' + last.name + '」 근처 도보 ' + S.minutes + '분');
    moveCenter(last, false);
  }
  function resetJourney() {
    S.journey = []; S.round = 1; S.kinds = new Set(defaultKinds(1, S.meal === 'dinner'));
    if (S.myLoc) moveCenter(S.myLoc, false); else render();
  }
  function decide(r) {
    visits.push([r.id, r.name, Date.now()]);
    visits = visits.filter((v) => Date.now() - v[2] < 90 * DAY).slice(-400);
    store.set('visits', visits);
    S.journey = S.journey.slice(0, S.round - 1);
    S.journey[S.round - 1] = r;
    closeGame(); closeSheet();
    toast(S.round + '차 「' + r.name + '」로 결정! 이번 주 기록에 남겼어요');
    render();
  }
  function hide(r, days) {
    hidden[r.id] = [days ? Date.now() + days * DAY : 0, r.name];
    store.set('hidden', hidden);
    toast(days ? '「' + r.name + '」 ' + days + '일 동안 안 보여요' : '「' + r.name + '」 이제 안 보여요 (설정에서 되돌리기)');
    render();
  }

  // ------------------------------------------------------------ 바깥 연결
  const kakaoPlace = (r) => r.kakao ? 'https://place.map.kakao.com/' + r.kakao : 'https://map.kakao.com/link/search/' + encodeURIComponent(r.name);
  const kakaoRoute = (r) => 'https://map.kakao.com/link/to/' + encodeURIComponent(r.name.replace(/,/g, ' ')) + ',' + r.lat.toFixed(6) + ',' + r.lng.toFixed(6);
  function shareUrl(r, round) {
    const u = new URL(location.href.split('?')[0].split('#')[0]);
    u.searchParams.set('eat', r.id); u.searchParams.set('n', String(round));
    return u.toString();
  }
  async function share(r, round, mins) {
    const text = '오늘 ' + round + '차는 「' + r.name + '」 당첨! (' + r.cat + ', 도보 약 ' + mins + '분)';
    const url = shareUrl(r, round);
    try {
      if (navigator.share) { await navigator.share({ title: '뭐 먹노?', text, url }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text + '\n' + url); toast('복사했어요. 단톡방에 붙여 넣으세요'); }
    catch (e) { prompt2(text + '\n' + url); }
  }
  function prompt2(text) {
    openSheet('공유할 글', (body) => {
      const ta = document.createElement('textarea'); ta.className = 'search'; ta.rows = 4; ta.value = text; ta.readOnly = true;
      body.append(ta, note('글을 길게 눌러 복사하세요.'));
      setTimeout(() => ta.select(), 50);
    });
  }
  function link(label, href, cls) {
    const a = document.createElement('a');
    a.className = 'btn ' + (cls || ''); a.textContent = label; a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.style.textDecoration = 'none'; a.style.color = 'inherit';
    return a;
  }

  // ------------------------------------------------------------ 게임
  const TITLES = { roulette: '룰렛', ladder: '사다리 타기', pirate: '해적 룰렛', race: '경마', cup: '식당 월드컵', bomb: '폭탄 돌리기', slot: '바로 뽑기', shake: '흔들어 뽑기' };
  const SIZE = { roulette: 8, ladder: 5, pirate: 8, race: 6, cup: 8, bomb: 12, slot: 12, shake: 12 };
  const stage = $('#stage'), result = $('#result');
  let curGame = null, cands = [], timers = [], rafId = 0, gameKey = 0;
  function stopAll() { timers.forEach(clearTimeout); timers = []; cancelAnimationFrame(rafId); window.removeEventListener('devicemotion', onMotionGame); }
  const later = (fn, ms) => { const k = gameKey; timers.push(setTimeout(() => { if (k === gameKey) fn(); }, ms)); };
  const buzz = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch (e) { /* 지원 안 함 */ } };
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  function startGame(type) {
    computePool();
    const p = S.pool;
    if (!p.length) { toast(S.state === 'ready' ? '조건에 맞는 곳이 없어요. 반경을 넓히거나 종류를 풀어 보세요.' : '식당 정보를 불러오는 중이에요'); return; }
    if (p.length === 1) { toast('후보가 1곳뿐이에요'); openDetail(p[0].r); return; }
    let n = SIZE[type];
    if (type === 'ladder' && innerWidth > innerHeight && innerWidth >= 600) n = 6;
    if (type === 'cup') n = p.length >= 8 ? 8 : p.length >= 4 ? 4 : 2;
    curGame = type;
    cands = shuffle(p).slice(0, n);
    stopAll(); gameKey++;
    $('#game').hidden = false; result.hidden = true; stage.textContent = '';
    $('#gTitle').textContent = TITLES[type];
    $('#gHead').textContent = S.round + '차 · ' + (S.meal === 'lunch' ? '점심' : '저녁') + ' · 후보 ' + cands.length + '곳 (전체 ' + p.length.toLocaleString('ko-KR') + '곳)';
    requestAnimationFrame(() => ({ roulette, ladder, pirate, race, cup, bomb, slot, shake: shakeGame })[type](cands));
  }
  function closeGame() { stopAll(); gameKey++; $('#game').hidden = true; curGame = null; }
  $('#gClose').onclick = closeGame;

  const FX = window.MMFX || { sfx: new Proxy({}, { get: () => () => {} }), cannons() {}, burst() {}, sparkle() {}, smoke() {}, dust() {}, shake() {}, flash() {}, stamp() {}, countdown() {}, popText() {} };
  const sfx = FX.sfx;
  const rectOf = (el) => el.getBoundingClientRect();

  function roulette(c) {
    const n = c.length, seg = Math.PI * 2 / n;
    const size = Math.floor(Math.max(220, Math.min(stage.clientWidth - 8, stage.clientHeight - 96, 440)));
    stage.innerHTML = '<div class="wheel" id="wheel"><canvas id="wc"></canvas><div class="ptr" id="ptr"></div></div><button class="btn primary big" id="spin">돌리기</button>';
    const cv = $('#wc'), ptr = $('#ptr'), dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = cv.height = size * dpr; cv.style.width = cv.style.height = size + 'px';
    const g = cv.getContext('2d'); g.scale(dpr, dpr);
    const ink = css('--ink'), font = css('--font');
    let rot = -Math.PI / 2 - seg / 2, spinning = false, highlight = -1, glow = 0;
    const R = size / 2, rim = Math.max(14, size * 0.055), rIn = R - rim;
    function draw(t) {
      const cc = R;
      g.clearRect(0, 0, size, size);
      // 금색 테두리
      const rg = g.createRadialGradient(cc, cc, rIn, cc, cc, R);
      rg.addColorStop(0, '#8a5a00'); rg.addColorStop(0.5, '#ffd54a'); rg.addColorStop(1, '#a86f00');
      g.beginPath(); g.arc(cc, cc, R - 1, 0, Math.PI * 2); g.fillStyle = rg; g.fill();
      // 칸
      for (let i = 0; i < n; i++) {
        g.beginPath(); g.moveTo(cc, cc); g.arc(cc, cc, rIn, rot + i * seg, rot + (i + 1) * seg); g.closePath();
        g.fillStyle = COLORS[i % COLORS.length]; g.fill();
        if (highlight >= 0 && i !== highlight) { g.fillStyle = 'rgba(0,0,0,.55)'; g.fill(); }
        if (i === highlight) { g.fillStyle = 'rgba(255,255,255,' + (0.18 + 0.22 * glow) + ')'; g.fill(); }
        g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineWidth = 2; g.stroke();
        const mid = rot + (i + 0.5) * seg;
        const norm = ((mid % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const flip = norm > Math.PI / 2 && norm < Math.PI * 1.5;
        g.save(); g.translate(cc, cc); g.rotate(flip ? mid + Math.PI : mid);
        g.fillStyle = '#fff'; g.font = '800 ' + Math.round(Math.max(12, Math.min(17, size / 24))) + 'px ' + font;
        g.textBaseline = 'middle'; g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 3;
        const nm = c[i].r.name.length > 9 ? c[i].r.name.slice(0, 8) + '…' : c[i].r.name;
        if (flip) { g.textAlign = 'left'; g.fillText(nm, -rIn + 14, 0); } else { g.textAlign = 'right'; g.fillText(nm, rIn - 14, 0); }
        g.restore();
      }
      // 입체감
      const sh = g.createRadialGradient(cc - rIn * 0.3, cc - rIn * 0.35, rIn * 0.1, cc, cc, rIn);
      sh.addColorStop(0, 'rgba(255,255,255,.22)'); sh.addColorStop(0.6, 'rgba(255,255,255,0)'); sh.addColorStop(1, 'rgba(0,0,0,.22)');
      g.beginPath(); g.arc(cc, cc, rIn, 0, Math.PI * 2); g.fillStyle = sh; g.fill();
      // 전구
      const bulbs = 24, on = Math.floor((t || 0) / (spinning ? 90 : 380)) % 2;
      for (let b = 0; b < bulbs; b++) {
        const a = b / bulbs * Math.PI * 2, x = cc + Math.cos(a) * (R - rim / 2), y = cc + Math.sin(a) * (R - rim / 2);
        const lit = (b % 2) === on;
        g.beginPath(); g.arc(x, y, rim * 0.22, 0, Math.PI * 2);
        g.fillStyle = lit ? '#fffbe0' : '#a3740a'; g.shadowColor = lit ? '#fff3a0' : 'transparent'; g.shadowBlur = lit ? 8 : 0; g.fill();
      }
      g.shadowBlur = 0;
      // 가운데
      g.beginPath(); g.arc(cc, cc, size * 0.1, 0, Math.PI * 2); g.fillStyle = ink; g.fill();
      g.beginPath(); g.arc(cc, cc, size * 0.045, 0, Math.PI * 2); g.fillStyle = '#FFC21A'; g.fill();
    }
    // 대기 중에도 전구가 깜빡이게
    const key0 = gameKey;
    (function idle(t) { if (key0 !== gameKey) return; if (!spinning) draw(t); rafId = requestAnimationFrame(idle); })(performance.now());
    function flap() { if (!FX.reduce && ptr.animate) ptr.animate([{ transform: 'translateX(-50%) rotate(0)' }, { transform: 'translateX(-50%) rotate(-24deg)' }, { transform: 'translateX(-50%) rotate(0)' }], { duration: 110 }); }
    function spin() {
      if (spinning) return;
      spinning = true; highlight = -1; $('#spin').disabled = true; result.hidden = true;
      sfx.whoosh();
      const win = Math.floor(Math.random() * n), jit = (Math.random() - 0.5) * seg * 0.7;
      let target = -Math.PI / 2 - (win + 0.5) * seg + jit;
      const turns = reduce ? 1 : 7 + Math.floor(Math.random() * 3);
      while (target < rot + turns * Math.PI * 2) target += Math.PI * 2;
      const from = rot, dur = reduce ? 500 : 5200, t0 = performance.now(), k = gameKey;
      let last = -1;
      cancelAnimationFrame(rafId);
      (function f(t) {
        if (k !== gameKey) return;
        const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 4.2);
        rot = from + (target - from) * e; draw(t);
        const cur = Math.floor((((-Math.PI / 2 - rot) % (Math.PI * 2)) + Math.PI * 4) % (Math.PI * 2) / seg);
        if (cur !== last) { last = cur; sfx.tick(); flap(); if (p > 0.6) buzz(5); }
        if (p < 1) { rafId = requestAnimationFrame(f); return; }
        // 멈춘 칸을 반짝인 뒤 발표
        highlight = win;
        const t1 = performance.now();
        (function glowLoop(tt) {
          if (k !== gameKey) return;
          const q = (tt - t1) / 900;
          glow = 0.5 + 0.5 * Math.sin(q * Math.PI * 4); draw(tt);
          if (q < 1 && !reduce) { rafId = requestAnimationFrame(glowLoop); return; }
          spinning = false; const b = $('#spin'); b.disabled = false; b.textContent = '한 번 더 돌리기';
          showResult(c[win], $('#wheel'));
          (function idle2(t2) { if (k !== gameKey || spinning) return; draw(t2); rafId = requestAnimationFrame(idle2); })(performance.now());
        })(t1);
      })(t0);
    }
    $('#spin').onclick = spin; cv.onclick = spin;
  }

  function ladder(c) {
    const n = c.length, H = 300, ys = [];
    for (let y = 30; y <= 270; y += 20) ys.push(y);
    const occ = {}, rungs = [];
    for (let g = 0; g < n - 1; g++) {
      const want = 3 + Math.floor(Math.random() * 2); let got = 0, tries = 0;
      while (got < want && tries++ < 80) {
        const y = ys[Math.floor(Math.random() * ys.length)], o = occ[y] || (occ[y] = new Set());
        if (o.has(g) || o.has(g - 1) || o.has(g + 1)) continue;
        o.add(g); rungs.push({ g, y }); got++;
      }
    }
    rungs.sort((a, b) => a.y - b.y);
    const X = (i) => i * 100 + 50;
    function trace(i) {
      let pos = i; const pts = [[X(i), 0]];
      for (const r of rungs) {
        if (r.g === pos) { pts.push([X(pos), r.y], [X(pos + 1), r.y]); pos++; } else if (r.g === pos - 1) { pts.push([X(pos), r.y], [X(pos - 1), r.y]); pos--; }
      }
      pts.push([X(pos), H]); return { pts, end: pos };
    }
    let lines = '';
    for (let i = 0; i < n; i++) lines += '<line x1="' + X(i) + '" y1="0" x2="' + X(i) + '" y2="' + H + '" vector-effect="non-scaling-stroke"/>';
    for (const r of rungs) lines += '<line x1="' + X(r.g) + '" y1="' + r.y + '" x2="' + X(r.g + 1) + '" y2="' + r.y + '" vector-effect="non-scaling-stroke"/>';
    const cols = 'grid-template-columns:repeat(' + n + ',1fr)';
    stage.innerHTML = '<p class="hint" id="lh">번호 하나를 누르면 사다리를 타고 내려가요</p><div class="ladder">' +
      '<div class="lrow" id="ltop"></div>' +
      '<svg id="lsvg" viewBox="0 0 ' + n * 100 + ' ' + H + '" preserveAspectRatio="none"><g stroke="' + esc(css('--muted')) + '" stroke-width="5" stroke-linecap="round">' + lines +
      '</g><polyline id="lglow" fill="none" stroke-width="18" stroke-opacity=".35" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      '<polyline id="lpath" fill="none" stroke-width="8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>' +
      '<div class="lrow" id="lbot"></div></div>';
    const top = $('#ltop'), bot = $('#lbot'), svg = $('#lsvg');
    top.style.cssText = cols; bot.style.cssText = cols;
    c.forEach((_, i) => {
      const b = document.createElement('button'); b.textContent = String(i + 1); b.style.background = COLORS[i % COLORS.length]; b.dataset.l = i;
      b.style.animationDelay = (i * 0.08) + 's'; b.className = 'bounce'; top.append(b);
      const d = document.createElement('div'); d.className = 'lab'; d.textContent = '?'; bot.append(d);
    });
    top.onclick = (e) => {
      const b = e.target.closest('[data-l]'); if (!b || b.disabled) return;
      [...top.children].forEach((x) => { x.disabled = x !== b; x.classList.remove('bounce'); });
      b.disabled = true;
      $('#lh').textContent = '두근두근…';
      sfx.drum(14);
      const i = +b.dataset.l, { pts, end } = trace(i), pl = $('#lpath'), gl = $('#lglow');
      const color = COLORS[i % COLORS.length];
      pl.setAttribute('stroke', color); gl.setAttribute('stroke', color);
      const segs = []; let total = 0;
      for (let k = 1; k < pts.length; k++) { const l = Math.hypot(pts[k][0] - pts[k - 1][0], (pts[k][1] - pts[k - 1][1]) * 1.6); segs.push(l); total += l; }
      const dur = reduce ? 300 : 3200, t0 = performance.now(), key = gameKey;
      let lastCorner = 0, frame = 0;
      (function f(t) {
        if (key !== gameKey) return;
        const p = Math.min(1, (t - t0) / dur);
        let d = total * (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
        const out = [pts[0]]; let corners = 0;
        for (let k = 1; k < pts.length; k++) {
          if (d >= segs[k - 1]) { out.push(pts[k]); d -= segs[k - 1]; corners = k; } else {
            const q = segs[k - 1] ? d / segs[k - 1] : 0;
            out.push([pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * q, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * q]); break;
          }
        }
        if (corners !== lastCorner) { lastCorner = corners; sfx.beep(1 + corners * 0.04); buzz(6); }
        const s = out.map((x) => x.join(',')).join(' ');
        pl.setAttribute('points', s); gl.setAttribute('points', s);
        // 선 끝에서 반짝이
        if ((frame++ & 1) === 0) {
          const head = out[out.length - 1], rb = rectOf(svg);
          FX.sparkle(rb.left + head[0] / (n * 100) * rb.width, rb.top + head[1] / H * rb.height, '#FFE27A');
        }
        if (p < 1) { rafId = requestAnimationFrame(f); return; }
        const labs = bot.children;
        labs[end].textContent = c[end].r.name; labs[end].classList.add('win', 'flip'); buzz([30, 40, 60]);
        later(() => [...labs].forEach((l, j) => { if (j !== end) { l.textContent = c[j].r.name; l.classList.add('dim', 'flip'); } }), 600);
        showResult(c[end], labs[end]);
      })(t0);
    };
  }

  function pirate(c) {
    const n = Math.min(8, c.length), trig = Math.floor(Math.random() * n);
    const pos = [[95, 195], [135, 195], [175, 195], [215, 195], [95, 258], [135, 258], [175, 258], [215, 258]];
    let holes = '';
    for (let i = 0; i < n; i++) {
      const [x, y] = pos[i];
      holes += '<g class="hole" data-h="' + i + '" tabindex="0" role="button" aria-label="' + (i + 1) + '번 구멍"><circle cx="' + x + '" cy="' + y + '" r="20" fill="transparent"/>' +
        '<circle class="hring" cx="' + x + '" cy="' + y + '" r="12" fill="#2B1A0C" stroke="' + COLORS[i] + '" stroke-width="4"/><text x="' + x + '" y="' + (y + 4) +
        '" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">' + (i + 1) + '</text><g class="sw"></g></g>';
    }
    stage.innerHTML = '<p class="hint" id="phint">구멍을 눌러 칼을 꽂으세요. 해적이 튀어나오는 칸이 오늘의 식당!</p>' +
      '<div class="pirate" id="pwrap"><svg viewBox="0 0 310 330" id="psvg"><g transform="translate(155,112)"><g id="pgrp">' +
      '<circle r="30" fill="#F2C9A0"/><path d="M-30 -6Q0 -26 30 -6L30 -12Q0 -34 -30 -12Z" fill="#D33B2C"/><path d="M-44 -14Q0 -62 44 -14Q0 -26 -44 -14Z" fill="#1B1B1B"/>' +
      '<circle cx="0" cy="-28" r="5" fill="#fff"/><circle cx="-11" cy="0" r="3.5" fill="#1B1B1B"/><circle cx="11" cy="0" r="7" fill="#1B1B1B"/>' +
      '<path d="M-30 -8L28 6" stroke="#1B1B1B" stroke-width="2"/><path id="pmouth" d="M-10 13Q0 20 10 13" stroke="#7A3B1C" stroke-width="3" fill="none" stroke-linecap="round"/>' +
      '<g id="psweat" opacity="0"><path d="M22 -16q3 6 0 9q-3-3 0-9z" fill="#7cc4ff"/></g></g></g>' +
      '<g id="barrel"><path d="M68 140Q54 220 68 305L242 305Q256 220 242 140Z" fill="#B7793F"/><path d="M110 140Q104 222 110 305M155 140V305M200 140Q206 222 200 305" stroke="#9A6231" stroke-width="3" fill="none"/>' +
      '<rect x="60" y="160" width="190" height="12" rx="4" fill="#5E3B1E"/><rect x="60" y="280" width="190" height="12" rx="4" fill="#5E3B1E"/>' +
      '<ellipse cx="155" cy="140" rx="88" ry="15" fill="#8C5A2B"/><ellipse cx="155" cy="140" rx="74" ry="10" fill="#4A2E15"/>' + holes + '</g></svg></div>' +
      '<div class="plegend" id="plegend"></div>';
    const leg = $('#plegend'), wrap = $('#pwrap'), svgEl = $('#psvg');
    for (let i = 0; i < n; i++) {
      const s = document.createElement('span'); s.dataset.pl = i;
      const ic = document.createElement('i'); ic.style.background = COLORS[i]; ic.textContent = String(i + 1);
      s.append(ic, document.createTextNode(c[i].r.name)); leg.append(s);
    }
    let busy = false, left = n;
    const toScreen = (x, y) => { const rb = rectOf(svgEl), k = Math.min(rb.width / 310, rb.height / 330); return [rb.left + rb.width / 2 + (x - 155) * k, rb.top + rb.height / 2 + (y - 165) * k]; };
    const hit = (g) => {
      if (busy || g.classList.contains('used')) return;
      busy = true; g.classList.add('used');
      const i = +g.dataset.h, [x, y] = pos[i], dir = x < 155 ? -1 : 1;
      g.querySelector('.sw').innerHTML = '<line x1="' + x + '" y1="' + y + '" x2="' + (x + dir * 48) + '" y2="' + (y - 14) + '" stroke="#D6DCE2" stroke-width="5" stroke-linecap="round"/>' +
        '<line x1="' + (x + dir * 44) + '" y1="' + (y - 12) + '" x2="' + (x + dir * 62) + '" y2="' + (y - 17) + '" stroke="' + COLORS[i] + '" stroke-width="8" stroke-linecap="round"/>';
      sfx.thunk();
      const [sx, sy] = toScreen(x, y); FX.burst(sx, sy, 10, { gv: 300, life: 600, shape: 'star', c: '#FFE27A' });
      const tension = (n - left) / n; left--;
      FX.shake(wrap, 4 + tension * 14, 360);
      $('#psweat').setAttribute('opacity', String(Math.min(1, tension * 1.6)));
      buzz(20 + Math.round(tension * 60));
      const wait = reduce ? 50 : 380 + tension * 700; // 남은 구멍이 적을수록 더 뜸을 들인다
      if (!reduce && tension > 0.3) sfx.drum(6);
      later(() => {
        busy = false;
        if (i === trig) {
          $('#pmouth').setAttribute('d', 'M-10 16Q0 6 10 16');
          $('#pgrp').classList.add('fly'); buzz([60, 50, 160]);
          sfx.boom(); sfx.pop(); FX.flash('#fff');
          FX.shake($('#game'), 16, 600);
          const [bx, by] = toScreen(155, 140); FX.smoke(bx, by, 18); FX.burst(bx, by - 20, 60);
          $('#phint').textContent = (i + 1) + '번에서 해적이 튀어나왔어요!';
          stage.querySelectorAll('.hole').forEach((h) => h.classList.add('used'));
          leg.querySelectorAll('[data-pl]').forEach((s) => { if (+s.dataset.pl !== i) s.classList.add('out'); else s.classList.add('winpl'); });
          later(() => showResult(c[i], leg.querySelector('.winpl')), reduce ? 0 : 900);
        } else {
          leg.querySelector('[data-pl="' + i + '"]').classList.add('out');
          $('#phint').textContent = left <= 2 ? '휴… 이제 ' + left + '개 남았어요. 손에 땀이…' : '휴, ' + (i + 1) + '번은 통과. 남은 구멍 ' + left + '개';
        }
      }, wait);
    };
    stage.querySelectorAll('.hole').forEach((g) => {
      g.onclick = () => hit(g);
      g.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hit(g); } };
    });
  }

  function race(c) {
    const n = c.length;
    stage.innerHTML = '<p class="commentary" id="rc">출발 준비!</p><div class="race" id="track"></div>';
    const track = $('#track'), runners = [], rc = $('#rc');
    c.forEach((x, i) => {
      const lane = document.createElement('div'); lane.className = 'lane';
      const nm = document.createElement('span'); nm.textContent = (i + 1) + ' ' + x.r.name;
      const ru = document.createElement('div'); ru.className = 'runner';
      const horse = document.createElement('i'); horse.textContent = '🏇';
      const num = document.createElement('b'); num.textContent = String(i + 1); num.style.background = COLORS[i % COLORS.length];
      ru.append(horse, num);
      lane.append(nm, ru); track.append(lane); runners.push(ru);
    });
    const pos = new Array(n).fill(0), base = c.map(() => 0.12 + Math.random() * 0.05);
    const say = (t) => { rc.textContent = t; if (!reduce && rc.animate) rc.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 260 }); };
    FX.countdown(['3', '2', '1', '출발!'], reduce ? 120 : 650, (t) => { if (!$('#rc')) return false; say(t); buzz(15); });
    later(() => {
      let leader = -1, t = 0, prev = performance.now(), hoof = 0, spurt = false;
      const key = gameKey;
      (function f(now) {
        if (key !== gameKey) return;
        const dt = Math.min(0.06, (now - prev) / 1000); prev = now; t++;
        const maxPos = Math.max(...pos);
        const slow = maxPos > 0.86 ? 0.45 : 1; // 결승선 앞에서 느린 화면
        for (let i = 0; i < n; i++) {
          let v = base[i] * (0.5 + Math.random() * 1.0);
          if (Math.random() < 0.014) v *= 3.4;
          if (Math.random() < 0.008) v *= 0.1;
          if (maxPos > 0.7 && pos[i] < maxPos - 0.05 && Math.random() < 0.03) v *= 2.6; // 뒤따르는 말의 추격
          pos[i] = Math.min(1, pos[i] + v * dt * slow);
        }
        const W = track.clientWidth - 56;
        let lead = 0; for (let i = 1; i < n; i++) if (pos[i] > pos[lead]) lead = i;
        runners.forEach((ru, i) => { ru.style.transform = 'translateX(' + (pos[i] * W) + 'px)'; ru.classList.toggle('lead', i === lead); });
        if (now - hoof > 140) { hoof = now; sfx.hoof(); const rb = rectOf(runners[lead]); FX.dust(rb.left + 6, rb.bottom - 6); }
        if (lead !== leader && t > 25) { leader = lead; say((lead + 1) + '번 ' + c[lead].r.name + ' 선두!'); buzz(8); }
        if (!spurt && maxPos > 0.86) { spurt = true; say('막판 스퍼트!'); sfx.drum(10); }
        const done = pos.map((p, i) => p >= 1 ? i : -1).filter((i) => i >= 0);
        if (done.length) {
          const w = done[Math.floor(Math.random() * done.length)];
          runners[w].classList.add('win'); say((w + 1) + '번 ' + c[w].r.name + ' 우승!'); buzz([60, 50, 120]);
          const rb = rectOf(runners[w]); FX.burst(rb.left + rb.width / 2, rb.top + rb.height / 2, 50);
          showResult(c[w], runners[w]); return;
        }
        rafId = requestAnimationFrame(f);
      })(performance.now());
    }, reduce ? 500 : 2600);
  }

  function cup(c) {
    let bracket = c.slice(), nextR = [], idx = 0, lastRound = 0, locked = false;
    const roundName = (k) => ({ 8: '8강', 4: '4강', 2: '결승' }[k] || '');
    function draw() {
      stage.textContent = '';
      if (bracket.length !== lastRound) { lastRound = bracket.length; FX.stamp(roundName(bracket.length) + '!', true); sfx.pop(); }
      const wrap = document.createElement('div'); wrap.className = 'cup';
      const h = document.createElement('p'); h.className = 'hint';
      h.textContent = roundName(bracket.length) + ' ' + (idx / 2 + 1) + '/' + bracket.length / 2 + ' · 더 끌리는 곳을 누르세요';
      const pair = document.createElement('div'); pair.className = 'pair';
      const mk = (x, col, from) => {
        const b = document.createElement('button'); b.className = 'cupcard'; b.style.background = col;
        const t = document.createElement('b'); t.textContent = x.r.name;
        const s = document.createElement('small'); s.textContent = x.r.cat + ' · 도보 ' + walkMin(x.m) + '분';
        b.append(t, s); b.onclick = () => pick(x, b);
        if (!reduce && b.animate) b.animate([{ transform: 'translateX(' + from + '%) rotate(' + (from / 10) + 'deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 420, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
        return b;
      };
      const vs = document.createElement('div'); vs.className = 'vs'; vs.textContent = 'VS';
      pair.append(mk(bracket[idx], COLORS[0], -120), vs, mk(bracket[idx + 1], COLORS[1], 120));
      wrap.append(h, pair); stage.append(wrap);
      if (!reduce && vs.animate) later(() => { vs.animate([{ transform: 'scale(3)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 260, easing: 'ease-in' }); sfx.thunk(); FX.shake(pair, 6, 250); }, 300);
    }
    function pick(x, el) {
      if (locked) return;
      locked = true; buzz(10); sfx.pop();
      const other = [...stage.querySelectorAll('.cupcard')].find((b) => b !== el);
      if (!reduce && el.animate) {
        el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1.04)' }], { duration: 300, fill: 'forwards' });
        if (other) other.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(60px) rotate(12deg) scale(.7)', opacity: 0 }], { duration: 320, fill: 'forwards', easing: 'ease-in' });
      }
      const rb = rectOf(el); FX.burst(rb.left + rb.width / 2, rb.top + rb.height / 2, 18, { life: 700 });
      later(() => {
        locked = false;
        const winners = nextR.concat([x]);
        if (idx + 2 >= bracket.length) {
          if (winners.length === 1) {
            stage.textContent = '';
            const tro = document.createElement('div'); tro.className = 'trophy'; tro.textContent = '🏆';
            const b = document.createElement('p'); b.className = 'slot done'; b.textContent = x.r.name;
            stage.append(tro, b); buzz([60, 50, 120]); showResult(x, b); return;
          }
          bracket = winners; nextR = []; idx = 0;
        } else { nextR = winners; idx += 2; }
        draw();
      }, reduce ? 0 : 380);
    }
    draw();
  }

  function bomb(c) {
    let cur = 0, started = false, exploded = false;
    const fuse = 6000 + Math.random() * 9000;
    stage.innerHTML = '<p class="hint" id="bh">폭탄이 언제 터질지 아무도 몰라요</p>' +
      '<div class="bombwrap" id="bw"><div class="bomb" id="bm"><i class="fuse" id="fz"></i><span id="bn"></span></div></div>' +
      '<button class="btn primary big" id="bb">불 붙이기</button>';
    const bn = $('#bn'), bm = $('#bm'), bb = $('#bb'), bh = $('#bh'), bw = $('#bw');
    bn.textContent = c[cur].r.name;
    bb.onclick = () => {
      if (exploded) return;
      if (!started) {
        started = true; bb.textContent = '넘기기 →'; bh.textContent = '폰을 옆 사람에게 넘기며 버튼을 누르세요'; bm.classList.add('lit');
        sfx.whoosh();
        let elapsed = 0;
        const tick = () => {
          if (elapsed >= fuse) {
            exploded = true; bb.hidden = true; bm.classList.remove('lit');
            bh.textContent = '펑!'; bh.className = 'boom';
            sfx.boom(); FX.flash('#fff3c4', 500); buzz([100, 60, 220]);
            FX.shake($('#game'), 22, 700);
            const rb = rectOf(bm); const cx = rb.left + rb.width / 2, cy = rb.top + rb.height / 2;
            FX.burst(cx, cy, 90, { c: undefined }); FX.smoke(cx, cy, 22);
            bm.classList.add('blown');
            later(() => showResult(c[cur], bm), reduce ? 0 : 700); return;
          }
          const frac = elapsed / fuse;
          bm.style.setProperty('--heat', String(0.15 + frac * 0.75));
          bw.style.setProperty('--rate', (0.5 - frac * 0.38).toFixed(2) + 's');
          sfx.beep(1 + frac * 0.6); buzz(10);
          const rb = rectOf($('#fz')); FX.sparkle(rb.left + rb.width / 2, rb.top, '#FFB020');
          const step = Math.max(100, 650 - 540 * frac); elapsed += step; later(tick, step);
        };
        tick();
      } else {
        cur = (cur + 1) % c.length; bn.textContent = c[cur].r.name; buzz(8); sfx.tock(1.2);
        if (!reduce && bn.animate) bn.animate([{ transform: 'translateY(10px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 160 });
      }
    };
  }

  function slot(c) {
    stage.innerHTML = '<div class="slotbox" id="sb"><div class="reel" id="reel"></div></div><p class="hint">후보 ' + c.length + '곳 중에서 뽑는 중</p>';
    const win = Math.floor(Math.random() * c.length), reel = $('#reel'), sb = $('#sb');
    const nameAt = (k) => c[((k % c.length) + c.length) % c.length].r.name;
    let i = 0, d = 40; const end = performance.now() + (reduce ? 200 : 2000);
    sb.classList.add('spinning');
    const show = (k, fast) => {
      reel.textContent = '';
      for (const off of [-1, 0, 1]) { const line = document.createElement('div'); line.textContent = nameAt(k + off); if (off === 0) line.className = 'mid'; reel.append(line); }
      if (!reduce && reel.animate) reel.animate([{ transform: 'translateY(-34%)', filter: fast ? 'blur(2px)' : 'none' }, { transform: 'translateY(0)', filter: 'none' }], { duration: Math.min(d, 220), easing: 'ease-out' });
    };
    const tick = () => {
      show(i, d < 90); i++; sfx.tick();
      if (performance.now() < end) { d *= 1.085; later(tick, d); return; }
      // 당첨 칸으로 멈추고 살짝 튕긴다
      reel.textContent = '';
      for (const off of [-1, 0, 1]) { const line = document.createElement('div'); line.textContent = off === 0 ? c[win].r.name : nameAt(win + off); if (off === 0) line.className = 'mid'; reel.append(line); }
      if (!reduce && reel.animate) reel.animate([{ transform: 'translateY(-20%)' }, { transform: 'translateY(6%)' }, { transform: 'none' }], { duration: 420, easing: 'ease-out' });
      sb.classList.remove('spinning'); sb.classList.add('done'); buzz(40);
      showResult(c[win], sb);
    };
    tick();
  }

  // 흔들기
  let shakeTimes = [];
  function shaken(e) {
    const a = e.accelerationIncludingGravity || e.acceleration;
    if (!a) return false;
    const g = Math.sqrt((a.x || 0) ** 2 + (a.y || 0) ** 2 + (a.z || 0) ** 2) / 9.81;
    const now = Date.now();
    if (g > 2.2) {
      if (!shakeTimes.length || now - shakeTimes[shakeTimes.length - 1] > 120) shakeTimes.push(now);
      shakeTimes = shakeTimes.filter((t) => now - t < 900);
      if (shakeTimes.length >= 2) { shakeTimes = []; return true; }
    }
    return false;
  }
  function onMotionGame(e) {
    if (curGame === 'shake' && shaken(e)) {
      window.removeEventListener('devicemotion', onMotionGame);
      sfx.whoosh(); FX.shake($('#game'), 12, 400); FX.burst(innerWidth / 2, innerHeight / 2, 30);
      slot(cands);
    }
  }
  let lastHomeShake = 0;
  function onMotionHome(e) {
    if (!settings.shake || curGame || $('#sheetRoot').childElementCount || !$('#onb').hidden || S.state !== 'ready') return;
    if (shaken(e) && Date.now() - lastHomeShake > 2500) { lastHomeShake = Date.now(); startGame('slot'); }
  }
  async function motionPermission() {
    try {
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        return (await DeviceMotionEvent.requestPermission()) === 'granted';
      }
      return typeof DeviceMotionEvent !== 'undefined';
    } catch (e) { return false; }
  }
  function shakeGame(c) {
    stage.textContent = '';
    const ph = document.createElement('div'); ph.className = 'phone';
    const t = document.createElement('p'); t.className = 'commentary'; t.textContent = '폰을 흔들어 주세요!';
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = '흔들기 어려우면 여기를 누르세요';
    b.onclick = () => { window.removeEventListener('devicemotion', onMotionGame); sfx.whoosh(); slot(c); };
    stage.append(ph, t, b);
    motionPermission().then((ok) => {
      if (ok) { window.addEventListener('devicemotion', onMotionGame); window.addEventListener('devicemotion', onMotionHome); }
      else t.textContent = '이 폰에서는 흔들기를 쓸 수 없어요. 아래 버튼을 눌러 주세요.';
    });
  }

  // 결과 카드
  const COMMENTS = {
    한식: ['든든하게 한 그릇 가입시더!', '밥심으로 오후 버티기'], 중식: ['짜장이냐 짬뽕이냐, 그것이 문제로다', '탕수육은 부먹? 찍먹?'],
    일식: ['오늘은 깔끔하게 가 봅시다', '초밥 한 점에 행복 한 점'], 양식: ['분위기 좀 내 볼까요', '포크 들 준비 완료'],
    분식: ['떡볶이는 진리다', '가볍게, 그러나 맛있게'], 호프: ['시원하게 한 잔 가입시더!', '치맥은 과학입니다'],
    주점: ['오늘 밤은 길다', '건배사 준비하세요'], 고기구이: ['불판 앞에 모이자', '고기는 언제나 옳다'],
    횟집: ['바다 한 접시 주문이요', '부산 왔으면 회지예'], 카페: ['달달하게 마무리', '커피 한 잔의 여유'], 치킨: ['1인 1닭 가능?', '바삭함이 부른다'],
  };
  function comment(r) { const l = COMMENTS[r.cat] || ['오늘의 운명은 여기로!', '고민 끝, 출발!', '맛있게 드이소!']; return l[Math.floor(Math.random() * l.length)]; }
  function badges(r) {
    const box = document.createElement('div'); box.className = 'badges';
    const add = (t, cls) => { const s = document.createElement('span'); s.className = 'bdg ' + cls; s.textContent = t; box.append(s); };
    if (isNew(r)) add('NEW', 'new');
    if (r.model) add('모범음식점', 'model');
    if (regulars().has(r.id)) add('★ 단골', 'fav');
    return box;
  }
  function textEl(tag, text, cls) { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; }
  function btn(label, cls, fn) { const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = label; b.onclick = fn; return b; }
  function row(...kids) { const d = document.createElement('div'); d.className = 'actions'; d.append(...kids); return d; }
  function note(t) { return textEl('p', t, 'note'); }

  function showResult(cand, fromEl) {
    const r = cand.r, mins = walkMin(cand.m);
    result.textContent = ''; result.hidden = false;
    const title = textEl('h3', r.name);
    result.append(
      textEl('div', S.round + '차 당첨', 'eyebrow'), title,
      textEl('div', r.cat + ' · 도보 약 ' + mins + '분 (' + Math.round(cand.m) + 'm)', 'meta'), badges(r),
    );
    if (r.food) result.append(textEl('div', '대표 음식: ' + r.food, 'meta'));
    result.append(textEl('p', comment(r), 'comment'),
      row(btn('다시 하기', '', () => startGame(curGame)), btn('여기로 결정', 'primary', () => decide(r))),
      row(link('카카오맵', kakaoPlace(r), 'sm'), link('길찾기', kakaoRoute(r), 'sm'), btn('공유', 'sm', () => share(r, S.round, mins))),
      row(btn('이번엔 빼기 (30일)', 'sm', () => { hide(r, 30); startGame(curGame); })),
      textEl('p', '영업시간·메뉴는 카카오맵에서 확인해 주세요.', 'fine'));
    if (CONFIG.donate) {
      const d = link('☕ 만든 사람에게 커피 한 잔', CONFIG.donate, 'sm donate');
      result.append(d);
    }
    // 축하 연출: 도장, 양쪽 폭죽, 팡파르, 글자 튀어나오기
    FX.popText(title);
    FX.stamp('당첨!');
    sfx.fanfare();
    FX.cannons(45);
    if (fromEl && fromEl.getBoundingClientRect) { const rb = fromEl.getBoundingClientRect(); FX.burst(rb.left + rb.width / 2, rb.top + rb.height / 2, 36); }
    if (!reduce && result.animate) result.animate([{ transform: 'translateY(40px) scale(.96)', opacity: 0 }, { transform: 'translateY(-6px) scale(1.01)', opacity: 1, offset: 0.7 }, { transform: 'none', opacity: 1 }], { duration: 520, easing: 'ease-out' });
  }

  // ------------------------------------------------------------ 시트(목록·상세·지역·설정)
  const sheetRoot = $('#sheetRoot');
  function closeSheet() { sheetRoot.textContent = ''; if (document.activeElement) document.activeElement.blur(); }
  function openSheet(title, fill) {
    sheetRoot.textContent = '';
    const bg = document.createElement('div'); bg.className = 'sheetbg'; bg.onclick = closeSheet;
    const sh = document.createElement('div'); sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-label', title);
    const head = document.createElement('div'); head.className = 'sh-head';
    head.append(textEl('h2', title), btn('닫기', 'sm', closeSheet));
    const body = document.createElement('div'); body.className = 'sh-body';
    sh.append(head, body); sheetRoot.append(bg, sh);
    fill(body);
  }

  function openDetail(r) {
    const m = dist(S.center, r.lat, r.lng), mins = walkMin(m);
    openSheet(r.cat || '식당', (b) => {
      b.append(textEl('h3', r.name, 'detail'), textEl('div', '도보 약 ' + mins + '분 (' + Math.round(m) + 'm) · ' + ({ b: '밥', s: '술', bs: '밥+술', c: '카페' }[r.kind]), 'meta'), badges(r));
      if (r.food) b.append(textEl('div', '대표 음식: ' + r.food, 'meta'));
      const dl = document.createElement('dl'); dl.className = 'kv';
      const kv = (k, v) => dl.append(textEl('dt', k), textEl('dd', v));
      if (r.addr) kv('주소', r.addr);
      if (r.open) kv('영업 신고', Math.floor(r.open / 10000) + '.' + Math.floor(r.open / 100) % 100 + '.' + r.open % 100 + (isNew(r) ? ' (새로 문 연 곳)' : ''));
      const last = visits.filter((v) => v[0] === r.id).pop();
      if (last) kv('최근 방문', Math.floor((Date.now() - last[2]) / DAY) === 0 ? '오늘' : Math.floor((Date.now() - last[2]) / DAY) + '일 전');
      b.append(dl);
      b.append(row(link('카카오맵에서 보기', kakaoPlace(r)), link('길찾기', kakaoRoute(r))));
      const r2 = row(btn(fav.has(r.id) ? '★ 단골 해제' : '☆ 단골 등록', '', () => {
        if (fav.has(r.id)) fav.delete(r.id); else fav.add(r.id);
        store.set('fav', [...fav]); toast(fav.has(r.id) ? '단골로 등록했어요' : '단골에서 뺐어요'); render(); openDetail(r);
      }));
      if (r.tel.length >= 9) r2.append(link('전화', 'tel:' + r.tel));
      r2.append(btn('공유', '', () => share(r, S.round, mins)));
      b.append(r2);
      b.append(row(btn('문 닫혀 있었어요', 'sm', () => { hide(r, 30); closeSheet(); }), btn('다시 안 보기', 'sm', () => { hide(r, 0); closeSheet(); })));
      b.append(btn(S.round + '차로 결정', 'primary', () => decide(r)));
      b.append(note('영업시간·메뉴·가격은 카카오맵에서 최신 정보를 확인해 주세요. 식당 정보: 행정안전부 인허가 공공데이터'));
    });
  }

  function openSearch() {
    openSheet('식당 찾기', (b) => {
      const inp = document.createElement('input'); inp.className = 'search'; inp.type = 'search'; inp.placeholder = '이름, 종류 (예: 국밥, 카페)'; inp.maxLength = 30;
      inp.setAttribute('enterkeyhint', 'search');
      const fs = document.createElement('div'); fs.className = 'filters';
      const opts = [['near', '반경 안'], ['all', '주변 전체'], ['new', 'NEW'], ['model', '모범'], ['reg', '단골'], ['hid', '숨긴 곳']];
      let f = 'near';
      const list = document.createElement('div'), cnt = textEl('div', '', 'meta');
      for (const [k, l] of opts) { const x = document.createElement('button'); x.textContent = l; x.dataset.f = k; fs.append(x); }
      const draw = () => {
        [...fs.children].forEach((x) => x.setAttribute('aria-pressed', x.dataset.f === f));
        const q = inp.value.trim().toLowerCase(), regs = regulars(), recent = recentIds();
        let base;
        if (f === 'near') base = S.pool;
        else base = S.all.map((r) => ({ r, m: dist(S.center, r.lat, r.lng) })).filter((x) => x.m < 3000 && (
          f === 'all' ? !isHidden(x.r.id) : f === 'new' ? isNew(x.r) : f === 'model' ? x.r.model : f === 'reg' ? regs.has(x.r.id) : isHidden(x.r.id)))
          .sort((a, b2) => a.m - b2.m);
        const shown = (q ? base.filter((x) => x.r.name.toLowerCase().includes(q) || x.r.cat.includes(q) || x.r.food.includes(q)) : base).slice(0, 200);
        cnt.textContent = shown.length + '곳' + (shown.length === 200 ? ' (가까운 200곳)' : '');
        list.textContent = '';
        const P = { b: css('--meal'), s: css('--drink'), bs: css('--both'), c: css('--cafe') };
        for (const x of shown) {
          const it = document.createElement('button'); it.className = 'item' + (recent.has(x.r.id) ? ' ex' : '');
          const k = document.createElement('span'); k.className = 'k'; k.style.background = P[x.r.kind];
          const mid = document.createElement('span');
          const nm = textEl('div', x.r.name, 'nm'); const sub = document.createElement('div'); sub.className = 'sub';
          sub.append(document.createTextNode(x.r.cat + (recent.has(x.r.id) ? ' · 이번 주 방문' : '')));
          const bd = badges(x.r); if (bd.childElementCount) sub.append(bd);
          mid.append(nm, sub);
          const rt = document.createElement('span'); rt.className = 'rt'; rt.append(textEl('b', walkMin(x.m) + '분'));
          it.append(k, mid, rt);
          it.onclick = () => {
            if (f === 'hid') { delete hidden[x.r.id]; store.set('hidden', hidden); toast('다시 보이게 했어요'); draw(); render(); return; }
            openDetail(x.r);
          };
          list.append(it);
        }
        if (f === 'hid' && shown.length) list.prepend(note('누르면 다시 후보에 나와요.'));
      };
      fs.onclick = (e) => { const x = e.target.closest('[data-f]'); if (x) { f = x.dataset.f; draw(); } };
      inp.oninput = draw;
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
      b.append(inp, fs, cnt, list); draw();
    });
  }

  function openRegions() {
    openSheet('지역 고르기', async (b) => {
      b.append(btn('내 위치로 찾기', 'primary', () => { closeSheet(); locate(true); }));
      const inp = document.createElement('input'); inp.className = 'search'; inp.type = 'search'; inp.placeholder = '시·군·구 이름 (예: 해운대)'; inp.maxLength = 20;
      inp.setAttribute('enterkeyhint', 'search');
      const list = document.createElement('div');
      b.append(inp, list);
      if (!S.regions.length) { try { await loadManifest(false); } catch (e) { list.append(note('지역 목록을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.')); return; } }
      const draw = () => {
        const q = inp.value.trim();
        const rs = S.regions.filter((r) => !q || r.name.includes(q))
          .map((r) => ({ r, d: dist(S.center, (r.minLat + r.maxLat) / 2, (r.minLng + r.maxLng) / 2) }))
          .sort((a, c) => (a.d > 30000) - (c.d > 30000) || a.r.name.localeCompare(c.r.name, 'ko')).slice(0, 120);
        list.textContent = '';
        for (const { r } of rs) {
          const it = document.createElement('button'); it.className = 'item'; it.style.gridTemplateColumns = '1fr auto';
          it.append(textEl('span', r.name, 'nm'), textEl('span', r.count.toLocaleString('ko-KR') + '곳', 'rt'));
          it.onclick = () => { inp.blur(); pickRegion(r); };
          list.append(it);
        }
      };
      inp.oninput = draw; inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
      draw();
    });
  }

  function openSettings() {
    openSheet('설정', (b) => {
      const sw = (label, key) => {
        const x = document.createElement('button'); x.className = 'setrow'; x.setAttribute('aria-pressed', settings[key]);
        x.append(textEl('span', label)); const s = document.createElement('i'); s.className = 'switch'; x.append(s);
        x.onclick = async () => {
          settings[key] = !settings[key];
          if (key === 'shake' && settings.shake) {
            const ok = await motionPermission();
            if (ok) window.addEventListener('devicemotion', onMotionHome); else { settings.shake = false; toast('이 폰에서는 흔들기를 쓸 수 없어요'); }
          }
          saveSettings(); x.setAttribute('aria-pressed', settings[key]); render();
        };
        return x;
      };
      b.append(sw('폰을 흔들면 바로 뽑기', 'shake'), sw('이번 주에 간 곳은 후보에서 빼기', 'exclude'));
      const snd = document.createElement('button'); snd.className = 'setrow';
      const paint = () => snd.setAttribute('aria-pressed', !(window.MMFX && MMFX.isMuted()));
      snd.append(textEl('span', '게임 효과음')); const si = document.createElement('i'); si.className = 'switch'; snd.append(si);
      snd.onclick = () => { if (window.MMFX) { MMFX.setMuted(!MMFX.isMuted()); paint(); paintSound(); } };
      paint(); b.append(snd);
      if (CONFIG.donate) b.append(link('☕ 만든 사람에게 커피 한 잔 사 주기', CONFIG.donate, 'donate'));
      const hc = Object.keys(hidden).filter(isHidden).length;
      if (hc) b.append(btn('숨긴 식당 ' + hc + '곳 모두 다시 보기', '', () => { hidden = {}; store.set('hidden', hidden); toast('모두 다시 보이게 했어요'); render(); closeSheet(); }));
      let confirmClear = false;
      const clearBtn = btn('방문 기록·단골 지우기', '', () => {
        if (!confirmClear) { confirmClear = true; clearBtn.textContent = '한 번 더 누르면 지워져요'; return; }
        visits = []; fav = new Set(); store.set('visits', visits); store.set('fav', []); toast('기록을 지웠어요'); render(); closeSheet();
      });
      b.append(clearBtn);
      b.append(btn('식당 데이터 새로 받기', '', async () => {
        try { if (window.caches) for (const k of await caches.keys()) if (k.startsWith('mm-data')) await caches.delete(k); } catch (e) { /* 무시 */ }
        S.loaded.clear(); S.regions = []; closeSheet(); loadAround();
      }));
      b.append(note('홈 화면에 추가하면 앱처럼 쓸 수 있어요.\n· 아이폰(사파리): 공유 버튼 → "홈 화면에 추가"\n· 안드로이드(크롬): 메뉴(⋮) → "홈 화면에 추가" 또는 "앱 설치"'));
      b.lastChild.style.whiteSpace = 'pre-line';
      b.append(note('식당 정보: 행정안전부 지방행정 인허가 공공데이터(일반·휴게·모범음식점)를 매일 자동 갱신 · 마지막 갱신 ' + (S.generated || '-') +
        '. 실제 영업 여부와 다를 수 있어요. 위치와 기록은 이 폰의 브라우저에만 저장되고 어디에도 보내지 않아요.'));
      const pv = link('개인정보처리방침', 'privacy.html'); b.append(pv);
    });
  }

  // ------------------------------------------------------------ 공유 링크로 들어온 경우
  async function handleSharedLink() {
    const q = new URLSearchParams(location.search);
    const id = q.get('eat'), n = Math.min(3, Math.max(1, parseInt(q.get('n') || '1', 10) || 1));
    if (!id || !/^[gr]\d{7}-[\w-]{1,40}$/.test(id)) return;
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* 무시 */ }
    try {
      if (!S.regions.length) await loadManifest(false);
      const region = S.regions.find((r) => r.code === id.slice(1, 8));
      if (!region) return;
      const r = (await loadRegion(region)).find((x) => x.id === id);
      if (!r) return;
      const root = $('#bannerRoot'); root.textContent = '';
      const bn = document.createElement('div'); bn.className = 'banner'; bn.setAttribute('role', 'status');
      bn.append(textEl('div', '친구가 고른 ' + n + '차', 'eyebrow'), textEl('b', r.name + ' · ' + r.cat));
      const done = visits.some((v) => v[0] === r.id && Date.now() - v[2] < DAY);
      bn.append(row(
        btn(done ? '이미 기록됨' : '나도 다녀왔어요', 'primary', () => {
          if (!done) { visits.push([r.id, r.name, Date.now()]); store.set('visits', visits); toast('이번 주 기록에 남겼어요'); render(); }
          root.textContent = '';
        }),
        link('카카오맵', kakaoPlace(r)),
        btn('닫기', '', () => { root.textContent = ''; }),
      ));
      root.append(bn);
    } catch (e) { /* 공유 정보가 없으면 그냥 시작 */ }
  }

  // ------------------------------------------------------------ 효과
  let toastTimer = 0;
  function toast(m) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
    t.textContent = m; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }
  // ------------------------------------------------------------ 설정 파일(후원 링크 등). 허용한 주소만 쓴다.
  const CONFIG = { donate: '' };
  fetch('config.json', { cache: 'no-cache' }).then((r) => r.ok ? r.json() : {}).then((c) => {
    const u = String((c && c.donate) || '');
    if (/^https:\/\/(toss\.me|qr\.kakaopay\.com|link\.kakaopay\.com)\/[\w\-./?=&%]+$/.test(u)) CONFIG.donate = u;
  }).catch(() => { /* 없으면 후원 버튼 없음 */ });

  // 효과음 켜기/끄기
  const soundBtn = $('#gSound');
  const paintSound = () => { soundBtn.textContent = (window.MMFX && MMFX.isMuted()) ? '🔇' : '🔊'; soundBtn.setAttribute('aria-label', (window.MMFX && MMFX.isMuted()) ? '효과음 켜기' : '효과음 끄기'); };
  soundBtn.onclick = () => { if (window.MMFX) { MMFX.setMuted(!MMFX.isMuted()); paintSound(); if (!MMFX.isMuted()) sfx.pop(); } };
  paintSound();

  // ------------------------------------------------------------ 시작
  function startApp(useLocation) {
    $('#onb').hidden = true;
    settings.onboarded = true; saveSettings();
    if (useLocation) locate(true); else { loadAround(); openRegions(); }
  }
  $('#onbLoc').onclick = () => startApp(true);
  $('#onbPick').onclick = () => startApp(false);

  buildStatic();
  new ResizeObserver(() => drawMap()).observe($('#mapwrap'));
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (sheetRoot.childElementCount) closeSheet(); else if (!$('#game').hidden) closeGame();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => render());
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { /* 없어도 동작 */ });
  if (settings.shake && typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission !== 'function') {
    window.addEventListener('devicemotion', onMotionHome);
  }

  render();
  handleSharedLink();
  if (!settings.onboarded) {
    $('#onb').hidden = false;
  } else if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') locate(false); else loadAround(); }).catch(() => loadAround());
  } else loadAround();
})();
