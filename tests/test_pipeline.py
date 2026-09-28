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
        self.assertAlmostEqual(lat, 35.1638568, places=5)
        self.assertAlmostEqual(lng, 129.1190009, places=5)

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
        self.assertEqual(names["국밥집1"][10], "12345")
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
            os.environ.update({"DATA_GO_KR_KEY": "g", "DATA_GO_REST_KEY": "r", "DATA_GO_MODEL_BUSAN_KEY": "m",
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
