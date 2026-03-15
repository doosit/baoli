#!/usr/bin/env python3
"""保利会员小程序自动签到脚本，仅依赖 Python 标准库。"""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


BASE_URL = "https://a.china-smartech.com"
# 直接替换成最新抓包里的 token，不要带 Bearer 前缀。
CAPTURED_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5NTExNTMxIiwiZ3VhcmQiOiJtZW1iZXIiLCJtYWxsX2lkIjoiMzU4MyIsImlzcyI6Imh0dHBzOi8vYS5jaGluYS1zbWFydGVjaC5jb20vcmVzdGZ1bC9tZW1iZXIveC90b2tlbiIsImV4cCI6NDA5MjU5OTM0OSwiaWF0IjoxNzczNTcwODQ1LCJhcHBfaWQiOiJ3eGI1ZTNmMzAwNzZmM2E2YzAifQ.qpxJv6hAJRflYTUL__tp3ro_4AXeTZ_XXGOl19QQRoE"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 "
    "MicroMessenger/8.0.69(0x18004531) NetType/4G Language/zh_CN"
)
DEFAULT_TIMEOUT = 15
DEFAULT_RETRY = 2
SUCCESS_CODES = {0, 200}


@dataclass
class ApiResult:
    http_status: int
    code: int
    msg: str
    data: Any
    raw: dict[str, Any]


def log(message: str, *, error: bool = False) -> None:
    print(message, file=sys.stderr if error else sys.stdout)


def normalize_token(token: str) -> str:
    token = (token or "").replace("\r", "").replace("\n", "").strip()
    if not token:
        return ""
    if (token.startswith('"') and token.endswith('"')) or (token.startswith("'") and token.endswith("'")):
        token = token[1:-1].strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    return token


def parse_positive_int(value: str | None, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def parse_non_negative_int(value: str | None, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 0 else default


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def decode_jwt_payload(token: str) -> dict[str, Any]:
    try:
        _, payload, _ = token.split(".", 2)
        payload += "=" * (-len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(payload))
        if not isinstance(decoded, dict):
            raise ValueError
        return decoded
    except Exception as exc:  # noqa: BLE001
        raise ValueError("token 不是有效的 JWT，无法解析 mall_id") from exc


def is_token_expired(payload: dict[str, Any]) -> bool:
    exp = safe_int(payload.get("exp"), 0)
    return exp > 0 and exp <= int(time.time())


def decode_response_body(response: Any, raw_body: bytes) -> str:
    charset = "utf-8"
    headers = getattr(response, "headers", None)
    if headers is not None:
        charset = headers.get_content_charset() or charset
    return raw_body.decode(charset, errors="replace")


def parse_api_result(content: str, http_status: int) -> ApiResult:
    try:
        raw = json.loads(content)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"接口未返回合法 JSON: {content}") from exc

    if not isinstance(raw, dict):
        raise RuntimeError(f"接口返回结构异常: {content}")

    return ApiResult(
        http_status=http_status,
        code=safe_int(raw.get("code"), -1),
        msg=str(raw.get("msg", "")),
        data=raw.get("data"),
        raw=raw,
    )


def request_json(
    method: str,
    path: str,
    token: str,
    *,
    payload: dict[str, Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT,
    retry: int = DEFAULT_RETRY,
    user_agent: str = DEFAULT_USER_AGENT,
) -> ApiResult:
    body = None
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        "User-Agent": user_agent,
    }

    if payload is not None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(
        url=f"{BASE_URL}{path}",
        data=body,
        headers=headers,
        method=method,
    )

    attempts = max(1, retry + 1)
    last_error = ""
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                content = decode_response_body(response, response.read())
                return parse_api_result(content, response.getcode())
        except urllib.error.HTTPError as exc:
            content = decode_response_body(exc, exc.read())
            return parse_api_result(content, exc.code)
        except (urllib.error.URLError, socket.timeout, TimeoutError) as exc:
            reason = getattr(exc, "reason", exc)
            last_error = str(reason)
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)

        if attempt < attempts:
            time.sleep(min(2, attempt))

    raise RuntimeError(f"请求失败，已重试 {attempts} 次: {last_error or '未知错误'}")


def get_today_entry(form_data: dict[str, Any]) -> dict[str, Any] | None:
    for item in form_data.get("days", []):
        if item.get("today") == 1:
            return item
    return None


def format_form_summary(form_data: dict[str, Any]) -> str:
    today = get_today_entry(form_data)
    stat = form_data.get("stat") or {}
    if not today:
        return "未找到今日签到记录。"

    checked = safe_int(today.get("point_total"), 0) > 0
    today_str = today.get("day", "今天")
    continuous = safe_int(stat.get("continuous_count"), 0)
    point_total = safe_int(today.get("point_total"), 0)
    status = "已签到" if checked else "未签到"
    return f"{today_str} {status}，今日积分 {point_total}，连续签到 {continuous} 天。"


