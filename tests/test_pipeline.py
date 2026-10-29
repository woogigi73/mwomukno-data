"""네트워크 없이 파이프라인 전체 흐름을 점검한다 (가짜 API 응답 사용)."""
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

from pipeline import build, classify, geo, safehttp


def fake_item(i, name, uptae, x=393000, y=187000, status="01"):
    return {"MNG_NO": f"3330000-101-{i:05d}", "BPLC_NM": name, "BZSTAT_SE_NM": uptae,
            "CRD_INFO_X": str(x + i * 10), "CRD_INFO_Y": str(y + i * 7), "ROAD_NM_ADDR": f"부산광역시 해운대구 테스트로 {i}",
            "LCPMT_YMD": "2026-09-01", "SALS_STTS_CD": status, "TELNO": "051-123-4567"}


def page(items, total):
    return 200, {"response": {"header": {"resultCode": "0", "resultMsg": "OK"},
                              "body": {"totalCount": total, "items": {"item": items}}}}


class GeoTest(unittest.TestCase):
    def test_busan(self):
        lat, lng = geo.tm5174_to_wgs84(393000, 187000)
        # 기준값: PROJ(EPSG:5174 → 4326, EPSG 변환 1 Molodensky-Badekas)
        self.assertAlmostEqual(lat, 35.1636747, places=6)
        self.assertAlmostEqual(lng, 129.1190442, places=6)

    def test_legacy_fix(self):
        o = geo._legacy(393000, 187000)
        f = geo.legacy_fix(*o)
        self.assertLess(geo.distance_m(f[0], f[1], 35.1636747, 129.1190442), 0.5)

    def test_invalid(self):
        self.assertIsNone(geo.tm5174_to_wgs84("", "1"))
        self.assertIsNone(geo.tm5174_to_wgs84("abc", "1"))
        self.assertIsNone(geo.tm5174_to_wgs84(0, 0))


class ClassifyTest(unittest.TestCase):
    def test_kinds(self):
        self.assertEqual(classify.classify("한식", "뜨끈국밥", "general")[0], "b")
        self.assertEqual(classify.classify("호프/통닭", "치맥공장", "general")[0], "s")
        self.assertEqual(classify.classify("한식", "삼겹살연탄집", "general")[0], "bs")
        self.assertEqual(classify.classify("커피숍", "메가커피", "rest")[0], "c")
        self.assertIsNone(classify.classify("편의점", "GS25", "rest")[0])
        self.assertEqual(classify.classify("경양식", "Barbecue house", "general")[0], "b")

    def test_clean(self):
        self.assertEqual(classify.clean_text("a​\x00b  c", 10), "ab c")


class RedactTest(unittest.TestCase):
    def test_redact(self):
        os.environ["TEST_KEY_X"] = "abc+def/=="
        k = safehttp.secret("TEST_KEY_X")
        self.assertEqual(k, "abc+def/==")
        self.assertNotIn("abc", safehttp.redact("url?serviceKey=abc%2Bdef%2F%3D%3D&x=1"))
        self.assertNotIn("def", safehttp.redact("KakaoAK abc+def/== boom"))


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        build.STATE = pathlib.Path("state")
        build.OUT = pathlib.Path("docs/v1")
        build.REGION_DIR = build.OUT / "r"
        build.REPORT = pathlib.Path("reports/last_run.md")
        for k in build.used:
            build.used[k] = 0

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def test_region_end_to_end(self):
        gen = [fake_item(i, f"국밥집{i}", "한식") for i in range(150)] + [fake_item(900, "해운대포차", "호프/통닭")]
        rest = [fake_item(500, "메가커피", "커피숍"), fake_item(501, "GS25", "편의점")]
        model = [{"BSNSSP_NM": "국밥집3", "ROAD_NM_ADDR": "부산광역시 해운대구 테스트로 3", "PRINC_FD_KND": "돼지국밥",
                  "SALS_STTS_CD": "01"}]

        def fake_get(url, params=None, headers=None, **kw):
            if "kakao" in url:
                return 200, {"documents": [{"id": "12345", "place_name": params["query"], "x": params.get("x", "129"),
                                            "y": params.get("y", "35"), "category_group_code": "FD6"}]}
            size = int(params["numOfRows"])
            p = int(params["pageNo"])
            src = gen if "general" in url else rest if "rest_cafes" in url else model
            return page(src[(p - 1) * size: p * size], len(src))

        with mock.patch.object(build, "get_json", side_effect=fake_get):
            info = {"name": "부산광역시 해운대구"}
            ok = build.build_region("3330000", info, {"general": "k", "rest": "k", "model": "k", "kakao": "k"})
        self.assertTrue(ok)
        data = json.loads(pathlib.Path("docs/v1/r/3330000.json").read_text(encoding="utf-8"))
        names = {r[1]: r for r in data["r"]}
        self.assertIn("메가커피", names)
        self.assertNotIn("GS25", names)
        self.assertEqual(names["해운대포차"][2], "s")
        self.assertEqual(names["국밥집3"][9], 1)
        self.assertEqual(names["국밥집3"][11], "돼지국밥")
        self.assertEqual(len(data["r"]), 152)
        self.assertEqual(info["count"], 152)
        build.write_manifest({"3330000": info})
        man = json.loads(pathlib.Path("docs/v1/manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["regions"][0]["cnt"], 152)

    def test_drop_guard(self):
        path = pathlib.Path("docs/v1/r/3330000.json")
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"r": [[str(i)] for i in range(500)]}), encoding="utf-8")
        gen = [fake_item(i, f"집{i}", "한식") for i in range(100)]

        def fake_get(url, params=None, headers=None, **kw):
            return page(gen, len(gen)) if "general" in url else page([], 0)

        with mock.patch.object(build, "get_json", side_effect=fake_get):
            ok = build.build_region("3330000", {}, {"general": "k", "rest": "k", "model": "", "kakao": ""})
        self.assertFalse(ok)
        self.assertEqual(len(json.loads(path.read_text())["r"]), 500)


