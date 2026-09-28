"""업태와 상호로 밥/술/카페를 나누고, 앱에 보여 줄 짧은 분류명을 정한다.

kind 값
  b  : 밥
  s  : 술
  bs : 밥과 술 모두 (고깃집, 횟집, 치킨 등)
  c  : 카페·디저트
None을 돌려주면 앱 후보에서 뺀다(편의점, 출장조리 등).
"""
import re
import unicodedata

EXCLUDE_UPTAE = ("편의점", "출장조리", "이동조리", "철도역구내", "유원지", "푸드트럭", "일반조리판매",
                 "관광호텔", "백화점", "기타 휴게음식점", "다방")

SUL_UPTAE = ("호프/통닭", "정종/대포집/소주방", "감성주점", "라이브카페", "룸살롱", "간이주점")
BOTH_UPTAE = ("통닭(치킨)", "식육(숯불구이)", "횟집", "복어취급", "탕류(보신용)")
CAFE_UPTAE = ("까페", "커피숍", "전통찻집", "아이스크림", "과자점", "떡카페", "키즈카페", "제과점")

SUL_WORDS = ("호프", "포차", "주점", "이자카야", "술집", "맥주", "비어", "펍", "와인", "하이볼", "칵테일",
             "위스키", "사케", "막걸리", "주막", "선술집", "로바다", "오뎅바")
_SUL_EN = re.compile(r"\b(bar|pub|beer|wine|brewery|izakaya)\b")
BOTH_WORDS = ("고기", "갈비", "삼겹", "곱창", "막창", "대창", "곰장어", "장어", "조개", "횟집", "회센터",
              "족발", "보쌈", "닭갈비", "양꼬치", "치킨", "통닭", "오리", "한우", "숯불", "구이", "쭈꾸미", "아구",
              "아귀", "해물", "전집", "빈대떡")
CAFE_WORDS = ("카페", "커피", "cafe", "coffee", "베이커리", "디저트", "빙수", "케이크", "도넛", "티하우스")


# 앱에 보이는 짧은 분류명
LABEL = {
    "한식": "한식", "중국식": "중식", "일식": "일식", "경양식": "양식", "분식": "분식",
    "호프/통닭": "호프", "정종/대포집/소주방": "주점", "통닭(치킨)": "치킨", "식육(숯불구이)": "고기구이",
    "횟집": "횟집", "뷔페식": "뷔페", "김밥(도시락)": "김밥", "패밀리레스토랑": "레스토랑",
    "외국음식전문점(인도,태국등)": "세계음식", "탕류(보신용)": "탕", "냉면집": "냉면", "복어취급": "복어",
    "감성주점": "감성주점", "라이브카페": "라이브바", "까페": "카페", "커피숍": "카페", "전통찻집": "찻집",
    "아이스크림": "아이스크림", "과자점": "베이커리", "떡카페": "떡카페", "키즈카페": "키즈카페",
    "패스트푸드": "패스트푸드", "제과점": "베이커리",
}

_CTRL = re.compile(r"[\u0000-\u001f\u007f-\u009f​-‏ -‮﻿]")
_SPACES = re.compile(r"\s+")


def clean_text(value, limit: int) -> str:
    """제어 문자·보이지 않는 문자를 지우고 길이를 제한한다."""
    s = unicodedata.normalize("NFKC", str(value or ""))
    s = _CTRL.sub("", s)
    s = _SPACES.sub(" ", s).strip()
    return s[:limit]


def classify(uptae: str, name: str, source: str) -> tuple[str | None, str]:
    """(kind, label). source는 'general' 또는 'rest'."""
    u = clean_text(uptae, 40)
    n = clean_text(name, 60).lower()
    if any(u.startswith(x) for x in EXCLUDE_UPTAE):
        return None, ""
    label = LABEL.get(u, u if 0 < len(u) <= 6 else ("음식점" if source == "general" else "간식"))
    if u in CAFE_UPTAE or (source == "rest" and any(w in n for w in CAFE_WORDS)):
        return "c", label if label not in ("간식", "기타") else "카페"
    if source == "rest":
        # 휴게음식점은 술을 팔 수 없다.
        return "b", label
    if u in SUL_UPTAE or any(w in n for w in SUL_WORDS) or _SUL_EN.search(n):
        if any(w in n for w in BOTH_WORDS) or u in BOTH_UPTAE:
            return "bs", label
        return "s", label
    if u in BOTH_UPTAE or any(w in n for w in BOTH_WORDS):
        return "bs", label
    if any(w in n for w in CAFE_WORDS) and u in ("기타", ""):
        return "c", "카페"
    return "b", label


_NAME_NOISE = re.compile(r"주식회사|유한회사|\(주\)|㈜|\(유\)|농업회사법인|영농조합법인")


def norm_name(value: str) -> str:
    s = unicodedata.normalize("NFKC", str(value or "")).lower()
    s = _NAME_NOISE.sub("", s)
    s = re.sub(r"[^0-9a-z가-힣]", "", s)
    s = re.sub(r"(본점|직영점|분점)$", "", s)
    return s


def name_similarity(a: str, b: str) -> float:
    x, y = norm_name(a), norm_name(b)
    if not x or not y:
        return 0.0
    if x == y:
        return 1.0
    if len(x) >= 2 and len(y) >= 2 and (x in y or y in x):
        return 0.9
    bx = {x[i:i + 2] for i in range(len(x) - 1)} or {x}
    by = {y[i:i + 2] for i in range(len(y) - 1)} or {y}
    return len(bx & by) / len(bx | by)
