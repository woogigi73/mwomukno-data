"""블로그 언급량과 추천 메뉴.

카카오(다음) 공식 블로그 검색 API로 "지역 + 가게 이름"을 검색해서
1) 그 가게를 실제로 다룬 최근 글이 얼마나 되는지(0~5 단계)와
2) 그 글들에 자주 나온 메뉴 이름(최대 3개)
만 계산해 저장한다. 글 내용·제목·링크는 저장하지 않는다(집계 숫자와 메뉴 단어만).
네이버·카카오 웹페이지를 긁어 오는(크롤링) 방식은 이용약관 위반이라 쓰지 않는다.
"""
import datetime as dt
import html
import re

from .classify import norm_name

BLOG_URL = "https://dapi.kakao.com/v2/search/blog"
REFRESH_DAYS = 45

# 메뉴 사전 (긴 이름이 먼저 잡히도록 길이순 정렬해서 쓴다)
MENU_WORDS = """
회 전 빵 난
돼지국밥 소고기국밥 순대국밥 콩나물국밥 따로국밥 수육국밥 내장국밥 국밥 수육 순대 순댓국 해장국 뼈해장국 감자탕 선지해장국 우거지국
밀면 물밀면 비빔밀면 냉면 물냉면 비빔냉면 평양냉면 함흥냉면 막국수 칼국수 바지락칼국수 손칼국수 수제비 잔치국수 비빔국수 콩국수 국수 우동 소바 메밀소바
짜장면 간짜장 짬뽕 짬뽕밥 탕수육 깐풍기 유린기 양장피 마라탕 마라샹궈 꿔바로우 군만두 물만두 만두 딤섬 볶음밥 마파두부 양꼬치
삼겹살 대패삼겹살 오겹살 목살 항정살 가브리살 갈매기살 돼지갈비 소갈비 갈비살 LA갈비 갈비찜 갈비탕 차돌박이 등심 안심 꽃등심 채끝 육회 육사시미 한우 숯불갈비 양념갈비 생갈비 주물럭
곱창 막창 대창 소곱창 돼지곱창 곱창전골 닭갈비 닭볶음탕 찜닭 닭한마리 삼계탕 백숙 닭발 똥집 오리고기 오리불고기 오리백숙 훈제오리
불고기 제육볶음 두루치기 김치찌개 된장찌개 부대찌개 순두부찌개 동태탕 알탕 매운탕 해물탕 아구찜 해물찜 낙지볶음 쭈꾸미 주꾸미 쭈꾸미볶음 오징어볶음 낚지볶음 낙곱새 곱도리탕
백반 정식 한정식 쌈밥 보쌈 족발 냉채족발 불족발 비빔밥 돌솥비빔밥 육개장 설렁탕 곰탕 꼬리곰탕 도가니탕 추어탕 장어 장어구이 민물장어 곰장어 꼼장어 생선구이 고등어구이 갈치조림 코다리 굴국밥 재첩국
회 모둠회 광어 우럭 방어 참치 연어 물회 회덮밥 초밥 스시 오마카세 사시미 해산물 조개구이 조개찜 대게 킹크랩 랍스터 새우구이 전복 전복죽 멍게 해삼 산낙지 꼼장어구이 복국 복어 생대구탕 대구탕 아귀찜
돈까스 돈카츠 치즈돈까스 카츠 규카츠 라멘 돈코츠라멘 규동 텐동 오야코동 카레 우동 덮밥 사케동 연어덮밥 타코야끼 오코노미야끼 야끼토리 꼬치 이자카야
파스타 크림파스타 토마토파스타 알리오올리오 리조또 스테이크 피자 화덕피자 버거 수제버거 햄버거 샌드위치 브런치 샐러드 포케 타코 부리또 쌀국수 분짜 팟타이 반미 똠양꿍 커리 탄두리 난
치킨 후라이드 양념치킨 간장치킨 닭강정 통닭 옛날통닭 파닭 치맥
떡볶이 로제떡볶이 순대 튀김 김밥 꼬마김밥 충무김밥 라볶이 오뎅 어묵 어묵탕 토스트 핫도그 붕어빵 호떡 씨앗호떡
전 파전 해물파전 김치전 빈대떡 막걸리 하이볼 생맥주 수제맥주 와인 칵테일 소주 사케 위스키 포차 안주
커피 아메리카노 라떼 카페라떼 아인슈페너 핸드드립 콜드브루 바닐라라떼 플랫화이트 에스프레소 크로플 와플 케이크 치즈케이크 티라미수 마카롱 스콘 크루아상 소금빵 베이글 도넛 휘낭시에 쿠키 빵 빙수 팥빙수 젤라또 아이스크림 밀크티 버블티 생과일주스 스무디 에이드
""".split()
# 메뉴 단어를 품고 있지만 메뉴가 아닌 말(먼저 잡아서 지운다): 베이커리→커리, 회사→회 …
NOT_MENU = {"베이커리", "카레라이스집", "우동역", "회사", "회관", "회식", "전국", "전화", "빵집", "커피숍"}
MENU = sorted(set(MENU_WORDS) | NOT_MENU, key=len, reverse=True)
# 이름만 봐서는 메뉴라고 하기 어려운 말(가게 이름에 흔한 말)
WEAK_IN_NAME = {"회", "전", "빵", "난", "카레", "커피", "안주", "포차", "소주", "와인", "한우"}
AD_WORDS = ("체험단", "협찬", "원고료", "제공받아", "제공 받아", "소정의", "업체로부터", "광고")