if __name__ == "__main__":
    unittest.main()


class MainFlowTest(unittest.TestCase):
    def test_main_offline(self):
        tmp = tempfile.TemporaryDirectory()
        cwd = os.getcwd()
        os.chdir(tmp.name)
        try:
            build.STATE = pathlib.Path("state")
            build.OUT = pathlib.Path("docs/v1")
            build.REGION_DIR = build.OUT / "r"
            build.REPORT = pathlib.Path("reports/last_run.md")
            build.USAGE_PATH = build.STATE / "usage.json"
            build.MAX_DISCOVERY_PER_RUN = 50
            for k in build.used:
                build.used[k] = 0
            build.report.clear()
            os.environ.update({"DATA_GO_KR_KEY": "g", "DATA_GO_REST_KEY": "r", "DATA_GO_MODEL_KEY": "m",
                               "KAKAO_REST_KEY": "k"})
            gen = [fake_item(i, f"국밥집{i}", "한식") for i in range(30)]

            def fake_get(url, params=None, headers=None, **kw):
                if "kakao" in url:
                    return 200, {"documents": []}
                code = params.get("cond[OPN_ATMY_GRP_CD::EQ]")
                if code in ("3330000", "3000000") and "general" in url:
                    size = int(params["numOfRows"]); p = int(params["pageNo"])
                    return page(gen[(p - 1) * size: p * size], len(gen))
                return page([], 0)

            with mock.patch.object(build, "get_json", side_effect=fake_get):
                build.main()
            man = json.loads(pathlib.Path("docs/v1/manifest.json").read_text(encoding="utf-8"))
            self.assertEqual([r["c"] for r in man["regions"]], ["3000000", "3330000"])
            self.assertIn("부산광역시 해운대구", man["regions"][1]["n"])
            usage = json.loads(pathlib.Path("state/usage.json").read_text())
            self.assertGreater(usage["general"], 16)
            regions = json.loads(pathlib.Path("state/regions.json").read_text())
            self.assertEqual(regions["_meta"]["cursor"], 3000000 + 50 * 5000)
            self.assertIn("3000000", regions)
        finally:
            os.chdir(cwd)
            tmp.cleanup()


