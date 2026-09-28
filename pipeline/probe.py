"""연결 점검: API 주소·파라미터·필드 이름을 실제 응답으로 확인한다.

결과는 reports/probe.md에 저장된다. 키 값은 절대 기록하지 않는다.
"""
import datetime as dt
import pathlib

from . import sources
from .safehttp import HttpError, get_json, log, redact, secret

OUT = pathlib.Path("reports/probe.md")
lines: list[str] = []


def w(s: str = "") -> None:
    lines.append(redact(s))
    log(s)


def key_shape(name: str, value: str) -> str:
    if not value:
        return f"- {name}: 설정 안 됨"
    kind = "16진수" if all(c in "0123456789abcdefABCDEF" for c in value) else "영문·숫자·기호"
    return f"- {name}: {len(value)}자, {kind}"


def call(label: str, url: str, params: dict) -> dict | None:
    try:
        status, payload = get_json(url, params, retries=3, timeout=40)
    except HttpError as e:
        w(f"- **{label}**: 실패 HTTP {e.status} — {e} {e.body[:200]}")
        return None
    except Exception as e:  # noqa: BLE001
        w(f"- **{label}**: 실패 — {type(e).__name__}: {e}")
        return None
    resp = payload.get("response", {}) if isinstance(payload, dict) else {}
    header, body = resp.get("header", {}), resp.get("body", {})
    items = (body.get("items") or {}).get("item") if isinstance(body.get("items"), dict) else body.get("items")
    if isinstance(items, dict):
        items = [items]
    n = len(items or [])
    w(f"- **{label}**: HTTP {status}, 결과코드 {header.get('resultCode')} ({header.get('resultMsg')}), "
      f"totalCount={body.get('totalCount')}, 받은 건수={n}")
    if not resp:
        w(f"  - 응답 최상위 키: {list(payload)[:10] if isinstance(payload, dict) else type(payload).__name__}")
    return {"body": body, "items": items or []}


def main() -> None:
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime("%Y-%m-%d %H:%M KST")
    w(f"# 연결 점검 결과 ({today})\n")
    keys = {n: secret(n, required=False) for n in
            ("DATA_GO_KR_KEY", "DATA_GO_REST_KEY", "DATA_GO_MODEL_KEY", "KAKAO_REST_KEY")}
    w("## 키 형태 (값은 기록하지 않음)")
    for n, v in keys.items():
        w(key_shape(n, v))
    same = len({v for k, v in keys.items() if k.startswith("DATA_GO") and v}) == 1
    w(f"- 공공데이터 키 3개가 같은 값인가: {'예' if same else '아니오'}\n")

    gk = keys["DATA_GO_KR_KEY"]
    base = {"serviceKey": gk, "pageNo": "1", "numOfRows": "1", "returnType": "json"}
    w("## 일반음식점")
    r = call("해운대구 3330000 영업중 1건", sources.GENERAL, {**base, "cond[OPN_ATMY_GRP_CD::EQ]": "3330000",
                                                            "cond[SALS_STTS_CD::EQ]": "01"})
    if r and r["items"]:
        it = r["items"][0]
        w(f"  - 필드 목록: {', '.join(sorted(it.keys()))}")
        for k in ("BPLC_NM", "BZSTAT_SE_NM", "ROAD_NM_ADDR", "CRD_INFO_X", "CRD_INFO_Y", "LCPMT_YMD",
                  "SALS_STTS_NM", "TELNO", "LCTN_TELNO", "OPN_ATMY_GRP_CD", "LAST_MDFCN_PNT", "MNG_NO"):
            if k in it:
                w(f"  - {k} = {str(it.get(k))[:60]}")
    call("전국(지역 조건 없음) 영업중", sources.GENERAL, {**base, "cond[SALS_STTS_CD::EQ]": "01"})
    for rows in ("1000", "500", "100"):
        call(f"해운대 numOfRows={rows}", sources.GENERAL, {**base, "numOfRows": rows,
                                                          "cond[OPN_ATMY_GRP_CD::EQ]": "3330000",
                                                          "cond[SALS_STTS_CD::EQ]": "01"})
    call("최종수정일 조건(GTE 20260801)", sources.GENERAL, {**base, "cond[OPN_ATMY_GRP_CD::EQ]": "3330000",
                                                           "cond[LAST_MDFCN_PNT::GTE]": "20260801"})
    call("주소 LIKE 부산광역시 해운대구", sources.GENERAL, {**base, "cond[ROAD_NM_ADDR::LIKE]": "부산광역시 해운대구",
                                                        "cond[SALS_STTS_CD::EQ]": "01"})

    w("\n## 부산 구·군 코드 확인 (일반음식점)")
    for code in range(3250000, 3410000, 10000):
        r = call(f"{code}", sources.GENERAL, {**base, "cond[OPN_ATMY_GRP_CD::EQ]": str(code),
                                             "cond[SALS_STTS_CD::EQ]": "01"})
        if r and r["items"]:
            w(f"  - 주소 예: {str(r['items'][0].get('ROAD_NM_ADDR') or r['items'][0].get('LOTNO_ADDR'))[:20]}")

    w("\n## 휴게음식점")
    rk = keys["DATA_GO_REST_KEY"] or gk
    r = call("해운대구 휴게음식점", sources.REST, {**base, "serviceKey": rk, "cond[OPN_ATMY_GRP_CD::EQ]": "3330000",
                                              "cond[SALS_STTS_CD::EQ]": "01"})
    if r and r["items"]:
        w(f"  - 필드 목록: {', '.join(sorted(r['items'][0].keys()))}")

    w("\n## 모범음식점")
    mk = keys["DATA_GO_MODEL_KEY"] or gk
    for st in ("01", None):
        p = {**base, "serviceKey": mk, "cond[OPN_ATMY_GRP_CD::EQ]": "3330000"}
        if st:
            p["cond[SALS_STTS_CD::EQ]"] = st
        r = call(f"행안부 모범음식점 해운대 상태={st}", sources.MODEL, p)
        if r and r["items"]:
            w(f"  - 필드 목록: {', '.join(sorted(r['items'][0].keys()))}")
            break
    for url in sources.BUSAN_MODEL_CANDIDATES:
        call(f"부산시 모범음식점 후보 {url.split('apis.data.go.kr/')[-1]}", url,
             {"serviceKey": mk, "pageNo": "1", "numOfRows": "1", "resultType": "json"})

    w("\n## 카카오")
    kk = keys["KAKAO_REST_KEY"]
    if kk:
        try:
            st, data = get_json(sources.KAKAO_KEYWORD, {"query": "국밥", "x": "129.1604", "y": "35.1631",
                                                       "radius": "500", "size": "3"},
                                headers={"Authorization": f"KakaoAK {kk}"}, retries=2)
            docs = data.get("documents", [])
            w(f"- 키워드 검색: HTTP {st}, 결과 {len(docs)}건, 전체 {data.get('meta', {}).get('total_count')}")
            if docs:
                w(f"  - 필드: {', '.join(sorted(docs[0].keys()))}")
        except HttpError as e:
            w(f"- 키워드 검색 실패: HTTP {e.status} {e.body[:200]}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