def is_success(result: ApiResult) -> bool:
    return result.code in SUCCESS_CODES


def is_already_checked_in(result: ApiResult) -> bool:
    return "已签到" in result.msg


def is_auth_error(result: ApiResult) -> bool:
    auth_codes = {401, 403}
    return result.http_status in auth_codes or result.code in auth_codes


def get_points(data: Any) -> tuple[int, int]:
    if not isinstance(data, dict):
        return 0, 0
    return safe_int(data.get("point"), 0), safe_int(data.get("total_point"), 0)


def check_in(
    token: str,
    mall_id: str,
    *,
    timeout: int,
    retry: int,
    check_only: bool,
    json_output: bool,
) -> int:
    form: ApiResult | None = None
    form_error = ""

    try:
        form = request_json(
            "GET",
            f"/restful/mall/{mall_id}/checkInForm?with_records=1",
            token,
            timeout=timeout,
            retry=retry,
        )
    except RuntimeError as exc:
        form_error = str(exc)
    else:
        if is_success(form) and isinstance(form.data, dict):
            if json_output:
                log(json.dumps({"stage": "form", **form.raw}, ensure_ascii=False, indent=2))
            else:
                log(format_form_summary(form.data))

            today = get_today_entry(form.data)
            if today and safe_int(today.get("point_total"), 0) > 0:
                log("今天已经签到，无需重复签到。")
                return 0
        else:
            form_error = f"查询签到状态失败: http={form.http_status}, code={form.code}, msg={form.msg}"

    if form_error:
        log(form_error, error=True)
        if check_only:
            return 1
        log("查询失败，继续尝试直接签到。")

    sign = request_json(
        "POST",
        f"/restful/mall/{mall_id}/checkInRecord",
        token,
        payload={"latitude": 0, "longitude": 0},
        timeout=timeout,
        retry=retry,
    )

    if json_output:
        log(json.dumps({"stage": "checkin", **sign.raw}, ensure_ascii=False, indent=2))

    if is_success(sign):
        point, total_point = get_points(sign.data)
        if not json_output:
            log(f"签到成功，获得 {point} 积分，累计 {total_point} 积分。")
        return 0

    if is_already_checked_in(sign):
        if not json_output:
            log("今天已经签到。")
        return 0

    if is_auth_error(sign):
        log("签到失败：token 可能已失效，请重新抓包替换 token。", error=True)
        if json_output:
            log(json.dumps(sign.raw, ensure_ascii=False, indent=2), error=True)
        return 1

    log(f"签到失败: http={sign.http_status}, code={sign.code}, msg={sign.msg}", error=True)
    if json_output:
        log(json.dumps(sign.raw, ensure_ascii=False, indent=2), error=True)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="保利会员小程序自动签到")
    parser.add_argument(
        "--token",
        help="Bearer token，不带 Bearer 前缀。默认读取 BAOLI_TOKEN 环境变量，再回退到当前抓包里的 token。",
    )
    parser.add_argument("--mall-id", help="商场 ID；默认从 JWT 的 mall_id 自动解析。")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="请求超时时间，默认 15 秒。")
    parser.add_argument("--retry", type=int, default=DEFAULT_RETRY, help="网络失败后的额外重试次数，默认 2 次。")
    parser.add_argument("--check-only", action="store_true", help="只查询今日是否已签到，不发起签到。")
    parser.add_argument("--json", action="store_true", help="输出原始 JSON 结果。")
    return parser


def main() -> int:
    args = build_parser().parse_args()

    token = normalize_token(args.token or os.environ.get("BAOLI_TOKEN") or CAPTURED_TOKEN)
    if not token:
        log("缺少 token，请通过 --token 或 BAOLI_TOKEN 提供。", error=True)
        return 1

    try:
        payload = decode_jwt_payload(token)
    except ValueError as exc:
        log(str(exc), error=True)
        return 1

    if is_token_expired(payload):
        log("token 已过期，请重新抓包替换。", error=True)
        return 1

    mall_id = args.mall_id or str(payload.get("mall_id") or "").strip()
    if not mall_id:
        log("无法从 token 中解析 mall_id，请通过 --mall-id 指定。", error=True)
        return 1

    timeout = parse_positive_int(os.environ.get("BAOLI_TIMEOUT"), args.timeout)
    retry = parse_non_negative_int(os.environ.get("BAOLI_RETRY"), args.retry)

    try:
        return check_in(
            token=token,
            mall_id=mall_id,
            timeout=timeout,
            retry=retry,
            check_only=args.check_only,
            json_output=args.json,
        )
    except RuntimeError as exc:
        log(str(exc), error=True)
        return 1
    except KeyboardInterrupt:
        log("已手动中断。", error=True)
        return 130
    except Exception as exc:  # noqa: BLE001
        log(f"发生未预期错误: {exc}", error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