class BlogTest(unittest.TestCase):
    def test_region_word(self):
        from pipeline import blog
        self.assertEqual(blog.region_word("부산광역시 해운대구 해운대로 1"), "해운대")
        self.assertEqual(blog.region_word("경상남도 양산시 중앙로 1"), "양산")
        self.assertEqual(blog.region_word("서울특별시 중구 세종대로 1"), "중구")

    def test_menu(self):
        from pipeline import blog
        c = blog.menu_from_text("돼지국밥 맛집! 돼지국밥이랑 수육 먹었어요. 회사 근처")
        self.assertEqual(c.get("돼지국밥"), 2)
        self.assertNotIn("국밥", c)
        self.assertNotIn("회", c)
        self.assertEqual(blog.menu_from_name("할매국밥"), ["국밥"])
        self.assertEqual(blog.merge_menu("", ["돼지국밥", "수육"], "할매국밥"), "돼지국밥·수육")
        self.assertEqual(blog.merge_menu("밀면", [], "가야밀면"), "밀면")

    def test_evaluate(self):
        import datetime as dt
        from pipeline import blog
        docs = [{"title": "<b>해운대</b> <b>대패부대</b> 후기", "contents": "대패삼겹살 이랑 부대찌개 최고, 대패삼겹살 또 먹고 싶다",
                 "datetime": "2026-09-01T12:00:00.000+09:00"} for _ in range(8)]
        docs += [{"title": "다른 가게", "contents": "해운대 회", "datetime": "2026-09-01T12:00:00.000+09:00"}] * 2
        b, menu, _, _, _ = blog.evaluate("대패부대", "부산광역시 해운대구 우동 1", {"meta": {"total_count": 80}, "documents": docs},
                                dt.date(2026, 10, 24), False)
        self.assertEqual(b, 3)  # 80 * 0.8 = 64
        self.assertEqual(menu[:2], ["대패삼겹살", "부대찌개"])
        b2, _, _, _, _ = blog.evaluate("대패부대", "부산광역시 해운대구", {"meta": {"total_count": 80}, "documents": docs},
                              dt.date(2026, 10, 24), True)
        self.assertEqual(b2, 3)  # 체인은 최대 3단계
        b3, m3, _, _, _ = blog.evaluate("없는집", "부산광역시 해운대구", {"meta": {"total_count": 0}, "documents": []},
                               dt.date(2026, 10, 24), False)
        self.assertEqual((b3, m3), (0, []))

    def test_short_name(self):
        import datetime as dt
        from pipeline import blog
        docs = [{"title": "해운대 맛집", "contents": "친구이와 같이 갔어요 해운대", "datetime": "2026-09-01T00:00:00"}] * 10
        b, _, st, _, _ = blog.evaluate("이와", "부산광역시 해운대구", {"meta": {"total_count": 2500000}, "documents": docs},
                                 dt.date(2026, 10, 24), False)
        self.assertEqual(st[1], 0)
        self.assertEqual(b, 0)
        self.assertEqual(blog.merge_menu("", ["우동", "오마카세"], "니은", "부산광역시 해운대구 우동 1"), "오마카세")
        self.assertEqual(blog.pick_menu({"돼지국밥": 5, "국밥": 4, "순대국밥": 3, "포차": 9}, 2, blog.NOT_MENU),
                         ["돼지국밥", "순대국밥"])

    def test_hours(self):
        from pipeline import blog
        h = blog.parse_hours("영업시간 : 11:00 ~ 21:30 브레이크타임 15:00~17:00 매주 월요일 휴무")
        self.assertEqual(h, {"open": (660, 1290), "break": (900, 1020), "off": "1"})
        self.assertEqual(blog.parse_hours("영업시간 오전 11시~오후 9시, 연중무휴")["open"], (660, 1260))
        self.assertEqual(blog.parse_hours("영업시간 17:00 - 02:00")["open"], (1020, 1560))
        self.assertEqual(blog.parse_hours("24시간 영업")["open"], (0, 1440))
        self.assertEqual(blog.parse_hours("정기휴무 : 매주 일요일")["off"], "7")
        self.assertEqual(blog.parse_hours("주차 가능"), {})
        self.assertEqual(blog.vote_hours([{"open": (660, 1260)}, {"open": (660, 1260), "off": "1"}, {"open": (600, 1200)}]),
                         "1100-2100||")
        self.assertEqual(blog.vote_hours([{"off": "1"}, {"open": (660, 1260), "off": "1"}]), "1100-2100||1")
        self.assertNotIn("off", blog.parse_hours("공휴일 휴무"))
        self.assertNotIn("off", blog.parse_hours("둘째, 넷째주 일요일 휴무"))
        self.assertNotIn("off", blog.parse_hours("명절 당일 휴무"))

    def test_score_false_positive(self):
        from pipeline import blog
        # 앞 20개 중 1~4개만 이 가게 글이면 전체 건수가 커도 높게 치지 않는다
        self.assertLessEqual(blog.score_stats("카페 플라워", 10942, 1, 20, 1, 0, False), 1)
        self.assertLessEqual(blog.score_stats("주차장식당", 183911, 4, 20, 4, 0, False), 2)
        # 20개 모두 이 가게 글이고 전체 수백 건 이상이면 최고 단계
        self.assertEqual(blog.score_stats("해운대암소갈비집", 35530, 20, 20, 20, 0, False), 5)
        self.assertEqual(blog.score_stats("대우쟁반짜장", 47, 12, 20, 12, 0, False), 2)
        self.assertEqual(blog.score_stats("굽네치킨 명지점", 174940, 20, 20, 20, 0, True), 3)

    def test_menu_kind_filter(self):
        from pipeline import blog
        self.assertEqual(blog.merge_menu("", ["수육", "커피"], "한신해물천국", "부산광역시 남구", "b"), "수육")
        self.assertEqual(blog.merge_menu("", ["아메리카노", "김밥", "커피"], "나르커피", "부산광역시 남구", "c"), "아메리카노·커피")

    def test_review_eval(self):
        from pipeline import blog
        st = lambda e: int(e.split("|")[0])
        # 부다면옥(인기 5단계, 맛 칭찬 3·아쉬움 2) 같은 유명 맛집이 3점 아래로 떨어지지 않게
        self.assertGreaterEqual(st(blog.review_eval([3, 2, 0, 0, 0, 0, 1, 0, 5, 0, 20], 5)), 38)
        # 인기 많고 칭찬 많은 곳 > 인기 많고 아쉬움 많은 곳 > 후기 거의 없는 곳
        good = st(blog.review_eval([8, 0, 2, 0, 3, 0, 4, 0, 2, 3, 20], 5))
        mixed = st(blog.review_eval([3, 4, 0, 2, 0, 1, 1, 0, 0, 0, 20], 5))
        low = st(blog.review_eval([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3], 0))
        self.assertGreater(good, mixed)
        self.assertGreater(mixed, low)
        self.assertLessEqual(good, 49)
        self.assertEqual(blog.review_eval([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 3), "")
        self.assertEqual(blog.review_eval([0, 0, 0, 0, 0, 0, 0, 0, 16, 0, 20], 5).split("|")[5], "8")  # 웨이팅 16/20
