"""안전한 HTTP 호출.

보안 원칙
- 키는 환경변수에서만 읽고, 코드·파일·로그 어디에도 남기지 않는다.
- GitHub는 등록된 비밀 값을 로그에서 가려 주지만, URL 인코딩된 형태
  (예: '+' -> '%2B')는 가려 주지 못한다. 그래서 인코딩된 형태도 직접
  마스킹 등록(::add-mask::)하고, 모든 오류 메시지에서 키를 지운다.
- 응답 크기 상한, 타임아웃, 재시도 횟수 상한을 둔다.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

MAX_BYTES = 8 * 1024 * 1024
USER_AGENT = "mwomukno-data-bot/1.0 (+https://woogigi73.github.io/mwomukno-data/)"

_SECRETS: list[str] = []


def _register_mask(value: str) -> None:
    if not value:
        return
    forms = {value, urllib.parse.quote(value, safe=""), urllib.parse.quote_plus(value)}
    for form in forms:
        if form and form not in _SECRETS:
            _SECRETS.append(form)
            if os.environ.get("GITHUB_ACTIONS") == "true":
                # GitHub 로그에서 이 문자열을 ***로 가린다.
                print(f"::add-mask::{form}", flush=True)


def secret(name: str, required: bool = True) -> str:
    """환경변수에서 키를 읽는다. 앞뒤 공백과 따옴표를 정리한다."""
    value = (os.environ.get(name) or "").strip().strip('"').strip("'")
    # 사용자가 '인코딩' 키를 넣었으면 한 번 풀어 준다(이중 인코딩 방지).
    if "%" in value:
        value = urllib.parse.unquote(value)
    if not value and required:
        raise SystemExit(f"[설정 오류] 저장소 비밀 설정 {name} 이(가) 비어 있습니다.")
    _register_mask(value)
    return value


def redact(text: str) -> str:
    text = str(text)
    for s in _SECRETS:
        if s:
            text = text.replace(s, "***")
    text = re.sub(r"(serviceKey=)[^&\s]*", r"\1***", text, flags=re.I)
    text = re.sub(r"(KakaoAK\s+)\S+", r"\1***", text)
    return text


def log(msg: str) -> None:
    print(redact(msg), flush=True)


class HttpError(Exception):
    def __init__(self, status: int, message: str, body: str = ""):
        super().__init__(redact(message))
        self.status = status
        self.body = redact(body[:500])


def get_json(url: str, params: dict | None = None, headers: dict | None = None,
             timeout: float = 45, retries: int = 5, pause: float = 0.0):
    """JSON GET. 실패하면 점점 길게 기다리며 재시도한다. 반환: (status, payload)."""
    full = url
    if params:
        full = url + "?" + urllib.parse.urlencode(params)
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    last: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(full, headers=hdrs, method="GET")
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (https만 사용)
                raw = resp.read(MAX_BYTES + 1)
                if len(raw) > MAX_BYTES:
                    raise HttpError(resp.status, "응답이 너무 큽니다")
                text = raw.decode("utf-8", errors="replace")
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    raise HttpError(resp.status, "JSON이 아닌 응답", text)
                if pause:
                    time.sleep(pause)
                return resp.status, payload
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read(4000).decode("utf-8", errors="replace")
            except Exception:  # noqa: BLE001
                pass
            last = HttpError(e.code, f"HTTP {e.code}", body)
            # 인증·권한 오류는 재시도해도 소용없다.
            if e.code in (400, 401, 403, 404):
                raise last
        except HttpError as e:
            last = e
            if "JSON이 아닌" in str(e) and ("SERVICE_KEY" in e.body or "SERVICE KEY" in e.body):
                raise
        except Exception as e:  # noqa: BLE001 (네트워크 오류 전반)
            last = HttpError(0, f"{type(e).__name__}: {e}")
        wait = min(40, 2 ** attempt)
        log(f"  요청 실패 {attempt}/{retries}: {last} → {wait}초 뒤 재시도")
        time.sleep(wait)
    assert last is not None
    raise last


def assert_https(url: str) -> None:
    if not url.startswith("https://"):
        print("https 주소만 허용합니다", file=sys.stderr)
        raise SystemExit(2)
