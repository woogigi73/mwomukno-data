"""매일 새벽 실행되는 데이터 갱신 작업.

1) 지역(시·군·구) 목록을 확인한다 (처음 한 번, 이후 90일마다).
2) 오래된 지역부터 일반음식점·휴게음식점(영업 중)을 받아 지역 파일을 만든다.
   하루 호출 한도 안에서 나눠 처리하므로 전국이 약 1주일 주기로 갱신된다.
3) 부산 지역은 모범음식점 표시를 붙인다.
4) 카카오 장소 ID를 매칭한다(부산 우선, 하루 한도 안에서).
5) docs/v1/ 아래에 앱이 받을 파일과 목록(manifest.json)을 쓴다.

어떤 단계가 실패해도 이미 배포된 파일은 망가뜨리지 않는다.
"""
import datetime as dt
import hashlib
import json
import math
import os
import pathlib
import time

from . import sources
from .classify import clean_text, classify, name_similarity, norm_name
from .geo import distance_m, tm5174_to_wgs84
from .safehttp import HttpError, get_json, log, redact, secret

ROOT = pathlib.Path(".")
STATE = ROOT / "state"
OUT = ROOT / "docs" / "v1"
REGION_DIR = OUT / "r"
REPORT = ROOT / "reports" / "last_run.md"

KST = dt.timezone(dt.timedelta(hours=9))
NOW = dt.datetime.now(KST)
TODAY = NOW.strftime("%Y%m%d")

BUDGET = {
    "general": int(os.environ.get("BUDGET_GENERAL", "8500")),
    "rest": int(os.environ.get("BUDGET_REST", "8500")),
    "model": int(os.environ.get("BUDGET_MODEL", "900")),
    "kakao": int(os.environ.get("BUDGET_KAKAO", "60000")),
}
TIME_LIMIT_S = int(os.environ.get("TIME_LIMIT_S", str(5 * 3600)))
REFRESH_DAYS = 6
DISCOVERY_DAYS = 90
BUSAN = range(3250000, 3410000)

used = {k: 0 for k in BUDGET}
report: list[str] = []
started = time.monotonic()


def note(msg: str) -> None:
    report.append(redact(msg))
    log(msg)


def time_left() -> float:
    return TIME_LIMIT_S - (time.monotonic() - started)