_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")


def strip(s) -> str:
    return _SPACE.sub(" ", html.unescape(_TAG.sub("", str(s or "")))).strip()


def region_word(addr: str) -> str:
    """'부산광역시 해운대구 우동 …' → '해운대', '경상남도 양산시 …' → '양산', '서울특별시 종로구' → '종로'."""
    parts = (addr or "").split()
    for p in parts[1:3]:
        if p.endswith(("구", "시", "군")) and len(p) >= 2:
            w = p[:-1]
            if len(w) >= 2:
                return w
            return p
    return parts[0][:2] if parts else ""


def dong_word(addr: str) -> str:
    for p in (addr or "").split()[2:5]:
        if p.endswith(("동", "읍", "면")) and len(p) >= 2 and not p[:-1].isdigit():
            return p
    return ""


def menu_from_text(text: str) -> dict:
    """글에서 메뉴 단어 세기. 긴 이름(돼지국밥)이 잡힌 자리는 짧은 이름(국밥)으로 다시 세지 않는다."""
    t = text.replace(" ", "")
    counts: dict = {}
    used = [False] * len(t)
    for w in MENU:
        if len(w) < 2:
            continue  # 한 글자(회·전·빵)는 글 속 다른 말과 헷갈려서 세지 않는다
        start = 0
        while True:
            i = t.find(w, start)
            if i < 0:
                break
            if not any(used[i:i + len(w)]):
                counts[w] = counts.get(w, 0) + 1
                for k in range(i, i + len(w)):
                    used[k] = True
            start = i + 1
    return counts


def place_words(addr: str) -> set:
    """주소에 나오는 동네 이름(해운대구 '우동' 같은 것)은 메뉴로 치지 않는다."""
    out = set()
    for p in (addr or "").split():
        out.add(p)
        if len(p) > 2 and p[-1] in "동읍면리로길":
            out.add(p)
    return out


def menu_from_name(name: str, addr: str = "") -> list:
    words = (name or "").split()
    if len(words) > 1 and words[-1].endswith("점"):
        words = words[:-1]  # 지점 이름(…우동벡스코점) 빼기
    c = menu_from_text(" ".join(words))
    bad = place_words(addr)
    return [w for w in sorted(c, key=lambda w: (-len(w), w)) if w not in WEAK_IN_NAME and w not in NOT_MENU and w not in bad][:2]


def merge_menu(food: str, blog_menu: list, name: str, addr: str = "") -> str:
    out: list = []
    bad = place_words(addr) | NOT_MENU
    blog_menu = [w for w in blog_menu if w not in bad]
    for src in ([s.strip() for s in re.split(r"[,·/]", food or "") if s.strip()], blog_menu, menu_from_name(name, addr)):
        for w in src:
            if len(out) >= 3:
                break
            if w and all(w not in o and o not in w for o in out):
                out.append(w[:12])
    return "·".join(out)


def bucket(est: float) -> int:
    return 0 if est < 1 else 1 if est < 5 else 2 if est < 20 else 3 if est < 60 else 4 if est < 200 else 5


def evaluate(name: str, addr: str, payload: dict, today: dt.date, chain: bool) -> tuple:
    """검색 결과 → (단계 0~5, 메뉴 목록). 글 내용은 여기서만 보고 버린다."""
    docs = payload.get("documents") or []
    total = int((payload.get("meta") or {}).get("total_count") or 0)
    nn = norm_name(name)
    region = region_word(addr)
    short = len(nn) <= 2
    rel = recent = ads = 0
    menu_counts: dict = {}
    for d in docs:
        text = strip(d.get("title")) + " " + strip(d.get("contents"))
        flat = norm_name(text)
        if not nn or nn not in flat:
            continue
        if (short or chain) and region and region not in text:
            continue
        rel += 1
        when = str(d.get("datetime") or "")[:10]
        try:
            if (today - dt.date.fromisoformat(when)).days <= 730:
                recent += 1
        except ValueError:
            pass
        if any(a in text for a in AD_WORDS):
            ads += 1
        for w, c in menu_from_text(text.replace(name, " ")).items():
            menu_counts[w] = menu_counts.get(w, 0) + min(c, 2)
    est = total * (rel / len(docs)) if docs else 0.0
    if chain:
        est = min(est, 20)  # 체인 이름은 지점과 상관없이 글이 많아서 크게 쳐 주지 않는다
    b = bucket(est)
    if rel and not recent:
        b = max(0, b - 1)  # 2년 넘은 글뿐이면 한 단계 낮춤
    if rel >= 3 and ads / rel >= 0.6:
        b = max(0, b - 1)  # 협찬·체험단 글이 대부분이면 한 단계 낮춤
    need = 2 if rel >= 4 else 1
    bad = place_words(addr) | NOT_MENU | {region}
    menu = [w for w, c in sorted(menu_counts.items(), key=lambda x: (-x[1], -len(x[0]), x[0]))
            if c >= need and w not in bad][:3]
    return b, menu


def query(name: str, addr: str) -> str:
    return f"{region_word(addr)} {name}".strip()
