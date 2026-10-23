/* 뭐 먹노? — 친구·동료용 식당 고르기 (웹)
 * 서버 없음. 식당 데이터는 같은 사이트의 v1/ 폴더에서 읽고, 위치·기록은 이 브라우저에만 저장한다.
 * 보안: 외부 스크립트 없음, 데이터 문자열은 textContent 또는 esc()로만 화면에 넣는다.
 */
'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  // 걷는 시간: 실제 길(보행 경로) 거리 ÷ 보통 걸음(분당 75m, 시속 4.5km) × 신호·건널목 대기 보정
  const SPEED = 75, SIGNAL = 1.08, DETOUR = 1.3; // DETOUR: 길 정보를 못 받았을 때 직선→실제 길 비율(실측 평균)
  const NEW_DAYS = 90;
  const DAY = 864e5;
  const COLORS = ['#E4473A', '#3E6BE0', '#1C9A55', '#F08A24', '#8A4FD0', '#149E9E', '#D64C8A', '#6B7A1E'];
  // 효과 줄이기: 폰 설정(절전 모드 등)과 상관없이 이 사이트의 설정으로만 정한다. 그래야 PC와 폰 화면이 같다.
  const reduce = (() => { try { return JSON.parse(localStorage.getItem('mm.settings') || '{}').lowfx === true; } catch (e) { return false; } })();
  document.documentElement.classList.toggle('lowfx', reduce);
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
  const settings = Object.assign({ minutes: 10, exclude: true, shake: true, onboarded: false, tier: 'good', lowfx: false, basemap: true, route: true, openNow: true }, store.get('settings', {}));
  const saveSettings = () => store.set('settings', settings);

  // ------------------------------------------------------------ 상태
  const hour = new Date().getHours();
  const S = {
    meal: hour < 15 ? 'lunch' : 'dinner',
    round: 1,
    kinds: new Set(),
    cats: new Set(),
    food: '',
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
  const walkMin = (routeM) => Math.max(1, Math.round(routeM / SPEED * SIGNAL));
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
  // ------------------------------------------------------------ 추천 등급·내 별점
  // 실제 별점 데이터는 공개 API로 받을 수 없어서, 가진 정보로 "추천 등급"을 매긴다.
  // 모범음식점 지정, 영업 연수(오래 살아남은 가게), 카카오맵 등록, 전화번호, 단골, 그리고 내가 준 별점.
  let ratings = store.get('ratings', {}); // {id: [별점 1~5, 시각, 이름]}
  const BAD_NAME = /구내식당|직원식당|급식|위탁|휴게소|푸드코트|기숙사|사내식당/;
  // 등급은 지금 주변 후보 안에서의 순위로 정한다: 상 = 위 30%, 중상 = 위 60%, 중 = 위 85%
  const TIERS = [['top', '상', 0.3], ['good', '중상', 0.6], ['mid', '중', 0.85], ['all', '전체', 1]];
  const tierQ = () => (TIERS.find((t) => t[0] === settings.tier) || TIERS[1])[2];
  let cuts = { top: 50, good: 42, mid: 25 }; // 주변 후보가 없을 때 쓰는 기본값
  function myStars(id) { const x = ratings[id]; return x ? x[0] : 0; }
  function score(r) {
    const st = myStars(r.id);
    if (st >= 4) return 100;
    let s = 0;
    if (r.model) s += 40;
    if (r.open > 19000101) {
      const yr = (Date.now() - ymdToTime(r.open)) / DAY / 365;
      s += yr >= 10 ? 30 : yr >= 5 ? 22 : yr >= 3 ? 15 : yr >= 1 ? 8 : 6;
    }
    if (r.kakao) s += 20;
    if (r.tel) s += 5;
    // 블로그 후기 양(최근 2년, 협찬 글이 대부분이면 낮춤): 확인 안 됨(-1)은 0점
    s += [-4, 4, 10, 18, 26, 32][r.blog] || 0;
    if (fav.has(r.id)) s += 30;
    if (BAD_NAME.test(r.name)) s -= 25;
    if (st === 3) s += 10;
    return s;
  }
  const tierName = (s) => s >= 100 ? '★내 픽' : s >= cuts.top ? '상' : s >= cuts.good ? '중상' : s >= cuts.mid ? '중' : '하';
  const BLOG_WORDS = ['거의 없음', '조금', '보통', '많음', '아주 많음', '아주 많음'];
  // 별점 1~2점은 30일 동안 후보에서 뺀다
  const dislikedNow = (id) => { const x = ratings[id]; return !!x && x[0] <= 2 && Date.now() - x[1] < 30 * DAY; };
  function rate(r, stars) {
    ratings[r.id] = [stars, Date.now(), r.name];
    store.set('ratings', ratings);
  }
  // 게임 후보 뽑기: 별점 4점 이상(또 가고 싶은 곳)은 두 배로 잘 뽑힌다
  function weightedPick(list, n) {
    return list.map((c) => ({ c, k: Math.pow(Math.random(), 1 / (myStars(c.r.id) >= 4 ? 2 : 1)) }))
      .sort((a, b) => b.k - a.k).slice(0, n).map((x) => x.c);
  }
  const kindOk = (k) => (k === 'b' && S.kinds.has('b')) || (k === 's' && S.kinds.has('s')) ||
    (k === 'bs' && (S.kinds.has('b') || S.kinds.has('s'))) || (k === 'c' && S.kinds.has('c'));
  function catOk(r) {
    if (!S.cats.size) return true;
    for (const c of S.cats) if (catFn.get(c)(r)) return true;
    return false;
  }
  // ------------------------------------------------------------ 영업 중인가?
  // 1) 블로그 글에 적힌 영업시간·브레이크타임·정기휴무, 2) 내가 '문 닫혀 있었어요'를 누른 요일·시간,
  // 3) 둘 다 없으면 업종별로 '거의 확실히 닫은' 시간대(술집 아침, 밥집 새벽 등)만 뺀다.
  let closedSeen = store.get('closedSeen', {}); // {id: [[요일 0~6, 분, 시각], ...]}
  const DAYN = ['일', '월', '화', '수', '목', '금', '토'];
  const hhmm = (t) => String(Math.floor(t / 60) % 24).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
  // 검사 시각: 지금 고른 끼니 시간대면 '지금', 아니면 그 끼니의 대표 시각(점심 12:30, 저녁 19:00, 2·3차는 더 늦게)
  function checkTime() {
    const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
    const isNow = S.meal === 'lunch' ? h >= 10 && h < 15.5 : h >= 15.5 || h < 4;
    const start = S.meal === 'lunch' ? 11.5 : 18; // 끼니 시작 전이면 그 시각 기준 (오후 4시에 저녁 고르면 18:00)
    const early = isNow && h >= 4 && h < start;
    if (isNow && !early && S.round === 1) return { d: now, now: true };
    const d = new Date(now);
    if (early) d.setHours(Math.floor(start), (start % 1) * 60 + (S.round - 1) * 90, 0, 0);
    else if (isNow) d.setMinutes(d.getMinutes() + (S.round - 1) * 90);
    if (early) return { d, now: false };
    if (isNow) return { d, now: S.round === 1 };
    { const base = S.meal === 'lunch' ? 12.5 : 19 + (S.round - 1) * 1.5; d.setHours(Math.floor(base), Math.round((base % 1) * 60), 0, 0); }
    return { d, now: isNow };
  }
  const NIGHT_OK = /24|국밥|해장|순대|감자탕|편의|김밥천국/;
  function openState(r, d) {
    let dow = d.getDay(), t = d.getHours() * 60 + d.getMinutes();
    const seen = closedSeen[r.id];
    if (seen && seen.some((x) => x[0] === dow && Math.abs(x[1] - t) <= 90 && Date.now() - x[2] < 60 * DAY)) return { closed: true, why: '전에 이 요일·시간에 닫혀 있었음' };
    const h = r.hours;
    if (h) {
      if (h.open && t < 300 && h.open[1] > 1440) { t += 1440; dow = (dow + 6) % 7; } // 새벽은 전날 영업의 연장
      const dIdx = String(dow === 0 ? 7 : dow);
      if (h.off && h.off.includes(dIdx)) return { closed: true, why: DAYN[dow] + '요일 정기휴무' };
      if (h.open) {
        if (t < h.open[0] || t >= h.open[1]) return { closed: true, why: t < h.open[0] ? '영업 전 (' + hhmm(h.open[0]) + ' 오픈)' : '영업 끝 (' + hhmm(h.open[1]) + '까지)' };
        if (h.brk && t >= h.brk[0] && t < h.brk[1]) return { closed: true, why: '브레이크타임 (' + hhmm(h.brk[1]) + '부터)' };
        return { closed: false, why: '영업 중' };
      }
      return { closed: false, why: '' };
    }
    if (r.kind === 's' && t >= 360 && t < 900) return { closed: true, why: '술집은 보통 오후 늦게 열어요' };
    if (r.kind === 'c' && (t < 390 || t >= 1410) && !/24/.test(r.name)) return { closed: true, why: '카페가 보통 닫는 시간' };
    if (r.kind === 'b' && t >= 30 && t < 330 && !NIGHT_OK.test(r.name)) return { closed: true, why: '밥집이 보통 닫는 시간' };
    if (r.kind === 'bs' && t >= 120 && t < 540 && !NIGHT_OK.test(r.name)) return { closed: true, why: '보통 닫는 시간' };
    return { closed: false, why: '' };
  }
  function reportClosed(r) {
    const d = new Date();
    const list = (closedSeen[r.id] || []).filter((x) => Date.now() - x[2] < 60 * DAY);
    list.push([d.getDay(), d.getHours() * 60 + d.getMinutes(), Date.now()]);
    closedSeen[r.id] = list.slice(-6);
    store.set('closedSeen', closedSeen);
  }


  // ------------------------------------------------------------ 먹고 싶은 음식으로 찾기
  // 가게 이름·추천 메뉴·대표 음식·업종(+업종별 흔한 메뉴)에서 찾는다. 묶음 말(고기·회·면·해장·매운…)은 여러 메뉴로 넓혀 찾는다.
  const TYPICAL = {
    중식: ['짜장면', '짬뽕', '탕수육'], 일식: ['초밥', '돈까스', '우동'], 양식: ['파스타', '스테이크', '피자'], 분식: ['떡볶이', '김밥', '순대'],
    호프: ['맥주', '치킨'], 치킨: ['치킨'], 고기구이: ['삼겹살', '갈비'], 횟집: ['회', '매운탕'], 김밥: ['김밥', '라면'],
    냉면: ['냉면', '수육'], 복어: ['복국'], 탕: ['삼계탕'], 카페: ['커피', '디저트'], 베이커리: ['빵', '케이크'], 아이스크림: ['아이스크림'],
    찻집: ['전통차'], 떡카페: ['떡', '차'], 패스트푸드: ['버거', '감자튀김'], 세계음식: ['쌀국수', '커리'], 레스토랑: ['스테이크', '파스타'],
    뷔페: ['뷔페'], 주점: ['안주', '소주'],
  };
  const FOOD_GROUPS = {
    고기: ['고기', '삼겹', '목살', '항정', '갈비', '숯불', '한우', '차돌', '등심', '곱창', '막창', '대창', '대패', '주물럭', '고기구이'],
    회: ['회', '횟집', '물회', '사시미', '광어', '방어', '모둠회', '횟'], 해산물: ['회', '조개', '해물', '대게', '장어', '꼼장어', '곰장어', '낙지', '쭈꾸미', '주꾸미', '아구', '전복', '굴'],
    국밥: ['국밥', '순대국', '해장국'], 국물: ['국밥', '탕', '찌개', '국', '전골'], 면: ['국수', '칼국수', '냉면', '밀면', '라멘', '우동', '짬뽕', '짜장', '쌀국수', '파스타', '소바', '면'],
    해장: ['해장국', '국밥', '콩나물국밥', '복국', '재첩', '짬뽕', '라멘', '선지', '북엇국', '해장'], 매운: ['짬뽕', '마라', '닭발', '떡볶이', '쭈꾸미', '주꾸미', '낙지', '불족발', '아구찜', '매운'],
    중식: ['중식', '짜장', '짬뽕', '탕수육', '마라', '양꼬치'], 일식: ['일식', '초밥', '스시', '돈까스', '돈카츠', '라멘', '우동', '오마카세', '덮밥'],
    양식: ['양식', '파스타', '피자', '스테이크', '버거', '브런치', '리조또'], 분식: ['분식', '떡볶이', '김밥', '순대', '튀김', '라볶이'],
    치킨: ['치킨', '통닭', '닭강정'], 커피: ['카페', '커피', '아메리카노', '라떼'], 디저트: ['베이커리', '케이크', '빵', '디저트', '빙수', '마카롱', '도넛', '와플', '크로플'],
    술: ['호프', '주점', '포차', '이자카야', '맥주', '하이볼', '와인', '술집'], 밥: ['백반', '정식', '한정식', '비빔밥', '덮밥', '쌈밥', '기사식당', '밥'],
  };
  const FOOD_CHIPS = ['고기', '국밥', '면', '회', '중식', '일식', '해장', '매운', '치킨', '분식', '디저트'];
  const normQ = (q) => String(q || '').toLowerCase().replace(/\s+/g, '');
  function foodTerms(q) {
    const out = [];
    for (const part of String(q || '').split(/[,·/]|\s+/).map(normQ).filter(Boolean)) {
      out.push(...(FOOD_GROUPS[part] || [part]));
    }
    return [...new Set(out)];
  }
  // 0: 안 맞음, 2: 이름·메뉴에 딱 있음, 1: 업종으로 짐작
  function foodMatch(r, terms) {
    if (!terms.length) return 2;
    const name = normQ(r.name), menu = (r.menu || []).join('|') + '|' + (r.food || '');
    for (const t of terms) {
      if (t.length === 1 ? name.endsWith(t) || (r.menu || []).includes(t) : name.includes(t) || menu.includes(t)) return 2;
    }
    if (r.menu && r.menu.length) return 0; // 메뉴를 아는 가게인데 없으면 아닌 걸로 (업종이 잘못 적힌 경우 대비)
    const typ = (TYPICAL[r.cat] || []).join('|') + '|' + r.cat;
    for (const t of terms) if (t.length > 1 ? typ.includes(t) : (TYPICAL[r.cat] || []).includes(t)) return 1;
    return 0;
  }
  function computePool() {
    // 직선거리는 실제 길보다 길 수 없으니, 직선으로 이 안에 있는 곳만 따져 보면 된다.
    const limit = S.minutes * SPEED / SIGNAL;
    const cosLat = Math.max(0.2, Math.cos(S.center.lat * Math.PI / 180));
    const dLat = limit / 110540, dLng = limit / (111320 * cosLat);
    const ex = new Set();
    if (settings.exclude) for (const id of recentIds()) ex.add(id);
    S.journey.slice(0, S.round - 1).forEach((r) => ex.add(r.id));
    const all = [], seen = new Set(), excluded = [], near = [];
    const ct = checkTime();
    const terms = foodTerms(S.food);
    let shut = 0;
    for (const r of S.all) {
      if (r.lat < S.center.lat - dLat || r.lat > S.center.lat + dLat || r.lng < S.center.lng - dLng || r.lng > S.center.lng + dLng) continue;
      const m = dist(S.center, r.lat, r.lng);
      if (m > limit) continue;
      near.push({ r, m });
      if (isHidden(r.id) || dislikedNow(r.id)) continue;
      if (!terms.length && (!kindOk(r.kind) || !catOk(r))) continue; // 음식을 넣으면 밥·술·카페 구분 없이 찾는다
      const fm = terms.length ? foodMatch(r, terms) : 2;
      if (!fm) continue;
      if (settings.openNow && openState(r, ct.d).closed) { shut++; continue; }
      const w = routeMeters(r, m), min = w / SPEED * SIGNAL;
      if (min > S.minutes + 0.49) continue;
      const c = { r, m, w, min, sc: score(r) + (fm === 2 ? 0 : -15), fm };
      if (ex.has(r.id)) { excluded.push(c); continue; }
      const key = r.name + '@' + Math.round(r.lat * 5000) + ',' + Math.round(r.lng * 5000);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(c);
    }
    // 주변 후보 안에서 순위로 등급 기준점 계산
    if (all.length) {
      const sc = all.map((c) => c.sc).sort((a, b) => b - a);
      const at = (q) => sc[Math.min(sc.length - 1, Math.max(0, Math.ceil(sc.length * q) - 1))];
      cuts = { top: at(0.3), good: at(0.6), mid: at(0.85) };
    }
    const q = tierQ();
    const minScore = q >= 1 || !all.length ? -1e9 : cuts[settings.tier] ?? cuts.good;
    const out = all.filter((c) => c.sc >= minScore);
    out.sort((a, b) => (b.fm || 2) - (a.fm || 2) || a.min - b.min); // 음식을 넣었으면 그 메뉴가 확실한 곳 먼저
    S.near = near;
    S.check = ct; S.shut = shut;
    S.pool = out;
    S.excluded = excluded;
    scheduleWalk();
  }

  // ------------------------------------------------------------ 실제로 걷는 길 (OpenStreetMap 보행 경로)
  // 중심에서 주변 가게까지의 '실제 걷는 길' 거리를 길찾기 서버(FOSSGIS)에서 한 번에 최대 99곳씩 받는다.
  // 위치마다 최대 3번(1초 이상 간격)만 묻고, 나머지 가게는 가까운 실측값의 '돌아가는 비율'로 추정한다.
  const ROUTER = 'https://routing.openstreetmap.de/routed-foot/';
  const W = { key: '', exact: new Map(), samples: [], passes: 0, busy: false, last: 0, failUntil: 0, timer: 0, total: 0, route: null, bins: null };
  function routeMeters(r, m) {
    const ex = W.exact.get(r.id);
    if (ex != null) return ex;
    return m * ratioAt(r.lat, r.lng, m);
  }
  function ratioAt(lat, lng, m) {
    if (!W.samples.length) return m < 60 ? 1.2 : DETOUR;
    const cosLat = Math.cos(lat * Math.PI / 180);
    let a = [1e12, 0], b = [1e12, 0], c = [1e12, 0], d = [1e12, 0];
    for (const p of W.samples) {
      const dd = Math.hypot((p.lat - lat) * 110540, (p.lng - lng) * 111320 * cosLat);
      if (dd < d[0]) { d = [dd, p.ratio]; if (d[0] < c[0]) { [c, d] = [d, c]; if (c[0] < b[0]) { [b, c] = [c, b]; if (b[0] < a[0]) [a, b] = [b, a]; } } }
    }
    let sw = 0, sr = 0;
    for (const [dd, ra] of [a, b, c, d]) { if (dd > 1e11) continue; const wt = 1 / (dd + 40); sw += wt; sr += ra * wt; }
    const r = sw ? sr / sw : DETOUR;
    return Math.max(1.02, Math.min(3, m < 60 ? Math.max(r, 1.2) : r));
  }
  const walkKey = () => S.center.lat.toFixed(4) + ',' + S.center.lng.toFixed(4);
  function scheduleWalk() {
    const key = walkKey();
    if (key !== W.key) {
      W.key = key; W.exact = new Map(); W.samples = []; W.passes = 0; W.bins = null; W.route = null;
    }
    if (!settings.route || W.busy || W.passes >= 3 || W.total >= 40 || !S.near || !S.near.length) return;
    if (Date.now() < W.failUntil || !navigator.onLine) return;
    clearTimeout(W.timer);
    W.timer = setTimeout(walkPass, Math.max(500, 1100 - (Date.now() - W.last)));
  }
  function pickDests() {
    const left = S.near.filter((c) => !W.exact.has(c.r.id) && c.m >= 25);
    if (!W.samples.length) {
      // 첫 번째: 방향 12칸 × 거리 3칸에 고르게 퍼진 표본
      const cells = new Map();
      const lim = S.minutes * SPEED / SIGNAL;
      for (const c of left) {
        const ang = Math.atan2(c.r.lat - S.center.lat, (c.r.lng - S.center.lng) * Math.cos(S.center.lat * Math.PI / 180));
        const k = Math.floor((ang + Math.PI) / (Math.PI * 2) * 12) % 12 + ':' + Math.min(2, Math.floor(c.m / lim * 3));
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(c);
      }
      const lists = [...cells.values()].map((l) => l.sort(() => Math.random() - 0.5));
      const out = [];
      for (let i = 0; out.length < 99 && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && out.length < 99) out.push(l[i]);
      return out;
    }
    // 그다음: 후보 중 아직 추정값인 곳, 특히 경계(정한 시간 ±2분)에 가까운 곳부터
    const pool = new Set(S.pool.map((c) => c.r.id));
    return left.map((c) => {
      const est = c.m * ratioAt(c.r.lat, c.r.lng, c.m) / SPEED * SIGNAL;
      return { c, k: (pool.has(c.r.id) ? 0 : 10) + Math.abs(est - S.minutes) };
    }).filter((x) => x.k < 12.5).sort((a, b) => a.k - b.k).slice(0, 99).map((x) => x.c);
  }
  async function walkPass() {
    if (W.busy) return;
    const key = W.key, origin = { lat: S.center.lat, lng: S.center.lng };
    const dests = pickDests();
    if (!dests.length) { W.passes = 3; return; }
    W.busy = true; W.last = Date.now(); W.total++;
    const coords = [origin, ...dests.map((c) => c.r)].map((p) => p.lng.toFixed(5) + ',' + p.lat.toFixed(5)).join(';');
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(ROUTER + 'table/v1/driving/' + coords + '?sources=0&annotations=distance',
        { signal: ctl.signal, referrerPolicy: 'strict-origin-when-cross-origin', credentials: 'omit' });
      clearTimeout(to);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      if (j.code !== 'Ok' || !j.distances || !j.distances[0]) throw new Error(j.code || 'bad');
      if (key !== W.key) return;
      const row = j.distances[0], snap0 = Math.min(150, (j.sources && j.sources[0] && j.sources[0].distance) || 0);
      dests.forEach((c, i) => {
        const dm = row[i + 1];
        if (typeof dm !== 'number' || !(dm >= 0)) return;
        const snap = Math.min(150, (j.destinations && j.destinations[i + 1] && j.destinations[i + 1].distance) || 0);
        const total = dm + snap + snap0;
        W.exact.set(c.r.id, Math.max(total, c.m));
        if (c.m >= 60) W.samples.push({ lat: c.r.lat, lng: c.r.lng, ratio: Math.max(1, Math.min(3, total / c.m)), ang: Math.atan2(c.r.lat - origin.lat, (c.r.lng - origin.lng) * Math.cos(origin.lat * Math.PI / 180)) });
      });
      W.passes++; W.bins = null;
    } catch (e) {
      W.failUntil = Date.now() + 5 * 60e3; // 서버가 바쁘거나 막히면 5분 동안은 직선 추정으로
    } finally {
      W.busy = false;
    }
    if (key === W.key) render();
  }
  // 방향별로 '정한 시간 안에 걸어서 닿는 거리' (지도에 울퉁불퉁한 도달 범위로 그린다)
  function reachBins() {
    if (W.bins) return W.bins;
    const N = 72, out = new Array(N), base = S.minutes * SPEED / SIGNAL;
    const glob = W.samples.length ? W.samples.reduce((a, p) => a + p.ratio, 0) / W.samples.length : DETOUR;
    for (let i = 0; i < N; i++) {
      const ang = -Math.PI + (i + 0.5) / N * Math.PI * 2;
      let sw = 0.6, sr = glob * 0.6;
      for (const p of W.samples) {
        let d = Math.abs(p.ang - ang); if (d > Math.PI) d = Math.PI * 2 - d;
        if (d > 0.6) continue;
        const wt = Math.cos(d / 0.6 * Math.PI / 2) ** 2;
        sw += wt; sr += p.ratio * wt;
      }
      out[i] = base / (sr / sw);
    }
    // 부드럽게
    const sm = out.map((_, i) => (out[(i + N - 2) % N] + 2 * out[(i + N - 1) % N] + 3 * out[i] + 2 * out[(i + 1) % N] + out[(i + 2) % N]) / 9);
    W.bins = sm;
    return sm;
  }
  // 정해진 곳까지 실제 걷는 길(선)을 받아 지도에 그린다
  async function fetchRoute(r) {
    W.route = null;
    if (!settings.route || !navigator.onLine || Date.now() < W.failUntil) return;
    const o = S.center;
    try {
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
      const res = await fetch(ROUTER + 'route/v1/driving/' + o.lng.toFixed(5) + ',' + o.lat.toFixed(5) + ';' + r.lng.toFixed(5) + ',' + r.lat.toFixed(5) +
        '?overview=full&geometries=geojson', { signal: ctl.signal, referrerPolicy: 'strict-origin-when-cross-origin', credentials: 'omit' });
      clearTimeout(to);
      const j = await res.json();
      const rt = j && j.routes && j.routes[0];
      if (!rt || !rt.geometry || !Array.isArray(rt.geometry.coordinates)) return;
      const pts = rt.geometry.coordinates.slice(0, 2000).filter((c) => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])).map((c) => [c[1], c[0]]);
      pts.unshift([o.lat, o.lng]); pts.push([r.lat, r.lng]);
      W.route = { id: r.id, pts, meters: rt.distance, t0: performance.now() };
      W.exact.set(r.id, Math.max(rt.distance, dist(o, r.lat, r.lng)));
      drawMap();
    } catch (e) { /* 선을 못 그리면 그냥 넘어간다 */ }
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
  // 'HHMM-HHMM|HHMM-HHMM|요일숫자(월=1)' → {open:[분,분], brk:[분,분], off:'1'}
  function parseHours(v) {
    const m = /^(?:(\d{4})-(\d{4}))?\|(?:(\d{4})-(\d{4}))?\|([1-7]{0,7})$/.exec(String(v || ''));
    if (!m) return null;
    const t = (x) => +x.slice(0, 2) * 60 + +x.slice(2);
    const h = { open: m[1] ? [t(m[1]), t(m[2])] : null, brk: m[3] ? [t(m[3]), t(m[4])] : null, off: m[5] };
    return h.open || h.off ? h : null;
  }
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
        blog: Number.isInteger(f[12]) && f[12] >= 0 && f[12] <= 5 ? f[12] : -1,
        menu: clip(f[13], 40).split('·').map((x) => x.trim()).filter(Boolean).slice(0, 3),
        hours: parseHours(f[14]),
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
    resetView();
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

  // ------------------------------------------------------------ 화면: 지도 (확대·이동·점 누르면 정보 카드)
  const canvas = $('#map');
  const ctx = canvas.getContext('2d');
  const mapwrap = $('#mapwrap');
  let view = null; // 좌표 변환 정보
  const V = { zoom: 1, px: 0, py: 0 }; // 확대 배율, 화면 이동(px)
  let popAnim = 0; // 점이 톡톡 나타나는 연출 시작 시각
  let lastPoolKey = '';
  function resetView() { V.zoom = 1; V.px = 0; V.py = 0; hideCard(); }

  // 길·건물 배경: OpenStreetMap 지도 그림을 레이더 느낌(흑백·옅게)으로 깐다.
  // 화면에 보이는 칸만 받고(미리 받기 없음), 브라우저 캐시를 그대로 쓴다. 못 받으면 격자만 보인다.
  const tiles = new Map(); // 'z/x/y' -> Image
  const osmAttr = $('#osmAttr');
  const darkQ = matchMedia('(prefers-color-scheme: dark)');
  const hasFilter = 'filter' in ctx;
  let tileRaf = 0;
  function tileImg(z, x, y) {
    const n = 1 << z; x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const k = z + '/' + x + '/' + y;
    let im = tiles.get(k);
    if (im) { tiles.delete(k); tiles.set(k, im); return im; }
    im = new Image();
    im.referrerPolicy = 'strict-origin-when-cross-origin'; // 지도 제공처 정책: 어느 사이트에서 쓰는지 알려야 함
    im.decoding = 'async';
    im.onload = () => { if (!tileRaf) tileRaf = requestAnimationFrame(() => { tileRaf = 0; drawMap(); }); };
    im.onerror = () => { im.bad = true; };
    im.src = 'https://tile.openstreetmap.org/' + k + '.png';
    tiles.set(k, im);
    if (tiles.size > 260) tiles.delete(tiles.keys().next().value);
    return im;
  }
  const ready = (im) => im && im.complete && !im.bad && im.naturalWidth > 0;
  function drawTiles(cx, cy, mpp, w, h, cosLat, dpr) {
    if (!settings.basemap || !navigator.onLine) return false;
    const z = Math.max(3, Math.min(19, Math.round(Math.log2(156543.03 * cosLat * dpr / mpp))));
    const s = (156543.03 * cosLat / (1 << z)) / mpp; // 지도 그림 1px이 화면에서 몇 px인지
    const n = 256 * (1 << z), lat = S.center.lat * Math.PI / 180;
    const Cx = (S.center.lng + 180) / 360 * n, Cy = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * n;
    const x0 = Math.floor((Cx - cx / s) / 256), x1 = Math.floor((Cx + (w - cx) / s) / 256);
    const y0 = Math.floor((Cy - cy / s) / 256), y1 = Math.floor((Cy + (h - cy) / s) / 256);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) return false;
    const dark = darkQ.matches;
    ctx.save();
    if (hasFilter) ctx.filter = dark ? 'grayscale(1) invert(1) brightness(.9) contrast(.85)' : 'grayscale(1) contrast(.9) brightness(1.04)';
    ctx.globalAlpha = hasFilter ? (dark ? 0.5 : 0.62) : 0.4;
    ctx.imageSmoothingEnabled = true;
    const size = 256 * s + 0.5;
    for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
      const sx = cx + (tx * 256 - Cx) * s, sy = cy + (ty * 256 - Cy) * s;
      const im = tileImg(z, tx, ty);
      if (ready(im)) { ctx.drawImage(im, sx, sy, size, size); continue; }
      // 아직 안 받아졌으면 한 단계 넓은 그림을 잘라서 임시로
      if (z > 3) {
        const pn = 1 << (z - 1), p = tiles.get((z - 1) + '/' + ((((tx >> 1) % pn) + pn) % pn) + '/' + (ty >> 1));
        if (ready(p)) ctx.drawImage(p, (tx & 1) * 128, (ty & 1) * 128, 128, 128, sx, sy, size, size);
      }
    }
    ctx.restore();
    return true;
  }
  darkQ.addEventListener && darkQ.addEventListener('change', () => drawMap());
  function drawMap() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bins = reachBins(), NB = bins.length;
    const radiusM = Math.max(...bins) * 1.04, baseR = Math.min(w, h) / 2 * 0.84, mpp = radiusM / baseR / V.zoom;
    const cosLat = Math.cos(S.center.lat * Math.PI / 180);
    const cx = w / 2 + V.px, cy = h / 2 + V.py, radiusPx = radiusM / mpp;
    const toPx = (lat, lng) => [cx + (lng - S.center.lng) * 111320 * cosLat / mpp, cy - (lat - S.center.lat) * 110540 / mpp];
    view = { toPx, mpp, cx, cy, cosLat, w, h, radiusPx };
    // 걸어서 닿는 범위(방향마다 다름) 모양 — scale배 크기로
    const blob = (scale) => {
      const path = new Path2D();
      for (let i = 0; i <= NB; i++) {
        const k = i % NB, ang = -Math.PI + (k + 0.5) / NB * Math.PI * 2, rr = bins[k] * scale / mpp;
        const x = cx + Math.cos(ang) * rr, y = cy - Math.sin(ang) * rr;
        if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
      }
      path.closePath();
      return path;
    };
    const reach = blob(1);
    view.reach = reach;
    const P = { map: css('--map'), line: css('--line'), muted: css('--muted'), accent: css('--accent'), ring: css('--ring'), ink: css('--ink'),
      surface: css('--surface'), bg: css('--bg'), b: css('--meal'), s: css('--drink'), bs: css('--both'), c: css('--cafe') };
    const font = css('--font');
    ctx.fillStyle = P.map; ctx.fillRect(0, 0, w, h);
    const based = drawTiles(cx, cy, mpp, w, h, cosLat, dpr);
    osmAttr.hidden = !based;
    // 100m 격자 (길 그림이 있으면 더 옅게)
    const grid = 100 / mpp;
    if (grid > 12) {
      ctx.strokeStyle = P.line; ctx.globalAlpha = based ? 0.18 : 0.45; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = ((cx % grid) + grid) % grid; x < w; x += grid) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = ((cy % grid) + grid) % grid; y < h; y += grid) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }
    // 걸어서 닿는 범위 (안쪽은 은은한 빛, 바깥은 살짝 어둡게)
    ctx.save();
    ctx.fillStyle = 'rgba(10,16,26,.10)'; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out'; ctx.fill(reach); ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, radiusPx);
    gr.addColorStop(0, 'rgba(255,194,26,.30)'); gr.addColorStop(0.7, 'rgba(255,194,26,.13)'); gr.addColorStop(1, 'rgba(255,194,26,.06)');
    ctx.fillStyle = gr; ctx.fill(reach);
    ctx.font = '700 11px ' + font;
    ctx.setLineDash([4, 4]); ctx.strokeStyle = P.muted; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
    for (const m of [5, 10, 15]) {
      if (m >= S.minutes) continue;
      ctx.stroke(blob(m / S.minutes));
      const top = bins[Math.floor(NB * 0.75)] * m / S.minutes / mpp;
      ctx.fillStyle = P.muted; ctx.globalAlpha = 0.85; ctx.textAlign = 'center'; ctx.fillText(m + '분', cx, cy - top - 4); ctx.globalAlpha = 0.45;
    }
    ctx.globalAlpha = 1; ctx.setLineDash([11, 6]); ctx.lineWidth = 2.5; ctx.strokeStyle = P.ring;
    ctx.stroke(reach); ctx.setLineDash([]);
    const topR = bins[Math.floor(NB * 0.75)] / mpp;
    const label = (S.food ? '「' + S.food.slice(0, 8) + '」 ' : '') + '도보 ' + S.minutes + '분' + (W.exact.size ? ' · 실제 길' : '') +
      (settings.openNow && S.check ? (S.check.now ? ' · 지금 연 곳' : ' · ' + hhmm(S.check.d.getHours() * 60 + S.check.d.getMinutes()) + '에 연 곳') : '');
    // 크게 확대했을 때만 후보가 아닌 가게를 흐리게
    const poolIds = new Set(S.pool.map((c) => c.r.id));
    if (V.zoom >= 2) {
      const halfLat = (h * mpp) / 110540, halfLng = (w * mpp) / (111320 * cosLat);
      ctx.fillStyle = P.muted; ctx.globalAlpha = 0.25;
      let n = 0;
      for (const r of S.all) {
        if (Math.abs(r.lat - S.center.lat) > halfLat || Math.abs(r.lng - S.center.lng) > halfLng || poolIds.has(r.id)) continue;
        const [x, y] = toPx(r.lat, r.lng);
        if (x < -10 || y < -10 || x > w + 10 || y > h + 10) continue;
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
        if (++n > 3000) break;
      }
      ctx.globalAlpha = 1;
    }
    // 이번 주에 간 곳
    for (const e of S.excluded || []) {
      const [x, y] = toPx(e.r.lat, e.r.lng);
      ctx.fillStyle = P.surface; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = P.muted; ctx.lineWidth = 2; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.stroke();
    }
    // 후보: 처음 나타날 때 톡톡 튀어나온다
    const now = performance.now(), regs = regulars();
    const dotR = Math.min(9, 5.6 + (V.zoom - 1) * 0.9);
    let visible = 0, animating = false;
    const dots = [];
    S.pool.forEach((c, i) => {
      const [x, y] = toPx(c.r.lat, c.r.lng);
      if (x < -12 || y < -12 || x > w + 12 || y > h + 12) return;
      visible++;
      dots.push({ x, y, a: Math.atan2(y - cy, x - cx), id: c.r.id, col: P[c.r.kind] || P.b });
      let k = 1;
      if (popAnim && !reduce) {
        const t = (now - popAnim - Math.min(i, 120) * 4) / 260;
        k = t <= 0 ? 0 : t >= 1 ? 1 : 1 + 2.70158 * Math.pow(t - 1, 3) + 1.70158 * Math.pow(t - 1, 2); // 살짝 튀는 등장
        if (t < 1) animating = true;
        if (t <= 0) return;
      }
      const liked = myStars(c.r.id) >= 4;
      ctx.fillStyle = P.surface; ctx.beginPath(); ctx.arc(x, y, (dotR + 1.8) * k, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = P[c.r.kind] || P.b; ctx.beginPath(); ctx.arc(x, y, dotR * k, 0, Math.PI * 2); ctx.fill();
      if (liked || regs.has(c.r.id) || c.r.model) { ctx.strokeStyle = liked ? '#FF5A3C' : P.accent; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(x, y, (dotR + 3.5) * k, 0, Math.PI * 2); ctx.stroke(); }
      if (card && card.r.id === c.r.id) { ctx.strokeStyle = P.ink; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, dotR + 6, 0, Math.PI * 2); ctx.stroke(); }
    });
    if (visible <= 24 || V.zoom >= 2.6) {
      ctx.font = '700 11px ' + font; ctx.textAlign = 'center';
      for (const c of S.pool) {
        const [x, y] = toPx(c.r.lat, c.r.lng);
        if (x < 0 || y < 0 || x > w || y > h) continue;
        const t = c.r.name.length > 10 ? c.r.name.slice(0, 9) + '…' : c.r.name;
        ctx.lineWidth = 3; ctx.strokeStyle = P.map; ctx.strokeText(t, x, y + dotR + 13);
        ctx.fillStyle = P.ink; ctx.fillText(t, x, y + dotR + 13);
      }
    }
    // 여정
    S.journey.forEach((r, i) => {
      const [x, y] = toPx(r.lat, r.lng);
      ctx.fillStyle = P.ink; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = P.bg; ctx.font = '900 13px ' + font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 1); ctx.textBaseline = 'alphabetic';
    });
    // 범위 이름표 (점 위에 보이도록 나중에)
    {
      ctx.font = '800 12px ' + font; ctx.textAlign = 'center';
      const tw = ctx.measureText(label).width + 16, ly = Math.max(16, cy - topR - 12);
      ctx.fillStyle = P.surface; ctx.globalAlpha = 0.92;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(cx - tw / 2, ly - 13, tw, 20, 10); else ctx.rect(cx - tw / 2, ly - 13, tw, 20); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = P.ink; ctx.fillText(label, cx, ly + 1);
    }
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
    canvas.setAttribute('aria-label', '도보 ' + S.minutes + '분 반경 지도, 후보 ' + S.pool.length + '곳');
    view.dots = dots; view.dotR = dotR;
    fxKick();
    $('#zoomLbl').textContent = '×' + (Math.round(V.zoom * 10) / 10);
    if (card) placeCard();
    if (animating) requestAnimationFrame(drawMap); else popAnim = 0;
  }

  // ------------------------------------------------------------ 지도 위 움직이는 연출
  // 레이더 빛줄기(걸어서 닿는 범위 안만), 빛이 지나갈 때 반짝이는 가게 점, 게임 전 조준, 정한 곳까지 걷는 사람
  const fxc = $('#mapfx'), fctx = fxc.getContext('2d');
  const SWEEP_MS = 4200;
  let fxRaf = 0, fxLast = 0, lock = null;
  function fxKick() { if (!fxRaf) fxRaf = requestAnimationFrame(fxFrame); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fxKick(); });
  function pathPts(pts) {
    const out = [];
    let len = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = view.toPx(pts[i][0], pts[i][1]);
      if (i) len += Math.hypot(x - out[i - 1][0], y - out[i - 1][1]);
      out.push([x, y, len]);
    }
    return out;
  }
  function fxFrame(t) {
    fxRaf = 0;
    if (!view || document.hidden) return;
    const live = !reduce && $('#game').hidden;
    if (live && t - fxLast < 30 && !lock) { fxRaf = requestAnimationFrame(fxFrame); return; } // 30fps면 충분 (배터리)
    fxLast = t;
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = view.w, h = view.h;
    if (fxc.width !== Math.round(w * dpr) || fxc.height !== Math.round(h * dpr)) { fxc.width = Math.round(w * dpr); fxc.height = Math.round(h * dpr); }
    const g = fctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const cx = view.cx, cy = view.cy, R = view.radiusPx * 1.05, acc = css('--accent');
    if (!reduce && view.reach) {
      // 1) 레이더 빛줄기
      const a = (t % SWEEP_MS) / SWEEP_MS * Math.PI * 2 - Math.PI, tail = 1.15;
      g.save(); g.clip(view.reach);
      if (g.createConicGradient) {
        const cg = g.createConicGradient(a - tail, cx, cy);
        const f = tail / (Math.PI * 2);
        cg.addColorStop(0, 'rgba(255,194,26,0)'); cg.addColorStop(f * 0.7, 'rgba(255,184,0,.22)');
        cg.addColorStop(f, 'rgba(255,200,40,.55)'); cg.addColorStop(Math.min(1, f + 0.002), 'rgba(255,194,26,0)'); cg.addColorStop(1, 'rgba(255,194,26,0)');
        g.fillStyle = cg; g.fillRect(0, 0, w, h);
      } else {
        for (let i = 0; i < 12; i++) {
          g.fillStyle = 'rgba(255,194,26,' + (0.03 * (i + 1) / 2).toFixed(3) + ')';
          g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a - tail + i * tail / 12, a - tail + (i + 1) * tail / 12); g.closePath(); g.fill();
        }
      }
      g.strokeStyle = 'rgba(255,214,90,.9)'; g.lineWidth = 2; g.shadowColor = acc; g.shadowBlur = 10;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.stroke();
      g.restore();
      // 2) 빛이 지나간 가게 점이 반짝
      const dr = view.dotR || 6;
      for (const d of view.dots || []) {
        let k = a - d.a; while (k < 0) k += Math.PI * 2; while (k >= Math.PI * 2) k -= Math.PI * 2;
        if (k > 1.0) continue;
        const al = 1 - k;
        g.globalAlpha = al * 0.9; g.strokeStyle = d.col; g.lineWidth = 2.4;
        g.beginPath(); g.arc(d.x, d.y, dr + 2 + k * 11, 0, Math.PI * 2); g.stroke();
        g.globalAlpha = al * 0.55; g.fillStyle = '#fff';
        g.beginPath(); g.arc(d.x, d.y, dr * 0.55, 0, Math.PI * 2); g.fill();
      }
      g.globalAlpha = 1;
      // 3) 가운데 물결
      for (const off of [0, 1200]) {
        const p = ((t + off) % 2400) / 2400;
        g.globalAlpha = (1 - p) * 0.8; g.strokeStyle = acc; g.lineWidth = 3;
        g.beginPath(); g.arc(cx, cy, 10 + p * 38, 0, Math.PI * 2); g.stroke();
      }
      g.globalAlpha = 1;
    }
    // 4) 정한 곳까지 실제 걷는 길 + 걷는 사람
    if (W.route) {
      const pp = pathPts(W.route.pts), total = pp[pp.length - 1][2];
      const grow = reduce ? 1 : Math.min(1, (t - W.route.t0) / 900);
      g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath(); pp.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.setLineDash([total * grow, total + 10]);
      g.strokeStyle = 'rgba(255,194,26,.45)'; g.lineWidth = 10; g.stroke();
      g.strokeStyle = css('--ink'); g.lineWidth = 3.4; g.setLineDash(grow < 1 ? [total * grow, total + 10] : [8, 7]); g.lineDashOffset = reduce ? 0 : -t / 35; g.stroke();
      g.restore();
      if (grow >= 1 && total > 20) {
        const p = reduce ? 0.5 : ((t - W.route.t0 - 900) % 7000) / 7000, at = p * total;
        let i = 1; while (i < pp.length - 1 && pp[i][2] < at) i++;
        const [x0, y0, l0] = pp[i - 1], [x1, y1, l1] = pp[i], q = l1 > l0 ? (at - l0) / (l1 - l0) : 0;
        const x = x0 + (x1 - x0) * q, y = y0 + (y1 - y0) * q;
        g.font = '22px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.save(); g.translate(x, y - 12 - (reduce ? 0 : Math.abs(Math.sin(t / 140)) * 3));
        if (x1 < x0) g.scale(-1, 1);
        g.fillText('🚶', 0, 0); g.restore(); g.textBaseline = 'alphabetic';
      }
    }
    // 5) 게임 직전 조준
    if (lock) {
      const el = t - lock.t0;
      lock.pts.forEach((pt, k) => {
        const st = el - k * lock.step;
        if (st < 0 || !pt) return;
        if (!pt.beeped) { pt.beeped = true; sfx.beep(1 + k * 0.07); buzz(6); }
        const q = Math.min(1, st / 200), sz = 30 - 16 * q, x = pt.x, y = pt.y;
        g.strokeStyle = '#FF3B30'; g.lineWidth = 2.6; g.globalAlpha = 0.5 + 0.5 * q;
        g.save(); g.translate(x, y); g.rotate((1 - q) * 1.2);
        for (let s4 = 0; s4 < 4; s4++) {
          g.rotate(Math.PI / 2);
          g.beginPath(); g.moveTo(-sz, -sz + 7); g.lineTo(-sz, -sz); g.lineTo(-sz + 7, -sz); g.stroke();
        }
        g.restore();
        g.globalAlpha = 0.35 * (1 - q * 0.6); g.lineWidth = 1.5; g.setLineDash([3, 4]);
        g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke(); g.setLineDash([]);
        g.globalAlpha = 1;
      });
      if (el > lock.step * lock.pts.length + 380) { const done = lock.done; lock = null; done(); }
    }
    if (live || lock || (W.route && !reduce)) fxRaf = requestAnimationFrame(fxFrame);
  }
  function lockOn(list, done) {
    if (reduce || !view || !view.toPx) { done(); return; }
    const pts = list.map((c) => {
      const [x, y] = view.toPx(c.r.lat, c.r.lng);
      return x < -20 || y < -20 || x > view.w + 20 || y > view.h + 20 ? null : { x, y };
    });
    if (!pts.some(Boolean)) { done(); return; }
    lock = { t0: performance.now(), step: Math.max(70, Math.min(130, 900 / list.length)), pts, done };
    fxKick();
  }
  function startPop() {
    const key = S.pool.length + ':' + (S.pool[0] && S.pool[0].r.id) + ':' + Math.round(S.center.lat * 1e4);
    if (key !== lastPoolKey) { lastPoolKey = key; popAnim = performance.now(); }
  }

  // 확대·이동: 한 손가락 끌기, 두 손가락 벌리기, 마우스 휠, +/- 버튼, 두 번 누르기
  function zoomAt(f, x, y) {
    const z = Math.max(1, Math.min(8, V.zoom * f));
    const k = z / V.zoom;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const ox = x - w / 2, oy = y - h / 2;
    V.px = ox - (ox - V.px) * k; V.py = oy - (oy - V.py) * k;
    V.zoom = z;
    if (z === 1) { V.px = 0; V.py = 0; }
    clampPan(); drawMap();
  }
  function clampPan() {
    const lim = Math.max(canvas.clientWidth, canvas.clientHeight) * V.zoom * 0.6;
    V.px = Math.max(-lim, Math.min(lim, V.px)); V.py = Math.max(-lim, Math.min(lim, V.py));
  }
  const ptrs = new Map();
  let gesture = null, pressTimer = 0, lastTap = 0;
  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, local(e));
    if (ptrs.size === 1) {
      const [x, y] = local(e);
      gesture = { mode: 'tap', x0: x, y0: y, px: V.px, py: V.py, t0: performance.now() };
      clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        if (gesture && gesture.mode === 'tap' && !hitDot(x, y)) { gesture.mode = 'done'; buzz(30); moveCenterTo(x, y); }
      }, 600);
    } else if (ptrs.size === 2) {
      clearTimeout(pressTimer);
      const [a, b] = [...ptrs.values()];
      gesture = { mode: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), z0: V.zoom, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || !gesture) return;
    ptrs.set(e.pointerId, local(e));
    if (gesture.mode === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const target = Math.max(1, Math.min(8, gesture.z0 * d / Math.max(10, gesture.d0)));
      zoomAt(target / V.zoom, gesture.mx, gesture.my);
    } else if (gesture.mode === 'tap' || gesture.mode === 'pan') {
      const [x, y] = local(e);
      if (gesture.mode === 'tap' && Math.hypot(x - gesture.x0, y - gesture.y0) > 7) { gesture.mode = 'pan'; clearTimeout(pressTimer); hideCard(); }
      if (gesture.mode === 'pan') { V.px = gesture.px + x - gesture.x0; V.py = gesture.py + y - gesture.y0; clampPan(); drawMap(); }
    }
  });
  const endPtr = (e) => {
    ptrs.delete(e.pointerId);
    clearTimeout(pressTimer);
    if (!gesture) return;
    if (gesture.mode === 'tap' && ptrs.size === 0) {
      const now = performance.now();
      const [x, y] = [gesture.x0, gesture.y0];
      const hit = hitDot(x, y);
      if (hit) { showCard(hit); }
      else if (now - lastTap < 320) { zoomAt(2, x, y); lastTap = 0; }
      else { lastTap = now; hideCard(); if (V.zoom === 1 && !S.pool.length && S.state === 'ready') toast('지도를 꾹 누르면 그곳을 중심으로 찾아요'); }
    }
    if (ptrs.size === 0) gesture = null;
    else if (ptrs.size === 1 && gesture.mode === 'pinch') { const [p] = [...ptrs.values()]; gesture = { mode: 'pan', x0: p[0], y0: p[1], px: V.px, py: V.py }; }
  };
  canvas.addEventListener('pointerup', endPtr);
  canvas.addEventListener('pointercancel', endPtr);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const [x, y] = local(e); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, x, y); }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  function hitDot(x, y) {
    if (!view) return null;
    let best = null, bd = 24;
    for (const c of S.pool) {
      const [px, py] = view.toPx(c.r.lat, c.r.lng);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }
  function moveCenterTo(x, y) {
    const lat = S.center.lat + (view.cy - y) * view.mpp / 110540;
    const lng = S.center.lng + (x - view.cx) * view.mpp / (111320 * view.cosLat);
    resetView();
    moveCenter({ lat, lng }, true);
  }
  $('#zoomIn').onclick = () => zoomAt(1.6, canvas.clientWidth / 2, canvas.clientHeight / 2);
  $('#zoomOut').onclick = () => zoomAt(1 / 1.6, canvas.clientWidth / 2, canvas.clientHeight / 2);

  // 점을 누르면 뜨는 작은 정보 카드
  let card = null;
  const cardEl = $('#card');
  function showCard(c) {
    card = c; buzz(8);
    const r = c.r, st = myStars(r.id), sc = score(r);
    cardEl.textContent = '';
    const head = document.createElement('div'); head.className = 'c-head';
    const dot = document.createElement('i'); dot.style.background = css({ b: '--meal', s: '--drink', bs: '--both', c: '--cafe' }[r.kind]);
    head.append(dot, textEl('b', r.name));
    const x = btn('×', 'c-x', hideCard); x.setAttribute('aria-label', '닫기'); head.append(x);
    const meta = textEl('div', r.cat + ' · 도보 ' + (W.exact.has(r.id) ? '' : '약 ') + walkMin(c.w) + '분 · 추천 ' + tierName(sc), 'c-meta');
    cardEl.append(head, meta);
    const bd = badges(r); if (st) bd.prepend(textEl('span', '★'.repeat(st) + ' 내 별점', 'bdg star')); if (bd.childElementCount) cardEl.append(bd);
    if (hasMenu(r)) cardEl.append(menuEl(r));
    if (r.hours) { const os = openState(r, new Date()); if (os.why) cardEl.append(textEl('div', (os.closed ? '⛔ 지금 ' : '✅ 지금 ') + os.why, 'c-meta')); }
    const acts = document.createElement('div'); acts.className = 'c-acts';
    acts.append(btn('자세히', '', () => { const cc = card; hideCard(); openDetail(cc.r); }), link('길찾기', kakaoRoute(r)), btn('여기로!', 'primary', () => { hideCard(); decide(r); }));
    cardEl.append(acts);
    cardEl.hidden = false;
    if (!reduce && cardEl.animate) cardEl.animate([{ transform: 'translate(-50%,-100%) translateY(10px) scale(.9)', opacity: 0 }, { transform: 'translate(-50%,-100%)', opacity: 1 }], { duration: 180, easing: 'ease-out' });
    placeCard(); drawMap();
  }
  function placeCard() {
    if (!card || !view) return;
    const [x, y] = view.toPx(card.r.lat, card.r.lng);
    const w = cardEl.offsetWidth || 240, mw = mapwrap.clientWidth;
    const left = Math.max(w / 2 + 8, Math.min(mw - w / 2 - 8, x));
    const below = y < (cardEl.offsetHeight || 140) + 20;
    cardEl.classList.toggle('below', below);
    cardEl.style.left = left + 'px'; cardEl.style.top = (below ? y + 18 : y - 14) + 'px';
  }
  function hideCard() { if (!card) return; card = null; cardEl.hidden = true; drawMap(); }

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
  let shownCount = 0, rollT = 0, rollFood = '';
  function rollCount(n) {
    const el = $('#count'), from = shownCount, t0 = performance.now();
    if (S.food !== rollFood) { rollFood = S.food; shownCount = -1; }
    shownCount = n; cancelAnimationFrame(rollT);
    const pre = S.food ? '「' + S.food.slice(0, 8) + '」 ' : '후보 ';
    if (reduce || from === n) { el.textContent = pre + n.toLocaleString('ko-KR') + '곳'; return; }
    (function f(t) {
      const p = Math.min(1, (t - t0) / 450), v = Math.round(from + (n - from) * (1 - Math.pow(1 - p, 3)));
      el.textContent = pre + v.toLocaleString('ko-KR') + '곳';
      if (p < 1) rollT = requestAnimationFrame(f);
    })(t0);
    if (el.animate) el.animate([{ transform: 'scale(1.12)' }, { transform: 'none' }], { duration: 300 });
  }
  function render() {
    computePool();
    $('#mLunch').setAttribute('aria-pressed', S.meal === 'lunch');
    $('#mDinner').setAttribute('aria-pressed', S.meal === 'dinner');
    $('#tMeal').setAttribute('aria-pressed', S.kinds.has('b'));
    $('#tDrink').setAttribute('aria-pressed', S.kinds.has('s'));
    $('#tCafe').setAttribute('aria-pressed', S.kinds.has('c'));
    const tiers = $('#tiers'); tiers.textContent = '';
    for (const [id, label] of TIERS) {
      const b = document.createElement('button'); b.dataset.tier = id; b.textContent = label;
      b.setAttribute('aria-pressed', settings.tier === id); tiers.append(b);
    }
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
    rollCount(S.pool.length);
    paintFood();
    startPop();
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
    } else if (t.dataset.tier) { settings.tier = t.dataset.tier; saveSettings(); hideCard(); render(); }
    else if (t.dataset.r) { S.round = +t.dataset.r; S.kinds = new Set(defaultKinds(S.round, S.meal === 'dinner')); render(); }
    else if (t.dataset.m) { S.minutes = +t.dataset.m; settings.minutes = S.minutes; saveSettings(); render(); }
    else if (t.dataset.cat) {
      const c = t.dataset.cat;
      if (c === '전체') S.cats.clear(); else if (S.cats.has(c)) S.cats.delete(c); else S.cats.add(c);
      render();
    } else if (t.dataset.g) startGame(t.dataset.g);
    else if (t.id === 'locBtn') { resetView(); locate(true); }
    else if (t.id === 'recBtn') openRecord();
    else if (t.id === 'areaBtn') openRegions();
    else if (t.id === 'searchBtn') openSearch();
    else if (t.id === 'setBtn') openSettings();
  });


  // 먹고 싶은 음식 입력칸
  const foodIn = $('#foodIn'), foodX = $('#foodX'), foodSug = $('#foodSug'), foodHint = $('#foodHint');
  let foodT = 0;
  function setFood(v, fromChip) {
    S.food = String(v || '').trim().slice(0, 20);
    if (foodIn.value !== S.food) foodIn.value = S.food;
    hideCard(); resetView(); render();
    if (fromChip) { foodIn.blur(); foodSug.hidden = true; }
    if (S.food && S.pool.length && !reduce) { sfx.pop(); }
  }
  function nearbyMenus() {
    const cnt = new Map();
    for (const c of S.near || []) for (const m of c.r.menu || []) cnt.set(m, (cnt.get(m) || 0) + 1);
    return [...cnt.entries()].filter(([m]) => !FOOD_CHIPS.includes(m)).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
  }
  function paintSug() {
    foodSug.textContent = '';
    const add = (label, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'fchip ' + (cls || ''); b.textContent = label;
      b.setAttribute('aria-pressed', S.food === label); b.onmousedown = (e) => e.preventDefault(); b.onclick = () => setFood(S.food === label ? '' : label, true); foodSug.append(b); };
    for (const g of FOOD_CHIPS) add(g, 'grp');
    const near = nearbyMenus();
    if (near.length) { foodSug.append(textEl('span', '이 근처 많은 메뉴', 'flabel')); for (const m of near) add(m, ''); }
  }
  function paintFood() {
    foodX.hidden = !S.food;
    document.body.classList.toggle('foodon', !!S.food);
    foodHint.textContent = '';
    if (!S.food) { foodHint.hidden = true; return; }
    foodHint.hidden = false;
    if (S.pool.length) {
      const c = S.pool[0];
      foodHint.append(textEl('span', '가장 가까운 곳 '), textEl('b', c.r.name), textEl('span', ' 도보 ' + (W.exact.has(c.r.id) ? '' : '약 ') + walkMin(c.w) + '분'));
      const b = btn('보기', 'sm ink', () => { const cc = S.pool.find((x) => x.r.id === c.r.id); if (cc) showCard(cc); });
      foodHint.append(b);
    } else {
      foodHint.append(textEl('span', '도보 ' + S.minutes + '분 안에 「' + S.food + '」 가게가 없어요'));
      if (S.minutes < 20) foodHint.append(btn('20분으로 넓히기', 'sm ink', () => { S.minutes = 20; settings.minutes = 20; saveSettings(); render(); }));
      else if (settings.tier !== 'all') foodHint.append(btn('등급 전체로', 'sm ink', () => { settings.tier = 'all'; saveSettings(); render(); }));
    }
  }
  foodIn.addEventListener('input', () => { clearTimeout(foodT); foodT = setTimeout(() => setFood(foodIn.value), 300); });
  foodIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(foodT); setFood(foodIn.value, true); } });
  foodIn.addEventListener('focus', () => { paintSug(); foodSug.hidden = false; });
  foodIn.addEventListener('blur', () => setTimeout(() => { foodSug.hidden = true; }, 150));
  foodX.addEventListener('click', () => setFood('', true));

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
    visits.push([r.id, r.name, Date.now(), S.meal]);
    visits = visits.filter((v) => Date.now() - v[2] < 90 * DAY).slice(-400);
    store.set('visits', visits);
    S.journey = S.journey.slice(0, S.round - 1);
    S.journey[S.round - 1] = r;
    closeGame(); closeSheet();
    fetchRoute(r);
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
    if (lock) return;
    curGame = type;
    cands = weightedPick(p, n);
    lockOn(cands, () => openGame(type));
  }
  function openGame(type) {
    stopAll(); gameKey++;
    $('#game').hidden = false; result.hidden = true; stage.textContent = '';
    $('#gTitle').textContent = TITLES[type];
    $('#gHead').textContent = S.round + '차 · ' + (S.food ? '「' + S.food.slice(0, 8) + '」 · ' : (S.meal === 'lunch' ? '점심' : '저녁') + ' · ') + '후보 ' + cands.length + '곳 (전체 ' + S.pool.length.toLocaleString('ko-KR') + '곳)';
    requestAnimationFrame(() => ({ roulette, ladder, pirate, race, cup, bomb, slot, shake: shakeGame })[type](cands));
  }
  function closeGame() { stopAll(); gameKey++; $('#game').hidden = true; curGame = null; fxKick(); }
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
        const s = document.createElement('small'); s.textContent = (menuOf(x.r).slice(0, 2).join('·') || x.r.cat) + ' · 도보 ' + walkMin(x.w || x.m * DETOUR) + '분';
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
    if (myStars(r.id) >= 4) add('또 가고 싶은 곳', 'like');
    if (r.blog >= 4) add('🔥 후기 많음', 'hot');
    return box;
  }
  // 추천 메뉴 (최대 3개): 블로그 후기에 자주 나온 메뉴 > 공공데이터 대표 음식 > 가게 이름
  function hoursText(h) {
    const parts = [];
    if (h.open) parts.push(h.open[0] === 0 && h.open[1] === 1440 ? '24시간' : hhmm(h.open[0]) + '~' + hhmm(h.open[1]));
    if (h.brk) parts.push('브레이크 ' + hhmm(h.brk[0]) + '~' + hhmm(h.brk[1]));
    if (h.off) parts.push([...h.off].map((d) => DAYN[+d % 7]).join('·') + '요일 휴무');
    return parts.join(' · ');
  }
  function menuOf(r) {
    if (r.menu && r.menu.length) return r.menu;
    return r.food ? r.food.split(/[,·/]/).map((x) => x.trim()).filter(Boolean).slice(0, 3) : [];
  }
  function menuEl(r, big) {
    const d = document.createElement('div');
    const real = menuOf(r), guess = !real.length;
    const list = guess ? (TYPICAL[r.cat] || []) : real;
    d.className = 'menu' + (big ? ' big' : '') + (guess ? ' guess' : '');
    d.append(textEl('span', guess ? '보통 이런 메뉴' : '추천 메뉴', 'mlabel'));
    const terms = foodTerms(S.food);
    for (const m of list) {
      const hit = terms.some((t) => t.length > 1 && (m.includes(t) || t.includes(m)));
      d.append(textEl('span', m, 'mchip' + (hit ? ' hit' : '')));
    }
    return d;
  }
  const hasMenu = (r) => menuOf(r).length > 0 || (TYPICAL[r.cat] || []).length > 0;
  function textEl(tag, text, cls) { const e = document.createElement(tag); if (cls) e.className = cls; e.textContent = text; return e; }
  function btn(label, cls, fn) { const b = document.createElement('button'); b.className = 'btn ' + (cls || ''); b.textContent = label; b.onclick = fn; return b; }
  function row(...kids) { const d = document.createElement('div'); d.className = 'actions'; d.append(...kids); return d; }
  function note(t) { return textEl('p', t, 'note'); }

  function showResult(cand, fromEl) {
    const r = cand.r, wm = routeMeters(r, cand.m), mins = walkMin(wm);
    result.textContent = ''; result.hidden = false;
    const title = textEl('h3', r.name);
    result.append(
      textEl('div', S.round + '차 당첨', 'eyebrow'), title,
      textEl('div', r.cat + ' · 도보 ' + (W.exact.has(r.id) ? '' : '약 ') + mins + '분 (길 ' + Math.round(wm) + 'm)', 'meta'), badges(r),
    );
    if (hasMenu(r)) result.append(menuEl(r, true));
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
    const m = dist(S.center, r.lat, r.lng), wm = routeMeters(r, m), mins = walkMin(wm);
    openSheet(r.cat || '식당', (b) => {
      b.append(textEl('h3', r.name, 'detail'), textEl('div', '도보 ' + (W.exact.has(r.id) ? '' : '약 ') + mins + '분 (길 ' + Math.round(wm) + 'm) · ' + ({ b: '밥', s: '술', bs: '밥+술', c: '카페' }[r.kind]) + ' · 추천 ' + tierName(score(r)), 'meta'), badges(r));
      const myRow = document.createElement('div'); myRow.className = 'myrate';
      const w = textEl('span', myStars(r.id) ? STAR_WORDS[myStars(r.id)] : '내 별점', 'meta');
      myRow.append(starsEl(myStars(r.id), (n) => { rate(r, n); w.textContent = STAR_WORDS[n]; render(); }), w);
      b.append(myRow);
      if (hasMenu(r)) {
        b.append(menuEl(r, true));
        b.append(textEl('div', r.blog > 0 ? '추천 메뉴는 블로그 후기에 자주 나온 메뉴와 가게 이름·공공데이터 대표 음식으로 골랐어요' : '추천 메뉴는 가게 이름과 공공데이터 대표 음식으로 짐작한 거예요', 'fine'));
      }
      b.append(textEl('div', '블로그 후기: ' + (r.blog >= 0 ? BLOG_WORDS[r.blog] : '아직 확인 전'), 'meta'));
      if (r.hours) b.append(textEl('div', '영업시간(블로그 글 기준): ' + hoursText(r.hours), 'meta'));
      const os = openState(r, new Date());
      if (os.why) b.append(textEl('div', (os.closed ? '⛔ 지금 ' : '✅ 지금 ') + os.why + (r.hours ? '' : ' (추정)'), 'openst' + (os.closed ? ' shut' : '')));
      const dl = document.createElement('dl'); dl.className = 'kv';
      const kv = (k, v) => dl.append(textEl('dt', k), textEl('dd', v));
      if (r.addr) kv('주소', r.addr);
      if (r.open) kv('영업 신고', Math.floor(r.open / 10000) + '.' + Math.floor(r.open / 100) % 100 + '.' + r.open % 100 + (isNew(r) ? ' (새로 문 연 곳)' : ''));
      const last = visits.filter((v) => v[0] === r.id).pop();
      if (last) kv('최근 방문', Math.floor((Date.now() - last[2]) / DAY) === 0 ? '오늘' : Math.floor((Date.now() - last[2]) / DAY) + '일 전');
      b.append(dl);
      b.append(row(link('카카오맵에서 보기', kakaoPlace(r)), link('길찾기', kakaoRoute(r))));
      b.append(row(link('블로그 후기 찾아보기', 'https://search.naver.com/search.naver?where=blog&query=' + encodeURIComponent(((r.region || '').split(' ').pop() || '') + ' ' + r.name), 'sm')));
      const r2 = row(btn(fav.has(r.id) ? '★ 단골 해제' : '☆ 단골 등록', '', () => {
        if (fav.has(r.id)) fav.delete(r.id); else fav.add(r.id);
        store.set('fav', [...fav]); toast(fav.has(r.id) ? '단골로 등록했어요' : '단골에서 뺐어요'); render(); openDetail(r);
      }));
      if (r.tel.length >= 9) r2.append(link('전화', 'tel:' + r.tel));
      r2.append(btn('공유', '', () => share(r, S.round, mins)));
      b.append(r2);
      b.append(row(btn('🍽 여기서 먹었어요', 'sm', () => recordForm(r)), btn('문 닫혀 있었어요', 'sm', () => { reportClosed(r); hide(r, 3); closeSheet(); toast('3일 동안 빼고, 앞으로 이 요일·시간대에는 빼 둘게요'); }), btn('다시 안 보기', 'sm', () => { hide(r, 0); closeSheet(); })));
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
        const shown = (q ? base.filter((x) => x.r.name.toLowerCase().includes(q) || x.r.cat.includes(q) || x.r.food.includes(q) || x.r.menu.some((m) => m.includes(q))) : base).slice(0, 200);
        cnt.textContent = shown.length + '곳' + (shown.length === 200 ? ' (가까운 200곳)' : '');
        list.textContent = '';
        const P = { b: css('--meal'), s: css('--drink'), bs: css('--both'), c: css('--cafe') };
        for (const x of shown) {
          const it = document.createElement('button'); it.className = 'item' + (recent.has(x.r.id) ? ' ex' : '');
          const k = document.createElement('span'); k.className = 'k'; k.style.background = P[x.r.kind];
          const mid = document.createElement('span');
          const nm = textEl('div', x.r.name, 'nm'); const sub = document.createElement('div'); sub.className = 'sub';
          sub.append(document.createTextNode(x.r.cat + (menuOf(x.r).length ? ' · ' + menuOf(x.r).join('·') : '') + (recent.has(x.r.id) ? ' · 이번 주 방문' : '')));
          const bd = badges(x.r); if (bd.childElementCount) sub.append(bd);
          mid.append(nm, sub);
          const rt = document.createElement('span'); rt.className = 'rt'; rt.append(textEl('b', walkMin(routeMeters(x.r, x.m)) + '분'));
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
          saveSettings(); x.setAttribute('aria-pressed', settings[key]);
          if (key === 'lowfx') { location.reload(); return; }
          if (key === 'basemap') drawMap();
          if (key === 'route') { W.key = ''; W.failUntil = 0; }
          render();
        };
        return x;
      };
      b.append(sw('폰을 흔들면 바로 뽑기', 'shake'), sw('이번 주에 간 곳은 후보에서 빼기', 'exclude'), sw('지도에 길·건물 보이기', 'basemap'), sw('실제 걷는 길로 시간 계산', 'route'), sw('그 시간에 문 닫은 곳 빼기', 'openNow'), sw('화면 효과 줄이기 (오래된 폰·배터리 절약)', 'lowfx'));
      const snd = document.createElement('button'); snd.className = 'setrow';
      const paint = () => snd.setAttribute('aria-pressed', !(window.MMFX && MMFX.isMuted()));
      snd.append(textEl('span', '게임 효과음')); const si = document.createElement('i'); si.className = 'switch'; snd.append(si);
      snd.onclick = () => { if (window.MMFX) { MMFX.setMuted(!MMFX.isMuted()); paint(); paintSound(); } };
      paint(); b.append(snd);
      if (CONFIG.donate) b.append(link('☕ 만든 사람에게 커피 한 잔 사 주기', CONFIG.donate, 'donate'));
      b.append(btn('🍽 내 기록·별점 보기', '', openHistory));
      const hc = Object.keys(hidden).filter(isHidden).length;
      if (hc) b.append(btn('숨긴 식당 ' + hc + '곳 모두 다시 보기', '', () => { hidden = {}; store.set('hidden', hidden); toast('모두 다시 보이게 했어요'); render(); closeSheet(); }));
      let confirmClear = false;
      const clearBtn = btn('방문 기록·단골·별점 지우기', '', () => {
        if (!confirmClear) { confirmClear = true; clearBtn.textContent = '한 번 더 누르면 지워져요'; return; }
        visits = []; fav = new Set(); ratings = {}; store.set('visits', visits); store.set('fav', []); store.set('ratings', {}); toast('기록을 지웠어요'); render(); closeSheet();
      });
      b.append(clearBtn);
      b.append(btn('식당 데이터 새로 받기', '', async () => {
        try { if (window.caches) for (const k of await caches.keys()) if (k.startsWith('mm-data')) await caches.delete(k); } catch (e) { /* 무시 */ }
        S.loaded.clear(); S.regions = []; closeSheet(); loadAround();
      }));
      b.append(note('홈 화면에 추가하면 앱처럼 쓸 수 있어요.\n· 아이폰(사파리): 공유 버튼 → "홈 화면에 추가"\n· 안드로이드(크롬): 메뉴(⋮) → "홈 화면에 추가" 또는 "앱 설치"'));
      b.lastChild.style.whiteSpace = 'pre-line';
      b.append(note('식당 정보: 행정안전부 지방행정 인허가 공공데이터(일반·휴게·모범음식점)를 매일 자동 갱신 · 마지막 갱신 ' + (S.generated || '-') +
        '. 실제 영업 여부와 다를 수 있어요. 위치와 기록은 이 폰의 브라우저에만 저장돼요. 지도 그림·걷는 길: © OpenStreetMap 기여자, 길찾기 FOSSGIS. 블로그 후기 양: 다음 검색(카카오).'));
      const pv = link('개인정보처리방침', 'privacy.html'); b.append(pv);
    });
  }

  // ------------------------------------------------------------ 먹은 곳 기록·별점
  function starsEl(cur, onPick, big) {
    const box = document.createElement('div'); box.className = 'stars' + (big ? ' big' : '');
    box.setAttribute('role', 'group'); box.setAttribute('aria-label', '별점');
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement('button'); b.textContent = '★'; b.setAttribute('aria-label', i + '점');
      b.setAttribute('aria-pressed', i <= cur);
      b.onclick = () => {
        [...box.children].forEach((x, j) => x.setAttribute('aria-pressed', j < i));
        sfx.tock(1 + i * 0.1); buzz(8);
        if (!reduce && b.animate) b.animate([{ transform: 'scale(1.6) rotate(-15deg)' }, { transform: 'none' }], { duration: 260 });
        onPick(i);
      };
      box.append(b);
    }
    return box;
  }
  const STAR_WORDS = ['', '별로였어요 (한 달간 빼기)', '아쉬웠어요 (한 달간 빼기)', '보통이에요', '좋았어요 (다음 주 우선 추천)', '최고! (다음 주 우선 추천)'];
  const mealName = (m) => ({ lunch: '점심', dinner: '저녁' }[m] || '식사');
  function visitLabel(v) {
    const d = new Date(v[2]), days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(v[2]).setHours(0, 0, 0, 0)) / DAY);
    const when = days === 0 ? '오늘' : days === 1 ? '어제' : (d.getMonth() + 1) + '/' + d.getDate();
    return when + ' ' + mealName(v[3]);
  }

  function openRecord() {
    openSheet('먹은 곳 기록', (b) => {
      const base = S.myLoc || S.center;
      b.append(note('근처에서 먹은 곳을 고르세요. 이번 주 후보에서 빠지고, 별점은 다음 주 추천에 반영돼요.'));
      const inp = document.createElement('input'); inp.className = 'search'; inp.type = 'search'; inp.placeholder = '가게 이름 (예: 국밥)'; inp.maxLength = 30;
      inp.setAttribute('enterkeyhint', 'search');
      const list = document.createElement('div');
      const draw = () => {
        const q = inp.value.trim().toLowerCase();
        const near = S.all.map((r) => ({ r, m: dist(base, r.lat, r.lng) })).filter((x) => x.m < (q ? 2000 : 600) && (!q || x.r.name.toLowerCase().includes(q)))
          .sort((a, c) => a.m - c.m).slice(0, 60);
        list.textContent = '';
        if (!near.length) list.append(note(S.all.length ? '근처에서 찾지 못했어요. 이름으로 검색해 보세요.' : '식당 정보를 불러오는 중이에요.'));
        for (const x of near) {
          const it = document.createElement('button'); it.className = 'item';
          const k = document.createElement('span'); k.className = 'k'; k.style.background = css({ b: '--meal', s: '--drink', bs: '--both', c: '--cafe' }[x.r.kind]);
          const mid = document.createElement('span'); mid.append(textEl('div', x.r.name, 'nm'), textEl('div', x.r.cat + (myStars(x.r.id) ? ' · ' + '★'.repeat(myStars(x.r.id)) : ''), 'sub'));
          const rt = document.createElement('span'); rt.className = 'rt'; rt.append(textEl('b', Math.round(x.m) + 'm'));
          it.append(k, mid, rt); it.onclick = () => recordForm(x.r);
          list.append(it);
        }
      };
      inp.oninput = draw; inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
      b.append(inp, list); draw();
    });
  }
  function recordForm(r) {
    openSheet('먹은 곳 기록', (b) => {
      let meal = new Date().getHours() < 15 ? 'lunch' : 'dinner', day = 0, stars = myStars(r.id);
      b.append(textEl('h3', r.name, 'detail'), textEl('div', r.cat + ' · ' + r.region, 'meta'));
      const seg = (opts, cur, set) => {
        const d = document.createElement('div'); d.className = 'seg';
        const paint = () => [...d.children].forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === String(cur())));
        for (const [v, l] of opts) { const x = document.createElement('button'); x.dataset.v = v; x.textContent = l; x.onclick = () => { set(v); paint(); }; d.append(x); }
        paint(); return d;
      };
      const row1 = document.createElement('div'); row1.className = 'row';
      row1.append(seg([['0', '오늘'], ['1', '어제'], ['2', '그저께']], () => day, (v) => { day = +v; }),
        seg([['lunch', '점심'], ['dinner', '저녁']], () => meal, (v) => { meal = v; }));
      const word = textEl('div', stars ? STAR_WORDS[stars] : '별점은 안 줘도 돼요', 'meta');
      b.append(row1, textEl('div', '어땠어요?', 'eyebrow'), starsEl(stars, (n) => { stars = n; word.textContent = STAR_WORDS[n]; }, true), word);
      b.append(btn('기록하기', 'primary', () => {
        const base = new Date(); base.setHours(meal === 'lunch' ? 12 : 19, 0, 0, 0);
        const t = Math.min(Date.now(), base.getTime() - day * DAY);
        visits.push([r.id, r.name, t, meal]);
        visits = visits.filter((v) => Date.now() - v[2] < 90 * DAY).slice(-400);
        store.set('visits', visits);
        if (stars) rate(r, stars);
        closeSheet(); render();
        FX.burst(innerWidth / 2, innerHeight * 0.6, 24); sfx.pop();
        toast('「' + r.name + '」 기록했어요' + (stars >= 4 ? ' · 다음 주에 우선 추천할게요' : stars && stars <= 2 ? ' · 한 달간 후보에서 뺄게요' : ''));
      }));
    });
  }
  function openHistory() {
    openSheet('내 기록·별점', (b) => {
      const seen = new Set();
      const list = visits.slice().sort((a, c) => c[2] - a[2]).filter((v) => {
        const k = v[0] + '@' + new Date(v[2]).toDateString(); if (seen.has(k)) return false; seen.add(k); return true;
      }).slice(0, 80);
      if (!list.length) { b.append(note('아직 기록이 없어요. 지도 오른쪽의 "먹은 곳" 버튼으로 기록해 보세요.')); return; }
      b.append(note('별점을 바꾸면 바로 추천에 반영돼요. 4점 이상은 우선 추천, 2점 이하는 한 달간 빠져요.'));
      for (const v of list) {
        const it = document.createElement('div'); it.className = 'hist';
        const left = document.createElement('div'); left.append(textEl('b', v[1]), textEl('small', visitLabel(v)));
        it.append(left, starsEl(myStars(v[0]), (n) => { rate({ id: v[0], name: v[1] }, n); render(); }));
        b.append(it);
      }
    });
  }
  // 다녀온 뒤 별점 물어보기 (한 번만, 최소 1시간 지난 뒤, 3일 안)
  function askReview() {
    if ($('#bannerRoot').childElementCount) return;
    let asked = store.get('asked', []);
    const now = Date.now();
    const v = visits.slice().reverse().find((x) => now - x[2] > 3600e3 && now - x[2] < 3 * DAY && !ratings[x[0]] && !asked.includes(x[0]));
    if (!v) return;
    asked = asked.concat([v[0]]).slice(-100); store.set('asked', asked);
    const root = $('#bannerRoot');
    const bn = document.createElement('div'); bn.className = 'banner review'; bn.setAttribute('role', 'status');
    bn.append(textEl('div', visitLabel(v) + ' 다녀온 곳', 'eyebrow'), textEl('b', '「' + v[1] + '」 어땠어요?'));
    bn.append(starsEl(0, (n) => {
      rate({ id: v[0], name: v[1] }, n); render();
      toast(n >= 4 ? '좋았군요! 다음 주에 우선 추천할게요' : n <= 2 ? '아쉬웠군요. 한 달간 빼 둘게요' : '기록했어요');
      setTimeout(() => { root.textContent = ''; }, 500);
    }, true));
    bn.append(row(btn('다음에', '', () => { root.textContent = ''; })));
    root.append(bn);
    if (!reduce && bn.animate) bn.animate([{ transform: 'translateY(-30px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 300, easing: 'ease-out' });
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
  handleSharedLink().then(() => setTimeout(askReview, 1200));
  if (!settings.onboarded) {
    $('#onb').hidden = false;
  } else if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((p) => { if (p.state === 'granted') locate(false); else loadAround(); }).catch(() => loadAround());
  } else loadAround();
})();
