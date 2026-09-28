"""좌표 변환과 거리 계산.

공공데이터(지방행정 인허가) 좌표는 EPSG:5174(Bessel 중부원점 TM)입니다.
외부 라이브러리 없이 변환해서 공급망 위험을 줄였고, tests/test_geo.py에서
pyproj 결과와 1m 이내로 일치하는지 확인합니다.
"""
import math

# Bessel 1841
_A_B = 6377397.155
_F_B = 1 / 299.1528128
# WGS84
_A_W = 6378137.0
_F_W = 1 / 298.257223563

_LAT0 = math.radians(38.0)
_LON0 = math.radians(127.002890277778)
_K0 = 1.0
_X0 = 200000.0
_Y0 = 500000.0

# towgs84 (Position Vector 규약, PROJ와 동일)
_DX, _DY, _DZ = -145.907, 505.034, 685.756
_RX, _RY, _RZ = (math.radians(v / 3600.0) for v in (-1.162, 2.347, 1.592))
_DS = 6.342e-6


def _meridian_arc(phi, a, e2):
    e4, e6 = e2 * e2, e2 * e2 * e2
    return a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
                - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * math.sin(2 * phi)
                + (15 * e4 / 256 + 45 * e6 / 1024) * math.sin(4 * phi)
                - (35 * e6 / 3072) * math.sin(6 * phi))


def _tm_inverse(x, y):
    """EPSG:5174 평면좌표(x=동, y=북) -> Bessel 위경도(라디안)."""
    a, f = _A_B, _F_B
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    m0 = _meridian_arc(_LAT0, a, e2)
    m = m0 + (y - _Y0) / _K0
    mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
            + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    s1, c1 = math.sin(phi1), math.cos(phi1)
    t1 = math.tan(phi1) ** 2
    c1e = ep2 * c1 * c1
    n1 = a / math.sqrt(1 - e2 * s1 * s1)
    r1 = a * (1 - e2) / (1 - e2 * s1 * s1) ** 1.5
    d = (x - _X0) / (n1 * _K0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d * d / 2
        - (5 + 3 * t1 + 10 * c1e - 4 * c1e * c1e - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1e + 45 * t1 * t1 - 252 * ep2 - 3 * c1e * c1e) * d ** 6 / 720)
    lon = _LON0 + (d - (1 + 2 * t1 + c1e) * d ** 3 / 6
                   + (5 - 2 * c1e + 28 * t1 - 3 * c1e * c1e + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / c1
    return lat, lon


def _geodetic_to_ecef(lat, lon, a, f):
    e2 = f * (2 - f)
    n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    return (n * math.cos(lat) * math.cos(lon),
            n * math.cos(lat) * math.sin(lon),
            n * (1 - e2) * math.sin(lat))


def _ecef_to_geodetic(x, y, z, a, f):
    e2 = f * (2 - f)
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - e2))
    for _ in range(8):
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        lat = math.atan2(z + e2 * n * math.sin(lat), p)
    return lat, lon


def tm5174_to_wgs84(x, y):
    """평면좌표 문자열/숫자 -> (위도, 경도). 값이 없거나 국내 범위를 벗어나면 None."""
    try:
        x, y = float(x), float(y)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(x) and math.isfinite(y)) or (abs(x) < 10 and abs(y) < 10):
        return None
    lat, lon = _tm_inverse(x, y)
    bx, by, bz = _geodetic_to_ecef(lat, lon, _A_B, _F_B)
    s = 1 + _DS
    wx = _DX + s * (bx - _RZ * by + _RY * bz)
    wy = _DY + s * (_RZ * bx + by - _RX * bz)
    wz = _DZ + s * (-_RY * bx + _RX * by + bz)
    wlat, wlon = _ecef_to_geodetic(wx, wy, wz, _A_W, _F_W)
    wlat, wlon = math.degrees(wlat), math.degrees(wlon)
    if not (32.5 <= wlat <= 39.0 and 124.0 <= wlon <= 132.5):
        return None
    return wlat, wlon


def distance_m(lat1, lon1, lat2, lon2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))