def load(path: pathlib.Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default
    except json.JSONDecodeError:
        note(f"⚠️ {path} 파일이 손상되어 새로 만듭니다.")
        return default


def save(path: pathlib.Path, data, compact_lines: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    if compact_lines and isinstance(data, dict) and "r" in data:
        head = {k: v for k, v in data.items() if k != "r"}
        rows = ",\n".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in data["r"])
        text = json.dumps(head, ensure_ascii=False, separators=(",", ":"))[:-1] + ',"r":[\n' + rows + "\n]}\n"
    else:
        text = json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n"
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


# ---------------------------------------------------------------- 공공데이터 호출

def _items(payload) -> tuple[int, list, str, str]:
    resp = payload.get("response", {}) if isinstance(payload, dict) else {}
    header, body = resp.get("header", {}) or {}, resp.get("body", {}) or {}
    raw = body.get("items")
    if isinstance(raw, dict):
        raw = raw.get("item")
    if isinstance(raw, dict):
        raw = [raw]
    return int(body.get("totalCount") or 0), list(raw or []), str(header.get("resultCode", "")), \
        str(header.get("resultMsg", ""))


def fetch_all(api: str, url: str, key: str, cond: dict, page_size: int) -> list | None:
    """조건에 맞는 전체 목록. 한도가 부족하거나 오류면 None."""
    params = {"serviceKey": key, "pageNo": "1", "numOfRows": str(page_size), "returnType": "json", **cond}
    if used[api] >= BUDGET[api]:
        return None
    used[api] += 1
    _, payload = get_json(url, params, pause=0.05)
    total, items, code, msg = _items(payload)
    if code not in ("0", "00", ""):
        raise HttpError(200, f"결과코드 {code} {msg}")
    pages = math.ceil(total / page_size) if total else 1
    if used[api] + pages - 1 > BUDGET[api]:
        note(f"  · {api} 오늘 한도 부족으로 다음 실행에 처리 (필요 {pages}장)")
        used[api] -= 1
        return None
    for page in range(2, pages + 1):
        if time_left() < 300:
            return None
        used[api] += 1
        _, payload = get_json(url, {**params, "pageNo": str(page)}, pause=0.05)
        _, more, code, msg = _items(payload)
        if code not in ("0", "00", ""):
            raise HttpError(200, f"결과코드 {code} {msg}")
        items.extend(more)
    if len(items) < total:
        note(f"  · {api} 건수 불일치 (기대 {total}, 받음 {len(items)}) — 이번 결과는 쓰지 않음")
        return None
    return items


def probe_total(api: str, url: str, key: str, cond: dict) -> tuple[int, dict | None]:
    used[api] += 1
    _, payload = get_json(url, {"serviceKey": key, "pageNo": "1", "numOfRows": "1", "returnType": "json", **cond},
                          retries=3, pause=0.05)
    total, items, code, msg = _items(payload)
    if code not in ("0", "00", ""):
        raise HttpError(200, f"결과코드 {code} {msg}")
    return total, (items[0] if items else None)


# ---------------------------------------------------------------- 지역

def region_name(addr: str) -> str:
    t = clean_text(addr, 80).split(" ")
    if len(t) >= 3 and t[1].endswith("시") and t[2].endswith("구"):
        return " ".join(t[:3])
    return " ".join(t[:2])


def discover_regions(regions: dict, key: str) -> None:
    last = regions.get("_meta", {}).get("discovered", "")
    if last and (NOW - dt.datetime.strptime(last, "%Y%m%d").replace(tzinfo=KST)).days < DISCOVERY_DAYS:
        return
    note("지역 코드 확인을 시작합니다 (90일마다 한 번).")
    found = 0
    errors = 0
    candidates = list(range(3000000, 7000000, 5000))
    for code in candidates:
        if used["general"] >= BUDGET["general"] - 50 or time_left() < 1800:
            note("  · 지역 확인을 다음 실행에서 이어 합니다.")
            regions.setdefault("_meta", {})["cursor"] = code
            return
        cursor = regions.get("_meta", {}).get("cursor", 0)
        if code < cursor:
            continue
        try:
            total, item = probe_total("general", sources.GENERAL, key,
                                      {"cond[OPN_ATMY_GRP_CD::EQ]": str(code), "cond[SALS_STTS_CD::EQ]": "01"})
        except HttpError as e:
            errors += 1
            if errors <= 3:
                note(f"  · 코드 {code} 확인 실패: {e} {e.body[:150]}")
            if errors >= 8 and found == 0:
                note("⚠️ 공공데이터 호출이 계속 실패해 지역 확인을 멈춥니다 (키·활용신청 확인 필요).")
                return
            continue
        if total and item:
            name = region_name(item.get("ROAD_NM_ADDR") or item.get("LOTNO_ADDR") or "")
            entry = regions.setdefault(str(code), {"last": "00000000"})
            entry.update({"name": name, "estimate": total})
            found += 1
    known = sum(1 for c in regions if not c.startswith("_"))
    if known < 100:
        note(f"⚠️ 지역을 {known}곳만 찾았습니다. 키/주소 문제일 수 있어 다음 실행에 다시 확인합니다.")
        regions.setdefault("_meta", {})["cursor"] = 0
        return
    regions.setdefault("_meta", {}).update({"discovered": TODAY, "cursor": 0})
    note(f"  · 지역 {found}곳 확인")


# ---------------------------------------------------------------- 레코드 변환

def to_record(item: dict, source: str) -> list | None:
    status = str(item.get("SALS_STTS_CD", "")).strip()
    if status and status != "01":
        return None
    name = clean_text(item.get("BPLC_NM"), 40)
    if not name:
        return None
    uptae = item.get("BZSTAT_SE_NM") or item.get("SNTTN_BZSTAT_NM") or item.get("UPTAE_NM") or ""
    kind, label = classify(uptae, name, source)
    if not kind:
        return None
    pos = tm5174_to_wgs84(item.get("CRD_INFO_X"), item.get("CRD_INFO_Y"))
    addr = clean_text(item.get("ROAD_NM_ADDR") or item.get("LOTNO_ADDR"), 90)
    phone = "".join(ch for ch in str(item.get("TELNO") or item.get("SITE_TELNO") or "") if ch.isdigit() or ch == "-")[:14]
    opened = "".join(ch for ch in str(item.get("LCPMT_YMD") or "") if ch.isdigit())[:8]
    mng = clean_text(item.get("MNG_NO"), 40) or hashlib.sha1(f"{name}|{addr}".encode()).hexdigest()[:16]
    return {
        "id": ("g" if source == "general" else "r") + mng,
        "name": name, "kind": kind, "cat": label,
        "lat": round(pos[0], 6) if pos else None, "lng": round(pos[1], 6) if pos else None,
        "addr": addr, "tel": phone if len(phone) >= 9 else "",
        "open": int(opened) if len(opened) == 8 else 0,
    }


def load_model_busan(code: str, key: str) -> list:
    """부산 모범음식점(행정안전부 모범음식점정보). 실패하면 빈 목록."""
    if not key or int(code) not in BUSAN or used["model"] >= BUDGET["model"]:
        return []
    try:
        items = fetch_all("model", sources.MODEL, key, {"cond[OPN_ATMY_GRP_CD::EQ]": code,
                                                        "cond[SALS_STTS_CD::EQ]": "01"}, sources.PAGE_SIZE)
    except HttpError as e:
        note(f"  · 모범음식점 {code} 실패: {e}")
        return []
    out = []
    for it in items or []:
        if clean_text(it.get("DSGN_RTRCN_YMD"), 10):
            continue  # 지정 취소
        out.append({"name": clean_text(it.get("BSNSSP_NM") or it.get("BPLC_NM"), 40),
                    "addr": clean_text(it.get("ROAD_NM_ADDR") or it.get("LCTN_ADDR"), 90),
                    "food": clean_text(it.get("PRINC_FD_KND"), 20)})
    return out


def mark_model(records: list, models: list) -> int:
    if not models:
        return 0
    by_name: dict[str, list] = {}
    for r in records:
        by_name.setdefault(norm_name(r["name"]), []).append(r)
    hit = 0
    for m in models:
        cands = by_name.get(norm_name(m["name"]), [])
        if not cands:
            cands = [r for r in records if name_similarity(r["name"], m["name"]) >= 0.9]
        best = None
        for r in cands:
            if m["addr"] and r["addr"] and norm_name(m["addr"])[:12] == norm_name(r["addr"])[:12]:
                best = r
                break
            best = best or (r if len(cands) == 1 else None)
        if best:
            best["model"] = 1
            if m["food"]:
                best["food"] = m["food"]
            hit += 1
    return hit


# ---------------------------------------------------------------- 카카오

def kakao_match(records: list, kakao_state: dict, key: str) -> int:
    matched = 0
    headers = {"Authorization": f"KakaoAK {key}"}
    for r in records:
        if used["kakao"] >= BUDGET["kakao"] or time_left() < 600:
            break
        prev = kakao_state.get(r["id"])
        if prev:
            kid, when = prev[0], prev[1]
            if kid or (NOW - dt.datetime.strptime(when, "%Y%m%d").replace(tzinfo=KST)).days < 60:
                continue
        need_pos = r["lat"] is None
        params = {"query": r["name"], "size": "5"}
        if not need_pos:
            params.update({"x": f"{r['lng']:.6f}", "y": f"{r['lat']:.6f}", "radius": "200", "sort": "distance"})
        else:
            if not r["addr"]:
                continue
            params["query"] = f"{' '.join(r['addr'].split(' ')[:3])} {r['name']}"
        used["kakao"] += 1
        try:
            _, data = get_json(sources.KAKAO_KEYWORD, params, headers=headers, retries=3, pause=0.02)
        except HttpError as e:
            if e.status in (401, 403):
                note(f"⚠️ 카카오 인증 오류(HTTP {e.status}) — 카카오 매칭을 멈춥니다.")
                BUDGET["kakao"] = 0
                break
            if e.status == 429:
                note("⚠️ 카카오 호출 한도 도달 — 내일 이어서 합니다.")
                BUDGET["kakao"] = 0
                break
            continue
        best, best_score = None, 0.0
        for d in (data.get("documents") or [])[:5]:
            if d.get("category_group_code") not in ("FD6", "CE7") and not str(d.get("category_name", "")).startswith(("음식점", "카페")):
                continue
            score = name_similarity(r["name"], d.get("place_name", ""))
            try:
                dx, dy = float(d.get("x")), float(d.get("y"))
            except (TypeError, ValueError):
                continue
            if not need_pos:
                if distance_m(r["lat"], r["lng"], dy, dx) > 150:
                    continue
            elif r["addr"] and not str(d.get("road_address_name") or d.get("address_name")).startswith(
                    " ".join(r["addr"].split(" ")[:2])):
                continue
            if score > best_score:
                best, best_score = d, score
        kid = ""
        if best is not None and best_score >= 0.6 and str(best.get("id", "")).isdigit():
            kid = str(best["id"])
            if need_pos:
                r["lat"], r["lng"] = round(float(best["y"]), 6), round(float(best["x"]), 6)
                r["pos_from_kakao"] = 1
            matched += 1
        kakao_state[r["id"]] = [kid, TODAY]
    return matched


# ---------------------------------------------------------------- 지역 처리

def build_region(code: str, info: dict, keys: dict) -> bool:
    general = fetch_all("general", sources.GENERAL, keys["general"],
                        {"cond[OPN_ATMY_GRP_CD::EQ]": code, "cond[SALS_STTS_CD::EQ]": "01"}, sources.PAGE_SIZE)
    if general is None:
        return False
    rest = []
    if keys["rest"]:
        rest = fetch_all("rest", sources.REST, keys["rest"],
                         {"cond[OPN_ATMY_GRP_CD::EQ]": code, "cond[SALS_STTS_CD::EQ]": "01"}, sources.PAGE_SIZE)
        if rest is None:
            return False
    records, seen = [], set()
    for src, items in (("general", general), ("rest", rest)):
        for it in items:
            rec = to_record(it, src)
            if rec and rec["id"] not in seen:
                seen.add(rec["id"])
                records.append(rec)
    models = load_model_busan(code, keys["model"])
    mcount = mark_model(records, models)

    kstate_path = STATE / "kakao" / f"{code}.json"
    kstate = load(kstate_path, {})
    for r in records:  # 이전에 카카오로 보완한 좌표 재사용
        v = kstate.get(r["id"])
        if r["lat"] is None and v and len(v) >= 4:
            r["lat"], r["lng"] = v[2], v[3]
    kmatched = 0
    if keys["kakao"] and BUDGET["kakao"] > used["kakao"]:
        kmatched = kakao_match(records, kstate, keys["kakao"])
        for r in records:
            if r.pop("pos_from_kakao", None):
                kstate[r["id"]] = kstate[r["id"]][:2] + [r["lat"], r["lng"]]
        save(kstate_path, kstate)

    rows = []
    for r in records:
        if r["lat"] is None:
            continue
        kid = (kstate.get(r["id"]) or [""])[0]
        flags = 1 if r.get("model") else 0
        rows.append([r["id"], r["name"], r["kind"], r["cat"], int(round(r["lat"] * 1e6)), int(round(r["lng"] * 1e6)),
                     r["addr"], r["tel"], r["open"], flags, kid, r.get("food", "")])
    rows.sort(key=lambda x: x[0])
    if not rows:
        note(f"  · {code} 결과 0건 — 파일을 바꾸지 않음")
        return False

    path = REGION_DIR / f"{code}.json"
    old = load(path, None)
    if old and len(old.get("r", [])) > 200 and len(rows) < 0.6 * len(old["r"]):
        note(f"  · {code} 건수가 급감({len(old['r'])}→{len(rows)}) — 안전을 위해 이번 결과는 반영하지 않음")
        return False
    lats = [x[4] for x in rows]
    lngs = [x[5] for x in rows]
    data = {"v": 1, "c": code, "n": info.get("name", ""), "u": TODAY,
            "cols": ["id", "name", "kind", "cat", "lat6", "lng6", "addr", "tel", "open", "flags", "kakao", "food"],
            "r": rows}
    save(path, data, compact_lines=True)
    blob = path.read_bytes()
    info.update({"last": TODAY, "count": len(rows), "bbox": [min(lats), min(lngs), max(lats), max(lngs)],
                 "sha": hashlib.sha256(blob).hexdigest(), "size": len(blob), "model": mcount})
    note(f"  · {code} {info.get('name','')}: {len(rows)}곳 (모범 {mcount}, 카카오 매칭 +{kmatched})")
    return True


def write_manifest(regions: dict) -> None:
    items = []
    for code, info in sorted(regions.items()):
        if code.startswith("_") or not info.get("count"):
            continue
        items.append({"c": code, "n": info.get("name", ""), "u": info["last"], "cnt": info["count"],
                      "b": info["bbox"], "sha": info["sha"], "size": info["size"]})
    save(OUT / "manifest.json", {"v": 1, "generated": NOW.strftime("%Y-%m-%dT%H:%M:%S+09:00"),
                                 "regions": items, "minApp": 1})


def main() -> None:
    keys = {
        "general": secret("DATA_GO_KR_KEY"),
        "rest": secret("DATA_GO_REST_KEY", required=False),
        "model": secret("DATA_GO_MODEL_BUSAN_KEY", required=False),
        "kakao": secret("KAKAO_REST_KEY", required=False),
    }
    note(f"# 데이터 갱신 보고서 ({NOW.strftime('%Y-%m-%d %H:%M KST')})\n")
    regions = load(STATE / "regions.json", {})
    try:
        discover_regions(regions, keys["general"])
    finally:
        save(STATE / "regions.json", regions)

    codes = [c for c in regions if not c.startswith("_")]

    def priority(c: str):
        info = regions[c]
        stale = info.get("last", "00000000")
        return (0 if int(c) in BUSAN and stale == "00000000" else 1, stale, 0 if int(c) in BUSAN else 1, c)

    done = 0
    for code in sorted(codes, key=priority):
        info = regions[code]
        last = info.get("last", "00000000")
        if last != "00000000" and (NOW - dt.datetime.strptime(last, "%Y%m%d").replace(tzinfo=KST)).days < REFRESH_DAYS:
            continue
        if time_left() < 900 or used["general"] >= BUDGET["general"] - 5:
            break
        try:
            if build_region(code, info, keys):
                done += 1
        except HttpError as e:
            note(f"  · {code} 실패: {e} {e.body[:120]}")
            if "SERVICE_KEY" in e.body or e.status in (401, 403):
                note("⚠️ 공공데이터 키 또는 활용신청 문제로 중단합니다.")
                break
        finally:
            save(STATE / "regions.json", regions)

    # 오늘 새로 받은 지역이 없어도 남은 카카오 한도로 부산부터 매칭을 이어 간다.
    if keys["kakao"] and used["kakao"] < BUDGET["kakao"] and time_left() > 1200:
        for code in sorted(codes, key=lambda c: (0 if int(c) in BUSAN else 1, c)):
            path = REGION_DIR / f"{code}.json"
            if not path.exists() or used["kakao"] >= BUDGET["kakao"] or time_left() < 900:
                continue
            kpath = STATE / "kakao" / f"{code}.json"
            kstate = load(kpath, {})
            data = load(path, {})
            pending = [r for r in data.get("r", []) if r[0] not in kstate]
            if not pending:
                continue
            recs = [{"id": r[0], "name": r[1], "lat": r[4] / 1e6, "lng": r[5] / 1e6, "addr": r[6]} for r in pending]
            n = kakao_match(recs, kstate, keys["kakao"])
            save(kpath, kstate)
            if n:
                ids = {k: v[0] for k, v in kstate.items() if v and v[0]}
                for r in data["r"]:
                    if r[0] in ids:
                        r[10] = ids[r[0]]
                save(path, data, compact_lines=True)
                blob = path.read_bytes()
                regions[code].update({"sha": hashlib.sha256(blob).hexdigest(), "size": len(blob)})
                note(f"  · {code} 카카오 추가 매칭 {n}곳")
        save(STATE / "regions.json", regions)

    write_manifest(regions)
    total_regions = len(codes)
    fresh = sum(1 for c in codes if regions[c].get("count"))
    note(f"\n## 요약\n- 오늘 갱신한 지역: {done}\n- 데이터가 있는 지역: {fresh}/{total_regions}")
    note(f"- 호출 수: 일반 {used['general']}/{BUDGET['general']}, 휴게 {used['rest']}/{BUDGET['rest']}, "
         f"모범 {used['model']}/{BUDGET['model']}, 카카오 {used['kakao']}/{BUDGET['kakao']}")
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text("\n".join(report) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
