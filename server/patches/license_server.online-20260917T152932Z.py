#!/usr/bin/env python3
import argparse
import base64
import csv
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
except ImportError:  # MC2 fails closed without affecting existing license routes.
    InvalidSignature = Exception
    hashes = None
    ec = None


PROJECT_DIR = Path(__file__).resolve().parents[1]
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from license_core import APP_NAME, INITIAL_CREDITS, _is_expired, code_hash
from por_precise_credits import (
    APP_NAME as POR_PRECISE_APP_NAME,
    PreciseCreditError,
    balance as por_precise_balance,
    consume as por_precise_consume,
    ensure_schema as ensure_por_precise_schema,
)


LEGACY_APP_NAME = APP_NAME
QIANCHUAN_APP_NAME = "QianchuanMixCutTool"
QIANCHUAN_LAPIAN_APP_NAME = "qianchuan-lapian-tool"
QIANCHUAN_LAPIAN_PRODUCT = "qianchuan-lapian-tool"
PRODUCT_OPERATION_REPORT_APP_NAME = "ProductOperationReport"
DADAO_SOCIAL_COMMENT_APP_NAME = "DadaoSocialCommentCrawler"
LIVE_PHOTO_STUDIO_APP_NAME = "LivePhotoStudio"
SUPPORTED_APPS = {
    LEGACY_APP_NAME: {"default_credits": int(INITIAL_CREDITS), "signed_codes": True},
    QIANCHUAN_APP_NAME: {"default_credits": 300, "signed_codes": False},
    QIANCHUAN_LAPIAN_APP_NAME: {"default_credits": 300, "signed_codes": True},
    PRODUCT_OPERATION_REPORT_APP_NAME: {"default_credits": 100, "signed_codes": False},
    DADAO_SOCIAL_COMMENT_APP_NAME: {"default_credits": 100, "signed_codes": False},
    LIVE_PHOTO_STUDIO_APP_NAME: {"default_credits": 100, "signed_codes": False},
}
SCHEMA_VERSION = 14
APP_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{1,63}$")
LIVEPHOTO_MC2_VERSION = 1
LIVEPHOTO_MC2_PREFIX = "/api/license/livephoto/mc2"
LIVEPHOTO_MC2_ID_RE = re.compile(r"^MC2(?:-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}){4}$")
LIVEPHOTO_MC2_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{8,160}$")

QC1_PUBLIC_KEY_DER_B64 = "MCowBQYDK2VwAyEAOH9frGqBE5jlFh04pDmsTxm0C89YB9tVP0fzq0SjVfs="
ED25519_Q = 2 ** 255 - 19
ED25519_L = 2 ** 252 + 27742317777372353535851937790883648493
ED25519_D = (-121665 * pow(121666, ED25519_Q - 2, ED25519_Q)) % ED25519_Q
ED25519_I = pow(2, (ED25519_Q - 1) // 4, ED25519_Q)

HOST = os.environ.get("OVDT_LICENSE_HOST", "0.0.0.0")
PORT = int(os.environ.get("OVDT_LICENSE_PORT", "8791"))
DB_PATH = Path(os.environ.get("OVDT_LICENSE_DB", Path(__file__).with_suffix(".sqlite3")))
BUSINESS_PROXY_DB_PATH = Path(
    os.environ.get("BUSINESS_PROXY_DB", "/opt/qianchuan-business-proxy/business.sqlite3")
)
LAPIAN_PROXY_DB_PATH = Path(
    os.environ.get("LAPIAN_PROXY_DB", "/opt/qianchuan-business-proxy/lapian.sqlite3")
)
QIANCHUAN_REDEEM_LOCK_PATH = Path(
    os.environ.get("QIANCHUAN_REDEEM_LOCK_PATH", "/run/lock/dadao-qianchuan-redeem.lock")
)
SERVER_PUBLIC_URL = os.environ.get(
    "OVDT_LICENSE_PUBLIC_URL",
    f"http://124.174.46.12:{PORT}",
).rstrip("/")
DB_LOCK = threading.RLock()
POINTS_INTERNAL_TOKEN = os.environ.get("POINTS_INTERNAL_TOKEN", "").strip()
POR_PRECISE_ENABLED = os.environ.get("POR_PRECISE_ENABLED", "0").strip() == "1"
POR_PRECISE_INTERNAL_TOKEN = os.environ.get("POR_PRECISE_INTERNAL_TOKEN", "").strip()
POR_PRECISE_POINTS_PER_CNY = os.environ.get("POR_PRECISE_POINTS_PER_CNY", "100").strip()
POR_PRECISE_COST_RATE = os.environ.get("POR_PRECISE_COST_RATE", "0.5").strip()
POINT_RESERVATION_TTL_SECONDS = max(60, int(os.environ.get("POINT_RESERVATION_TTL_SECONDS", "900")))
DEVICE_SESSION_SECRET = os.environ.get("DEVICE_SESSION_SECRET", "").strip()
DEVICE_SESSION_TTL_SECONDS = max(300, int(os.environ.get("DEVICE_SESSION_TTL_SECONDS", str(30 * 86400))))
LIVEPHOTO_MC2_ENABLED = os.environ.get("LIVEPHOTO_MC2_ENABLED", "false").strip().lower() in {
    "1", "true", "yes", "on",
}
LIVEPHOTO_MC2_CHALLENGE_TTL_SECONDS = max(
    60, min(int(os.environ.get("LIVEPHOTO_MC2_CHALLENGE_TTL_SECONDS", "300")), 900)
)
LIVEPHOTO_MC2_SESSION_TTL_SECONDS = max(
    300, min(int(os.environ.get("LIVEPHOTO_MC2_SESSION_TTL_SECONDS", "900")), 3600)
)
LICENSE_ADMIN_API_TOKEN = os.environ.get("LICENSE_ADMIN_API_TOKEN", "").strip()
DEVICE_UNBIND_COOLDOWN_HOURS = 24
DEVICE_SELF_TRANSFER_LIMIT = 3
DEVICE_SELF_TRANSFER_WINDOW_DAYS = 30
TIME_BASED_APPS = {
    item.strip()
    for item in os.environ.get("TIME_BASED_APPS", "DailyReminderBoard").split(",")
    if item.strip()
}
POINT_RESERVATION_APPS = {
    item.strip()
    for item in os.environ.get("POINT_RESERVATION_APPS", "LivePhotoStudio").split(",")
    if item.strip()
}
FEISHU_APP_ID = os.environ.get("FEISHU_APP_ID", "").strip()
FEISHU_APP_SECRET = os.environ.get("FEISHU_APP_SECRET", "").strip()
FEISHU_BASE_APP_TOKEN = os.environ.get("FEISHU_BASE_APP_TOKEN", "").strip()
FEISHU_BASE_TABLE_ID = os.environ.get("FEISHU_BASE_TABLE_ID", "").strip()
FEISHU_ORIGINAL_TABLE_ID = os.environ.get("FEISHU_ORIGINAL_TABLE_ID", "").strip()
FEISHU_QIANCHUAN_TABLE_ID = os.environ.get("FEISHU_QIANCHUAN_TABLE_ID", "").strip()
FEISHU_LAPIAN_TABLE_ID = os.environ.get("FEISHU_LAPIAN_TABLE_ID", "").strip()
FEISHU_DADAO_SOCIAL_COMMENT_TABLE_ID = os.environ.get("FEISHU_DADAO_SOCIAL_COMMENT_TABLE_ID", "").strip()
FEISHU_API_ORIGIN = os.environ.get("FEISHU_API_ORIGIN", "https://open.feishu.cn").rstrip("/")
FEISHU_SYNC_ENABLED = os.environ.get("FEISHU_SYNC_ENABLED", "true").strip().lower() in {
    "1", "true", "yes", "on",
}
FEISHU_RETRY_SECONDS = max(5, int(os.environ.get("FEISHU_RETRY_SECONDS", "15")))
FEISHU_WORKER_EVENT = threading.Event()
FEISHU_TOKEN_LOCK = threading.Lock()
FEISHU_TOKEN_CACHE = {"value": "", "expires_at": 0.0}
FEISHU_WORKER = None


def utc_now():
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


@contextmanager
def qianchuan_redeem_lock(app_name):
    if str(app_name or "").strip() != QIANCHUAN_LAPIAN_APP_NAME:
        yield
        return
    QIANCHUAN_REDEEM_LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    with QIANCHUAN_REDEEM_LOCK_PATH.open("a+", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _qianchuan_redeem_overlay_blocks(code_id):
    if not LAPIAN_PROXY_DB_PATH.is_file():
        return False
    conn = sqlite3.connect(f"file:{LAPIAN_PROXY_DB_PATH}?mode=ro", uri=True)
    try:
        table = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='redeem_transactions'"
        ).fetchone()
        if not table:
            return False
        return bool(conn.execute(
            """
            SELECT 1 FROM redeem_transactions
             WHERE app_name = ? AND source_code_id = ? AND status = 'succeeded'
             LIMIT 1
            """,
            (QIANCHUAN_LAPIAN_APP_NAME, str(code_id or "")),
        ).fetchone())
    finally:
        conn.close()


def _guard_qianchuan_central_activation(code, app_name, confirm_merge=False):
    clean_app = normalize_app_name(app_name)
    if clean_app != QIANCHUAN_LAPIAN_APP_NAME:
        return
    if bool(confirm_merge):
        raise ValueError("千川爆款拉片工具请使用拉片专用兑换接口充值。")
    payload, _ = payload_for_code(code, clean_app)
    code_id = str(payload.get("code_id") or "").strip().upper()
    if code_id and _qianchuan_redeem_overlay_blocks(code_id):
        raise ValueError("该激活码已通过拉片专用兑换接口兑换，不能再次激活或合并。")


def _parse_utc(value):
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _time_entitlement(payload, app_name=""):
    license_type = str(payload.get("license_type") or "").strip().lower()
    return (
        str(app_name or "") in TIME_BASED_APPS
        or int(payload.get("duration_days") or 0) > 0
        or license_type.startswith("time_")
    )


def _time_status(payload, activated_at=""):
    expires_at = str(payload.get("expires_at") or "")
    expires = _parse_utc(expires_at)
    if not expires:
        return {
            "activated_at": str(activated_at or ""),
            "expires_at": expires_at,
            "remaining_days": None,
        }
    seconds = max(0, (expires - datetime.now(timezone.utc)).total_seconds())
    return {
        "activated_at": str(activated_at or ""),
        "expires_at": expires_at,
        "remaining_days": int((seconds + 86399) // 86400),
    }


def _server_is_expired(expires_at):
    text = str(expires_at or "").strip()
    if not text:
        return False
    expires = _parse_utc(text)
    return True if not expires else expires <= datetime.now(timezone.utc)


class DeviceApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = int(status)


def _b64url_encode(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _issue_device_session(app_name, code_id, machine_code, credential_version):
    if not DEVICE_SESSION_SECRET:
        raise RuntimeError("服务器尚未配置 DEVICE_SESSION_SECRET。")
    payload = {
        "app_name": app_name,
        "code_id": code_id,
        "machine_code": machine_code,
        "credential_version": int(credential_version),
        "exp": int(time.time()) + DEVICE_SESSION_TTL_SECONDS,
        "nonce": secrets.token_urlsafe(12),
    }
    encoded = _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = _b64url_encode(
        hmac.new(DEVICE_SESSION_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    )
    return f"DVS1.{encoded}.{signature}"


def _verify_device_session(token):
    if not DEVICE_SESSION_SECRET:
        raise DeviceApiError("服务器尚未配置设备会话。", 503)
    parts = str(token or "").split(".")
    if len(parts) != 3 or parts[0] != "DVS1":
        raise DeviceApiError("设备会话无效。", 401)
    expected = _b64url_encode(
        hmac.new(DEVICE_SESSION_SECRET.encode("utf-8"), parts[1].encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(parts[2], expected):
        raise DeviceApiError("设备会话签名无效。", 401)
    try:
        payload = json.loads(_b64url_decode(parts[1]).decode("utf-8"))
    except Exception as exc:
        raise DeviceApiError("设备会话内容无效。", 401) from exc
    if int(payload.get("exp") or 0) <= int(time.time()):
        raise DeviceApiError("设备会话已过期。", 401)
    return payload


class LivePhotoMC2Error(DeviceApiError):
    def __init__(self, code, message, status=400):
        super().__init__(message, status)
        self.code = str(code)


def _livephoto_mc2_require_enabled():
    if not LIVEPHOTO_MC2_ENABLED:
        raise LivePhotoMC2Error("MC2_DISABLED", "实况小匠 MC2 设备身份尚未启用。", 410)
    if ec is None or hashes is None:
        raise LivePhotoMC2Error("MC2_CRYPTO_UNAVAILABLE", "服务器暂时无法验证设备签名。", 503)


def _livephoto_mc2_public_key(value):
    text = str(value or "").strip()
    if not text or len(text) > 256:
        raise LivePhotoMC2Error("MC2_PUBLIC_KEY_INVALID", "设备公钥格式无效。")
    try:
        raw = base64.b64decode(text.encode("ascii"), validate=True)
        if len(raw) != 65 or raw[0] != 4:
            raise ValueError("unexpected P-256 point")
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    except Exception as exc:
        raise LivePhotoMC2Error(
            "MC2_PUBLIC_KEY_INVALID", "设备公钥必须是 P-256 X9.63 未压缩格式。"
        ) from exc
    normalized = base64.b64encode(raw).decode("ascii")
    return key, normalized, hashlib.sha256(raw).hexdigest()


def _livephoto_mc2_verify_signature(public_key_base64, signing_payload_base64, signature_base64):
    public_key, _, _ = _livephoto_mc2_public_key(public_key_base64)
    try:
        payload = base64.b64decode(str(signing_payload_base64 or "").encode("ascii"), validate=True)
        signature = base64.b64decode(str(signature_base64 or "").encode("ascii"), validate=True)
        if not payload or len(payload) > 4096 or not signature or len(signature) > 144:
            raise ValueError("invalid signature payload")
        public_key.verify(signature, payload, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature as exc:
        raise LivePhotoMC2Error("MC2_SIGNATURE_INVALID", "设备签名验证失败。", 401) from exc
    except LivePhotoMC2Error:
        raise
    except Exception as exc:
        raise LivePhotoMC2Error("MC2_SIGNATURE_INVALID", "设备签名格式无效。", 401) from exc


def _livephoto_mc2_issue_session(device_row):
    if not DEVICE_SESSION_SECRET:
        raise LivePhotoMC2Error("MC2_SESSION_UNAVAILABLE", "服务器尚未配置设备会话。", 503)
    expires_at = int(time.time()) + LIVEPHOTO_MC2_SESSION_TTL_SECONDS
    payload = {
        "app_name": LIVE_PHOTO_STUDIO_APP_NAME,
        "code_id": str(device_row["code_id"]),
        "mc2_id": str(device_row["mc2_id"]),
        "legacy_machine_code": str(device_row["legacy_machine_code"]),
        "credential_version": int(device_row["credential_version"]),
        "exp": expires_at,
        "nonce": secrets.token_urlsafe(12),
    }
    encoded = _b64url_encode(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    signature = _b64url_encode(
        hmac.new(DEVICE_SESSION_SECRET.encode("utf-8"), encoded.encode("ascii"), hashlib.sha256).digest()
    )
    return f"LMC2.{encoded}.{signature}", expires_at


def _livephoto_mc2_verify_session(token):
    _livephoto_mc2_require_enabled()
    parts = str(token or "").split(".")
    if len(parts) != 3 or parts[0] != "LMC2":
        raise LivePhotoMC2Error("MC2_SESSION_INVALID", "MC2 设备会话无效。", 401)
    expected = _b64url_encode(
        hmac.new(DEVICE_SESSION_SECRET.encode("utf-8"), parts[1].encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(parts[2], expected):
        raise LivePhotoMC2Error("MC2_SESSION_INVALID", "MC2 设备会话签名无效。", 401)
    try:
        payload = json.loads(_b64url_decode(parts[1]).decode("utf-8"))
    except Exception as exc:
        raise LivePhotoMC2Error("MC2_SESSION_INVALID", "MC2 设备会话内容无效。", 401) from exc
    if payload.get("app_name") != LIVE_PHOTO_STUDIO_APP_NAME:
        raise LivePhotoMC2Error("MC2_APP_MISMATCH", "MC2 设备身份不属于实况小匠。", 403)
    if int(payload.get("exp") or 0) <= int(time.time()):
        raise LivePhotoMC2Error("MC2_SESSION_EXPIRED", "MC2 设备会话已过期。", 401)
    return payload


def _livephoto_mc2_new_id(conn):
    alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    for _ in range(32):
        value = "".join(secrets.choice(alphabet) for _ in range(16))
        candidate = "MC2-" + "-".join(value[index:index + 4] for index in range(0, 16, 4))
        if not conn.execute(
            "SELECT 1 FROM livephoto_mc2_devices WHERE mc2_id = ?", (candidate,)
        ).fetchone():
            return candidate
    raise LivePhotoMC2Error("MC2_ID_UNAVAILABLE", "服务器暂时无法创建设备身份。", 503)


def _livephoto_mc2_signing_payload(purpose, challenge_id, challenge, code_id,
                                    legacy_machine_code, mc2_id, public_key_sha256):
    value = {
        "app_name": LIVE_PHOTO_STUDIO_APP_NAME,
        "challenge": challenge,
        "challenge_id": challenge_id,
        "code_id": code_id,
        "legacy_machine_code": legacy_machine_code,
        "mc2_id": mc2_id,
        "protocol": "MC2",
        "public_key_sha256": public_key_sha256,
        "purpose": purpose,
        "version": LIVEPHOTO_MC2_VERSION,
    }
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _livephoto_mc2_insert_challenge(conn, purpose, code_id, legacy_machine_code,
                                    mc2_id, public_key_base64, public_key_sha256):
    now_epoch = int(time.time())
    conn.execute(
        "DELETE FROM livephoto_mc2_challenges WHERE expires_at < ?",
        (now_epoch - 86400,),
    )
    challenge_id = "mc2c_" + secrets.token_hex(16)
    challenge = _b64url_encode(secrets.token_bytes(32))
    signing_payload = _livephoto_mc2_signing_payload(
        purpose, challenge_id, challenge, code_id, legacy_machine_code,
        mc2_id, public_key_sha256,
    )
    signing_payload_base64 = base64.b64encode(signing_payload).decode("ascii")
    expires_at = now_epoch + LIVEPHOTO_MC2_CHALLENGE_TTL_SECONDS
    conn.execute(
        """
        INSERT INTO livephoto_mc2_challenges
            (challenge_id, app_name, purpose, code_id, legacy_machine_code,
             mc2_id, public_key_x963_base64, public_key_sha256,
             signing_payload_base64, expires_at, used_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
        """,
        (
            challenge_id, LIVE_PHOTO_STUDIO_APP_NAME, purpose, code_id,
            legacy_machine_code, mc2_id, public_key_base64, public_key_sha256,
            signing_payload_base64, expires_at, utc_now(),
        ),
    )
    return {
        "challenge_id": challenge_id,
        "challenge": challenge,
        "signing_payload_base64": signing_payload_base64,
        "expires_at": expires_at,
    }


def _livephoto_mc2_binding_row(conn, mc2_id):
    row = conn.execute(
        """
        SELECT d.*, a.bound_machine_code AS activation_machine_code,
               a.binding_status AS activation_binding_status,
               a.binding_role AS activation_binding_role,
               a.credential_version AS activation_credential_version,
               a.payload_json AS activation_payload_json,
               a.activated_at AS activation_activated_at,
               COALESCE(r.disabled, 0) AS code_disabled
        FROM livephoto_mc2_devices AS d
        JOIN activations AS a
          ON a.app_name = d.app_name AND a.code_id = d.code_id
        LEFT JOIN redeem_codes AS r
          ON r.app_name = d.app_name AND r.code_id = d.code_id
        WHERE d.app_name = ? AND d.mc2_id = ?
        """,
        (LIVE_PHOTO_STUDIO_APP_NAME, str(mc2_id or "").strip().upper()),
    ).fetchone()
    if not row:
        raise LivePhotoMC2Error("MC2_DEVICE_NOT_FOUND", "MC2 设备身份无效。", 404)
    if str(row["status"] or "") != "active":
        raise LivePhotoMC2Error("MC2_DEVICE_REVOKED", "MC2 设备身份已失效。", 401)
    if str(row["activation_binding_status"] or "") != "active":
        raise LivePhotoMC2Error("MC2_BINDING_CHANGED", "原授权绑定已失效。", 401)
    if str(row["activation_binding_role"] or "primary") != "primary":
        raise LivePhotoMC2Error("MC2_BINDING_CHANGED", "原授权已不再是主授权。", 401)
    if int(row["code_disabled"] or 0):
        raise LivePhotoMC2Error("MC2_LICENSE_DISABLED", "当前授权已停用。", 401)
    if str(row["activation_machine_code"] or "").strip().upper() != str(row["legacy_machine_code"] or "").upper():
        raise LivePhotoMC2Error("MC2_BINDING_CHANGED", "原授权设备绑定已变更。", 401)
    if int(row["activation_credential_version"] or 0) != int(row["credential_version"] or -1):
        raise LivePhotoMC2Error("MC2_CREDENTIAL_REVOKED", "原设备凭证已撤销。", 401)
    try:
        payload = json.loads(str(row["activation_payload_json"] or "{}"))
    except json.JSONDecodeError:
        payload = {}
    if _server_is_expired(str(payload.get("expires_at") or "")):
        raise LivePhotoMC2Error("MC2_LICENSE_EXPIRED", "当前授权已过期。", 401)
    return row, payload


def _livephoto_mc2_old_auth(data, headers):
    row = _device_auth(headers)
    if str(row.get("app_name") or "") != LIVE_PHOTO_STUDIO_APP_NAME:
        raise LivePhotoMC2Error("MC2_APP_MISMATCH", "仅实况小匠可以使用 MC2 迁移。", 403)
    code_id = str(data.get("code_id") or "").strip().upper()
    old_machine = str(data.get("legacy_machine_code") or "").strip().upper()
    if code_id != str(row.get("code_id") or "").strip().upper():
        raise LivePhotoMC2Error("MC2_IDENTITY_MISMATCH", "授权编号与当前设备会话不一致。", 403)
    if old_machine != str(row.get("bound_machine_code") or "").strip().upper():
        raise LivePhotoMC2Error("MC2_IDENTITY_MISMATCH", "旧机器码与当前设备绑定不一致。", 403)
    return row, code_id, old_machine


def handle_livephoto_mc2_migration_challenge(data, headers):
    _livephoto_mc2_require_enabled()
    row, code_id, old_machine = _livephoto_mc2_old_auth(data, headers)
    _, public_key_base64, public_key_sha256 = _livephoto_mc2_public_key(
        data.get("public_key_x963_base64")
    )
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT * FROM livephoto_mc2_devices WHERE app_name = ? AND code_id = ?",
            (LIVE_PHOTO_STUDIO_APP_NAME, code_id),
        ).fetchone()
        if existing and str(existing["public_key_sha256"]) != public_key_sha256:
            raise LivePhotoMC2Error(
                "MC2_KEY_CONFLICT", "该授权已绑定其他 MC2 设备公钥，请联系管理员处理。", 409
            )
        challenge = _livephoto_mc2_insert_challenge(
            conn, "migrate", code_id, old_machine,
            str(existing["mc2_id"] if existing else ""),
            public_key_base64, public_key_sha256,
        )
        conn.commit()
    return {
        "ok": True,
        "app_name": LIVE_PHOTO_STUDIO_APP_NAME,
        "mc2Version": LIVEPHOTO_MC2_VERSION,
        "purpose": "migrate",
        **challenge,
    }


def _livephoto_mc2_migration_result(row, *, idempotent):
    session, expires_at = _livephoto_mc2_issue_session(row)
    return {
        "ok": True,
        "app_name": LIVE_PHOTO_STUDIO_APP_NAME,
        "mc2Version": LIVEPHOTO_MC2_VERSION,
        "migrated": True,
        "idempotent": bool(idempotent),
        "mc2_id": str(row["mc2_id"]),
        "code_id": str(row["code_id"]),
        "binding_preserved": True,
        "entitlement_preserved": True,
        "balance_preserved": True,
        "mc2_session": session,
        "expires_at": expires_at,
    }


def handle_livephoto_mc2_migrate(data, headers):
    _livephoto_mc2_require_enabled()
    auth_row, code_id, old_machine = _livephoto_mc2_old_auth(data, headers)
    idempotency_key = str(data.get("idempotency_key") or "").strip()
    challenge_id = str(data.get("challenge_id") or "").strip()
    signature = str(data.get("signature_der_base64") or "").strip()
    if not LIVEPHOTO_MC2_SAFE_ID_RE.fullmatch(idempotency_key):
        raise LivePhotoMC2Error("MC2_IDEMPOTENCY_REQUIRED", "缺少有效的幂等键。")
    if not LIVEPHOTO_MC2_SAFE_ID_RE.fullmatch(challenge_id):
        raise LivePhotoMC2Error("MC2_CHALLENGE_INVALID", "挑战编号无效。")
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        previous = conn.execute(
            "SELECT * FROM livephoto_mc2_migrations WHERE app_name = ? AND idempotency_key = ?",
            (LIVE_PHOTO_STUDIO_APP_NAME, idempotency_key),
        ).fetchone()
        if previous:
            if str(previous["code_id"]) != code_id or str(previous["legacy_machine_code"]).upper() != old_machine:
                raise LivePhotoMC2Error("MC2_IDEMPOTENCY_CONFLICT", "幂等键已用于其他迁移。", 409)
            device, _ = _livephoto_mc2_binding_row(conn, previous["mc2_id"])
            conn.rollback()
            return _livephoto_mc2_migration_result(device, idempotent=True)
        challenge = conn.execute(
            "SELECT * FROM livephoto_mc2_challenges WHERE challenge_id = ?",
            (challenge_id,),
        ).fetchone()
        if not challenge or str(challenge["purpose"]) != "migrate":
            raise LivePhotoMC2Error("MC2_CHALLENGE_INVALID", "迁移挑战无效。", 401)
        if challenge["used_at"] or int(challenge["expires_at"] or 0) <= int(time.time()):
            raise LivePhotoMC2Error("MC2_CHALLENGE_EXPIRED", "迁移挑战已使用或过期。", 401)
        if str(challenge["code_id"]) != code_id or str(challenge["legacy_machine_code"]).upper() != old_machine:
            raise LivePhotoMC2Error("MC2_CHALLENGE_MISMATCH", "迁移挑战与当前授权不一致。", 403)
        _livephoto_mc2_verify_signature(
            challenge["public_key_x963_base64"], challenge["signing_payload_base64"], signature
        )
        current = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (LIVE_PHOTO_STUDIO_APP_NAME, code_id),
        ).fetchone()
        if (
            not current
            or str(current["binding_status"] or "") != "active"
            or str(current["binding_role"] or "primary") != "primary"
            or str(current["bound_machine_code"] or "").strip().upper() != old_machine
            or int(current["credential_version"] or 0) != int(auth_row.get("credential_version") or -1)
        ):
            raise LivePhotoMC2Error("MC2_BINDING_CHANGED", "迁移期间原授权绑定发生变化。", 409)
        existing = conn.execute(
            "SELECT * FROM livephoto_mc2_devices WHERE app_name = ? AND code_id = ?",
            (LIVE_PHOTO_STUDIO_APP_NAME, code_id),
        ).fetchone()
        if existing:
            if (
                str(existing["public_key_sha256"]) != str(challenge["public_key_sha256"])
                or str(existing["legacy_machine_code"]).upper() != old_machine
            ):
                raise LivePhotoMC2Error("MC2_KEY_CONFLICT", "该授权已迁移到其他 MC2 设备。", 409)
            device, _ = _livephoto_mc2_binding_row(conn, existing["mc2_id"])
            conn.rollback()
            return _livephoto_mc2_migration_result(device, idempotent=True)
        mc2_id = _livephoto_mc2_new_id(conn)
        now = utc_now()
        conn.execute(
            """
            INSERT INTO livephoto_mc2_devices
                (mc2_id, app_name, code_id, legacy_machine_code,
                 public_key_x963_base64, public_key_sha256, credential_version,
                 status, created_at, updated_at, last_verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
            """,
            (
                mc2_id, LIVE_PHOTO_STUDIO_APP_NAME, code_id, old_machine,
                challenge["public_key_x963_base64"], challenge["public_key_sha256"],
                int(current["credential_version"] or 1), now, now, now,
            ),
        )
        conn.execute(
            """
            INSERT INTO livephoto_mc2_migrations
                (migration_id, app_name, idempotency_key, code_id,
                 legacy_machine_code, mc2_id, public_key_sha256, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "mc2m_" + secrets.token_hex(16), LIVE_PHOTO_STUDIO_APP_NAME,
                idempotency_key, code_id, old_machine, mc2_id,
                challenge["public_key_sha256"], now,
            ),
        )
        conn.execute(
            "UPDATE livephoto_mc2_challenges SET used_at = ? WHERE challenge_id = ? AND used_at = ''",
            (now, challenge_id),
        )
        device = conn.execute(
            "SELECT * FROM livephoto_mc2_devices WHERE mc2_id = ?", (mc2_id,)
        ).fetchone()
        conn.commit()
    return _livephoto_mc2_migration_result(device, idempotent=False)


def handle_livephoto_mc2_auth_challenge(data):
    _livephoto_mc2_require_enabled()
    mc2_id = str(data.get("mc2_id") or "").strip().upper()
    if not LIVEPHOTO_MC2_ID_RE.fullmatch(mc2_id):
        raise LivePhotoMC2Error("MC2_DEVICE_NOT_FOUND", "MC2 设备身份无效。", 404)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        device, _ = _livephoto_mc2_binding_row(conn, mc2_id)
        challenge = _livephoto_mc2_insert_challenge(
            conn, "authenticate", str(device["code_id"]),
            str(device["legacy_machine_code"]), mc2_id,
            str(device["public_key_x963_base64"]), str(device["public_key_sha256"]),
        )
        conn.commit()
    return {
        "ok": True,
        "app_name": LIVE_PHOTO_STUDIO_APP_NAME,
        "mc2Version": LIVEPHOTO_MC2_VERSION,
        "purpose": "authenticate",
        "mc2_id": mc2_id,
        **challenge,
    }


def handle_livephoto_mc2_session(data):
    _livephoto_mc2_require_enabled()
    challenge_id = str(data.get("challenge_id") or "").strip()
    signature = str(data.get("signature_der_base64") or "").strip()
    if not LIVEPHOTO_MC2_SAFE_ID_RE.fullmatch(challenge_id):
        raise LivePhotoMC2Error("MC2_CHALLENGE_INVALID", "挑战编号无效。", 401)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        challenge = conn.execute(
            "SELECT * FROM livephoto_mc2_challenges WHERE challenge_id = ?",
            (challenge_id,),
        ).fetchone()
        if not challenge or str(challenge["purpose"]) != "authenticate":
            raise LivePhotoMC2Error("MC2_CHALLENGE_INVALID", "登录挑战无效。", 401)
        if challenge["used_at"] or int(challenge["expires_at"] or 0) <= int(time.time()):
            raise LivePhotoMC2Error("MC2_CHALLENGE_EXPIRED", "登录挑战已使用或过期。", 401)
        _livephoto_mc2_verify_signature(
            challenge["public_key_x963_base64"], challenge["signing_payload_base64"], signature
        )
        device, _ = _livephoto_mc2_binding_row(conn, challenge["mc2_id"])
        if (
            str(device["code_id"]) != str(challenge["code_id"])
            or str(device["public_key_sha256"]) != str(challenge["public_key_sha256"])
        ):
            raise LivePhotoMC2Error("MC2_CHALLENGE_MISMATCH", "登录挑战与设备身份不一致。", 403)
        now = utc_now()
        conn.execute(
            "UPDATE livephoto_mc2_challenges SET used_at = ? WHERE challenge_id = ? AND used_at = ''",
            (now, challenge_id),
        )
        conn.execute(
            "UPDATE livephoto_mc2_devices SET last_verified_at = ?, updated_at = ? WHERE mc2_id = ?",
            (now, now, device["mc2_id"]),
        )
        conn.commit()
    token, expires_at = _livephoto_mc2_issue_session(device)
    return {
        "ok": True,
        "app_name": LIVE_PHOTO_STUDIO_APP_NAME,
        "mc2Version": LIVEPHOTO_MC2_VERSION,
        "mc2_id": str(device["mc2_id"]),
        "code_id": str(device["code_id"]),
        "mc2_session": token,
        "expires_at": expires_at,
    }


def handle_livephoto_mc2_status(headers):
    authorization = str(headers.get("Authorization") or "")
    if not authorization.startswith("Bearer "):
        raise LivePhotoMC2Error("MC2_SESSION_REQUIRED", "缺少 MC2 设备会话。", 401)
    identity = _livephoto_mc2_verify_session(authorization[7:].strip())
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        device, payload = _livephoto_mc2_binding_row(conn, identity.get("mc2_id"))
        if (
            str(device["code_id"]) != str(identity.get("code_id") or "")
            or str(device["legacy_machine_code"]).upper()
            != str(identity.get("legacy_machine_code") or "").upper()
            or int(device["credential_version"] or 0)
            != int(identity.get("credential_version") or -1)
        ):
            raise LivePhotoMC2Error("MC2_SESSION_REVOKED", "MC2 设备会话已撤销。", 401)
        is_time_based = _time_entitlement(payload, LIVE_PHOTO_STUDIO_APP_NAME)
        account = None if is_time_based else _point_account_state(
            conn, LIVE_PHOTO_STUDIO_APP_NAME, str(device["code_id"]),
            str(device["legacy_machine_code"]),
        )
    result = {
        "ok": True,
        "app_name": LIVE_PHOTO_STUDIO_APP_NAME,
        "mc2Version": LIVEPHOTO_MC2_VERSION,
        "authentication_method": "secure_enclave_p256",
        "mc2_id": str(device["mc2_id"]),
        "device_id": str(device["mc2_id"]),
        "code_id": str(device["code_id"]),
        "primary_code_id": str(device["code_id"]),
        "binding_status": "active",
        # The proxy uses the unchanged ledger key internally; clients display mc2_id.
        "machine_code": str(device["legacy_machine_code"]),
    }
    if is_time_based:
        result.update(_time_status(payload, device["activation_activated_at"]))
        result["entitlement_type"] = "time"
        result["unlimited"] = False
    else:
        balance = int(account["balance"] if account else 0)
        unlimited = bool(account and account["unlimited"])
        result.update({
            "remaining_credits": 999999999 if unlimited else balance,
            "unlimited": unlimited,
            "entitlement_type": "unlimited" if unlimited else "credits",
            "balance_authoritative": bool(account and account["balance_mode"] == "server_managed"),
        })
    return result


def _supported_apps_from_db():
    apps = dict(SUPPORTED_APPS)
    if not DB_PATH.exists():
        return apps
    try:
        with sqlite3.connect(DB_PATH) as conn:
            if not _table_exists(conn, "apps"):
                return apps
            rows = conn.execute(
                """
                SELECT app_name, default_credits, signed_codes
                FROM apps
                WHERE active = 1
                """
            ).fetchall()
    except sqlite3.Error:
        return apps
    for app_name, default_credits, signed_codes in rows:
        clean_app = str(app_name or "").strip()
        if clean_app and APP_NAME_RE.match(clean_app):
            apps[clean_app] = {
                "default_credits": int(default_credits or 100),
                "signed_codes": bool(signed_codes),
            }
    return apps


def app_config(app_name):
    return _supported_apps_from_db().get(str(app_name or "").strip())


def normalize_app_name(value, *, allow_legacy_default=True):
    clean = str(value or "").strip()
    if not clean and allow_legacy_default:
        return LEGACY_APP_NAME
    if not APP_NAME_RE.match(clean) or clean not in _supported_apps_from_db():
        raise ValueError("客户端应用不匹配。")
    return clean


def _table_exists(conn, table_name):
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone()
    return bool(row)


def _table_columns(conn, table_name):
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table_name})")}


def _primary_key_columns(conn, table_name):
    rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return [str(row[1]) for row in sorted(rows, key=lambda item: int(item[5] or 0)) if int(row[5] or 0)]


def _create_activations_table(conn, table_name="activations"):
    conn.execute(
        f"""
        CREATE TABLE {table_name} (
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            bound_machine_code TEXT NOT NULL,
            activated_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            binding_status TEXT NOT NULL DEFAULT 'active',
            device_credential_hash TEXT NOT NULL DEFAULT '',
            credential_version INTEGER NOT NULL DEFAULT 1,
            transfer_count INTEGER NOT NULL DEFAULT 0,
            last_bound_at TEXT NOT NULL DEFAULT '',
            last_unbound_at TEXT NOT NULL DEFAULT '',
            previous_machine_code TEXT NOT NULL DEFAULT '',
            binding_role TEXT NOT NULL DEFAULT 'primary',
            merged_into_code_id TEXT NOT NULL DEFAULT '',
            merged_at TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (app_name, code_id)
        )
        """
    )
    conn.execute(
        f"""
        CREATE INDEX IF NOT EXISTS idx_{table_name}_machine
        ON {table_name} (app_name, bound_machine_code)
        """
    )


def _create_redeem_codes_table(conn, table_name="redeem_codes"):
    conn.execute(
        f"""
        CREATE TABLE {table_name} (
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            code_plaintext TEXT NOT NULL DEFAULT '',
            credits INTEGER NOT NULL DEFAULT 100,
            duration_days INTEGER NOT NULL DEFAULT 0,
            unlimited INTEGER NOT NULL DEFAULT 0,
            license_type TEXT NOT NULL DEFAULT 'standard',
            expires_at TEXT NOT NULL DEFAULT '',
            disabled INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (app_name, code_id),
            UNIQUE (app_name, code_hash)
        )
        """
    )


def _create_feishu_outbox_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS feishu_outbox (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            attempts INTEGER NOT NULL DEFAULT 0,
            next_retry_at TEXT NOT NULL,
            last_error TEXT NOT NULL DEFAULT '',
            feishu_record_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            sent_at TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_feishu_outbox_retry
        ON feishu_outbox (status, next_retry_at, id)
        """
    )


def _create_apps_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS apps (
            app_name TEXT PRIMARY KEY,
            display_name TEXT NOT NULL DEFAULT '',
            default_credits INTEGER NOT NULL DEFAULT 100,
            signed_codes INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            note TEXT NOT NULL DEFAULT ''
        )
        """
    )
    created_at = utc_now()
    for app_name, config in SUPPORTED_APPS.items():
        conn.execute(
            """
            INSERT OR IGNORE INTO apps
                (app_name, display_name, default_credits, signed_codes, active, created_at, note)
            VALUES (?, '', ?, ?, 1, ?, '系统内置软件')
            """,
            (
                app_name,
                int(config.get("default_credits") or 100),
                1 if config.get("signed_codes") else 0,
                created_at,
            ),
        )


def _create_points_tables(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS point_accounts (
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            machine_code TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            balance INTEGER NOT NULL DEFAULT 0,
            unlimited INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (app_name, code_id, machine_code)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS point_reservations (
            reservation_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            machine_code TEXT NOT NULL,
            idempotency_key TEXT NOT NULL,
            points INTEGER NOT NULL,
            operation TEXT NOT NULL DEFAULT '',
            billing_kind TEXT NOT NULL DEFAULT '',
            quantity INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(app_name, machine_code, idempotency_key)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_point_reservations_status
        ON point_reservations (status, expires_at)
        """
    )
    account_columns = _table_columns(conn, "point_accounts")
    account_additions = {
        "balance_mode": "TEXT NOT NULL DEFAULT 'pending_migration'",
        "balance_source": "TEXT NOT NULL DEFAULT 'unverified_legacy'",
        "migration_status": "TEXT NOT NULL DEFAULT 'pending'",
        "billing_api": "TEXT NOT NULL DEFAULT 'legacy_points'",
    }
    for name, definition in account_additions.items():
        if name not in account_columns:
            conn.execute(f"ALTER TABLE point_accounts ADD COLUMN {name} {definition}")
    conn.execute(
        """
        UPDATE point_accounts
        SET balance = 0,
            balance_mode = 'server_managed',
            balance_source = 'unlimited_entitlement',
            migration_status = 'completed',
            billing_api = 'credits_consume'
        WHERE unlimited = 1
          AND (
              balance <> 0
              OR balance_mode <> 'server_managed'
              OR balance_source <> 'unlimited_entitlement'
              OR migration_status <> 'completed'
              OR billing_api <> 'credits_consume'
          )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS credit_transactions (
            transaction_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            machine_code TEXT NOT NULL,
            transaction_type TEXT NOT NULL,
            amount INTEGER NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            balance_before INTEGER,
            balance_after INTEGER,
            unlimited INTEGER NOT NULL DEFAULT 0,
            client_version TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(app_name, code_id, request_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_credit_transactions_code_time
        ON credit_transactions (app_name, code_id, created_at)
        """
    )
    credit_columns = _table_columns(conn, "credit_transactions")
    if "transaction_type" not in credit_columns:
        conn.execute(
            "ALTER TABLE credit_transactions ADD COLUMN transaction_type TEXT NOT NULL DEFAULT 'consume'"
        )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS time_renewals (
            renewal_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL,
            primary_code_id TEXT NOT NULL,
            renewal_code_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            machine_code TEXT NOT NULL,
            duration_days INTEGER NOT NULL,
            old_expires_at TEXT NOT NULL,
            new_expires_at TEXT NOT NULL,
            client_version TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(app_name, renewal_code_id),
            UNIQUE(app_name, primary_code_id, request_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS balance_migrations (
            migration_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            old_machine_code TEXT NOT NULL DEFAULT '',
            reported_balance INTEGER,
            approved_balance INTEGER,
            balance_source TEXT NOT NULL,
            operator TEXT NOT NULL,
            reason TEXT NOT NULL,
            client_version TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(app_name, code_id)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_credit_adjustments (
            adjustment_id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            machine_code TEXT NOT NULL,
            adjustment_mode TEXT NOT NULL,
            amount INTEGER NOT NULL,
            balance_before INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            operator TEXT NOT NULL,
            reason TEXT NOT NULL,
            proxy_source TEXT NOT NULL DEFAULT '',
            proxy_balance_before INTEGER,
            proxy_balance_after INTEGER,
            proxy_sync_status TEXT NOT NULL DEFAULT 'pending',
            user_ip TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            synced_at TEXT NOT NULL DEFAULT ''
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_admin_credit_adjustments_code_time
        ON admin_credit_adjustments (app_name, code_id, created_at DESC)
        """
    )


def _create_livephoto_mc2_tables(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS livephoto_mc2_devices (
            mc2_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL CHECK (app_name = 'LivePhotoStudio'),
            code_id TEXT NOT NULL,
            legacy_machine_code TEXT NOT NULL,
            public_key_x963_base64 TEXT NOT NULL,
            public_key_sha256 TEXT NOT NULL,
            credential_version INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_verified_at TEXT NOT NULL DEFAULT '',
            UNIQUE(app_name, code_id),
            UNIQUE(app_name, legacy_machine_code),
            UNIQUE(app_name, public_key_sha256)
        )
        """
    )


    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS livephoto_mc2_challenges (
            challenge_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL CHECK (app_name = 'LivePhotoStudio'),
            purpose TEXT NOT NULL,
            code_id TEXT NOT NULL,
            legacy_machine_code TEXT NOT NULL,
            mc2_id TEXT NOT NULL DEFAULT '',
            public_key_x963_base64 TEXT NOT NULL,
            public_key_sha256 TEXT NOT NULL,
            signing_payload_base64 TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            used_at TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_livephoto_mc2_challenges_expiry
        ON livephoto_mc2_challenges (expires_at, used_at)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS livephoto_mc2_migrations (
            migration_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL CHECK (app_name = 'LivePhotoStudio'),
            idempotency_key TEXT NOT NULL,
            code_id TEXT NOT NULL,
            legacy_machine_code TEXT NOT NULL,
            mc2_id TEXT NOT NULL,
            public_key_sha256 TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(app_name, idempotency_key)
        )
        """
    )


def _create_livephoto_point_event_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS livephoto_point_events (
            transaction_id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            reservation_id TEXT NOT NULL,
            app_name TEXT NOT NULL CHECK (app_name = 'LivePhotoStudio'),
            code_id TEXT NOT NULL,
            mc2_id TEXT NOT NULL DEFAULT '',
            operation TEXT NOT NULL,
            event_type TEXT NOT NULL CHECK (event_type IN ('reserve', 'commit', 'release')),
            points INTEGER NOT NULL,
            quoted_points INTEGER NOT NULL,
            balance_before INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            unlimited INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            UNIQUE(app_name, reservation_id, event_type)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_livephoto_point_events_account_time
        ON livephoto_point_events (app_name, code_id, created_at DESC)
        """
    )


def _create_ai_label_consumptions_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS ai_label_consumptions (
            consumption_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL CHECK (app_name = 'OriginalVideoDedupTool'),
            code_id TEXT NOT NULL,
            machine_code TEXT NOT NULL,
            request_id TEXT NOT NULL,
            video_task_id TEXT NOT NULL,
            visible_label_points INTEGER NOT NULL,
            subtitle_points INTEGER NOT NULL,
            total_points INTEGER NOT NULL,
            balance_before INTEGER NOT NULL,
            balance_after INTEGER NOT NULL,
            unlimited INTEGER NOT NULL DEFAULT 0,
            credit_transaction_id TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'completed',
            created_at TEXT NOT NULL,
            UNIQUE(app_name, code_id, machine_code, request_id, video_task_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_ai_label_consumptions_account_time
        ON ai_label_consumptions (app_name, code_id, machine_code, created_at DESC)
        """
    )


def _create_device_transfer_log_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS device_transfer_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            old_machine_code TEXT NOT NULL DEFAULT '',
            new_machine_code TEXT NOT NULL DEFAULT '',
            actor_type TEXT NOT NULL,
            actor TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            user_ip TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL
        )
        """
    )


def _create_admin_batch_action_tables(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_batch_actions (
            batch_id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE,
            request_hash TEXT NOT NULL,
            action TEXT NOT NULL,
            item_count INTEGER NOT NULL,
            operator TEXT NOT NULL,
            reason TEXT NOT NULL,
            status TEXT NOT NULL,
            user_ip TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            result_json TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS admin_batch_action_items (
            batch_id TEXT NOT NULL,
            app_name TEXT NOT NULL,
            code_id TEXT NOT NULL,
            action TEXT NOT NULL,
            binding_status_before TEXT NOT NULL,
            binding_status_after TEXT NOT NULL,
            disabled_before INTEGER NOT NULL,
            disabled_after INTEGER NOT NULL,
            old_machine_code TEXT NOT NULL DEFAULT '',
            released_reservations INTEGER NOT NULL DEFAULT 0,
            result_status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (batch_id, app_name, code_id),
            FOREIGN KEY (batch_id) REFERENCES admin_batch_actions(batch_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_admin_batch_action_items_code
        ON admin_batch_action_items (app_name, code_id, created_at DESC)
        """
    )


def _create_primary_reissue_tables(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS primary_reissues (
            reissue_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL,
            old_code_id TEXT NOT NULL,
            new_code_id TEXT NOT NULL,
            request_id TEXT NOT NULL,
            entitlement_type TEXT NOT NULL,
            balance_mode TEXT NOT NULL DEFAULT '',
            balance_before INTEGER,
            balance_after INTEGER,
            activated_at TEXT NOT NULL DEFAULT '',
            expires_at TEXT NOT NULL DEFAULT '',
            operator TEXT NOT NULL,
            reason TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'completed',
            created_at TEXT NOT NULL,
            approved_at TEXT NOT NULL,
            UNIQUE(app_name, old_code_id),
            UNIQUE(request_id),
            UNIQUE(app_name, new_code_id)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_primary_reissues_created
        ON primary_reissues (created_at DESC)
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS primary_reissue_adjustments (
            adjustment_id TEXT PRIMARY KEY,
            reissue_id TEXT NOT NULL,
            app_name TEXT NOT NULL,
            old_code_id TEXT NOT NULL,
            reported_balance INTEGER,
            approved_balance INTEGER NOT NULL,
            operator TEXT NOT NULL,
            reason TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE(reissue_id)
        )
        """
    )
    columns = _table_columns(conn, "activations")
    additions = {
        "replaces_code_id": "TEXT NOT NULL DEFAULT ''",
        "replaced_by_code_id": "TEXT NOT NULL DEFAULT ''",
        "replacement_status": "TEXT NOT NULL DEFAULT ''",
        "replaced_at": "TEXT NOT NULL DEFAULT ''",
    }
    for name, definition in additions.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE activations ADD COLUMN {name} {definition}")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_device_transfer_log_code_time
        ON device_transfer_log (app_name, code_id, created_at)
        """
    )


def _migrate_activations(conn):
    if not _table_exists(conn, "activations"):
        _create_activations_table(conn)
        return
    if _primary_key_columns(conn, "activations") == ["app_name", "code_id"]:
        columns = _table_columns(conn, "activations")
        additions = {
            "binding_status": "TEXT NOT NULL DEFAULT 'active'",
            "device_credential_hash": "TEXT NOT NULL DEFAULT ''",
            "credential_version": "INTEGER NOT NULL DEFAULT 1",
            "transfer_count": "INTEGER NOT NULL DEFAULT 0",
            "last_bound_at": "TEXT NOT NULL DEFAULT ''",
            "last_unbound_at": "TEXT NOT NULL DEFAULT ''",
            "previous_machine_code": "TEXT NOT NULL DEFAULT ''",
            "binding_role": "TEXT NOT NULL DEFAULT 'primary'",
            "merged_into_code_id": "TEXT NOT NULL DEFAULT ''",
            "merged_at": "TEXT NOT NULL DEFAULT ''",
        }
        for name, definition in additions.items():
            if name not in columns:
                conn.execute(f"ALTER TABLE activations ADD COLUMN {name} {definition}")
        conn.execute(
            "UPDATE activations SET last_bound_at = activated_at WHERE last_bound_at = ''"
        )
        conn.execute(
            "UPDATE activations SET binding_role = 'primary' WHERE binding_role = ''"
        )
        conn.execute(
            """
            UPDATE activations AS current
            SET binding_role = 'merged',
                merged_into_code_id = (
                    SELECT first.code_id
                    FROM activations AS first
                    WHERE first.app_name = current.app_name
                      AND UPPER(first.bound_machine_code) = UPPER(current.bound_machine_code)
                      AND first.binding_status = 'active'
                      AND first.binding_role = 'primary'
                    ORDER BY first.activated_at, first.code_id
                    LIMIT 1
                ),
                merged_at = CASE WHEN merged_at = '' THEN activated_at ELSE merged_at END
            WHERE current.binding_status = 'active'
              AND current.binding_role = 'primary'
              AND current.bound_machine_code <> ''
              AND current.code_id <> (
                    SELECT first.code_id
                    FROM activations AS first
                    WHERE first.app_name = current.app_name
                      AND UPPER(first.bound_machine_code) = UPPER(current.bound_machine_code)
                      AND first.binding_status = 'active'
                      AND first.binding_role = 'primary'
                    ORDER BY first.activated_at, first.code_id
                    LIMIT 1
              )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_one_primary
            ON activations (app_name, bound_machine_code)
            WHERE binding_status = 'active' AND binding_role = 'primary'
              AND bound_machine_code <> ''
            """
        )
        return

    columns = _table_columns(conn, "activations")
    conn.execute("DROP TABLE IF EXISTS activations_multi_app_new")
    _create_activations_table(conn, "activations_multi_app_new")
    app_expr = (
        "COALESCE(NULLIF(TRIM(app_name), ''), ?)"
        if "app_name" in columns
        else "?"
    )
    conn.execute(
        f"""
        INSERT INTO activations_multi_app_new
            (app_name, code_id, code_hash, bound_machine_code, activated_at, last_seen_at,
             payload_json, binding_status, last_bound_at)
        SELECT
            {app_expr}, code_id, code_hash, bound_machine_code, activated_at, last_seen_at,
            payload_json, 'active', activated_at
        FROM activations
        """,
        (LEGACY_APP_NAME,),
    )
    conn.execute("DROP TABLE activations")
    conn.execute("ALTER TABLE activations_multi_app_new RENAME TO activations")
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_activations_machine
        ON activations (app_name, bound_machine_code)
        """
    )


def _migrate_redeem_codes(conn):
    if not _table_exists(conn, "redeem_codes"):
        _create_redeem_codes_table(conn)
        return
    if _primary_key_columns(conn, "redeem_codes") == ["app_name", "code_id"]:
        columns = _table_columns(conn, "redeem_codes")
        if "code_plaintext" not in columns:
            conn.execute(
                "ALTER TABLE redeem_codes ADD COLUMN code_plaintext TEXT NOT NULL DEFAULT ''"
            )
        if "duration_days" not in columns:
            conn.execute(
                "ALTER TABLE redeem_codes ADD COLUMN duration_days INTEGER NOT NULL DEFAULT 0"
            )
        return

    columns = _table_columns(conn, "redeem_codes")
    conn.execute("DROP TABLE IF EXISTS redeem_codes_multi_app_new")
    _create_redeem_codes_table(conn, "redeem_codes_multi_app_new")
    app_expr = (
        "COALESCE(NULLIF(TRIM(app_name), ''), ?)"
        if "app_name" in columns
        else "?"
    )
    conn.execute(
        f"""
        INSERT INTO redeem_codes_multi_app_new
            (app_name, code_id, code_hash, code_plaintext, credits, duration_days, unlimited, license_type,
             expires_at, disabled, created_at, note)
        SELECT
            {app_expr}, code_id, code_hash,
            {"COALESCE(code_plaintext, '')" if "code_plaintext" in columns else "''"},
            credits,
            {"COALESCE(duration_days, 0)" if "duration_days" in columns else "0"},
            unlimited, license_type,
            expires_at, disabled, created_at, note
        FROM redeem_codes
        """,
        (LEGACY_APP_NAME,),
    )
    conn.execute("DROP TABLE redeem_codes")
    conn.execute("ALTER TABLE redeem_codes_multi_app_new RENAME TO redeem_codes")


def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.execute("BEGIN IMMEDIATE")
        _migrate_activations(conn)
        conn.execute(
            """
            UPDATE activations AS current
            SET binding_role = 'merged',
                merged_into_code_id = (
                    SELECT first.code_id FROM activations AS first
                    WHERE first.app_name = current.app_name
                      AND UPPER(first.bound_machine_code) = UPPER(current.bound_machine_code)
                      AND first.binding_status = 'active'
                      AND first.binding_role = 'primary'
                    ORDER BY first.activated_at, first.code_id LIMIT 1
                ),
                merged_at = CASE WHEN merged_at = '' THEN activated_at ELSE merged_at END
            WHERE current.binding_status = 'active'
              AND current.binding_role = 'primary'
              AND current.bound_machine_code <> ''
              AND current.code_id <> (
                    SELECT first.code_id FROM activations AS first
                    WHERE first.app_name = current.app_name
                      AND UPPER(first.bound_machine_code) = UPPER(current.bound_machine_code)
                      AND first.binding_status = 'active'
                      AND first.binding_role = 'primary'
                    ORDER BY first.activated_at, first.code_id LIMIT 1
              )
            """
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_activations_one_primary
            ON activations (app_name, bound_machine_code)
            WHERE binding_status = 'active' AND binding_role = 'primary'
              AND bound_machine_code <> ''
            """
        )
        _migrate_redeem_codes(conn)
        _create_feishu_outbox_table(conn)
        _create_apps_table(conn)
        _create_points_tables(conn)
        _create_livephoto_mc2_tables(conn)
        _create_livephoto_point_event_table(conn)
        _create_ai_label_consumptions_table(conn)
        _create_device_transfer_log_table(conn)
        _create_admin_batch_action_tables(conn)
        _create_primary_reissue_tables(conn)
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()


def database_summary():
    init_db()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        activation_counts = dict(
            conn.execute(
                "SELECT app_name, COUNT(*) FROM activations GROUP BY app_name"
            ).fetchall()
        )
        redeem_counts = dict(
            conn.execute(
                "SELECT app_name, COUNT(*) FROM redeem_codes GROUP BY app_name"
            ).fetchall()
        )
        outbox_counts = dict(
            conn.execute(
                "SELECT status, COUNT(*) FROM feishu_outbox GROUP BY status"
            ).fetchall()
        )
        schema_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    return {
        "database": str(DB_PATH),
        "schema_version": schema_version,
        "activations": activation_counts,
        "redeem_codes": redeem_counts,
        "feishu_outbox": outbox_counts,
        "feishu_configured": feishu_configured(),
    }


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler):
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length <= 0:
        return {}
    if length > 65536:
        raise ValueError("请求内容过大。")
    return json.loads(handler.rfile.read(length).decode("utf-8") or "{}")


def feishu_configured():
    return bool(
        FEISHU_SYNC_ENABLED
        and FEISHU_APP_ID
        and FEISHU_APP_SECRET
        and FEISHU_BASE_APP_TOKEN
        and (
            FEISHU_ORIGINAL_TABLE_ID
            or FEISHU_QIANCHUAN_TABLE_ID
            or FEISHU_LAPIAN_TABLE_ID
            or FEISHU_DADAO_SOCIAL_COMMENT_TABLE_ID
            or FEISHU_BASE_TABLE_ID
        )
    )


def _utc_after(seconds):
    return (datetime.utcnow() + timedelta(seconds=seconds)).isoformat(timespec="seconds") + "Z"


def license_benefit_text(credits=0, unlimited=False, duration_days=0, license_type=""):
    if unlimited:
        return "永久/无限"
    days = int(duration_days or 0)
    if days <= 0:
        match = re.match(r"^time_(\d+)d$", str(license_type or "").strip())
        if match:
            days = int(match.group(1))
    if days > 0:
        if days == 30:
            return "月卡 30 天"
        if days == 365:
            return "年卡 365 天"
        return f"{days} 天"
    return f"{int(credits or 0)} 积分"


def _feishu_fields(event):
    duration_days = int(event.get("duration_days") or 0)
    license_type = str(event.get("license_type") or "")
    credits = int(event.get("credits") or 0)
    unlimited = bool(event.get("unlimited"))
    fields = {
        "激活时间": str(event.get("activated_at") or ""),
        "软件 app_name": str(event.get("app_name") or ""),
        "激活码": str(event.get("activation_code") or ""),
        "激活码 code_id": str(event.get("code_id") or ""),
        "激活码 hash": str(event.get("code_hash") or ""),
        "授权类型": license_type,
        "积分": credits,
        "是否无限": unlimited,
        "绑定机器码": str(event.get("machine_code") or ""),
        "用户 IP": str(event.get("user_ip") or ""),
        "客户端版本": str(event.get("client_version") or ""),
        "激活结果": str(event.get("activation_result") or "激活成功"),
        "错误信息": str(event.get("error") or ""),
        "服务器时间": str(event.get("server_time") or ""),
    }
    if fields["软件 app_name"] == DADAO_SOCIAL_COMMENT_APP_NAME:
        fields["权益"] = license_benefit_text(credits, unlimited, duration_days, license_type)
    return fields


def _feishu_activation_table_id(fields):
    app_name = str(fields.get("软件 app_name") or "").strip()
    if app_name == QIANCHUAN_LAPIAN_APP_NAME:
        table_id = FEISHU_LAPIAN_TABLE_ID or FEISHU_BASE_TABLE_ID
    elif app_name == DADAO_SOCIAL_COMMENT_APP_NAME:
        table_id = FEISHU_DADAO_SOCIAL_COMMENT_TABLE_ID or FEISHU_BASE_TABLE_ID
    elif app_name == QIANCHUAN_APP_NAME:
        table_id = FEISHU_QIANCHUAN_TABLE_ID or FEISHU_BASE_TABLE_ID
    else:
        table_id = FEISHU_ORIGINAL_TABLE_ID or FEISHU_BASE_TABLE_ID
    if table_id:
        return table_id
    raise RuntimeError(f"Feishu activation table is not configured for {app_name or 'unknown app'}")


def _feishu_datetime_millis(value):
    text = str(value or "").strip()
    if not text:
        return int(time.time() * 1000)
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return int(time.time() * 1000)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def _prepare_feishu_activation_fields(fields):
    prepared = dict(fields)
    app_name = str(prepared.get("软件 app_name") or "").strip()
    if app_name in {QIANCHUAN_APP_NAME, DADAO_SOCIAL_COMMENT_APP_NAME}:
        activation_time = str(prepared.get("激活时间") or "").strip()
        if activation_time:
            prepared["激活时间"] = _feishu_datetime_millis(activation_time)
        else:
            prepared.pop("激活时间", None)
        prepared["服务器时间"] = _feishu_datetime_millis(prepared.get("服务器时间"))
        is_unused = str(prepared.get("激活结果") or "").strip() == "未使用"
        prepared["激活结果"] = "未使用" if is_unused else "已使用"
        prepared["是否分发"] = "未分发" if is_unused else "已分发"
        if app_name == DADAO_SOCIAL_COMMENT_APP_NAME:
            prepared["权益"] = str(prepared.get("权益") or license_benefit_text(
                prepared.get("积分") or 0,
                prepared.get("是否无限"),
                0,
                prepared.get("授权类型") or "",
            ))
            prepared.pop("积分", None)
    elif app_name == QIANCHUAN_LAPIAN_APP_NAME:
        prepared["激活时间"] = _feishu_datetime_millis(prepared.get("激活时间"))
        prepared["服务器时间"] = _feishu_datetime_millis(prepared.get("服务器时间"))
        prepared["激活结果"] = "已使用"
    else:
        prepared["是否使用"] = "是"
    return prepared


def enqueue_feishu_activation(event):
    now = utc_now()
    payload = json.dumps(
        {
            "lookup": {
                "app_name": str(event.get("app_name") or ""),
                "code_id": str(event.get("code_id") or ""),
            },
            "fields": _feishu_fields(event),
        },
        ensure_ascii=False,
    )
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        cursor = conn.execute(
            """
            INSERT INTO feishu_outbox
                (event_type, payload_json, status, attempts, next_retry_at, created_at)
            VALUES ('activation', ?, 'pending', 0, ?, ?)
            """,
            (payload, now, now),
        )
        conn.commit()
        outbox_id = int(cursor.lastrowid)
    FEISHU_WORKER_EVENT.set()
    return outbox_id


def enqueue_feishu_inventory(app_name, code_ids=None):
    clean_app = normalize_app_name(app_name, allow_legacy_default=False)
    wanted_ids = {
        str(code_id or "").strip().upper()
        for code_id in (code_ids or [])
        if str(code_id or "").strip()
    }
    now = utc_now()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT r.code_id, r.code_hash, r.code_plaintext, r.license_type,
                   r.credits, r.unlimited, r.duration_days,
                   a.bound_machine_code, a.activated_at
            FROM redeem_codes AS r
            LEFT JOIN activations AS a
              ON a.app_name = r.app_name AND a.code_id = r.code_id
            WHERE r.app_name = ?
            ORDER BY r.created_at, r.code_id
            """,
            (clean_app,),
        ).fetchall()
        payloads = []
        skipped_without_plaintext = 0
        for row in rows:
            code_id = str(row[0] or "").strip().upper()
            if wanted_ids and code_id not in wanted_ids:
                continue
            plaintext = str(row[2] or "").strip()
            if not plaintext:
                skipped_without_plaintext += 1
                continue
            activated_at = str(row[8] or "")
            fields = {
                "激活时间": activated_at,
                "软件 app_name": clean_app,
                "激活码": plaintext,
                "激活码 code_id": code_id,
                "激活码 hash": str(row[1] or ""),
                "授权类型": str(row[3] or ""),
                "积分": int(row[4] or 0),
                "是否无限": bool(row[5]),
                "绑定机器码": str(row[7] or ""),
                "用户 IP": "",
                "客户端版本": "",
                "激活结果": "已使用" if activated_at else "未使用",
                "错误信息": "",
                "服务器时间": now,
            }
            if clean_app == DADAO_SOCIAL_COMMENT_APP_NAME:
                fields["权益"] = license_benefit_text(row[4], row[5], row[6], row[3])
            payloads.append(
                (
                    "inventory",
                    json.dumps(
                        {
                            "lookup": {
                                "app_name": clean_app,
                                "code_id": code_id,
                            },
                            "fields": fields,
                        },
                        ensure_ascii=False,
                    ),
                    "pending",
                    0,
                    now,
                    now,
                )
            )
        if payloads:
            conn.executemany(
                """
                INSERT INTO feishu_outbox
                    (event_type, payload_json, status, attempts, next_retry_at, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                payloads,
            )
            conn.commit()
    if payloads:
        FEISHU_WORKER_EVENT.set()
    return {
        "queued": len(payloads),
        "skipped_without_plaintext": skipped_without_plaintext,
    }


def _request_json(url, payload, headers=None, timeout=12, method="POST"):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json; charset=utf-8", **(headers or {})},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as exc:
        detail = exc.read(1024).decode("utf-8", errors="replace")
        raise RuntimeError(f"Feishu HTTP {exc.code}: {detail}") from exc
    except (URLError, TimeoutError) as exc:
        raise RuntimeError(f"Feishu network error: {exc}") from exc
    if int(data.get("code") or 0) != 0:
        raise RuntimeError(f"Feishu API error {data.get('code')}: {data.get('msg') or 'unknown'}")
    return data


def _tenant_access_token():
    with FEISHU_TOKEN_LOCK:
        now = time.time()
        if FEISHU_TOKEN_CACHE["value"] and FEISHU_TOKEN_CACHE["expires_at"] > now + 60:
            return FEISHU_TOKEN_CACHE["value"]
        data = _request_json(
            f"{FEISHU_API_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal",
            {"app_id": FEISHU_APP_ID, "app_secret": FEISHU_APP_SECRET},
        )
        token = str(data.get("tenant_access_token") or "")
        if not token:
            raise RuntimeError("Feishu token response is missing tenant_access_token")
        FEISHU_TOKEN_CACHE["value"] = token
        FEISHU_TOKEN_CACHE["expires_at"] = now + int(data.get("expire") or 7200)
        return token


def _feishu_records_url(table_id, suffix=""):
    return (
        f"{FEISHU_API_ORIGIN}/open-apis/bitable/v1/apps/"
        f"{quote(FEISHU_BASE_APP_TOKEN, safe='')}/tables/"
        f"{quote(table_id, safe='')}/records{suffix}"
    )


def _create_feishu_record(payload):
    token = _tenant_access_token()
    fields = _prepare_feishu_activation_fields(dict(payload.get("fields") or {}))
    table_id = _feishu_activation_table_id(fields)
    data = _request_json(
        _feishu_records_url(table_id),
        {"fields": fields},
        {"Authorization": f"Bearer {token}"},
    )
    return str(((data.get("data") or {}).get("record") or {}).get("record_id") or "")


def _find_feishu_inventory_records(app_name, code_id, table_id):
    token = _tenant_access_token()
    payload = {
        "filter": {
            "conjunction": "and",
            "conditions": [
                {
                    "field_name": "软件 app_name",
                    "operator": "is",
                    "value": [str(app_name or "")],
                },
                {
                    "field_name": "激活码 code_id",
                    "operator": "is",
                    "value": [str(code_id or "")],
                },
            ],
        }
    }
    data = _request_json(
        _feishu_records_url(table_id, "/search?page_size=20"),
        payload,
        {"Authorization": f"Bearer {token}"},
    )
    return [
        str(item.get("record_id") or "")
        for item in ((data.get("data") or {}).get("items") or [])
        if item.get("record_id")
    ]


def _update_feishu_record(record_id, fields, table_id):
    token = _tenant_access_token()
    data = _request_json(
        _feishu_records_url(table_id, f"/{quote(record_id, safe='')}"),
        {"fields": fields},
        {"Authorization": f"Bearer {token}"},
        method="PUT",
    )
    return str(((data.get("data") or {}).get("record") or {}).get("record_id") or record_id)


def _sync_feishu_inventory(payload):
    fields = _prepare_feishu_activation_fields(dict(payload.get("fields") or {}))
    lookup = dict(payload.get("lookup") or {})
    app_name = str(lookup.get("app_name") or fields.get("软件 app_name") or "")
    code_id = str(lookup.get("code_id") or fields.get("激活码 code_id") or "")
    table_id = _feishu_activation_table_id(fields)
    if not app_name or not code_id:
        return _create_feishu_record({"fields": fields})

    record_ids = _find_feishu_inventory_records(app_name, code_id, table_id)
    if not record_ids:
        return _create_feishu_record({"fields": fields})
    update_fields = dict(fields)
    if (
        app_name in {QIANCHUAN_APP_NAME, DADAO_SOCIAL_COMMENT_APP_NAME}
        and str(update_fields.get("激活结果") or "") == "未使用"
    ):
        update_fields.pop("是否分发", None)
    for record_id in record_ids:
        _update_feishu_record(record_id, update_fields, table_id)
    return record_ids[0]


def process_feishu_outbox_once():
    if not feishu_configured():
        return False
    now = utc_now()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            """
            SELECT id, payload_json, attempts
            FROM feishu_outbox
            WHERE status IN ('pending', 'retry') AND next_retry_at <= ?
            ORDER BY id
            LIMIT 1
            """,
            (now,),
        ).fetchone()
    if not row:
        return False

    outbox_id, payload_text, attempts = row
    try:
        record_id = _sync_feishu_inventory(json.loads(payload_text))
        with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                UPDATE feishu_outbox
                SET status = 'sent', attempts = attempts + 1, last_error = '',
                    feishu_record_id = ?, sent_at = ?
                WHERE id = ?
                """,
                (record_id, utc_now(), outbox_id),
            )
            conn.commit()
    except Exception as exc:
        next_attempt = int(attempts or 0) + 1
        delay = min(FEISHU_RETRY_SECONDS * (2 ** min(next_attempt - 1, 8)), 3600)
        error_text = str(exc)[:1000]
        with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                """
                UPDATE feishu_outbox
                SET status = 'retry', attempts = ?, next_retry_at = ?, last_error = ?
                WHERE id = ?
                """,
                (next_attempt, _utc_after(delay), error_text, outbox_id),
            )
            conn.commit()
        sys.stderr.write(f"[{utc_now()}] Feishu outbox {outbox_id} failed: {error_text}\n")
    return True


def _feishu_worker_loop():
    while True:
        processed = process_feishu_outbox_once()
        if processed:
            continue
        FEISHU_WORKER_EVENT.wait(timeout=10)
        FEISHU_WORKER_EVENT.clear()


def start_feishu_worker():
    global FEISHU_WORKER
    if not feishu_configured() or (FEISHU_WORKER and FEISHU_WORKER.is_alive()):
        return False
    FEISHU_WORKER = threading.Thread(
        target=_feishu_worker_loop,
        name="feishu-license-sync",
        daemon=True,
    )
    FEISHU_WORKER.start()
    return True


def _credential_hash(value):
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


def _point_balance(conn, app_name, code_id, machine_code):
    row = conn.execute(
        """
        SELECT balance, unlimited
        FROM point_accounts
        WHERE app_name = ? AND code_id = ? AND machine_code = ?
        """,
        (app_name, code_id, machine_code),
    ).fetchone()
    return (int(row[0] or 0), bool(row[1])) if row else (None, False)


def _point_account_state(conn, app_name, code_id, machine_code):
    row = conn.execute(
        """
        SELECT balance, unlimited, balance_mode, balance_source, migration_status, billing_api
        FROM point_accounts
        WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = UPPER(?)
        """,
        (app_name, code_id, machine_code),
    ).fetchone()
    if not row:
        return None
    state = {
        "balance": int(row[0] or 0),
        "unlimited": bool(row[1]),
        "balance_mode": str(row[2] or "pending_migration"),
        "balance_source": str(row[3] or "unverified_legacy"),
        "migration_status": str(row[4] or "pending"),
        "billing_api": str(row[5] or "legacy_points"),
    }
    if state["unlimited"]:
        state.update({
            "balance": 0,
            "balance_mode": "server_managed",
            "balance_source": "unlimited_entitlement",
            "migration_status": "completed",
            "billing_api": "credits_consume",
        })
    return state


def _external_proxy_balance(app_name, code_id, machine_code):
    path = LAPIAN_PROXY_DB_PATH if app_name == QIANCHUAN_LAPIAN_APP_NAME else BUSINESS_PROXY_DB_PATH
    if not path.exists():
        return None
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=10)
        if app_name == QIANCHUAN_LAPIAN_APP_NAME:
            row = conn.execute(
                "SELECT balance FROM accounts WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?",
                (app_name, code_id, machine_code),
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT balance FROM wallets WHERE app_name = ? AND UPPER(machine_id) = ?",
                (app_name, machine_code),
            ).fetchone()
        conn.close()
        return int(row[0]) if row else None
    except sqlite3.Error:
        return None


def _ensure_point_account_for_binding(conn, activation_row, now, use_external_balance=True):
    app_name = str(activation_row["app_name"])
    code_id = str(activation_row["code_id"])
    machine_code = str(activation_row["bound_machine_code"] or "").strip().upper()
    if not machine_code:
        return
    try:
        payload = json.loads(str(activation_row["payload_json"] or "{}"))
    except json.JSONDecodeError:
        payload = {}
    unlimited = bool(payload.get("unlimited"))
    credits = int(payload.get("credits") or payload.get("grant_score") or 0)
    license_type = str(payload.get("license_type") or "").strip().lower()
    duration_days = int(payload.get("duration_days") or 0)
    if app_name in TIME_BASED_APPS or duration_days > 0 or license_type.startswith("time_"):
        return
    external_balance = (
        _external_proxy_balance(app_name, code_id, machine_code)
        if use_external_balance else None
    )
    account = conn.execute(
        """
        SELECT balance, unlimited, balance_mode
        FROM point_accounts
        WHERE app_name = ? AND code_id = ? AND machine_code = ?
        """,
        (app_name, code_id, machine_code),
    ).fetchone()
    if account is not None:
        if unlimited:
            conn.execute(
                """
                UPDATE point_accounts
                SET balance = 0, unlimited = 1,
                    balance_mode = 'server_managed',
                    balance_source = 'unlimited_entitlement',
                    migration_status = 'completed',
                    billing_api = 'credits_consume', updated_at = ?
                WHERE app_name = ? AND code_id = ? AND machine_code = ?
                """,
                (now, app_name, code_id, machine_code),
            )
            return
        # Once the authorization database owns the balance, a delayed or stale
        # business proxy snapshot must never overwrite it during verification,
        # credential rotation, restart checks, or device rebinds.
        if (
            external_balance is not None
            and not unlimited
            and str(account[2] or "") != "server_managed"
        ):
            conn.execute(
                """
                UPDATE point_accounts SET balance = ?, updated_at = ?
                WHERE app_name = ? AND code_id = ? AND machine_code = ?
                """,
                (max(0, external_balance), now, app_name, code_id, machine_code),
            )
        return
    conn.execute(
        """
        INSERT INTO point_accounts
            (app_name, code_id, machine_code, code_hash, balance, unlimited,
             balance_mode, balance_source, migration_status, billing_api,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            app_name,
            code_id,
            machine_code,
            str(activation_row["code_hash"] or ""),
            0 if unlimited else max(0, external_balance if external_balance is not None else credits),
            1 if unlimited else 0,
            "server_managed" if unlimited else "pending_migration",
            "unlimited_entitlement" if unlimited else "unverified_legacy",
            "completed" if unlimited else "pending",
            "credits_consume" if unlimited else "legacy_points",
            now,
            now,
        ),
    )


def _release_pending_reservations(conn, app_name, code_id, machine_code, now):
    rows = conn.execute(
        """
        SELECT reservation_id, points
        FROM point_reservations
        WHERE app_name = ? AND code_id = ? AND machine_code = ? AND status = 'reserved'
        """,
        (app_name, code_id, machine_code),
    ).fetchall()
    if not rows:
        return 0
    balance, unlimited = _point_balance(conn, app_name, code_id, machine_code)
    released = sum(int(row[1] or 0) for row in rows)
    if balance is not None and not unlimited:
        conn.execute(
            """
            UPDATE point_accounts SET balance = balance + ?, updated_at = ?
            WHERE app_name = ? AND code_id = ? AND machine_code = ?
            """,
            (released, now, app_name, code_id, machine_code),
        )
    conn.execute(
        """
        UPDATE point_reservations SET status = 'released', updated_at = ?
        WHERE app_name = ? AND code_id = ? AND machine_code = ? AND status = 'reserved'
        """,
        (now, app_name, code_id, machine_code),
    )
    return released


def _migrate_point_balance(conn, app_name, code_id, old_machine, new_machine, now):
    if not old_machine or old_machine == new_machine:
        return
    _release_pending_reservations(conn, app_name, code_id, old_machine, now)
    source = conn.execute(
        """
        SELECT code_hash, balance, unlimited, created_at,
               balance_mode, balance_source, migration_status, billing_api
        FROM point_accounts
        WHERE app_name = ? AND code_id = ? AND machine_code = ?
        """,
        (app_name, code_id, old_machine),
    ).fetchone()
    if not source:
        return
    destination = conn.execute(
        """
        SELECT balance FROM point_accounts
        WHERE app_name = ? AND code_id = ? AND machine_code = ?
        """,
        (app_name, code_id, new_machine),
    ).fetchone()
    if destination:
        conn.execute(
            """
            UPDATE point_accounts
            SET balance = balance + ?, unlimited = ?, balance_mode = ?,
                balance_source = ?, migration_status = ?, billing_api = ?, updated_at = ?
            WHERE app_name = ? AND code_id = ? AND machine_code = ?
            """,
            (
                int(source[1] or 0), int(source[2] or 0), str(source[4] or "pending_migration"),
                str(source[5] or "unverified_legacy"), str(source[6] or "pending"),
                str(source[7] or "legacy_points"), now, app_name, code_id, new_machine,
            ),
        )
    else:
        conn.execute(
            """
            INSERT INTO point_accounts
                (app_name, code_id, machine_code, code_hash, balance, unlimited,
                 balance_mode, balance_source, migration_status, billing_api,
                 created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                app_name, code_id, new_machine, str(source[0]), int(source[1] or 0),
                int(source[2] or 0), str(source[4] or "pending_migration"),
                str(source[5] or "unverified_legacy"), str(source[6] or "pending"),
                str(source[7] or "legacy_points"), str(source[3]), now,
            ),
        )
    conn.execute(
        """
        UPDATE point_accounts SET balance = 0, updated_at = ?
        WHERE app_name = ? AND code_id = ? AND machine_code = ?
        """,
        (now, app_name, code_id, old_machine),
    )


def _merge_point_balance(
    conn, app_name, source_row, source_payload, target_row, target_machine, now
):
    """Move a source code's remaining points into the target primary account once."""
    target_code_id = str(target_row["code_id"])
    _ensure_point_account_for_binding(conn, target_row, now)
    target_balance, target_unlimited = _point_balance(
        conn, app_name, target_code_id, target_machine
    )
    if target_unlimited:
        return 0, 999999999

    source_balance = int(source_payload.get("credits") or source_payload.get("grant_score") or 0)
    source_unlimited = bool(source_payload.get("unlimited"))
    if source_unlimited:
        raise ValueError("无限积分码不能合并到普通积分账户。")

    if source_row:
        old_machine = str(
            source_row["previous_machine_code"]
            or source_row["bound_machine_code"]
            or ""
        ).strip().upper()
        if old_machine:
            _release_pending_reservations(
                conn, app_name, str(source_row["code_id"]), old_machine, now
            )
            stored_balance, stored_unlimited = _point_balance(
                conn, app_name, str(source_row["code_id"]), old_machine
            )
            if stored_unlimited:
                raise ValueError("无限积分码不能合并到普通积分账户。")
            if stored_balance is not None:
                source_balance = max(0, int(stored_balance))
                conn.execute(
                    """
                    UPDATE point_accounts SET balance = 0, updated_at = ?
                    WHERE app_name = ? AND code_id = ? AND machine_code = ?
                    """,
                    (now, app_name, str(source_row["code_id"]), old_machine),
                )

    target_balance = max(0, int(target_balance or 0))
    merged_balance = target_balance + max(0, source_balance)
    conn.execute(
        """
        UPDATE point_accounts SET balance = ?, updated_at = ?
        WHERE app_name = ? AND code_id = ? AND machine_code = ?
        """,
        (merged_balance, now, app_name, target_code_id, target_machine),
    )
    return max(0, source_balance), merged_balance


def _move_merged_children(
    conn, app_name, old_primary_code_id, new_primary_code_id,
    old_machine, new_machine, now
):
    """Keep every historical top-up code attached to its device wallet owner."""
    if not old_machine:
        return 0
    rows = conn.execute(
        """
        SELECT code_id FROM activations
        WHERE app_name = ? AND binding_status = 'active' AND binding_role = 'merged'
          AND merged_into_code_id = ? AND UPPER(bound_machine_code) = ?
        """,
        (app_name, old_primary_code_id, old_machine),
    ).fetchall()
    if not rows:
        return 0
    code_ids = [str(row[0]) for row in rows]
    placeholders = ",".join("?" for _ in code_ids)
    conn.execute(
        f"""
        UPDATE activations
        SET bound_machine_code = ?, previous_machine_code = ?,
            merged_into_code_id = ?, merged_at = ?, last_seen_at = ?,
            credential_version = credential_version + 1,
            device_credential_hash = ''
        WHERE app_name = ? AND code_id IN ({placeholders})
        """,
        (
            new_machine, old_machine, new_primary_code_id, now, now,
            app_name, *code_ids,
        ),
    )
    conn.execute(
        f"""
        UPDATE point_accounts SET balance = 0, updated_at = ?
        WHERE app_name = ? AND machine_code = ? AND code_id IN ({placeholders})
        """,
        (now, app_name, old_machine, *code_ids),
    )
    return len(code_ids)


def _transfer_window_count(conn, app_name, code_id):
    cutoff = (datetime.utcnow() - timedelta(days=DEVICE_SELF_TRANSFER_WINDOW_DAYS)).isoformat(timespec="seconds") + "Z"
    return int(conn.execute(
        """
        SELECT COUNT(*) FROM device_transfer_log
        WHERE app_name = ? AND code_id = ? AND event_type = 'self_unbind' AND created_at >= ?
        """,
        (app_name, code_id, cutoff),
    ).fetchone()[0])


def _device_auth(headers, *, allow_expired=False):
    authorization = str(headers.get("Authorization") or "")
    if not authorization.startswith("Bearer "):
        raise DeviceApiError("缺少设备会话。", 401)
    identity = _verify_device_session(authorization[7:].strip())
    credential = str(
        headers.get("X-Device-Credential")
        or headers.get("x-device-credential")
        or ""
    ).strip()
    if not credential:
        raise DeviceApiError("缺少 device_credential。", 401)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """
            SELECT * FROM activations WHERE app_name = ? AND code_id = ?
            """,
            (str(identity.get("app_name") or ""), str(identity.get("code_id") or "")),
        ).fetchone()
        code_row = conn.execute(
            """
            SELECT disabled FROM redeem_codes WHERE app_name = ? AND code_id = ?
            """,
            (str(identity.get("app_name") or ""), str(identity.get("code_id") or "")),
        ).fetchone()
    if not row or str(row["binding_status"] or "") != "active":
        raise DeviceApiError("授权当前未绑定设备。", 401)
    if code_row and int(code_row[0] or 0):
        raise DeviceApiError("这个兑换码已被停用。", 401)
    if str(row["binding_role"] or "primary") != "primary":
        raise DeviceApiError("合并码不能作为设备主授权。", 401)
    if str(row["bound_machine_code"] or "").strip().upper() != str(identity.get("machine_code") or "").strip().upper():
        raise DeviceApiError("设备绑定已变更。", 401)
    if int(row["credential_version"] or 0) != int(identity.get("credential_version") or -1):
        raise DeviceApiError("设备凭证已撤销。", 401)
    expected_hash = str(row["device_credential_hash"] or "")
    if not expected_hash or not hmac.compare_digest(expected_hash, _credential_hash(credential)):
        raise DeviceApiError("设备凭证无效。", 401)
    try:
        payload = json.loads(str(row["payload_json"] or "{}"))
    except json.JSONDecodeError:
        payload = {}
    if not allow_expired and _server_is_expired(str(payload.get("expires_at") or "")):
        raise DeviceApiError("授权已过期。", 401)
    return dict(row)


def _unbind_activation(app_name, code_id, actor_type, actor, reason, user_ip=""):
    now = utc_now()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (app_name, code_id),
        ).fetchone()
        if not row:
            raise DeviceApiError("没有找到激活记录。", 404)
        if str(row["binding_role"] or "primary") != "primary":
            raise DeviceApiError("合并码不能解绑或迁移。", 409)
        if str(row["binding_status"] or "active") == "unbound":
            conn.rollback()
            return {
                "ok": True,
                "success": True,
                "action": "unbound",
                "app_name": app_name,
                "code_id": code_id,
                "binding_status": "unbound",
                "already_unbound": True,
            }
        old_machine = str(row["bound_machine_code"] or "").strip().upper()
        if actor_type == "self":
            transfer_count = int(row["transfer_count"] or 0)
            last_bound_at = str(row["last_bound_at"] or "")
            if transfer_count > 0 and last_bound_at:
                try:
                    last_bound = datetime.fromisoformat(last_bound_at.replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) - last_bound < timedelta(hours=DEVICE_UNBIND_COOLDOWN_HOURS):
                        raise DeviceApiError("成功换机后 24 小时内不能再次解绑。", 429)
                except ValueError:
                    pass
            if _transfer_window_count(conn, app_name, code_id) >= DEVICE_SELF_TRANSFER_LIMIT:
                raise DeviceApiError("该激活码 30 天内已自助换机 3 次，请联系管理员。", 429)
        try:
            payload = json.loads(str(row["payload_json"] or "{}"))
        except json.JSONDecodeError:
            payload = {}
        is_time_based = _time_entitlement(payload, app_name)
        if is_time_based:
            released = 0
            balance, unlimited = None, False
        else:
            _ensure_point_account_for_binding(conn, row, now)
            released = _release_pending_reservations(conn, app_name, code_id, old_machine, now)
            balance, unlimited = _point_balance(conn, app_name, code_id, old_machine)
        conn.execute(
            """
            UPDATE activations
            SET bound_machine_code = '', binding_status = 'unbound',
                device_credential_hash = '', credential_version = credential_version + 1,
                previous_machine_code = ?, last_unbound_at = ?, last_seen_at = ?
            WHERE app_name = ? AND code_id = ?
            """,
            (old_machine, now, now, app_name, code_id),
        )
        conn.execute(
            """
            INSERT INTO device_transfer_log
                (app_name, code_id, event_type, old_machine_code, new_machine_code,
                 actor_type, actor, reason, user_ip, created_at)
            VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)
            """,
            (
                app_name,
                code_id,
                "self_unbind" if actor_type == "self" else "admin_unbind",
                old_machine,
                actor_type,
                actor,
                reason,
                user_ip,
                now,
            ),
        )
        conn.commit()
    result = {
        "ok": True,
        "success": True,
        "action": "unbound",
        "app_name": app_name,
        "code_id": code_id,
        "binding_status": "unbound",
        "released_reservations": released,
    }
    if is_time_based:
        result.update(_time_status(payload, row["activated_at"]))
        result["entitlement_type"] = "time"
    else:
        actual_balance = 999999999 if unlimited else int(balance or 0)
        result.update({
            "remaining_credits": actual_balance,
            "remaining_balance": actual_balance,
            "balance": actual_balance,
        })
    return result


def handle_device_status(headers):
    row = _device_auth(headers)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        used = _transfer_window_count(conn, row["app_name"], row["code_id"])
        try:
            payload = json.loads(str(row["payload_json"] or "{}"))
        except json.JSONDecodeError:
            payload = {}
        is_time_based = _time_entitlement(payload, row["app_name"])
        account_state = None if is_time_based else _point_account_state(
            conn, row["app_name"], row["code_id"], str(row["bound_machine_code"] or "").upper()
        )
        balance = account_state["balance"] if account_state else None
        unlimited = account_state["unlimited"] if account_state else False
        code_row = conn.execute(
            """
            SELECT code_plaintext FROM redeem_codes
            WHERE app_name = ? AND code_id = ?
            """,
            (row["app_name"], row["code_id"]),
        ).fetchone()
        primary_activation_code = str(code_row[0] or "").strip() if code_row else ""
    result = {
        "ok": True,
        "app_name": row["app_name"],
        "code_id": row["code_id"],
        "primary_code_id": row["code_id"],
        "primary_activation_code": primary_activation_code,
        "binding_status": row["binding_status"],
        "machine_code": row["bound_machine_code"],
        "transfer_count": int(row["transfer_count"] or 0),
        "self_transfers_used_30d": used,
        "self_transfers_remaining_30d": max(0, DEVICE_SELF_TRANSFER_LIMIT - used),
    }
    if is_time_based:
        result.update(_time_status(payload, row["activated_at"]))
        result["entitlement_type"] = "time"
    else:
        result["balance_mode"] = account_state["balance_mode"] if account_state else "legacy_local"
        result["migration_status"] = account_state["migration_status"] if account_state else "not_started"
        result["balance_authoritative"] = bool(
            account_state and account_state["balance_mode"] == "server_managed"
        )
        # Keep the numeric field for older v2 clients, but explicitly mark
        # unverified legacy balances as non-authoritative.
        result["remaining_credits"] = 999999999 if unlimited else int(balance or 0)
        result["unlimited"] = bool(unlimited)
        result["entitlement_type"] = "unlimited" if unlimited else "credits"
    return result



def handle_device_refresh(data, headers):
    """Issue a fresh device session without reactivation or entitlement changes."""
    app_name = normalize_app_name(
        str(data.get("app_name") or "").strip(), allow_legacy_default=False
    )
    code_id = str(data.get("code_id") or "").strip().upper()
    machine_code = str(data.get("machine_code") or data.get("machine_id") or "").strip().upper()
    credential = str(
        headers.get("X-Device-Credential")
        or headers.get("x-device-credential")
        or ""
    ).strip()
    if not code_id or len(code_id) > 160:
        raise DeviceApiError("缺少有效的授权编号。", 401)
    if not machine_code:
        raise DeviceApiError("缺少机器码。", 401)
    if not credential:
        raise DeviceApiError("缺少 device_credential。", 401)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (app_name, code_id),
        ).fetchone()
        code_row = conn.execute(
            "SELECT disabled FROM redeem_codes WHERE app_name = ? AND code_id = ?",
            (app_name, code_id),
        ).fetchone()
        if not row or str(row["binding_status"] or "") != "active":
            raise DeviceApiError("授权当前未绑定设备。", 401)
        if code_row and int(code_row[0] or 0):
            raise DeviceApiError("这个兑换码已被停用。", 401)
        if str(row["binding_role"] or "primary") != "primary":
            raise DeviceApiError("合并码不能作为设备主授权。", 401)
        if str(row["bound_machine_code"] or "").strip().upper() != machine_code:
            raise DeviceApiError("设备绑定已变更。", 401)
        expected_hash = str(row["device_credential_hash"] or "")
        if not expected_hash or not hmac.compare_digest(expected_hash, _credential_hash(credential)):
            raise DeviceApiError("设备凭证无效。", 401)
        try:
            payload = json.loads(str(row["payload_json"] or "{}"))
        except json.JSONDecodeError:
            payload = {}
        if _server_is_expired(str(payload.get("expires_at") or "")):
            raise DeviceApiError("授权已过期。", 401)
        is_time_based = _time_entitlement(payload, app_name)
        account_state = None if is_time_based else _point_account_state(
            conn, app_name, code_id, machine_code
        )
        conn.execute(
            "UPDATE activations SET last_seen_at = ? WHERE app_name = ? AND code_id = ?",
            (utc_now(), app_name, code_id),
        )
        conn.commit()
    result = {
        "ok": True,
        "app_name": app_name,
        "code_id": code_id,
        "machine_code": machine_code,
        "binding_status": "active",
        "license_type": str(payload.get("license_type") or ("unlimited" if bool(payload.get("unlimited")) else "standard")),
        "expires_at": str(payload.get("expires_at") or ""),
        "device_session": _issue_device_session(
            app_name, code_id, machine_code, int(row["credential_version"] or 1)
        ),
    }
    if is_time_based:
        result.update(_time_status(payload, row["activated_at"]))
        result["entitlement_type"] = "time"
        result["unlimited"] = False
    else:
        balance = account_state["balance"] if account_state else 0
        unlimited = account_state["unlimited"] if account_state else False
        result["remaining_credits"] = 999999999 if unlimited else int(balance or 0)
        result["unlimited"] = bool(unlimited)
        result["entitlement_type"] = "unlimited" if unlimited else "credits"
    return result

def handle_device_unbind(headers, user_ip=""):
    row = _device_auth(headers)
    if str(row["app_name"] or "") == LIVE_PHOTO_STUDIO_APP_NAME:
        raise DeviceApiError("实况小匠不支持自助解绑，请联系管理员处理。", 403)
    return _unbind_activation(
        row["app_name"], row["code_id"], "self", str(row["bound_machine_code"] or ""), "用户自助解绑", user_ip
    )


def handle_admin_unbind(data, headers, user_ip=""):
    if not LICENSE_ADMIN_API_TOKEN:
        raise DeviceApiError("服务器尚未配置管理员接口令牌。", 503)
    received = str(headers.get("X-Admin-Token") or headers.get("x-admin-token") or "").strip()
    if not received or not hmac.compare_digest(received, LICENSE_ADMIN_API_TOKEN):
        raise DeviceApiError("管理员接口认证失败。", 403)
    app_name = normalize_app_name(str(data.get("app_name") or ""), allow_legacy_default=False)
    code_id = str(data.get("code_id") or "").strip().upper()
    reason = str(data.get("reason") or "").strip()
    operator = str(data.get("operator") or "").strip()
    if not code_id:
        raise DeviceApiError("缺少 code_id。")
    if not reason:
        raise DeviceApiError("管理员强制解绑必须填写原因。")
    if not operator:
        raise DeviceApiError("管理员强制解绑必须记录操作人。")
    return _unbind_activation(app_name, code_id, "admin", operator, reason, user_ip)


ADMIN_BATCH_ACTIONS = {"unbind", "disable", "unbind_disable"}
ADMIN_BATCH_MAX_ITEMS = 200


def _batch_request_hash(action, items, operator, reason):
    canonical = json.dumps(
        {
            "action": action,
            "items": items,
            "operator": operator,
            "reason": reason,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _existing_admin_batch_result(row):
    try:
        result = json.loads(str(row["result_json"] or "{}"))
    except (json.JSONDecodeError, TypeError):
        result = {}
    if not isinstance(result, dict):
        result = {}
    result.update({
        "ok": True,
        "success": True,
        "batch_id": str(row["batch_id"]),
        "request_id": str(row["request_id"]),
        "action": str(row["action"]),
        "idempotent": True,
    })
    return result


def handle_admin_batch_action(data, headers, user_ip=""):
    _admin_api_auth(headers)
    action = str(data.get("action") or "").strip().lower()
    if action not in ADMIN_BATCH_ACTIONS:
        raise DeviceApiError("批量操作类型无效。")
    if data.get("confirm_action") is not True:
        raise DeviceApiError("批量操作必须明确二次确认。")
    request_id = str(data.get("request_id") or "").strip()
    operator = str(data.get("operator") or "").strip()
    reason = str(data.get("reason") or "").strip()
    if not request_id or len(request_id) > 160:
        raise DeviceApiError("批量操作缺少有效 request_id。")
    if not operator or len(operator) > 120:
        raise DeviceApiError("批量操作必须填写操作人。")
    if not reason or len(reason) > 500:
        raise DeviceApiError("批量操作必须填写具体原因。")

    raw_items = data.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise DeviceApiError("请至少选择一条授权记录。")
    if len(raw_items) > ADMIN_BATCH_MAX_ITEMS:
        raise DeviceApiError(f"一次最多处理 {ADMIN_BATCH_MAX_ITEMS} 条授权记录。")

    items = []
    seen = set()
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            raise DeviceApiError("批量授权记录格式无效。")
        try:
            app_name = normalize_app_name(
                str(raw_item.get("app_name") or ""), allow_legacy_default=False
            )
        except ValueError as exc:
            raise DeviceApiError(str(exc)) from exc
        code_id = str(raw_item.get("code_id") or "").strip().upper()
        if not code_id or len(code_id) > 160:
            raise DeviceApiError("批量授权记录缺少有效 code_id。")
        key = (app_name, code_id)
        if key in seen:
            raise DeviceApiError("批量授权记录存在重复项。")
        seen.add(key)
        items.append({"app_name": app_name, "code_id": code_id})

    request_hash = _batch_request_hash(action, items, operator, reason)
    now = utc_now()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT * FROM admin_batch_actions WHERE request_id = ?", (request_id,)
        ).fetchone()
        if existing:
            if str(existing["request_hash"] or "") != request_hash:
                raise DeviceApiError("request_id 已被其他批量操作使用。", 409)
            conn.rollback()
            return _existing_admin_batch_result(existing)

        prepared = []
        for item in items:
            activation = conn.execute(
                "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
                (item["app_name"], item["code_id"]),
            ).fetchone()
            code_row = conn.execute(
                "SELECT disabled FROM redeem_codes WHERE app_name = ? AND code_id = ?",
                (item["app_name"], item["code_id"]),
            ).fetchone()
            if action == "unbind":
                if not activation:
                    raise DeviceApiError(
                        f"没有找到授权记录：{item['app_name']} / {item['code_id']}。", 404
                    )
                if str(activation["binding_role"] or "primary") != "primary":
                    raise DeviceApiError(
                        f"只有主授权可以批量解绑：{item['code_id']}。", 409
                    )
                binding_status = str(activation["binding_status"] or "active")
                if binding_status not in {"active", "unbound"}:
                    raise DeviceApiError(
                        f"当前绑定状态不能解绑：{item['code_id']} / {binding_status}。", 409
                    )
            elif not code_row:
                raise DeviceApiError(
                    f"授权码不在服务器库存中，无法安全禁用：{item['code_id']}。", 409
                )
            prepared.append((item, activation, int(code_row[0] or 0) if code_row else 0))

        batch_id = secrets.token_urlsafe(18)
        conn.execute(
            """
            INSERT INTO admin_batch_actions
                (batch_id, request_id, request_hash, action, item_count, operator,
                 reason, status, user_ip, created_at, result_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?, '{}')
            """,
            (
                batch_id, request_id, request_hash, action, len(prepared),
                operator, reason, user_ip, now,
            ),
        )
        result_items = []
        for item, activation, disabled_before in prepared:
            app_name = item["app_name"]
            code_id = item["code_id"]
            binding_before = (
                str(activation["binding_status"] or "active")
                if activation else "unused"
            )
            binding_after = binding_before
            disabled_after = disabled_before
            old_machine = (
                str(activation["bound_machine_code"] or "").strip().upper()
                if activation else ""
            )
            released = 0
            result_status = "unchanged"

            if action == "unbind":
                if binding_before == "active":
                    try:
                        payload = json.loads(str(activation["payload_json"] or "{}"))
                    except json.JSONDecodeError:
                        payload = {}
                    if not _time_entitlement(payload, app_name):
                        _ensure_point_account_for_binding(conn, activation, now)
                        released = _release_pending_reservations(
                            conn, app_name, code_id, old_machine, now
                        )
                    conn.execute(
                        """
                        UPDATE activations
                        SET bound_machine_code = '', binding_status = 'unbound',
                            device_credential_hash = '', credential_version = credential_version + 1,
                            previous_machine_code = ?, last_unbound_at = ?, last_seen_at = ?
                        WHERE app_name = ? AND code_id = ?
                        """,
                        (old_machine, now, now, app_name, code_id),
                    )
                    binding_after = "unbound"
                    result_status = "unbound"
            else:
                if activation and binding_before == "active":
                    try:
                        payload = json.loads(str(activation["payload_json"] or "{}"))
                    except json.JSONDecodeError:
                        payload = {}
                    if not _time_entitlement(payload, app_name):
                        if str(activation["binding_role"] or "primary") == "primary":
                            _ensure_point_account_for_binding(conn, activation, now)
                        released = _release_pending_reservations(
                            conn, app_name, code_id, old_machine, now
                        )
                if activation and binding_before in {"active", "unbound"}:
                    previous_machine = old_machine or str(
                        activation["previous_machine_code"] or ""
                    ).strip().upper()
                    conn.execute(
                        """
                        UPDATE activations
                        SET bound_machine_code = '', binding_status = 'revoked',
                            device_credential_hash = '', credential_version = credential_version + 1,
                            previous_machine_code = ?, last_unbound_at = ?, last_seen_at = ?
                        WHERE app_name = ? AND code_id = ?
                        """,
                        (previous_machine, now, now, app_name, code_id),
                    )
                    binding_after = "revoked"
                conn.execute(
                    "UPDATE redeem_codes SET disabled = 1 WHERE app_name = ? AND code_id = ?",
                    (app_name, code_id),
                )
                disabled_after = 1
                result_status = "disabled" if disabled_before == 0 or binding_after != binding_before else "unchanged"

            if (
                activation
                and (binding_after != binding_before or disabled_after != disabled_before)
            ):
                event_type = {
                    "unbind": "admin_batch_unbind",
                    "disable": "admin_batch_disable",
                    "unbind_disable": "admin_batch_unbind_disable",
                }[action]
                conn.execute(
                    """
                    INSERT INTO device_transfer_log
                        (app_name, code_id, event_type, old_machine_code, new_machine_code,
                         actor_type, actor, reason, user_ip, created_at)
                    VALUES (?, ?, ?, ?, '', 'admin', ?, ?, ?, ?)
                    """,
                    (app_name, code_id, event_type, old_machine, operator, reason, user_ip, now),
                )

            conn.execute(
                """
                INSERT INTO admin_batch_action_items
                    (batch_id, app_name, code_id, action, binding_status_before,
                     binding_status_after, disabled_before, disabled_after,
                     old_machine_code, released_reservations, result_status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    batch_id, app_name, code_id, action, binding_before,
                    binding_after, disabled_before, disabled_after, old_machine,
                    released, result_status, now,
                ),
            )
            result_items.append({
                "app_name": app_name,
                "code_id": code_id,
                "binding_status_before": binding_before,
                "binding_status_after": binding_after,
                "disabled_before": bool(disabled_before),
                "disabled_after": bool(disabled_after),
                "released_reservations": released,
                "status": result_status,
            })

        result = {
            "ok": True,
            "success": True,
            "batch_id": batch_id,
            "request_id": request_id,
            "action": action,
            "item_count": len(result_items),
            "items": result_items,
            "idempotent": False,
        }
        conn.execute(
            """
            UPDATE admin_batch_actions
            SET status = 'completed', result_json = ?
            WHERE batch_id = ?
            """,
            (json.dumps(result, ensure_ascii=False, separators=(",", ":")), batch_id),
        )
        conn.commit()
        return result


REISSUE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _admin_api_auth(headers):
    if not LICENSE_ADMIN_API_TOKEN:
        raise DeviceApiError("服务器尚未配置管理员接口令牌。", 503)
    received = str(headers.get("X-Admin-Token") or headers.get("x-admin-token") or "").strip()
    if not received or not hmac.compare_digest(received, LICENSE_ADMIN_API_TOKEN):
        raise DeviceApiError("管理员接口认证失败。", 403)


def _trusted_proxy_credit_snapshot(app_name, code_id, machine_code):
    """Return a proxy balance only when the current code's grant proves it."""
    if app_name == QIANCHUAN_APP_NAME:
        path = BUSINESS_PROXY_DB_PATH
        if not path.exists():
            return {"source": "business_proxy", "available": False, "trusted": False}
        try:
            conn = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True, timeout=10)
            conn.row_factory = sqlite3.Row
            wallet = conn.execute(
                "SELECT balance FROM wallets WHERE app_name = ? AND UPPER(machine_id) = ?",
                (app_name, machine_code),
            ).fetchone()
            grant = conn.execute(
                """
                SELECT credits FROM wallet_grants
                WHERE app_name = ? AND code_id = ? AND UPPER(machine_id) = ?
                """,
                (app_name, code_id, machine_code),
            ).fetchone()
            ledger = conn.execute(
                """
                SELECT points, new_balance FROM wallet_ledger
                WHERE app_name = ? AND UPPER(machine_id) = ? AND idempotency_key = ?
                """,
                (app_name, machine_code, f"activation:{code_id}"),
            ).fetchone()
            conn.close()
        except sqlite3.Error:
            return {"source": "business_proxy", "available": False, "trusted": False}
        balance = int(wallet["balance"] or 0) if wallet else None
        trusted = bool(
            wallet
            and grant
            and ledger
            and int(grant["credits"] or 0) == int(ledger["points"] or 0)
            and int(ledger["new_balance"] or 0) == balance
        )
        return {
            "source": "business_proxy",
            "available": wallet is not None,
            "trusted": trusted,
            "balance": balance,
        }
    if app_name == QIANCHUAN_LAPIAN_APP_NAME:
        path = LAPIAN_PROXY_DB_PATH
        if not path.exists():
            return {"source": "lapian_proxy", "available": False, "trusted": False}
        try:
            conn = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True, timeout=10)
            row = conn.execute(
                """
                SELECT balance FROM accounts
                WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
                """,
                (app_name, code_id, machine_code),
            ).fetchone()
            conn.close()
        except sqlite3.Error:
            row = None
        return {
            "source": "lapian_proxy",
            "available": row is not None,
            "trusted": False,
            "balance": int(row[0] or 0) if row else None,
        }
    return {"source": "none", "available": False, "trusted": False, "balance": None}


def _apply_proxy_credit_delta(app_name, code_id, machine_code, delta, request_id, reason, now):
    """Apply an idempotent matching adjustment to an existing proxy account."""
    if not delta:
        snapshot = _trusted_proxy_credit_snapshot(app_name, code_id, machine_code)
        return {
            "source": snapshot.get("source") or "none",
            "status": "not_needed",
            "balance_before": snapshot.get("balance"),
            "balance_after": snapshot.get("balance"),
        }
    if app_name == QIANCHUAN_APP_NAME:
        if not BUSINESS_PROXY_DB_PATH.exists():
            return {"source": "business_proxy", "status": "not_configured"}
        with sqlite3.connect(BUSINESS_PROXY_DB_PATH, timeout=15) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN IMMEDIATE")
            key = f"license-admin:{request_id}"
            existing = conn.execute(
                """
                SELECT old_balance, new_balance, points FROM wallet_ledger
                WHERE app_name = ? AND UPPER(machine_id) = ? AND idempotency_key = ?
                """,
                (app_name, machine_code, key),
            ).fetchone()
            if existing:
                if int(existing["points"] or 0) != int(delta):
                    raise DeviceApiError("代理库 request_id 已用于不同的积分调整。", 409)
                conn.commit()
                return {
                    "source": "business_proxy",
                    "status": "completed",
                    "balance_before": int(existing["old_balance"] or 0),
                    "balance_after": int(existing["new_balance"] or 0),
                }
            wallet = conn.execute(
                "SELECT balance FROM wallets WHERE app_name = ? AND UPPER(machine_id) = ?",
                (app_name, machine_code),
            ).fetchone()
            if not wallet:
                conn.commit()
                return {"source": "business_proxy", "status": "not_configured"}
            before = int(wallet["balance"] or 0)
            after = before + int(delta)
            if after < 0:
                raise DeviceApiError("业务代理库余额不足，不能执行本次扣减。", 409)
            conn.execute(
                """
                UPDATE wallets SET balance = ?, updated_at = ?
                WHERE app_name = ? AND UPPER(machine_id) = ?
                """,
                (after, now, app_name, machine_code),
            )
            conn.execute(
                """
                INSERT INTO wallet_ledger
                    (app_name, machine_id, operation_type, points, old_balance,
                     new_balance, remark, idempotency_key, created_at)
                VALUES (?, ?, 'admin_adjustment', ?, ?, ?, ?, ?, ?)
                """,
                (app_name, machine_code, int(delta), before, after, reason, key, now),
            )
            conn.commit()
        return {
            "source": "business_proxy",
            "status": "completed",
            "balance_before": before,
            "balance_after": after,
        }
    if app_name == QIANCHUAN_LAPIAN_APP_NAME:
        if not LAPIAN_PROXY_DB_PATH.exists():
            return {"source": "lapian_proxy", "status": "not_configured"}
        with sqlite3.connect(LAPIAN_PROXY_DB_PATH, timeout=15) as conn:
            conn.row_factory = sqlite3.Row
            conn.execute("BEGIN IMMEDIATE")
            key = f"license-admin:{request_id}"
            existing = conn.execute(
                "SELECT cost, remaining FROM ledger WHERE job_id = ?",
                (key,),
            ).fetchone()
            if existing:
                if int(existing["cost"] or 0) != -int(delta):
                    raise DeviceApiError("拉片代理库 request_id 已用于不同的积分调整。", 409)
                conn.commit()
                return {
                    "source": "lapian_proxy",
                    "status": "completed",
                    "balance_before": None,
                    "balance_after": int(existing["remaining"] or 0),
                }
            account = conn.execute(
                """
                SELECT balance, reserved FROM accounts
                WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
                """,
                (app_name, code_id, machine_code),
            ).fetchone()
            if not account:
                conn.commit()
                return {"source": "lapian_proxy", "status": "not_configured"}
            if int(account["reserved"] or 0) > 0:
                raise DeviceApiError("当前存在进行中的拉片任务，请任务结束后再调整积分。", 409)
            before = int(account["balance"] or 0)
            after = before + int(delta)
            if after < 0:
                raise DeviceApiError("拉片代理库余额不足，不能执行本次扣减。", 409)
            conn.execute(
                """
                UPDATE accounts SET balance = ?, updated_at = ?
                WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
                """,
                (after, now, app_name, code_id, machine_code),
            )
            conn.execute(
                """
                INSERT INTO ledger
                    (app_name, code_id, job_id, operation, cost, remaining, created_at)
                VALUES (?, ?, ?, 'admin_adjustment', ?, ?, ?)
                """,
                (app_name, code_id, key, -int(delta), after, now),
            )
            conn.commit()
        return {
            "source": "lapian_proxy",
            "status": "completed",
            "balance_before": before,
            "balance_after": after,
        }
    return {"source": "none", "status": "not_configured"}


def _admin_adjustment_result(row, idempotent=False):
    return {
        "ok": True,
        "success": True,
        "action": "admin_credit_adjusted",
        "idempotent": bool(idempotent),
        "adjustment_id": str(row["adjustment_id"]),
        "request_id": str(row["request_id"]),
        "app_name": str(row["app_name"]),
        "code_id": str(row["code_id"]),
        "adjustment_mode": str(row["adjustment_mode"]),
        "amount": int(row["amount"] or 0),
        "balance_before": int(row["balance_before"] or 0),
        "balance_after": int(row["balance_after"] or 0),
        "proxy_source": str(row["proxy_source"] or "none"),
        "proxy_balance_before": row["proxy_balance_before"],
        "proxy_balance_after": row["proxy_balance_after"],
        "proxy_sync_status": str(row["proxy_sync_status"] or "pending"),
    }


def handle_admin_credit_adjust(data, headers, user_ip=""):
    _admin_api_auth(headers)
    app_name = normalize_app_name(str(data.get("app_name") or ""), allow_legacy_default=False)
    code_id = str(data.get("code_id") or "").strip().upper()
    operator = str(data.get("operator") or "").strip()[:120]
    reason = str(data.get("reason") or "").strip()[:500]
    request_id = str(data.get("request_id") or "").strip()[:200]
    mode = str(data.get("adjustment_mode") or "manual").strip().lower()
    if not bool(data.get("confirm_adjustment")):
        raise DeviceApiError("积分调整前必须二次确认。", 400)
    if not code_id:
        raise DeviceApiError("缺少 code_id。", 400)
    if not operator:
        raise DeviceApiError("积分调整必须填写操作人。", 400)
    if not reason:
        raise DeviceApiError("积分调整必须填写原因。", 400)
    if not request_id:
        raise DeviceApiError("缺少有效的 request_id。", 400)
    if mode not in {"manual", "trusted_proxy_repair"}:
        raise DeviceApiError("不支持的积分调整方式。", 400)

    now = utc_now()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT * FROM admin_credit_adjustments WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        if existing:
            if str(existing["app_name"]) != app_name or str(existing["code_id"]) != code_id:
                raise DeviceApiError("request_id 已用于其他授权。", 409)
            conn.commit()
            return _admin_adjustment_result(existing, idempotent=True)
        activation = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (app_name, code_id),
        ).fetchone()
        if not activation:
            raise DeviceApiError("未找到对应的激活记录。", 404)
        if str(activation["binding_role"] or "primary") != "primary":
            raise DeviceApiError("只有主激活码可以调整积分。", 409)
        try:
            payload = json.loads(str(activation["payload_json"] or "{}"))
        except json.JSONDecodeError:
            payload = {}
        if _time_entitlement(payload, app_name):
            raise DeviceApiError("时间授权不能调整积分。", 409)
        if bool(payload.get("unlimited")):
            raise DeviceApiError("无限授权不使用普通积分调整。", 409)
        machine_code = str(
            activation["bound_machine_code"] or activation["previous_machine_code"] or ""
        ).strip().upper()
        if not machine_code:
            raise DeviceApiError("激活记录没有可用的机器码。", 409)
        account = conn.execute(
            """
            SELECT balance, unlimited, balance_mode FROM point_accounts
            WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
            """,
            (app_name, code_id, machine_code),
        ).fetchone()
        if not account:
            raise DeviceApiError("该授权还没有服务器积分账户。", 409)
        if bool(account["unlimited"]):
            raise DeviceApiError("无限授权不使用普通积分调整。", 409)
        if str(account["balance_mode"] or "") != "server_managed":
            raise DeviceApiError("该余额尚未完成可信迁移，不能直接调整。", 409)
        before = int(account["balance"] or 0)
        proxy_snapshot = _trusted_proxy_credit_snapshot(app_name, code_id, machine_code)
        if mode == "trusted_proxy_repair":
            if not proxy_snapshot.get("available") or not proxy_snapshot.get("trusted"):
                raise DeviceApiError("未找到可验证的业务代理激活流水，不能自动修复。", 409)
            delta = int(proxy_snapshot.get("balance") or 0) - before
            if delta == 0:
                raise DeviceApiError("授权主库与可信业务余额已经一致，无需修复。", 409)
            proxy_delta = 0
        else:
            try:
                delta = int(data.get("amount"))
            except (TypeError, ValueError):
                raise DeviceApiError("积分调整数量必须是整数。", 400)
            if delta == 0:
                raise DeviceApiError("积分调整数量不能为 0。", 400)
            proxy_delta = delta
        after = before + delta
        if after < 0:
            raise DeviceApiError("调整后余额不能小于 0。", 409)
        adjustment_id = secrets.token_urlsafe(18)
        transaction_id = secrets.token_urlsafe(18)
        conn.execute(
            """
            UPDATE point_accounts SET balance = ?, updated_at = ?
            WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
            """,
            (after, now, app_name, code_id, machine_code),
        )
        conn.execute(
            """
            INSERT INTO credit_transactions
                (transaction_id, app_name, code_id, request_id, machine_code,
                 transaction_type, amount, reason, balance_before, balance_after,
                 unlimited, client_version, created_at)
            VALUES (?, ?, ?, ?, ?, 'admin_adjustment', ?, ?, ?, ?, 0, ?, ?)
            """,
            (
                transaction_id, app_name, code_id, request_id, machine_code,
                delta, reason, before, after, f"ops:{operator}", now,
            ),
        )
        conn.execute(
            """
            INSERT INTO admin_credit_adjustments
                (adjustment_id, request_id, app_name, code_id, machine_code,
                 adjustment_mode, amount, balance_before, balance_after,
                 operator, reason, proxy_source, proxy_balance_before,
                 proxy_balance_after, proxy_sync_status, user_ip, created_at, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '')
            """,
            (
                adjustment_id, request_id, app_name, code_id, machine_code,
                mode, delta, before, after, operator, reason,
                str(proxy_snapshot.get("source") or "none"), proxy_snapshot.get("balance"),
                proxy_snapshot.get("balance"), str(user_ip or ""), now,
            ),
        )
        conn.commit()

    try:
        proxy_result = _apply_proxy_credit_delta(
            app_name, code_id, machine_code, proxy_delta, request_id, reason, now
        )
        proxy_status = str(proxy_result.get("status") or "not_configured")
    except (sqlite3.Error, DeviceApiError) as exc:
        proxy_result = {
            "source": str(proxy_snapshot.get("source") or "none"),
            "status": "pending",
            "balance_before": proxy_snapshot.get("balance"),
            "balance_after": proxy_snapshot.get("balance"),
        }
        proxy_status = "pending"
        sys.stderr.write(f"[{utc_now()}] Admin credit proxy sync pending: {type(exc).__name__}\n")

    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute(
            """
            UPDATE admin_credit_adjustments
            SET proxy_source = ?, proxy_balance_before = ?, proxy_balance_after = ?,
                proxy_sync_status = ?, synced_at = ?
            WHERE adjustment_id = ?
            """,
            (
                str(proxy_result.get("source") or "none"),
                proxy_result.get("balance_before"), proxy_result.get("balance_after"),
                proxy_status, utc_now() if proxy_status != "pending" else "", adjustment_id,
            ),
        )
        conn.commit()
        completed = conn.execute(
            "SELECT * FROM admin_credit_adjustments WHERE adjustment_id = ?",
            (adjustment_id,),
        ).fetchone()
    return _admin_adjustment_result(completed)


def _recompute_trusted_credit_balance(conn, app_name, code_id):
    rows = conn.execute(
        """
        SELECT transaction_type, balance_before, balance_after
        FROM credit_transactions
        WHERE app_name = ? AND code_id = ?
        ORDER BY created_at, rowid
        """,
        (app_name, code_id),
    ).fetchall()
    if not rows:
        return None, "没有服务器积分流水"
    first = rows[0]
    if (
        str(first["transaction_type"] or "") != "activation_grant"
        or first["balance_before"] is None
        or int(first["balance_before"] or 0) != 0
    ):
        return None, "流水缺少可信的初始权益锚点"
    previous = 0
    for row in rows:
        if row["balance_before"] is None or row["balance_after"] is None:
            return None, "流水缺少前后余额"
        if int(row["balance_before"]) != previous:
            return None, "流水前后余额不连续"
        previous = int(row["balance_after"])
    return previous, "服务器流水可完整复算"


def _balance_migration_result(conn, row, idempotent=False):
    account = conn.execute(
        """
        SELECT balance, balance_mode, balance_source, migration_status, billing_api
        FROM point_accounts
        WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = UPPER(?)
        """,
        (row["app_name"], row["code_id"], row["old_machine_code"]),
    ).fetchone()
    return {
        "ok": True,
        "success": True,
        "action": "balance_migrated",
        "idempotent": bool(idempotent),
        "migration_id": str(row["migration_id"]),
        "app_name": str(row["app_name"]),
        "code_id": str(row["code_id"]),
        "balance_before": row["reported_balance"],
        "balance_after": row["approved_balance"],
        "balance_source": str(account["balance_source"] if account else row["balance_source"]),
        "balance_mode": str(account["balance_mode"] if account else "server_managed"),
        "migration_status": str(account["migration_status"] if account else "completed"),
        "billing_api": str(account["billing_api"] if account else "credits_consume"),
    }


def handle_admin_balance_migrate(data, headers, user_ip=""):
    _admin_api_auth(headers)
    app_name = normalize_app_name(str(data.get("app_name") or ""), allow_legacy_default=False)
    code_id = str(data.get("code_id") or "").strip().upper()
    operator = str(data.get("operator") or "").strip()[:120]
    reason = str(data.get("reason") or "").strip()[:500]
    mode = str(data.get("migration_mode") or "manual").strip().lower()
    if not bool(data.get("confirm_migration")):
        raise DeviceApiError("余额迁移前必须二次确认。", 400)
    if not code_id:
        raise DeviceApiError("缺少 code_id。", 400)
    if not operator:
        raise DeviceApiError("余额迁移必须填写操作人。", 400)
    if not reason:
        raise DeviceApiError("余额迁移必须填写核对依据和原因。", 400)
    if mode not in {"auto", "manual"}:
        raise DeviceApiError("不支持的余额迁移方式。", 400)
    if app_name in {QIANCHUAN_APP_NAME, QIANCHUAN_LAPIAN_APP_NAME}:
        raise DeviceApiError("该软件使用专用业务账本，无需同步到中央积分账户。", 409)

    now = utc_now()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT * FROM balance_migrations WHERE app_name = ? AND code_id = ?",
            (app_name, code_id),
        ).fetchone()
        if existing:
            requested = data.get("approved_balance")
            if requested not in {None, ""}:
                try:
                    requested_balance = int(requested)
                except (TypeError, ValueError) as exc:
                    raise DeviceApiError("人工确认余额必须是非负整数。", 400) from exc
                if requested_balance != int(existing["approved_balance"]):
                    raise DeviceApiError("该授权已经按其他余额完成迁移，不能重复覆盖。", 409)
            conn.commit()
            return _balance_migration_result(conn, existing, idempotent=True)

        activation = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (app_name, code_id),
        ).fetchone()
        if not activation:
            raise DeviceApiError("未找到对应的激活记录。", 404)
        if str(activation["binding_role"] or "primary") != "primary":
            raise DeviceApiError("合并码不能建立独立权威余额。", 409)
        try:
            payload = json.loads(str(activation["payload_json"] or "{}"))
        except json.JSONDecodeError:
            payload = {}
        code_row = conn.execute(
            "SELECT * FROM redeem_codes WHERE app_name = ? AND code_id = ?",
            (app_name, code_id),
        ).fetchone()
        if code_row:
            payload.setdefault("license_type", str(code_row["license_type"] or "standard"))
            payload.setdefault("duration_days", int(code_row["duration_days"] or 0))
            payload.setdefault("unlimited", bool(code_row["unlimited"]))
        if _time_entitlement(payload, app_name):
            raise DeviceApiError("时间授权不进入积分余额迁移。", 409)
        if bool(payload.get("unlimited")):
            raise DeviceApiError("无限授权不进入有限积分余额迁移。", 409)

        machine_code = str(
            activation["bound_machine_code"] or activation["previous_machine_code"] or ""
        ).strip().upper()
        if not machine_code:
            raise DeviceApiError("激活记录没有可核对的机器码。", 409)
        account = conn.execute(
            """
            SELECT * FROM point_accounts
            WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
            """,
            (app_name, code_id, machine_code),
        ).fetchone()
        if account and bool(account["unlimited"]):
            raise DeviceApiError("无限授权不进入有限积分余额迁移。", 409)
        if account and str(account["balance_mode"] or "") == "server_managed":
            raise DeviceApiError("该账户已经是服务器权威余额，无需迁移。", 409)

        before = int(account["balance"] or 0) if account else 0
        if mode == "auto":
            if not account:
                raise DeviceApiError("该授权尚未建立中央积分账户，只能由管理员人工核对余额。", 409)
            recomputed, recompute_reason = _recompute_trusted_credit_balance(conn, app_name, code_id)
            if recomputed is None:
                raise DeviceApiError(f"不能自动迁移：{recompute_reason}。", 409)
            if int(recomputed) != before:
                raise DeviceApiError("流水复算余额与中央账户当前值不一致，需要人工核对。", 409)
            approved = int(recomputed)
            source = "server_ledger_recomputed"
        else:
            try:
                approved = int(data.get("approved_balance"))
            except (TypeError, ValueError) as exc:
                raise DeviceApiError("人工确认余额必须是非负整数。", 400) from exc
            if approved < 0:
                raise DeviceApiError("人工确认余额不能小于 0。", 400)
            source = "admin_confirmed_migration"

        migration_id = secrets.token_urlsafe(18)
        request_id = f"balance_migration:{code_id}"
        transaction_id = secrets.token_urlsafe(18)
        if account:
            conn.execute(
                """
                UPDATE point_accounts
                SET balance = ?, balance_mode = 'server_managed', balance_source = ?,
                    migration_status = 'completed', billing_api = 'credits_consume', updated_at = ?
                WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
                """,
                (approved, source, now, app_name, code_id, machine_code),
            )
        else:
            activation_hash = str(activation["code_hash"] or "").strip()
            if not activation_hash:
                raise DeviceApiError("激活记录缺少可核对的激活码摘要，不能创建中央账户。", 409)
            conn.execute(
                """
                INSERT INTO point_accounts
                    (app_name, code_id, code_hash, machine_code, balance,
                     unlimited, balance_mode, balance_source, migration_status,
                     billing_api, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 0, 'server_managed', ?, 'completed',
                        'credits_consume', ?, ?)
                """,
                (app_name, code_id, activation_hash, machine_code, approved, source, now, now),
            )
        conn.execute(
            """
            INSERT INTO credit_transactions
                (transaction_id, app_name, code_id, request_id, machine_code,
                 transaction_type, amount, reason, balance_before, balance_after,
                 unlimited, client_version, created_at)
            VALUES (?, ?, ?, ?, ?, 'migration_opening_balance', ?, ?, ?, ?, 0, ?, ?)
            """,
            (
                transaction_id, app_name, code_id, request_id, machine_code,
                approved - before, reason, before, approved, f"ops:{operator}", now,
            ),
        )
        conn.execute(
            """
            INSERT INTO balance_migrations
                (migration_id, app_name, code_id, old_machine_code, reported_balance,
                 approved_balance, balance_source, operator, reason, client_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                migration_id, app_name, code_id, machine_code, before, approved,
                source, operator, reason, f"ops:{operator}", now,
            ),
        )
        completed = conn.execute(
            "SELECT * FROM balance_migrations WHERE migration_id = ?", (migration_id,)
        ).fetchone()
        conn.commit()
        return _balance_migration_result(conn, completed)


def _random_reissue_code(app_name):
    body = "".join(secrets.choice(REISSUE_CODE_ALPHABET) for _ in range(12))
    grouped = "-".join(body[index:index + 4] for index in range(0, 12, 4))
    if app_name == LEGACY_APP_NAME:
        prefix = "OVD"
    elif app_name == QIANCHUAN_LAPIAN_APP_NAME:
        prefix = "QLP"
    elif app_name == QIANCHUAN_APP_NAME:
        prefix = "QMC"
    else:
        prefix = "".join(ch for ch in app_name.upper() if ch.isalnum())[:3] or "APP"
    return f"{prefix}-{grouped}"


def _existing_reissue_result(conn, row):
    code_row = conn.execute(
        "SELECT code_plaintext FROM redeem_codes WHERE app_name = ? AND code_id = ?",
        (row["app_name"], row["new_code_id"]),
    ).fetchone()
    return {
        "ok": True,
        "success": True,
        "idempotent": True,
        "action": "primary_reissued",
        "app_name": str(row["app_name"]),
        "old_code_id": str(row["old_code_id"]),
        "new_code_id": str(row["new_code_id"]),
        "new_activation_code": str(code_row[0] or "") if code_row else "",
        "entitlement_type": str(row["entitlement_type"]),
        "balance_mode": str(row["balance_mode"] or ""),
        "remaining_credits": row["balance_after"],
        "activated_at": str(row["activated_at"] or ""),
        "expires_at": str(row["expires_at"] or ""),
        "request_id": str(row["request_id"]),
    }


def handle_admin_primary_reissue(data, headers, user_ip=""):
    _admin_api_auth(headers)
    app_name = normalize_app_name(str(data.get("app_name") or ""), allow_legacy_default=False)
    old_code_id = str(data.get("code_id") or "").strip().upper()
    operator = str(data.get("operator") or "").strip()
    reason = str(data.get("reason") or "").strip()
    request_id = str(data.get("request_id") or "").strip()
    confirmed_raw = data.get("confirmed_balance")
    if not old_code_id:
        raise DeviceApiError("缺少原主激活码 code_id。", 400)
    if not operator:
        raise DeviceApiError("管理员补发必须填写操作人。", 400)
    if not reason:
        raise DeviceApiError("管理员补发必须填写原因。", 400)
    if not request_id or len(request_id) > 200:
        raise DeviceApiError("缺少有效的 request_id。", 400)
    if not bool(data.get("confirm_reissue")):
        raise DeviceApiError("补发前必须明确确认。", 400)

    now = utc_now()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        repeated = conn.execute(
            "SELECT * FROM primary_reissues WHERE request_id = ?",
            (request_id,),
        ).fetchone()
        if repeated:
            if str(repeated["app_name"]) != app_name or str(repeated["old_code_id"]) != old_code_id:
                raise DeviceApiError("request_id 已用于其他补发操作。", 409)
            conn.commit()
            return _existing_reissue_result(conn, repeated)

        old = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (app_name, old_code_id),
        ).fetchone()
        if not old:
            raise DeviceApiError("没有找到对应的激活记录。", 404)
        if str(old["binding_role"] or "primary") != "primary":
            raise DeviceApiError("该记录不是主授权，不能补发。", 409)
        if str(old["binding_status"] or "active") == "replaced" or str(old["replaced_by_code_id"] or ""):
            prior = conn.execute(
                "SELECT * FROM primary_reissues WHERE app_name = ? AND old_code_id = ?",
                (app_name, old_code_id),
            ).fetchone()
            if prior:
                conn.commit()
                return _existing_reissue_result(conn, prior)
            raise DeviceApiError("该主激活码已经被替换。", 409)
        if str(old["binding_status"] or "active") not in {"active", "unbound"}:
            raise DeviceApiError("当前绑定状态不允许补发。", 409)

        old_code = conn.execute(
            "SELECT * FROM redeem_codes WHERE app_name = ? AND code_id = ?",
            (app_name, old_code_id),
        ).fetchone()
        if not old_code:
            raise DeviceApiError("原激活码资料不完整，不能自动补发。", 409)
        try:
            payload = json.loads(str(old["payload_json"] or "{}"))
        except json.JSONDecodeError:
            payload = {}
        payload.setdefault("license_type", str(old_code["license_type"] or "standard"))
        payload.setdefault("duration_days", int(old_code["duration_days"] or 0))
        payload.setdefault("unlimited", bool(old_code["unlimited"]))
        payload.setdefault("credits", int(old_code["credits"] or 0))
        is_time = _time_entitlement(payload, app_name)
        is_unlimited = bool(payload.get("unlimited")) and not is_time
        entitlement_type = "time" if is_time else ("unlimited" if is_unlimited else "credits")
        old_machine = str(old["bound_machine_code"] or old["previous_machine_code"] or "").strip().upper()

        balance_before = None
        balance_after = None
        balance_mode = "time_based" if is_time else "server_managed"
        billing_api = "credits_consume"
        account_rows = []
        if not is_time:
            account_rows = conn.execute(
                "SELECT * FROM point_accounts WHERE app_name = ? AND code_id = ?",
                (app_name, old_code_id),
            ).fetchall()
            current_balance = sum(max(0, int(item["balance"] or 0)) for item in account_rows)
            modes = {str(item["balance_mode"] or "pending_migration") for item in account_rows}
            if is_unlimited:
                balance_before = 999999999
                balance_after = 999999999
            elif account_rows and modes == {"server_managed"}:
                balance_before = current_balance
                balance_after = current_balance
                billing_values = {str(item["billing_api"] or "credits_consume") for item in account_rows}
                billing_api = next(iter(billing_values)) if len(billing_values) == 1 else "credits_consume"
            else:
                balance_mode = "pending_migration" if account_rows else "legacy_local"
                if confirmed_raw is None or str(confirmed_raw).strip() == "":
                    label = "余额待迁移确认" if account_rows else "旧客户端本地计费，余额需人工确认"
                    raise DeviceApiError(label, 409)
                try:
                    confirmed_balance = int(confirmed_raw)
                except (TypeError, ValueError) as exc:
                    raise DeviceApiError("人工确认余额必须是非负整数。", 400) from exc
                if confirmed_balance < 0:
                    raise DeviceApiError("人工确认余额不能小于 0。", 400)
                balance_before = current_balance if account_rows else None
                balance_after = confirmed_balance
                billing_values = {str(item["billing_api"] or "legacy_points") for item in account_rows}
                billing_api = next(iter(billing_values)) if len(billing_values) == 1 else "legacy_points"

        new_code = ""
        new_hash = ""
        new_code_id = ""
        for _ in range(100):
            candidate = normalize_redeem_code(_random_reissue_code(app_name), app_name)
            candidate_hash = code_hash_for_app(candidate, app_name)
            candidate_id = candidate_hash[:16].upper()
            exists = conn.execute(
                "SELECT 1 FROM redeem_codes WHERE app_name = ? AND (code_id = ? OR code_hash = ?)",
                (app_name, candidate_id, candidate_hash),
            ).fetchone()
            if not exists:
                new_code, new_hash, new_code_id = candidate, candidate_hash, candidate_id
                break
        if not new_code:
            raise DeviceApiError("生成新主激活码失败，请重试。", 500)

        activated_at = str(old["activated_at"] or now)
        expires_at = str(payload.get("expires_at") or old_code["expires_at"] or "")
        storage_machine = old_machine or f"REISSUE-{new_code_id}"
        new_payload = dict(payload)
        new_payload["code_id"] = new_code_id
        # Legacy clients still initialize their local display from payload credits.
        # V2 rebound responses override this with the server balance and grant_score=0.
        new_payload["credits"] = (
            int(payload.get("credits") or 0)
            if is_unlimited else (0 if is_time else int(balance_after or 0))
        )
        new_payload["grant_score"] = 0
        new_payload["expires_at"] = expires_at
        new_payload.pop("machine_code", None)
        conn.execute(
            """
            INSERT INTO redeem_codes
                (app_name, code_id, code_hash, code_plaintext, credits, duration_days,
                 unlimited, license_type, expires_at, disabled, created_at, note)
            VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?)
            """,
            (
                app_name, new_code_id, new_hash, new_code,
                int(payload.get("duration_days") or old_code["duration_days"] or 0),
                1 if is_unlimited else 0,
                str(payload.get("license_type") or old_code["license_type"] or "standard"),
                expires_at, now, f"管理员补发，替换 {old_code_id}",
            ),
        )
        conn.execute(
            """
            INSERT INTO activations
                (app_name, code_id, code_hash, bound_machine_code, activated_at,
                 last_seen_at, payload_json, binding_status, device_credential_hash,
                 credential_version, transfer_count, last_bound_at, last_unbound_at,
                 previous_machine_code, binding_role, merged_into_code_id, merged_at,
                 replaces_code_id, replaced_by_code_id, replacement_status, replaced_at)
            VALUES (?, ?, ?, '', ?, ?, ?, 'unbound', '', 1, ?, '', ?, ?,
                    'primary', '', '', ?, '', 'replacement_ready', ?)
            """,
            (
                app_name, new_code_id, new_hash, activated_at, now,
                json.dumps(new_payload, ensure_ascii=False, sort_keys=True),
                int(old["transfer_count"] or 0), now, storage_machine,
                old_code_id, now,
            ),
        )

        if not is_time:
            if account_rows:
                for account in account_rows:
                    _release_pending_reservations(
                        conn, app_name, old_code_id, str(account["machine_code"] or ""), now
                    )
                if not is_unlimited and balance_mode == "server_managed":
                    balance_after = sum(max(0, int(item["balance"] or 0)) for item in conn.execute(
                        "SELECT balance FROM point_accounts WHERE app_name = ? AND code_id = ?",
                        (app_name, old_code_id),
                    ).fetchall())
                    balance_before = balance_after
            conn.execute(
                """
                INSERT INTO point_accounts
                    (app_name, code_id, machine_code, code_hash, balance, unlimited,
                     balance_mode, balance_source, migration_status, billing_api,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'server_managed', ?, 'completed', ?, ?, ?)
                """,
                (
                    app_name, new_code_id, storage_machine, new_hash,
                    0 if is_unlimited else int(balance_after or 0), 1 if is_unlimited else 0,
                    "server_ledger" if balance_mode == "server_managed" else "manual_reissue",
                    billing_api, now, now,
                ),
            )
            conn.execute(
                "UPDATE point_accounts SET balance = 0, updated_at = ? WHERE app_name = ? AND code_id = ?",
                (now, app_name, old_code_id),
            )
            amount = 0 if is_unlimited else int(balance_after or 0)
            conn.execute(
                """
                INSERT INTO credit_transactions
                    (transaction_id, app_name, code_id, request_id, machine_code,
                     transaction_type, amount, reason, balance_before, balance_after,
                     unlimited, client_version, created_at)
                VALUES (?, ?, ?, ?, ?, 'reissue_transfer_out', ?, ?, ?, 0, ?, '', ?)
                """,
                (
                    secrets.token_urlsafe(18), app_name, old_code_id,
                    f"reissue-out:{request_id}", storage_machine, amount,
                    f"管理员补发到 {new_code_id}", balance_before,
                    1 if is_unlimited else 0, now,
                ),
            )
            conn.execute(
                """
                INSERT INTO credit_transactions
                    (transaction_id, app_name, code_id, request_id, machine_code,
                     transaction_type, amount, reason, balance_before, balance_after,
                     unlimited, client_version, created_at)
                VALUES (?, ?, ?, ?, ?, 'reissue_transfer_in', ?, ?, 0, ?, ?, '', ?)
                """,
                (
                    secrets.token_urlsafe(18), app_name, new_code_id,
                    f"reissue-in:{request_id}", storage_machine, amount,
                    f"管理员补发自 {old_code_id}", 0 if is_unlimited else int(balance_after or 0),
                    1 if is_unlimited else 0, now,
                ),
            )

        conn.execute(
            """
            UPDATE activations
            SET bound_machine_code = '', binding_status = 'replaced',
                device_credential_hash = '', credential_version = credential_version + 1,
                previous_machine_code = ?, replaced_by_code_id = ?,
                replacement_status = 'replaced', replaced_at = ?, last_seen_at = ?
            WHERE app_name = ? AND code_id = ?
            """,
            (old_machine, new_code_id, now, now, app_name, old_code_id),
        )
        conn.execute(
            "UPDATE redeem_codes SET disabled = 1 WHERE app_name = ? AND code_id = ?",
            (app_name, old_code_id),
        )
        conn.execute(
            """
            UPDATE activations
            SET bound_machine_code = ?, previous_machine_code = ?,
                merged_into_code_id = ?, replaced_by_code_id = ?,
                replacement_status = 'parent_reissued', replaced_at = ?
            WHERE app_name = ? AND binding_role = 'merged' AND merged_into_code_id = ?
            """,
            (storage_machine, old_machine, new_code_id, new_code_id, now, app_name, old_code_id),
        )
        reissue_id = secrets.token_urlsafe(18)
        conn.execute(
            """
            INSERT INTO primary_reissues
                (reissue_id, app_name, old_code_id, new_code_id, request_id,
                 entitlement_type, balance_mode, balance_before, balance_after,
                 activated_at, expires_at, operator, reason, status, created_at, approved_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)
            """,
            (
                reissue_id, app_name, old_code_id, new_code_id, request_id,
                entitlement_type, balance_mode, balance_before, balance_after,
                activated_at, expires_at, operator, reason, now, now,
            ),
        )
        if balance_mode in {"legacy_local", "pending_migration"} and not is_time and not is_unlimited:
            conn.execute(
                """
                INSERT INTO primary_reissue_adjustments
                    (adjustment_id, reissue_id, app_name, old_code_id, reported_balance,
                     approved_balance, operator, reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    secrets.token_urlsafe(18), reissue_id, app_name, old_code_id,
                    balance_before, int(balance_after or 0), operator, reason, now,
                ),
            )
        conn.execute(
            """
            INSERT INTO device_transfer_log
                (app_name, code_id, event_type, old_machine_code, new_machine_code,
                 actor_type, actor, reason, user_ip, created_at)
            VALUES (?, ?, 'admin_primary_reissue', ?, '', 'admin', ?, ?, ?, ?)
            """,
            (app_name, old_code_id, old_machine, operator, reason, user_ip, now),
        )
        conn.commit()
        created = conn.execute(
            "SELECT * FROM primary_reissues WHERE reissue_id = ?",
            (reissue_id,),
        ).fetchone()
        result = _existing_reissue_result(conn, created)
        result["idempotent"] = False
        return result


def public_license(payload, machine_code, app_name, already_bound):
    unlimited = bool(payload.get("unlimited"))
    raw_credits = payload.get("credits")
    config = app_config(app_name) or {"default_credits": int(INITIAL_CREDITS)}
    default_credits = config["default_credits"]
    credits = 0 if unlimited else int(default_credits if raw_credits is None else raw_credits)
    result = {
        "activated": True,
        "server_bound": True,
        "already_bound": bool(already_bound),
        "server_url": SERVER_PUBLIC_URL,
        "app_name": app_name,
        "machine_code": machine_code,
        "bound_machine_code": machine_code,
        "code_id": str(payload.get("code_id") or ""),
        "credits": credits,
        "grant_score": credits,
        "duration_days": int(payload.get("duration_days") or 0),
        "unlimited": unlimited,
        "license_type": str(payload.get("license_type") or ("unlimited" if unlimited else "standard")),
        "issued_at": str(payload.get("issued_at") or ""),
        "expires_at": str(payload.get("expires_at") or ""),
    }
    if _time_entitlement(payload, app_name):
        result.update(_time_status(payload))
        result["entitlement_type"] = "time"
    else:
        result["entitlement_type"] = "unlimited" if unlimited else "credits"
    return result


def _b64url_decode(value):
    text = str(value or "")
    return base64.urlsafe_b64decode((text + "=" * (-len(text) % 4)).encode("ascii"))


def _ed25519_xrecover(y):
    xx = (y * y - 1) * pow(ED25519_D * y * y + 1, ED25519_Q - 2, ED25519_Q)
    x = pow(xx, (ED25519_Q + 3) // 8, ED25519_Q)
    if (x * x - xx) % ED25519_Q != 0:
        x = (x * ED25519_I) % ED25519_Q
    if x % 2:
        x = ED25519_Q - x
    return x


def _ed25519_add(point_a, point_b):
    x1, y1 = point_a
    x2, y2 = point_b
    denominator_x = pow(1 + ED25519_D * x1 * x2 * y1 * y2, ED25519_Q - 2, ED25519_Q)
    denominator_y = pow(1 - ED25519_D * x1 * x2 * y1 * y2, ED25519_Q - 2, ED25519_Q)
    return (
        ((x1 * y2 + x2 * y1) * denominator_x) % ED25519_Q,
        ((y1 * y2 + x1 * x2) * denominator_y) % ED25519_Q,
    )


def _ed25519_scalar_mult(point, scalar):
    result = (0, 1)
    addend = point
    value = int(scalar)
    while value:
        if value & 1:
            result = _ed25519_add(result, addend)
        addend = _ed25519_add(addend, addend)
        value >>= 1
    return result


def _ed25519_decode_point(encoded):
    if len(encoded) != 32:
        raise ValueError("Ed25519 point length is invalid")
    y = int.from_bytes(encoded, "little") & ((1 << 255) - 1)
    if y >= ED25519_Q:
        raise ValueError("Ed25519 point is outside the field")
    x = _ed25519_xrecover(y)
    if (x & 1) != (encoded[31] >> 7):
        x = ED25519_Q - x
    point = (x, y)
    x_value, y_value = point
    if (-x_value * x_value + y_value * y_value - 1 - ED25519_D * x_value * x_value * y_value * y_value) % ED25519_Q:
        raise ValueError("Ed25519 point is not on the curve")
    return point


def verify_ed25519(message, signature, public_key):
    if len(signature) != 64 or len(public_key) != 32:
        return False
    scalar = int.from_bytes(signature[32:], "little")
    if scalar >= ED25519_L:
        return False
    try:
        point_r = _ed25519_decode_point(signature[:32])
        point_a = _ed25519_decode_point(public_key)
    except ValueError:
        return False
    base_y = (4 * pow(5, ED25519_Q - 2, ED25519_Q)) % ED25519_Q
    base_point = (_ed25519_xrecover(base_y), base_y)
    challenge = int.from_bytes(
        hashlib.sha512(signature[:32] + public_key + message).digest(),
        "little",
    ) % ED25519_L
    return _ed25519_scalar_mult(base_point, scalar) == _ed25519_add(
        point_r,
        _ed25519_scalar_mult(point_a, challenge),
    )


def parse_qc1_activation_code(code):
    clean_code = "".join(str(code or "").strip().split())
    parts = clean_code.split(".")
    if len(parts) != 3 or parts[0] != "QC1":
        raise ValueError("拉片工具激活码格式无效。")
    message = f"{parts[0]}.{parts[1]}".encode("ascii")
    try:
        signature = _b64url_decode(parts[2])
        public_key = base64.b64decode(QC1_PUBLIC_KEY_DER_B64)[-32:]
        payload = json.loads(_b64url_decode(parts[1]).decode("utf-8"))
    except Exception as exc:
        raise ValueError("拉片工具激活码编码无效。") from exc
    if not verify_ed25519(message, signature, public_key):
        raise ValueError("拉片工具激活码签名无效。")
    if str(payload.get("product") or "") != QIANCHUAN_LAPIAN_PRODUCT:
        raise ValueError("这个激活码属于其他软件。")
    raw_credits = payload.get("credits")
    try:
        credits = int(raw_credits)
    except (TypeError, ValueError) as exc:
        raise ValueError("拉片工具激活码积分配置无效。") from exc
    if credits < 0:
        raise ValueError("拉片工具激活码积分配置无效。")
    code_id = str(payload.get("license_id") or payload.get("id") or "").strip().upper()
    if not code_id:
        raise ValueError("拉片工具激活码缺少编号。")
    batch = str(payload.get("batch") or "offline")
    unlimited = bool(
        payload.get("unlimited")
        or batch == "infinite_unlimited"
        or code_id.startswith("QC-INFINITE-")
    )
    return {
        **payload,
        "version": int(payload.get("v") or payload.get("version") or 1),
        "app_name": QIANCHUAN_LAPIAN_APP_NAME,
        "code_id": code_id,
        "credits": 0 if unlimited else credits,
        "unlimited": unlimited,
        "license_type": "unlimited" if unlimited else str(payload.get("license_type") or payload.get("tier") or "pro"),
        "issued_at": str(payload.get("issued_at") or ""),
        "expires_at": str(payload.get("expires_at") or ""),
        "bind_on_activate": True,
        "signed_code": True,
    }


def normalize_legacy_short_code(code):
    raw = str(code or "").strip().upper()
    if raw.startswith("OVT2-"):
        return raw
    compact = "".join(ch for ch in raw if ch.isalnum())
    if compact.startswith("OVD"):
        compact = compact[3:]
    if len(compact) != 12:
        return raw
    return "OVD-" + "-".join(compact[index:index + 4] for index in range(0, 12, 4))


def normalize_redeem_code(code, app_name):
    if app_name == LEGACY_APP_NAME:
        return normalize_legacy_short_code(code)
    if app_name == QIANCHUAN_LAPIAN_APP_NAME:
        raw = str(code or "").strip()
        if raw.startswith("QC1."):
            return "".join(raw.split())
        compact = "".join(ch for ch in raw.upper() if ch.isalnum())
        if compact.startswith("QLP") and len(compact) == 15:
            return "QLP-" + "-".join([
                compact[3:7],
                compact[7:11],
                compact[11:15],
            ])
        if compact.startswith("QC") and len(compact) == 18:
            return "QC-" + "-".join([
                compact[2:6],
                compact[6:10],
                compact[10:14],
                compact[14:18],
            ])
        return "".join(raw.upper().split())
    return str(code or "").strip().upper()


def code_hash_for_app(code, app_name):
    normalized = normalize_redeem_code(code, app_name)
    if app_name == QIANCHUAN_LAPIAN_APP_NAME:
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    return code_hash(normalized)


def short_code_payload(code, app_name):
    clean_code = normalize_redeem_code(code, app_name)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        row = conn.execute(
            """
            SELECT code_id, credits, duration_days, unlimited, license_type, expires_at, disabled
            FROM redeem_codes
            WHERE app_name = ? AND code_hash = ?
            """,
            (app_name, code_hash_for_app(clean_code, app_name)),
        ).fetchone()
    if not row:
        raise ValueError("兑换码不存在、尚未导入服务器或不属于当前软件。")
    code_id, credits, duration_days, unlimited, license_type, expires_at, disabled = row
    if int(disabled or 0):
        raise ValueError("这个兑换码已被停用。")
    return {
        "version": 3,
        "app_name": app_name,
        "code_id": str(code_id),
        "credits": int(credits or 0),
        "duration_days": int(duration_days or 0),
        "unlimited": bool(unlimited),
        "license_type": str(license_type or ("unlimited" if unlimited else "standard")),
        "issued_at": "",
        "expires_at": str(expires_at or ""),
        "bind_on_activate": True,
        "short_code": True,
    }


def payload_for_code(code, app_name):
    clean_code = str(code or "").strip()
    if clean_code.upper().startswith("OVT2-"):
        raise ValueError("旧版 OVT2 激活码已永久停止受理，请联系管理员使用在线短码。")
    if clean_code.startswith("QC1."):
        if app_name != QIANCHUAN_LAPIAN_APP_NAME:
            raise ValueError("这个激活码属于其他软件。")
        payload = parse_qc1_activation_code(clean_code)
        return payload, normalize_redeem_code(clean_code, app_name)
    normalized = normalize_redeem_code(clean_code, app_name)
    return short_code_payload(normalized, app_name), normalized


def activate_remote(
    code,
    machine_code,
    app_name,
    device_credential="",
    current_code_id="",
    confirm_merge=False,
    credential_refresh=False,
    authenticated_row=None,
):
    clean_app = normalize_app_name(app_name)
    if not code:
        raise ValueError("请输入激活码。")
    if not machine_code:
        raise ValueError("缺少机器码。")

    payload, clean_code = payload_for_code(code, clean_app)
    payload_app = str(payload.get("app_name") or "").strip()
    if payload_app and payload_app != clean_app:
        raise ValueError("激活码所属软件与客户端不匹配。")

    clean_machine = str(machine_code).strip().upper()
    if _server_is_expired(str(payload.get("expires_at") or "")):
        raise ValueError("激活码已过期。")

    current_hash = code_hash_for_app(clean_code, clean_app)
    code_id = str(payload.get("code_id") or current_hash[:16]).upper()
    now = utc_now()
    already_bound = False
    replacement_rebound = False
    action = "activated"
    transferred_balance = 0
    primary_code_id = code_id
    merged_code_id = ""
    activated_at = now
    public_payload = dict(payload)
    plain_credential = ""
    credential_version = 1
    transfer_count = 0
    remaining_credits = None

    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            """
            SELECT *
            FROM activations
            WHERE app_name = ? AND code_id = ?
            """,
            (clean_app, code_id),
        ).fetchone()
        requested_code_id = str(current_code_id or "").strip().upper()
        requested_primary = None
        if requested_code_id:
            requested_primary = conn.execute(
                """
                SELECT * FROM activations
                WHERE app_name = ? AND code_id = ? AND binding_status = 'active'
                  AND binding_role = 'primary' AND UPPER(bound_machine_code) = ?
                LIMIT 1
                """,
                (clean_app, requested_code_id, clean_machine),
            ).fetchone()
        target_primary = requested_primary or conn.execute(
            """
            SELECT * FROM activations
            WHERE app_name = ? AND binding_status = 'active'
              AND binding_role = 'primary' AND UPPER(bound_machine_code) = ?
            LIMIT 1
            """,
            (clean_app, clean_machine),
        ).fetchone()
        legacy_primary_adoption = False
        if bool(confirm_merge) and requested_code_id and not requested_primary:
            source_is_current_machine_primary = bool(
                row
                and str(row["binding_status"] or "active") == "active"
                and str(row["binding_role"] or "primary") == "primary"
                and str(row["bound_machine_code"] or "").strip().upper() == clean_machine
            )
            if source_is_current_machine_primary:
                # Recover a code consumed by an older client before it rejected the
                # response because its legacy local primary was absent server-side.
                legacy_primary_adoption = True
                target_primary = row
            else:
                raise ValueError(
                    "服务器未找到当前主激活码，已拒绝消耗新的兑换码；"
                    "请先按主激活码编号完成旧授权迁移。"
                )

        if target_primary and str(target_primary["code_id"]) != code_id:
            try:
                target_payload = json.loads(str(target_primary["payload_json"] or "{}"))
            except json.JSONDecodeError:
                target_payload = {}
            if _time_entitlement(public_payload, clean_app) or _time_entitlement(target_payload, clean_app):
                raise ValueError("时间卡不能使用积分合并，请使用 /api/license/time/renew 续期。")
            if not bool(confirm_merge):
                raise ValueError("当前电脑已有主激活码，合并积分前必须明确确认。")
            expected_primary = str(target_primary["code_id"])
            if str(current_code_id or "").strip().upper() != expected_primary:
                raise ValueError("当前主激活码不匹配，已拒绝余额合并。")
            if not authenticated_row:
                raise ValueError("请先输入当前主激活码刷新设备凭证，再合并其他兑换码。")
            if (
                str(authenticated_row.get("app_name") or "") != clean_app
                or str(authenticated_row.get("code_id") or "") != expected_primary
                or str(authenticated_row.get("bound_machine_code") or "").strip().upper()
                != clean_machine
            ):
                raise ValueError("当前设备凭证与主激活码不匹配，已拒绝余额合并。")

            if row:
                if str(row["code_hash"] or "") != current_hash:
                    raise ValueError("激活码编号冲突，请联系管理员。")
                source_status = str(row["binding_status"] or "active")
                source_role = str(row["binding_role"] or "primary")
                if source_role == "merged":
                    if (
                        source_status == "active"
                        and str(row["merged_into_code_id"] or "") == expected_primary
                        and str(row["bound_machine_code"] or "").strip().upper() == clean_machine
                    ):
                        transferred_balance = 0
                    else:
                        raise ValueError("这个兑换码已经合并到其他主激活码，不能再次使用。")
                elif source_status == "active":
                    raise ValueError("这个激活码仍绑定在其他电脑，请先在旧电脑解绑。")
                elif source_status != "unbound":
                    raise ValueError("激活码绑定状态异常，请联系管理员。")
            source_payload = dict(payload)
            if row:
                try:
                    stored_payload = json.loads(str(row["payload_json"] or "{}"))
                    if isinstance(stored_payload, dict) and stored_payload:
                        source_payload = stored_payload
                except json.JSONDecodeError:
                    pass
            if not row or str(row["binding_role"] or "primary") != "merged":
                transferred_balance, remaining_credits = _merge_point_balance(
                    conn,
                    clean_app,
                    row,
                    source_payload,
                    target_primary,
                    clean_machine,
                    now,
                )
                payload_text = json.dumps(source_payload, ensure_ascii=False, sort_keys=True)
                if row:
                    old_machine = str(
                        row["previous_machine_code"] or row["bound_machine_code"] or ""
                    ).strip().upper()
                    _move_merged_children(
                        conn, clean_app, code_id, expected_primary,
                        old_machine, clean_machine, now,
                    )
                    conn.execute(
                        """
                        UPDATE activations
                        SET bound_machine_code = ?, binding_status = 'active', binding_role = 'merged',
                            merged_into_code_id = ?, merged_at = ?, device_credential_hash = '',
                            credential_version = credential_version + 1,
                            transfer_count = transfer_count + CASE WHEN binding_status = 'unbound' THEN 1 ELSE 0 END,
                            last_bound_at = ?, last_seen_at = ?
                        WHERE app_name = ? AND code_id = ?
                        """,
                        (clean_machine, expected_primary, now, now, now, clean_app, code_id),
                    )
                else:
                    old_machine = ""
                    conn.execute(
                        """
                        INSERT INTO activations
                            (app_name, code_id, code_hash, bound_machine_code, activated_at,
                             last_seen_at, payload_json, binding_status, device_credential_hash,
                             credential_version, transfer_count, last_bound_at, last_unbound_at,
                             previous_machine_code, binding_role, merged_into_code_id, merged_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '', 1, 0, ?, '', '',
                                'merged', ?, ?)
                        """,
                        (
                            clean_app, code_id, current_hash, clean_machine, now, now,
                            payload_text, now, expected_primary, now,
                        ),
                    )
                conn.execute(
                    """
                    INSERT INTO device_transfer_log
                        (app_name, code_id, event_type, old_machine_code, new_machine_code,
                         actor_type, actor, reason, user_ip, created_at)
                    VALUES (?, ?, 'balance_merge', ?, ?, 'self', ?, ?, '', ?)
                    """,
                    (
                        clean_app, code_id, old_machine, clean_machine, clean_machine,
                        f"余额合并到主激活码 {expected_primary}", now,
                    ),
                )
            else:
                remaining_credits, _ = _point_balance(
                    conn, clean_app, expected_primary, clean_machine
                )
            action = "balance_merged"
            primary_code_id = expected_primary
            merged_code_id = code_id
            public_payload = source_payload
            remaining_unlimited = False
            conn.commit()
        elif row:
            bound_machine = str(row["bound_machine_code"] or "").strip().upper()
            if str(row["code_hash"] or "") != current_hash:
                raise ValueError("激活码编号冲突，请联系管理员。")
            binding_status = str(row["binding_status"] or "active")
            activated_at = str(row["activated_at"] or now)
            credential_version = int(row["credential_version"] or 1)
            transfer_count = int(row["transfer_count"] or 0)
            if str(row["binding_role"] or "primary") == "merged":
                raise ValueError("这个兑换码已经合并到其他主激活码，不能再次使用。")
            try:
                stored_payload = json.loads(str(row["payload_json"] or "{}"))
                if isinstance(stored_payload, dict) and stored_payload:
                    public_payload = stored_payload
            except json.JSONDecodeError:
                public_payload = dict(payload)
            if _server_is_expired(str(public_payload.get("expires_at") or "")):
                raise ValueError("授权已过期，请使用新的激活码。")
            if binding_status == "active":
                if bound_machine != clean_machine:
                    raise ValueError("这个激活码仍绑定在其他电脑，请先在旧电脑解绑。")
                payload_machine = str(public_payload.get("machine_code") or "").strip().upper()
                if payload_machine and payload_machine != clean_machine:
                    raise ValueError("激活码与本机机器码不匹配。")
                already_bound = True
                action = (
                    "legacy_primary_adopted"
                    if legacy_primary_adoption
                    else "already_bound"
                )
                stored_hash = str(row["device_credential_hash"] or "")
                supplied_credential = str(device_credential or "").strip()
                if stored_hash:
                    if credential_refresh:
                        if not authenticated_row:
                            raise ValueError("设备已有凭证，刷新时必须验证当前设备会话和凭证。")
                        if (
                            str(authenticated_row.get("app_name") or "") != clean_app
                            or str(authenticated_row.get("code_id") or "") != code_id
                            or str(authenticated_row.get("bound_machine_code") or "").strip().upper()
                            != clean_machine
                        ):
                            raise ValueError("当前设备凭证与激活记录不匹配。")
                        plain_credential = secrets.token_urlsafe(48)
                        credential_version += 1
                        conn.execute(
                            """
                            UPDATE activations
                            SET device_credential_hash = ?, credential_version = ?, last_seen_at = ?
                            WHERE app_name = ? AND code_id = ?
                            """,
                            (_credential_hash(plain_credential), credential_version, now, clean_app, code_id),
                        )
                    elif supplied_credential:
                        if not hmac.compare_digest(stored_hash, _credential_hash(supplied_credential)):
                            raise ValueError("设备凭证不匹配。")
                        plain_credential = supplied_credential
                    else:
                        raise ValueError("设备凭证缺失，不能覆盖已有凭证；请使用当前设备凭证或联系管理员。")
                else:
                    if not credential_refresh:
                        raise ValueError("旧授权首次升级设备凭证时必须设置 credential_refresh=true。")
                    if str(current_code_id or "").strip().upper() != code_id:
                        raise ValueError("current_code_id 与原激活码不匹配。")
                    plain_credential = secrets.token_urlsafe(48)
                    conn.execute(
                        """
                        UPDATE activations SET device_credential_hash = ?
                        WHERE app_name = ? AND code_id = ?
                        """,
                        (_credential_hash(plain_credential), clean_app, code_id),
                    )
                conn.execute(
                    "UPDATE activations SET last_seen_at = ? WHERE app_name = ? AND code_id = ?",
                    (now, clean_app, code_id),
                )
            elif binding_status == "unbound":
                is_reissue_ready = bool(str(row["replaces_code_id"] or ""))
                action = "rebound" if not is_reissue_ready else "rebound"
                old_machine = str(row["previous_machine_code"] or "").strip().upper()
                _migrate_point_balance(conn, clean_app, code_id, old_machine, clean_machine, now)
                _move_merged_children(
                    conn, clean_app, code_id, code_id,
                    old_machine, clean_machine, now,
                )
                plain_credential = secrets.token_urlsafe(48)
                conn.execute(
                    """
                    UPDATE activations
                    SET bound_machine_code = ?, binding_status = 'active',
                        device_credential_hash = ?, transfer_count = transfer_count + 1,
                        last_bound_at = ?, last_seen_at = ?
                    WHERE app_name = ? AND code_id = ?
                    """,
                    (clean_machine, _credential_hash(plain_credential), now, now, clean_app, code_id),
                )
                transfer_count += 1
                conn.execute(
                    """
                    INSERT INTO device_transfer_log
                        (app_name, code_id, event_type, old_machine_code, new_machine_code,
                         actor_type, actor, reason, user_ip, created_at)
                    VALUES (?, ?, 'rebind', ?, ?, 'self', ?, '使用原激活码重新绑定', '', ?)
                    """,
                    (clean_app, code_id, old_machine, clean_machine, clean_machine, now),
                )
            else:
                raise ValueError("激活码绑定状态异常，请联系管理员。")
        else:
            payload_machine = str(public_payload.get("machine_code") or "").strip().upper()
            if payload_machine and payload_machine != clean_machine:
                raise ValueError("激活码与本机机器码不匹配。")
            duration_days = int(public_payload.get("duration_days") or 0)
            if duration_days > 0 and not str(public_payload.get("expires_at") or "").strip():
                public_payload["expires_at"] = (
                    datetime.utcnow() + timedelta(days=duration_days)
                ).isoformat(timespec="seconds") + "Z"
            payload_text = json.dumps(public_payload, ensure_ascii=False, sort_keys=True)
            plain_credential = secrets.token_urlsafe(48)
            conn.execute(
                """
                INSERT INTO activations
                    (app_name, code_id, code_hash, bound_machine_code,
                     activated_at, last_seen_at, payload_json, binding_status,
                     device_credential_hash, credential_version, transfer_count,
                     last_bound_at, last_unbound_at, previous_machine_code,
                     binding_role, merged_into_code_id, merged_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, 0, ?, '', '',
                        'primary', '', '')
                """,
                (
                    clean_app,
                    code_id,
                    current_hash,
                    clean_machine,
                    now,
                    now,
                    payload_text,
                    _credential_hash(plain_credential),
                    now,
                ),
            )
        if action != "balance_merged":
            current_row = conn.execute(
                "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
                (clean_app, code_id),
            ).fetchone()
            # A brand-new primary code must receive the entitlement encoded in
            # that code. The business proxy may not post its grant until after
            # this transaction, so its pre-grant balance must not override the
            # new code's initial credits.
            _ensure_point_account_for_binding(
                conn,
                current_row,
                now,
                use_external_balance=action != "activated",
            )
            if action == "activated" and not _time_entitlement(public_payload, clean_app):
                conn.execute(
                    """
                    UPDATE point_accounts
                    SET balance_mode = 'server_managed', balance_source = 'server_ledger',
                        migration_status = 'completed', billing_api = ?,
                        updated_at = ?
                    WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
                    """,
                    ('points_reserve' if clean_app in POINT_RESERVATION_APPS else 'credits_consume',
                     now, clean_app, code_id, clean_machine),
                )
                initial_balance, initial_unlimited = _point_balance(
                    conn, clean_app, code_id, clean_machine
                )
                transaction_id = secrets.token_urlsafe(18)
                conn.execute(
                    """
                    INSERT OR IGNORE INTO credit_transactions
                        (transaction_id, app_name, code_id, request_id, machine_code,
                         transaction_type, amount, reason, balance_before, balance_after,
                         unlimited, client_version, created_at)
                    VALUES (?, ?, ?, ?, ?, 'activation_grant', ?, 'initial entitlement',
                            0, ?, ?, '', ?)
                    """,
                    (
                        transaction_id, clean_app, code_id, f"activation:{code_id}", clean_machine,
                        0 if initial_unlimited else int(initial_balance or 0),
                        0 if initial_unlimited else int(initial_balance or 0),
                        1 if initial_unlimited else 0, now,
                    ),
                )
            remaining_credits, remaining_unlimited = _point_balance(
                conn, clean_app, code_id, clean_machine
            )
            conn.commit()

    public_payload["code_id"] = code_id
    license_state = public_license(public_payload, clean_machine, clean_app, already_bound)
    if action == "rebound":
        license_state["credits"] = 999999999 if remaining_unlimited else int(remaining_credits or 0)
        license_state["grant_score"] = 0
    state_details = {
        "action": action,
        "binding_status": "active",
        "binding_role": "merged" if action == "balance_merged" else "primary",
        "primary_code_id": primary_code_id,
        "merged_code_id": merged_code_id,
        "transferred_balance": int(transferred_balance or 0),
        "transfer_count": transfer_count,
        "transferred": action == "rebound",
    }
    if _time_entitlement(public_payload, clean_app):
        state_details.update(_time_status(public_payload, activated_at))
        state_details["entitlement_type"] = "time"
    else:
        actual_balance = 999999999 if remaining_unlimited else int(remaining_credits or 0)
        state_details["balance"] = actual_balance
        state_details["remaining_credits"] = actual_balance
    license_state.update(state_details)
    if plain_credential and action != "balance_merged":
        license_state["device_credential"] = plain_credential
        license_state["device_session"] = _issue_device_session(
            clean_app, code_id, clean_machine, credential_version
        )
    license_state["_feishu_event"] = {
        "activated_at": activated_at,
        "app_name": clean_app,
        "activation_code": clean_code,
        "code_id": code_id,
        "code_hash": current_hash,
        "license_type": license_state["license_type"],
        "credits": license_state["credits"],
        "duration_days": license_state.get("duration_days", 0),
        "unlimited": license_state["unlimited"],
        "machine_code": clean_machine,
        "activation_result": (
            "余额合并成功" if action == "balance_merged"
            else ("换机绑定成功" if action == "rebound"
                  else ("重复激活成功" if already_bound else "激活成功"))
        ),
        "error": "",
        "server_time": now,
    }
    return license_state


def activate_remote_legacy(code, machine_code, app_name):
    """Preserve the pre-device-credential activation contract for old clients."""
    clean_app = normalize_app_name(app_name)
    if not code:
        raise ValueError("请输入激活码。")
    if not machine_code:
        raise ValueError("缺少机器码。")

    payload, clean_code = payload_for_code(code, clean_app)
    payload_app = str(payload.get("app_name") or "").strip()
    if payload_app and payload_app != clean_app:
        raise ValueError("激活码所属软件与客户端不匹配。")

    clean_machine = str(machine_code).strip().upper()
    if _server_is_expired(str(payload.get("expires_at") or "")):
        raise ValueError("激活码已过期。")

    current_hash = code_hash_for_app(clean_code, clean_app)
    code_id = str(payload.get("code_id") or current_hash[:16]).upper()
    now = utc_now()
    already_bound = False
    replacement_rebound = False
    activated_at = now
    public_payload = dict(payload)

    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (clean_app, code_id),
        ).fetchone()
        if row:
            if str(row["code_hash"] or "") != current_hash:
                raise ValueError("激活码编号冲突，请联系管理员。")
            bound_machine = str(row["bound_machine_code"] or "").strip().upper()
            binding_status = str(row["binding_status"] or "active")
            if binding_status == "active" and bound_machine != clean_machine:
                raise ValueError("这个激活码已经绑定到其他电脑。")
            if binding_status not in {"active", "unbound"}:
                raise ValueError("激活码绑定状态异常，请联系管理员。")
            activated_at = str(row["activated_at"] or now)
            try:
                stored_payload = json.loads(str(row["payload_json"] or "{}"))
                if isinstance(stored_payload, dict) and stored_payload:
                    public_payload = stored_payload
            except json.JSONDecodeError:
                public_payload = dict(payload)
            if _server_is_expired(str(public_payload.get("expires_at") or "")):
                raise ValueError("授权已过期，请使用新的激活码。")
            if binding_status == "unbound":
                replacement_rebound = bool(str(row["replaces_code_id"] or ""))
                target_primary = conn.execute(
                    """
                    SELECT code_id FROM activations
                    WHERE app_name = ? AND binding_status = 'active'
                      AND binding_role = 'primary' AND UPPER(bound_machine_code) = ?
                    LIMIT 1
                    """,
                    (clean_app, clean_machine),
                ).fetchone()
                role = "legacy" if target_primary else "primary"
                old_machine = str(
                    row["previous_machine_code"] or row["bound_machine_code"] or ""
                ).strip().upper()
                _migrate_point_balance(conn, clean_app, code_id, old_machine, clean_machine, now)
                conn.execute(
                    """
                    UPDATE activations
                    SET bound_machine_code = ?, binding_status = 'active', binding_role = ?,
                        device_credential_hash = '', last_bound_at = ?, last_seen_at = ?
                    WHERE app_name = ? AND code_id = ?
                    """,
                    (clean_machine, role, now, now, clean_app, code_id),
                )
            else:
                already_bound = True
                conn.execute(
                    "UPDATE activations SET last_seen_at = ? WHERE app_name = ? AND code_id = ?",
                    (now, clean_app, code_id),
                )
        else:
            payload_machine = str(public_payload.get("machine_code") or "").strip().upper()
            if payload_machine and payload_machine != clean_machine:
                raise ValueError("激活码与本机机器码不匹配。")
            duration_days = int(public_payload.get("duration_days") or 0)
            if duration_days > 0 and not str(public_payload.get("expires_at") or "").strip():
                public_payload["expires_at"] = (
                    datetime.utcnow() + timedelta(days=duration_days)
                ).isoformat(timespec="seconds") + "Z"
            target_primary = conn.execute(
                """
                SELECT code_id FROM activations
                WHERE app_name = ? AND binding_status = 'active'
                  AND binding_role = 'primary' AND UPPER(bound_machine_code) = ?
                LIMIT 1
                """,
                (clean_app, clean_machine),
            ).fetchone()
            role = "legacy" if target_primary else "primary"
            payload_text = json.dumps(public_payload, ensure_ascii=False, sort_keys=True)
            conn.execute(
                """
                INSERT INTO activations
                    (app_name, code_id, code_hash, bound_machine_code,
                     activated_at, last_seen_at, payload_json, binding_status,
                     device_credential_hash, credential_version, transfer_count,
                     last_bound_at, last_unbound_at, previous_machine_code,
                     binding_role, merged_into_code_id, merged_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '', 1, 0, ?, '', '', ?, '', '')
                """,
                (
                    clean_app, code_id, current_hash, clean_machine, now, now,
                    payload_text, now, role,
                ),
            )

        current_row = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (clean_app, code_id),
        ).fetchone()
        _ensure_point_account_for_binding(conn, current_row, now)
        conn.commit()

    public_payload["code_id"] = code_id
    license_state = public_license(public_payload, clean_machine, clean_app, already_bound)
    license_state.update({
        "action": "already_bound" if already_bound else ("rebound" if replacement_rebound else "activated"),
        "compatibility_mode": "legacy_v1",
        "binding_status": "active",
        "primary_code_id": code_id,
    })
    if replacement_rebound:
        license_state["grant_score"] = 0
        license_state["transferred"] = True
    license_state["_feishu_event"] = {
        "activated_at": activated_at,
        "app_name": clean_app,
        "activation_code": clean_code,
        "code_id": code_id,
        "code_hash": current_hash,
        "license_type": license_state["license_type"],
        "credits": license_state["credits"],
        "duration_days": license_state.get("duration_days", 0),
        "unlimited": license_state["unlimited"],
        "machine_code": clean_machine,
        "activation_result": "重复激活成功" if already_bound else "激活成功",
        "error": "",
        "server_time": now,
    }
    return license_state


def _truthy(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "无限"}


def import_redeem_codes(csv_path, app_name):
    clean_app = normalize_app_name(app_name, allow_legacy_default=False)
    init_db()
    path = Path(csv_path)
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as file_handle:
        for index, row in enumerate(csv.DictReader(file_handle), start=2):
            code = normalize_redeem_code(
                row.get("兑换码") or row.get("激活码") or row.get("code") or "",
                clean_app,
            )
            if not code:
                raise ValueError(f"第 {index} 行缺少激活码。")
            if clean_app == LEGACY_APP_NAME and not code.startswith("OVD-"):
                raise ValueError(f"第 {index} 行旧软件短码格式不正确：{code}")

            unlimited = _truthy(row.get("无限") or row.get("unlimited"))
            if clean_app == QIANCHUAN_APP_NAME and unlimited:
                raise ValueError("千川客户端当前只支持有限积分码，不能导入无限积分码。")
            default_credits = (app_config(clean_app) or {"default_credits": int(INITIAL_CREDITS)})["default_credits"]
            credits = int(row.get("积分") or row.get("credits") or default_credits)
            if not unlimited and credits <= 0:
                raise ValueError(f"第 {index} 行积分必须大于 0。")

            rows.append((
                clean_app,
                str(row.get("code_id") or row.get("编号") or code_hash_for_app(code, clean_app)[:16]).upper(),
                code_hash_for_app(code, clean_app),
                code,
                0 if unlimited else credits,
                1 if unlimited else 0,
                str(row.get("授权类型") or row.get("license_type") or ("unlimited" if unlimited else "standard")),
                str(row.get("过期时间") or row.get("expires_at") or ""),
                1 if _truthy(row.get("停用") or row.get("disabled")) else 0,
                str(row.get("创建时间") or row.get("created_at") or utc_now()),
                str(row.get("备注") or row.get("note") or ""),
            ))

    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            """
            INSERT INTO redeem_codes
                (app_name, code_id, code_hash, code_plaintext, credits, unlimited, license_type,
                 expires_at, disabled, created_at, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(app_name, code_id) DO UPDATE SET
                code_hash = excluded.code_hash,
                code_plaintext = excluded.code_plaintext,
                credits = excluded.credits,
                unlimited = excluded.unlimited,
                license_type = excluded.license_type,
                expires_at = excluded.expires_at,
                disabled = excluded.disabled,
                note = excluded.note
            """,
            rows,
        )
        conn.commit()
    if clean_app in {QIANCHUAN_APP_NAME, DADAO_SOCIAL_COMMENT_APP_NAME}:
        sync_result = enqueue_feishu_inventory(
            clean_app,
            code_ids=[row[1] for row in rows],
        )
        print(
            "queued "
            f"{sync_result['queued']} Feishu inventory records for {clean_app}; "
            f"skipped {sync_result['skipped_without_plaintext']} without plaintext"
        )
    print(f"imported {len(rows)} redeem codes for {clean_app} into {DB_PATH}")


def import_hashed_codes(csv_path, app_name):
    clean_app = normalize_app_name(app_name, allow_legacy_default=False)
    if clean_app != QIANCHUAN_LAPIAN_APP_NAME:
        raise ValueError("哈希清单导入仅用于拉片工具历史激活码。")
    init_db()
    path = Path(csv_path)
    rows = []
    with path.open("r", encoding="utf-8-sig", newline="") as file_handle:
        for index, row in enumerate(csv.DictReader(file_handle), start=2):
            code_id = str(row.get("code_id") or row.get("编号") or "").strip().upper()
            stored_hash = str(row.get("code_hash") or row.get("hash") or "").strip().lower()
            if not code_id:
                raise ValueError(f"第 {index} 行缺少 code_id。")
            if len(stored_hash) != 64 or any(ch not in "0123456789abcdef" for ch in stored_hash):
                raise ValueError(f"第 {index} 行 code_hash 格式不正确。")
            unlimited = _truthy(row.get("无限") or row.get("unlimited"))
            credits = 0 if unlimited else int(row.get("积分") or row.get("credits") or 300)
            if not unlimited and credits <= 0:
                raise ValueError(f"第 {index} 行积分必须大于 0。")
            rows.append((
                clean_app,
                code_id,
                stored_hash,
                "",
                credits,
                1 if unlimited else 0,
                str(row.get("授权类型") or row.get("license_type") or ("unlimited" if unlimited else "pro")),
                str(row.get("过期时间") or row.get("expires_at") or ""),
                1 if _truthy(row.get("停用") or row.get("disabled")) else 0,
                str(row.get("创建时间") or row.get("created_at") or utc_now()),
                str(row.get("备注") or row.get("note") or "拉片工具历史授权码哈希导入"),
            ))
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.executemany(
            """
            INSERT INTO redeem_codes
                (app_name, code_id, code_hash, code_plaintext, credits, unlimited, license_type,
                 expires_at, disabled, created_at, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(app_name, code_id) DO UPDATE SET
                code_hash = excluded.code_hash,
                code_plaintext = CASE
                    WHEN excluded.code_plaintext <> '' THEN excluded.code_plaintext
                    ELSE redeem_codes.code_plaintext
                END,
                credits = excluded.credits,
                unlimited = excluded.unlimited,
                license_type = excluded.license_type,
                expires_at = excluded.expires_at,
                disabled = excluded.disabled,
                note = excluded.note
            """,
            rows,
        )
        conn.commit()
    print(f"imported {len(rows)} hashed codes for {clean_app} into {DB_PATH}")


def export_feishu_inventory(csv_path, app_name):
    clean_app = normalize_app_name(app_name, allow_legacy_default=False)
    init_db()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            """
            SELECT r.app_name, r.code_id, r.code_hash, r.code_plaintext, r.license_type,
                   r.credits, r.unlimited, a.bound_machine_code,
                   a.activated_at
            FROM redeem_codes AS r
            LEFT JOIN activations AS a
              ON a.app_name = r.app_name AND a.code_id = r.code_id
            WHERE r.app_name = ?
            ORDER BY r.created_at, r.code_id
            """,
            (clean_app,),
        ).fetchall()
    output = Path(csv_path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    fields = [
        "激活时间", "软件 app_name", "激活码", "激活码 code_id", "激活码 hash",
        "授权类型", "积分", "是否无限", "绑定机器码", "用户 IP",
        "客户端版本", "激活结果", "错误信息", "服务器时间",
    ]
    server_time = utc_now()
    with output.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            activated_at = str(row[8] or "")
            writer.writerow({
                "激活时间": activated_at,
                "软件 app_name": str(row[0]),
                "激活码": str(row[3] or ""),
                "激活码 code_id": str(row[1]),
                "激活码 hash": str(row[2]),
                "授权类型": str(row[4]),
                "积分": int(row[5] or 0),
                "是否无限": bool(row[6]),
                "绑定机器码": str(row[7] or ""),
                "用户 IP": "",
                "客户端版本": "",
                "激活结果": "已使用" if activated_at else "未使用",
                "错误信息": "",
                "服务器时间": server_time,
            })
    print(f"exported {len(rows)} Feishu inventory rows for {clean_app}: {output}")


def _uses_device_rebind_protocol(data, headers=None):
    raw_version = data.get("license_protocol_version")
    try:
        if int(raw_version or 0) >= 2:
            return True
    except (TypeError, ValueError):
        pass
    return False


def handle_activation_payload(data, user_ip="", headers=None):
    requested_app = str(data.get("app_name") or "").strip()
    authenticated_row = None
    authorization = str((headers or {}).get("Authorization") or "")
    uses_v2 = _uses_device_rebind_protocol(data, headers)
    if authorization and uses_v2:
        authenticated_row = _device_auth(headers or {})
    activation_code = str(data.get("code") or data.get("activation_code") or "").strip()
    with qianchuan_redeem_lock(requested_app):
        _guard_qianchuan_central_activation(
            activation_code, requested_app, bool(data.get("confirm_merge"))
        )
        if uses_v2:
            license_state = activate_remote(
                activation_code,
                str(data.get("machine_code") or data.get("machine_id") or "").strip(),
                requested_app,
                str(data.get("device_credential") or "").strip(),
                str(data.get("current_code_id") or "").strip(),
                bool(data.get("confirm_merge")),
                bool(data.get("credential_refresh")),
                authenticated_row,
            )
        else:
            license_state = activate_remote_legacy(
                activation_code,
                str(data.get("machine_code") or data.get("machine_id") or "").strip(),
                requested_app,
            )
    sync_event = license_state.pop("_feishu_event", {})
    if sync_event:
        sync_event["user_ip"] = str(user_ip or "")
        sync_event["client_version"] = str(data.get("client_version") or "")
        try:
            enqueue_feishu_activation(sync_event)
        except Exception as exc:
            sys.stderr.write(f"[{utc_now()}] Failed to queue Feishu activation: {exc}\n")
    credits = int(license_state.get("credits") or 0)
    action = str(license_state.get("action") or "activated")
    legacy_mode = str(license_state.get("compatibility_mode") or "") == "legacy_v1"
    is_time_based = str(license_state.get("entitlement_type") or "") == "time"
    grant_score = 0 if action == "rebound" else (
        0 if (is_time_based and not legacy_mode)
        else (credits if (legacy_mode or action == "activated") else 0)
    )
    message = (
        "余额合并成功，目标主激活码保持不变。"
        if action == "balance_merged"
        else (
            "换机绑定成功，原有剩余积分已迁移。"
            if action == "rebound"
            else (
                "旧版主激活记录未在服务器登记，已将当前兑换码设为新的主激活码。"
                if action == "legacy_primary_adopted"
                else ("该激活码已绑定本机，设备凭证有效。" if action == "already_bound" else "激活成功")
            )
        )
    )
    return {
        "ok": True,
        "success": True,
        "code": 200,
        "message": message,
        "action": action,
        "grant_score": grant_score,
        "primary_code_id": license_state.get("primary_code_id"),
        "merged_code_id": license_state.get("merged_code_id"),
        "transferred_balance": license_state.get("transferred_balance"),
        "balance": license_state.get("balance"),
        "data": {
            "grant_score": grant_score,
            "score": credits,
            "app_name": license_state["app_name"],
            "already_bound": bool(license_state.get("already_bound")),
        },
        "license": license_state,
    }


class PointsError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = int(status)


AI_LABEL_APP_NAME = "OriginalVideoDedupTool"
AI_LABEL_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,160}$")
AI_LABEL_MAX_FRAMES = 10_000_000
AI_LABEL_MAX_SUBTITLE_TRACKS = 10_000


def _ai_label_nonnegative_int(data, name, maximum):
    value = data.get(name)
    if isinstance(value, bool) or not isinstance(value, int):
        raise PointsError(f"{name} 必须是非负整数。", 400)
    if value < 0 or value > maximum:
        raise PointsError(f"{name} 超出允许范围。", 400)
    return value


def handle_ai_label_consume(data, headers):
    forbidden = {
        "activation_code", "license_id", "code_id", "price", "points",
        "amount", "charge_points", "charged_points", "balance",
    }
    if forbidden.intersection(data):
        raise PointsError("请求包含不允许由客户端控制的计费字段。", 400)
    if str(data.get("app_name") or "") != AI_LABEL_APP_NAME:
        raise PointsError("app_name 与该积分接口不匹配。", 403)
    request_id = str(data.get("request_id") or "").strip()
    video_task_id = str(data.get("video_task_id") or "").strip()
    if not AI_LABEL_ID_RE.fullmatch(request_id):
        raise PointsError("缺少有效的 request_id。", 400)
    if not AI_LABEL_ID_RE.fullmatch(video_task_id):
        raise PointsError("缺少有效的 video_task_id。", 400)
    output_verified = data.get("output_verified")
    metadata_removed = data.get("metadata_removed", False)
    if not isinstance(output_verified, bool):
        raise PointsError("output_verified 必须是布尔值。", 400)
    if not isinstance(metadata_removed, bool):
        raise PointsError("metadata_removed 必须是布尔值。", 400)
    visible_frames = _ai_label_nonnegative_int(
        data, "visible_removed_frames", AI_LABEL_MAX_FRAMES
    )
    subtitle_frames = _ai_label_nonnegative_int(
        data, "subtitle_removed_frames", AI_LABEL_MAX_FRAMES
    )
    subtitle_tracks = _ai_label_nonnegative_int(
        data, "subtitle_track_count_removed", AI_LABEL_MAX_SUBTITLE_TRACKS
    )

    row = _device_auth(headers)
    app_name = str(row["app_name"])
    code_id = str(row["code_id"])
    machine_code = str(row["bound_machine_code"] or "").strip().upper()
    requested_machine = str(data.get("machine_code") or "").strip().upper()
    if app_name != AI_LABEL_APP_NAME:
        raise PointsError("当前授权不属于原创视频去重去暗水印工具。", 403)
    if not requested_machine or requested_machine != machine_code:
        raise PointsError("机器码与当前设备授权不匹配。", 403)
    try:
        entitlement = json.loads(str(row.get("payload_json") or "{}"))
    except json.JSONDecodeError:
        entitlement = {}
    if _time_entitlement(entitlement, app_name):
        raise PointsError("该授权不使用积分接口。", 409)

    visible_points = 1 if output_verified and visible_frames > 0 else 0
    subtitle_points = 2 if output_verified and (subtitle_frames > 0 or subtitle_tracks > 0) else 0
    total_points = visible_points + subtitle_points
    now = utc_now()
    client_version = str(data.get("client_version") or "").strip()[:80]
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        account = conn.execute(
            """
            SELECT balance, unlimited, balance_mode, billing_api
            FROM point_accounts
            WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
            """,
            (app_name, code_id, machine_code),
        ).fetchone()
        if not account:
            raise PointsError("该授权尚未建立服务器积分账户。", 409)
        if str(account["balance_mode"] or "") != "server_managed":
            raise PointsError("该授权余额仍在迁移中，暂不能使用服务器扣费。", 409)
        if str(account["billing_api"] or "") not in {"credits_consume", "legacy_points"}:
            raise PointsError("该授权当前使用不兼容的计费接口。", 409)

        existing = conn.execute(
            """
            SELECT * FROM ai_label_consumptions
            WHERE app_name = ? AND code_id = ? AND machine_code = ?
              AND request_id = ? AND video_task_id = ?
            """,
            (app_name, code_id, machine_code, request_id, video_task_id),
        ).fetchone()
        if existing:
            current = conn.execute(
                """
                SELECT balance, unlimited FROM point_accounts
                WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
                """,
                (app_name, code_id, machine_code),
            ).fetchone()
            conn.commit()
            unlimited = bool(current["unlimited"])
            result = {
                "ok": True,
                "charged_points": int(existing["total_points"] or 0),
                "remaining_points": 999999999 if unlimited else int(current["balance"] or 0),
                "charge_items": {
                    "visible_label": int(existing["visible_label_points"] or 0),
                    "subtitle": int(existing["subtitle_points"] or 0),
                    "metadata": 0,
                },
                "already_consumed": True,
                "unlimited": unlimited,
                "request_id": request_id,
                "video_task_id": video_task_id,
            }
            status = str(existing["status"] or "")
            if status.startswith("no_charge_"):
                result["no_charge_reason"] = status.removeprefix("no_charge_")
            return result

        unlimited = bool(account["unlimited"])
        before = int(account["balance"] or 0)
        if total_points == 0:
            no_charge_reason = (
                "output_not_verified" if not output_verified else "no_billable_target"
            )
            conn.execute(
                """
                INSERT INTO ai_label_consumptions
                    (consumption_id, app_name, code_id, machine_code, request_id,
                     video_task_id, visible_label_points, subtitle_points, total_points,
                     balance_before, balance_after, unlimited, credit_transaction_id,
                     status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, '', ?, ?)
                """,
                (
                    "alc_" + secrets.token_hex(12), app_name, code_id, machine_code,
                    request_id, video_task_id, before, before,
                    1 if unlimited else 0, "no_charge_" + no_charge_reason, now,
                ),
            )
            conn.commit()
            return {
                "ok": True,
                "charged_points": 0,
                "remaining_points": 999999999 if unlimited else before,
                "charge_items": {"visible_label": 0, "subtitle": 0, "metadata": 0},
                "already_consumed": False,
                "unlimited": unlimited,
                "request_id": request_id,
                "video_task_id": video_task_id,
                "no_charge_reason": no_charge_reason,
            }

        charged = 0 if unlimited else total_points
        after = before
        if not unlimited:
            if before < total_points:
                raise PointsError("积分不足。", 402)
            changed = conn.execute(
                """
                UPDATE point_accounts SET balance = balance - ?, updated_at = ?
                WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
                  AND balance >= ? AND unlimited = 0
                """,
                (total_points, now, app_name, code_id, machine_code, total_points),
            ).rowcount
            if changed != 1:
                raise PointsError("积分不足或余额已发生变化。", 402)
            after = before - total_points

        consumption_id = "alc_" + secrets.token_hex(12)
        transaction_id = ""
        if not unlimited:
            transaction_id = "txn_" + secrets.token_hex(12)
            transaction_request_id = "ai_label:" + hashlib.sha256(
                "\x1f".join(
                    (app_name, code_id, machine_code, request_id, video_task_id)
                ).encode("utf-8")
            ).hexdigest()
            conn.execute(
                """
                INSERT INTO credit_transactions
                    (transaction_id, app_name, code_id, request_id, machine_code,
                     transaction_type, amount, reason, balance_before, balance_after,
                     unlimited, client_version, created_at)
                VALUES (?, ?, ?, ?, ?, 'consume', ?, ?, ?, ?, 0, ?, ?)
                """,
                (
                    transaction_id, app_name, code_id, transaction_request_id,
                    machine_code, charged, "06 AI标签/字幕擦除",
                    before, after, client_version, now,
                ),
            )
        conn.execute(
            """
            INSERT INTO ai_label_consumptions
                (consumption_id, app_name, code_id, machine_code, request_id,
                 video_task_id, visible_label_points, subtitle_points, total_points,
                 balance_before, balance_after, unlimited, credit_transaction_id,
                 status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)
            """,
            (
                consumption_id, app_name, code_id, machine_code, request_id,
                video_task_id, visible_points if not unlimited else 0,
                subtitle_points if not unlimited else 0, charged, before, after,
                1 if unlimited else 0, transaction_id, now,
            ),
        )
        conn.commit()
    return {
        "ok": True,
        "charged_points": charged,
        "remaining_points": 999999999 if unlimited else after,
        "charge_items": {
            "visible_label": visible_points if not unlimited else 0,
            "subtitle": subtitle_points if not unlimited else 0,
            "metadata": 0,
        },
        "already_consumed": False,
        "unlimited": unlimited,
        "request_id": request_id,
        "video_task_id": video_task_id,
    }


def _por_precise_identity(headers):
    if not POR_PRECISE_ENABLED or not POR_PRECISE_INTERNAL_TOKEN:
        raise PreciseCreditError("precise credits are disabled", 503)
    supplied = str(headers.get("X-POR-Internal-Token") or "")
    if not hmac.compare_digest(supplied, POR_PRECISE_INTERNAL_TOKEN):
        raise PreciseCreditError("precise credits are not authorized", 403)
    row = _device_auth(headers)
    if str(row["app_name"]) != POR_PRECISE_APP_NAME:
        raise PreciseCreditError("precise credits are restricted to ProductOperationReport", 403)
    return str(row["code_id"]), str(row["bound_machine_code"] or "").upper()


def handle_por_precise_balance(headers):
    code_id, machine_code = _por_precise_identity(headers)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        ensure_por_precise_schema(conn)
        result = por_precise_balance(conn, code_id, machine_code)
        conn.commit()
    return result


def handle_por_precise_consume(data, headers):
    code_id, machine_code = _por_precise_identity(headers)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        ensure_por_precise_schema(conn)
        result = por_precise_consume(
            conn, code_id, machine_code,
            data.get("logical_task_id"), data.get("attempt_id"),
            data.get("amount_units"), data.get("billed_model"),
            data.get("bill_ref"), data.get("cost_cny"),
            POR_PRECISE_POINTS_PER_CNY, POR_PRECISE_COST_RATE,
        )
        conn.commit()
    return result


def handle_credit_consume(data, headers):
    row = _device_auth(headers)
    amount = int(data.get("amount") or 0)
    request_id = str(data.get("request_id") or "").strip()
    reason = str(data.get("reason") or "").strip()[:200]
    client_version = str(data.get("client_version") or "").strip()[:80]
    if amount <= 0:
        raise PointsError("消费积分必须大于 0。", 400)
    if not request_id or len(request_id) > 200:
        raise PointsError("缺少有效的 request_id。", 400)
    try:
        payload = json.loads(str(row.get("payload_json") or "{}"))
    except json.JSONDecodeError:
        payload = {}
    if _time_entitlement(payload, row["app_name"]):
        raise PointsError("该软件使用时间授权，不使用积分接口。", 409)

    app_name = str(row["app_name"])
    code_id = str(row["code_id"])
    machine_code = str(row["bound_machine_code"] or "").strip().upper()
    now = utc_now()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            """
            SELECT transaction_id, balance_after, unlimited, amount, reason, transaction_type
            FROM credit_transactions
            WHERE app_name = ? AND code_id = ? AND request_id = ?
            """,
            (app_name, code_id, request_id),
        ).fetchone()
        if existing:
            expected_amount = 0 if existing["unlimited"] else amount
            if (
                str(existing["transaction_type"] or "") != "consume"
                or int(existing["amount"] or 0) != expected_amount
                or str(existing["reason"] or "") != reason
            ):
                raise PointsError("request_id 已用于不同的消费请求。", 409)
            conn.commit()
            return {
                "ok": True,
                "success": True,
                "idempotent": True,
                "remaining_credits": 999999999 if existing["unlimited"] else int(existing["balance_after"] or 0),
                "unlimited": bool(existing["unlimited"]),
                "transaction_id": str(existing["transaction_id"]),
            }
        account = conn.execute(
            """
            SELECT balance, unlimited, balance_mode, billing_api
            FROM point_accounts
            WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
            """,
            (app_name, code_id, machine_code),
        ).fetchone()
        if not account:
            raise PointsError("该授权尚未完成服务器余额迁移。", 409)
        if str(account["balance_mode"] or "") != "server_managed":
            raise PointsError("该授权余额仍在迁移中，暂不能使用服务器扣费。", 409)
        if str(account["billing_api"] or "") != "credits_consume":
            raise PointsError("该软件当前使用其他计费接口，已拒绝重复扣费。", 409)
        unlimited = bool(account["unlimited"])
        before = int(account["balance"] or 0)
        after = before
        if not unlimited:
            if before < amount:
                raise PointsError("积分不足。", 400)
            changed = conn.execute(
                """
                UPDATE point_accounts SET balance = balance - ?, updated_at = ?
                WHERE app_name = ? AND code_id = ? AND UPPER(machine_code) = ?
                  AND balance >= ? AND unlimited = 0
                """,
                (amount, now, app_name, code_id, machine_code, amount),
            ).rowcount
            if changed != 1:
                raise PointsError("积分不足或余额已发生变化。", 400)
            after = before - amount
        transaction_id = secrets.token_urlsafe(18)
        conn.execute(
            """
            INSERT INTO credit_transactions
                (transaction_id, app_name, code_id, request_id, machine_code,
                 transaction_type, amount, reason, balance_before, balance_after,
                 unlimited, client_version, created_at)
            VALUES (?, ?, ?, ?, ?, 'consume', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                transaction_id, app_name, code_id, request_id, machine_code,
                0 if unlimited else amount, reason, before, after,
                1 if unlimited else 0, client_version, now,
            ),
        )
        conn.commit()
    return {
        "ok": True,
        "success": True,
        "idempotent": False,
        "remaining_credits": 999999999 if unlimited else after,
        "unlimited": unlimited,
        "transaction_id": transaction_id,
    }


def handle_time_renew(data, headers):
    primary = _device_auth(headers, allow_expired=True)
    app_name = str(primary["app_name"])
    machine_code = str(primary["bound_machine_code"] or "").strip().upper()
    request_id = str(data.get("request_id") or "").strip()
    renewal_code = str(data.get("activation_code") or data.get("code") or "").strip()
    client_version = str(data.get("client_version") or "").strip()[:80]
    if not bool(data.get("confirm_renewal")):
        raise DeviceApiError("续期前必须明确确认。", 400)
    if not request_id or len(request_id) > 200:
        raise DeviceApiError("缺少有效的 request_id。", 400)
    if not renewal_code:
        raise DeviceApiError("请输入续期卡激活码。", 400)
    try:
        primary_payload = json.loads(str(primary.get("payload_json") or "{}"))
    except json.JSONDecodeError:
        primary_payload = {}
    if not _time_entitlement(primary_payload, app_name):
        raise DeviceApiError("该授权不是时间授权，不能使用时间卡续期接口。", 409)
    renewal_payload, clean_code = payload_for_code(renewal_code, app_name)
    if not _time_entitlement(renewal_payload, app_name):
        raise DeviceApiError("该激活码不是时间卡。", 409)
    duration_days = int(renewal_payload.get("duration_days") or 0)
    if duration_days <= 0:
        raise DeviceApiError("续期卡没有有效时长。", 409)
    if _server_is_expired(str(renewal_payload.get("expires_at") or "")):
        raise DeviceApiError("这张时间卡已过期。", 409)
    renewal_hash = code_hash_for_app(clean_code, app_name)
    renewal_code_id = str(renewal_payload.get("code_id") or renewal_hash[:16]).upper()
    primary_code_id = str(primary["code_id"])
    now = utc_now()
    now_dt = datetime.now(timezone.utc)
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN IMMEDIATE")
        repeated = conn.execute(
            """
            SELECT renewal_id, renewal_code_id, duration_days, old_expires_at, new_expires_at
            FROM time_renewals
            WHERE app_name = ? AND primary_code_id = ? AND request_id = ?
            """,
            (app_name, primary_code_id, request_id),
        ).fetchone()
        if repeated:
            conn.commit()
            return {
                "ok": True,
                "success": True,
                "action": "time_renewed",
                "idempotent": True,
                "renewal_id": str(repeated["renewal_id"]),
                "duration_days": int(repeated["duration_days"]),
                "old_expires_at": str(repeated["old_expires_at"]),
                "expires_at": str(repeated["new_expires_at"]),
                "remaining_days": _time_status({"expires_at": repeated["new_expires_at"]})["remaining_days"],
            }
        consumed = conn.execute(
            "SELECT binding_role, merged_into_code_id FROM activations WHERE app_name = ? AND code_id = ?",
            (app_name, renewal_code_id),
        ).fetchone()
        if consumed:
            raise DeviceApiError("这张时间卡已经使用，不能再次续期。", 409)
        current = conn.execute(
            "SELECT * FROM activations WHERE app_name = ? AND code_id = ?",
            (app_name, primary_code_id),
        ).fetchone()
        if not current or str(current["binding_status"] or "") != "active":
            raise DeviceApiError("当前主授权已失效。", 401)
        current_payload = json.loads(str(current["payload_json"] or "{}"))
        old_expires_at = str(current_payload.get("expires_at") or "")
        old_expiry = _parse_utc(old_expires_at)
        base = old_expiry if old_expiry and old_expiry > now_dt else now_dt
        new_expiry = base + timedelta(days=duration_days)
        new_expires_at = new_expiry.isoformat(timespec="seconds").replace("+00:00", "Z")
        current_payload["expires_at"] = new_expires_at
        conn.execute(
            """
            UPDATE activations SET payload_json = ?, last_seen_at = ?
            WHERE app_name = ? AND code_id = ?
            """,
            (json.dumps(current_payload, ensure_ascii=False, sort_keys=True), now, app_name, primary_code_id),
        )
        renewal_payload["expires_at"] = new_expires_at
        conn.execute(
            """
            INSERT INTO activations
                (app_name, code_id, code_hash, bound_machine_code, activated_at,
                 last_seen_at, payload_json, binding_status, device_credential_hash,
                 credential_version, transfer_count, last_bound_at, last_unbound_at,
                 previous_machine_code, binding_role, merged_into_code_id, merged_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '', 1, 0, ?, '', '',
                    'renewal', ?, ?)
            """,
            (
                app_name, renewal_code_id, renewal_hash, machine_code, now, now,
                json.dumps(renewal_payload, ensure_ascii=False, sort_keys=True), now,
                primary_code_id, now,
            ),
        )
        renewal_id = secrets.token_urlsafe(18)
        conn.execute(
            """
            INSERT INTO time_renewals
                (renewal_id, app_name, primary_code_id, renewal_code_id, request_id,
                 machine_code, duration_days, old_expires_at, new_expires_at,
                 client_version, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                renewal_id, app_name, primary_code_id, renewal_code_id, request_id,
                machine_code, duration_days, old_expires_at, new_expires_at,
                client_version, now,
            ),
        )
        conn.commit()
    return {
        "ok": True,
        "success": True,
        "action": "time_renewed",
        "idempotent": False,
        "renewal_id": renewal_id,
        "duration_days": duration_days,
        "old_expires_at": old_expires_at,
        "expires_at": new_expires_at,
        "remaining_days": _time_status({"expires_at": new_expires_at})["remaining_days"],
    }


def require_points_token(headers):
    if not POINTS_INTERNAL_TOKEN:
        raise PointsError("服务器尚未配置积分内部令牌。", 503)
    received = str(headers.get("X-Internal-Token") or headers.get("x-internal-token") or "").strip()
    if not secrets.compare_digest(received, POINTS_INTERNAL_TOKEN):
        raise PointsError("积分接口认证失败。", 403)


def _reservation_expiry():
    return (
        datetime.utcnow() + timedelta(seconds=POINT_RESERVATION_TTL_SECONDS)
    ).isoformat(timespec="seconds") + "Z"


def _points_auth(data, conn):
    clean_app = normalize_app_name(str(data.get("app_name") or "").strip(), allow_legacy_default=False)
    if clean_app in TIME_BASED_APPS:
        raise PointsError("该软件使用时间授权，不使用积分接口。", 409)
    activation_code = str(data.get("activation_code") or data.get("code") or "").strip()
    requested_code_id = str(data.get("code_id") or "").strip().upper()
    machine_code = str(data.get("machine_code") or data.get("machine_id") or "").strip().upper()
    if not machine_code:
        raise PointsError("缺少机器码，无法扣积分。", 401)
    if activation_code:
        clean_code = normalize_redeem_code(activation_code, clean_app)
        current_hash = code_hash_for_app(clean_code, clean_app)
        code_id = current_hash[:16].upper()
    elif requested_code_id:
        # Internal business proxies already authenticate with POINTS_INTERNAL_TOKEN.
        # Accepting the opaque code_id keeps the activation code out of proxy sessions.
        if not re.fullmatch(r"[A-Z0-9._:-]{1,160}", requested_code_id):
            raise PointsError("授权编号格式无效。", 401)
        code_id = requested_code_id
        current_hash = ""
    else:
        raise PointsError("缺少激活码或授权编号，无法扣积分。", 401)
    activation = conn.execute(
        """
        SELECT code_hash, bound_machine_code, payload_json, binding_status, transfer_count,
               binding_role
        FROM activations
        WHERE app_name = ? AND code_id = ?
        """,
        (clean_app, code_id),
    ).fetchone()
    if not activation:
        raise PointsError("授权尚未激活，请先在软件中激活。", 401)
    if str(activation[3] or "active") != "active":
        raise PointsError("授权当前已解绑。", 403)
    if str(activation[5] or "primary") != "primary":
        raise PointsError("合并码不能用于业务扣费。", 403)
    if current_hash and str(activation[0] or "") != current_hash:
        raise PointsError("激活码编号冲突，请联系管理员。", 409)
    current_hash = str(activation[0] or "")
    if str(activation[1] or "").strip().upper() != machine_code:
        raise PointsError("机器码不匹配，不能扣积分。", 403)
    code_row = conn.execute(
        "SELECT disabled FROM redeem_codes WHERE app_name = ? AND code_id = ?",
        (clean_app, code_id),
    ).fetchone()
    if code_row and int(code_row[0] or 0):
        raise PointsError("这个兑换码已被停用。", 403)
    try:
        payload = json.loads(str(activation[2] or "{}"))
    except json.JSONDecodeError:
        payload = {}
    if _server_is_expired(str(payload.get("expires_at") or "")):
        raise PointsError("授权已过期，请使用新的激活码。", 403)
    unlimited = bool(payload.get("unlimited"))
    credits = int(payload.get("credits") or payload.get("grant_score") or 0)
    if int(activation[4] or 0) > 0:
        credits = 0
    now = utc_now()
    account = conn.execute(
        """
        SELECT balance, unlimited, billing_api
        FROM point_accounts
        WHERE app_name = ? AND code_id = ? AND machine_code = ?
        """,
        (clean_app, code_id, machine_code),
    ).fetchone()
    if not account:
        conn.execute(
            """
            INSERT INTO point_accounts
                (app_name, code_id, machine_code, code_hash, balance, unlimited, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (clean_app, code_id, machine_code, current_hash, 0 if unlimited else credits, 1 if unlimited else 0, now, now),
        )
        balance = 0 if unlimited else credits
    else:
        balance = int(account[0] or 0)
        unlimited = bool(account[1])
        if str(account[2] or "legacy_points") == "credits_consume":
            raise PointsError("该授权使用 credits/consume 计费，已拒绝重复扣费。", 409)
    return {
        "app_name": clean_app,
        "code_id": code_id,
        "machine_code": machine_code,
        "code_hash": current_hash,
        "balance": balance,
        "unlimited": unlimited,
    }

def _reserved_total(conn, auth):
    row = conn.execute(
        """
        SELECT COALESCE(SUM(points), 0)
        FROM point_reservations
        WHERE app_name = ? AND code_id = ? AND machine_code = ? AND status = 'reserved'
        """,
        (auth["app_name"], auth["code_id"], auth["machine_code"]),
    ).fetchone()
    return int(row[0] or 0)


def _livephoto_mc2_for_points(conn, auth, data):
    if auth["app_name"] != LIVE_PHOTO_STUDIO_APP_NAME:
        return ""
    requested = str(data.get("mc2_id") or "").strip().upper()
    row = conn.execute(
        """
        SELECT mc2_id
        FROM livephoto_mc2_devices
        WHERE app_name = ? AND code_id = ?
          AND UPPER(legacy_machine_code) = ? AND status = 'active'
        """,
        (auth["app_name"], auth["code_id"], auth["machine_code"]),
    ).fetchone()
    actual = str(row[0] or "") if row else ""
    if requested and requested != actual:
        raise PointsError("MC2 设备身份与当前授权不匹配。", 403)
    return actual


def _record_livephoto_point_event(
    conn, *, auth, reservation_id, request_id, operation, event_type,
    points, quoted_points, balance_before, balance_after, mc2_id, now,
):
    if auth["app_name"] != LIVE_PHOTO_STUDIO_APP_NAME:
        return
    description = {
        "reserve": "积分预留",
        "commit": "任务成功结算",
        "release": "任务失败或取消释放预留",
    }[event_type]
    conn.execute(
        """
        INSERT OR IGNORE INTO livephoto_point_events
            (transaction_id, request_id, reservation_id, app_name, code_id, mc2_id,
             operation, event_type, points, quoted_points, balance_before,
             balance_after, unlimited, created_at, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            "lpe_" + secrets.token_hex(12), request_id, reservation_id,
            auth["app_name"], auth["code_id"], mc2_id, operation, event_type,
            int(points), int(quoted_points), int(balance_before), int(balance_after),
            1 if auth["unlimited"] else 0, now, description,
        ),
    )


def handle_points_payload(path, data, headers):
    require_points_token(headers)
    init_db()
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.execute("BEGIN IMMEDIATE")
        auth = _points_auth(data, conn)
        mc2_id = _livephoto_mc2_for_points(conn, auth, data)
        now = utc_now()
        if path.endswith("/balance"):
            reserved = _reserved_total(conn, auth)
            conn.commit()
            return {
                "ok": True,
                "balance": auth["balance"],
                "reserved": reserved,
                "available": 999999999 if auth["unlimited"] else auth["balance"],
                "unlimited": auth["unlimited"],
            }

        if path.endswith("/transactions"):
            try:
                limit = max(1, min(int(data.get("limit") or 50), 100))
            except (TypeError, ValueError):
                raise PointsError("流水条数格式无效。", 400)
            rows = conn.execute(
                """
                SELECT transaction_id, request_id, transaction_type, amount, reason,
                       balance_before, balance_after, unlimited, created_at
                FROM credit_transactions
                WHERE app_name = ? AND code_id = ? AND machine_code = ?
                ORDER BY created_at DESC, transaction_id DESC
                LIMIT ?
                """,
                (auth["app_name"], auth["code_id"], auth["machine_code"], limit),
            ).fetchall()
            items = [
                {
                    "transaction_id": str(row[0]),
                    "request_id": str(row[1]),
                    "type": str(row[2]),
                    "points": int(row[3] or 0),
                    "description": str(row[4] or ""),
                    "balance_before": row[5],
                    "balance_after": row[6],
                    "unlimited": bool(row[7]),
                    "created_at": str(row[8]),
                }
                for row in rows
            ]
            if bool(data.get("include_point_events")) and auth["app_name"] == LIVE_PHOTO_STUDIO_APP_NAME:
                legacy_items = items
                event_rows = conn.execute(
                    """
                    SELECT transaction_id, request_id, reservation_id, event_type, points,
                           description, balance_before, balance_after, unlimited, created_at,
                           operation, mc2_id
                    FROM livephoto_point_events
                    WHERE app_name = ? AND code_id = ?
                    ORDER BY created_at DESC, transaction_id DESC
                    LIMIT ?
                    """,
                    (auth["app_name"], auth["code_id"], limit),
                ).fetchall()
                items = [
                    {
                        "transaction_id": str(row[0]),
                        "request_id": str(row[1]),
                        "reservation_id": str(row[2]),
                        "type": str(row[3]),
                        "points": int(row[4] or 0),
                        "description": str(row[5] or ""),
                        "balance_before": int(row[6] or 0),
                        "balance_after": int(row[7] or 0),
                        "unlimited": bool(row[8]),
                        "created_at": str(row[9]),
                        "operation": str(row[10] or ""),
                        "mc2_id": str(row[11] or ""),
                    }
                    for row in event_rows
                ]
                items.extend(
                    item for item in legacy_items
                    if not (
                        item["type"] == "consume"
                        and str(item["request_id"]).startswith("reservation:")
                    )
                )
                items.sort(
                    key=lambda item: (str(item["created_at"]), str(item["transaction_id"])),
                    reverse=True,
                )
            reserved = _reserved_total(conn, auth)
            conn.commit()
            return {
                "ok": True,
                "balance": auth["balance"],
                "reserved": reserved,
                "available": 999999999 if auth["unlimited"] else auth["balance"],
                "unlimited": auth["unlimited"],
                "items": items[:limit],
            }

        if path.endswith("/reserve"):
            points = int(data.get("points") or 0)
            if points <= 0:
                raise PointsError("预扣积分必须大于 0。", 400)
            idempotency_key = str(data.get("idempotency_key") or "").strip()
            if not idempotency_key:
                raise PointsError("缺少 idempotency_key。", 400)
            existing = conn.execute(
                """
                SELECT reservation_id, points, status
                FROM point_reservations
                WHERE app_name = ? AND machine_code = ? AND idempotency_key = ?
                """,
                (auth["app_name"], auth["machine_code"], idempotency_key),
            ).fetchone()
            if existing:
                reservation_id, existing_points, status = existing
                reserved = _reserved_total(conn, auth)
                conn.commit()
                return {
                    "ok": True,
                    "reservation_id": str(reservation_id),
                    "balance": auth["balance"],
                    "reserved": reserved,
                    "status": str(status),
                    "points": int(existing_points or 0),
                    "unlimited": auth["unlimited"],
                }
            if not auth["unlimited"] and auth["balance"] < points:
                raise PointsError("积分不足。", 402)
            reservation_id = secrets.token_urlsafe(18)
            balance_before = int(auth["balance"])
            if not auth["unlimited"]:
                conn.execute(
                    """
                    UPDATE point_accounts
                    SET balance = balance - ?, updated_at = ?
                    WHERE app_name = ? AND code_id = ? AND machine_code = ?
                    """,
                    (points, now, auth["app_name"], auth["code_id"], auth["machine_code"]),
                )
                auth["balance"] -= points
            conn.execute(
                """
                INSERT INTO point_reservations
                    (reservation_id, app_name, code_id, machine_code, idempotency_key,
                     points, operation, billing_kind, quantity, status, created_at, expires_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)
                """,
                (
                    reservation_id,
                    auth["app_name"],
                    auth["code_id"],
                    auth["machine_code"],
                    idempotency_key,
                    points,
                    str(data.get("operation") or ""),
                    str(data.get("billing_kind") or ""),
                    int(data.get("quantity") or 1),
                    now,
                    _reservation_expiry(),
                    now,
                ),
            )
            _record_livephoto_point_event(
                conn, auth=auth, reservation_id=reservation_id,
                request_id=idempotency_key, operation=str(data.get("operation") or ""),
                event_type="reserve", points=0 if auth["unlimited"] else points,
                quoted_points=points, balance_before=balance_before,
                balance_after=int(auth["balance"]), mc2_id=mc2_id, now=now,
            )
            conn.commit()
            return {
                "ok": True,
                "reservation_id": reservation_id,
                "balance": auth["balance"],
                "reserved": _reserved_total(conn, auth),
                "unlimited": auth["unlimited"],
            }

        reservation_id = str(data.get("reservation_id") or "").strip()
        idempotency_key = str(data.get("idempotency_key") or "").strip()
        if not reservation_id and not idempotency_key:
            raise PointsError("缺少 reservation_id 或 idempotency_key。", 400)
        where = "reservation_id = ?" if reservation_id else "app_name = ? AND machine_code = ? AND idempotency_key = ?"
        params = (reservation_id,) if reservation_id else (auth["app_name"], auth["machine_code"], idempotency_key)
        reservation = conn.execute(
            f"""
            SELECT reservation_id, points, status, idempotency_key, operation,
                   billing_kind, quantity
            FROM point_reservations
            WHERE {where}
              AND app_name = ? AND code_id = ? AND machine_code = ?
            """,
            (*params, auth["app_name"], auth["code_id"], auth["machine_code"]),
        ).fetchone()
        if not reservation:
            raise PointsError("没有找到预扣记录。", 404)
        reservation_id = str(reservation[0])
        points = int(reservation[1] or 0)
        status = str(reservation[2] or "")
        reservation_key = str(reservation[3] or "")
        operation = str(reservation[4] or "")
        if path.endswith("/commit"):
            if status == "reserved":
                conn.execute(
                    "UPDATE point_reservations SET status = 'committed', updated_at = ? WHERE reservation_id = ?",
                    (now, reservation_id),
                )
                status = "committed"
            elif status != "committed":
                raise PointsError(f"当前状态不能确认扣费：{status}", 409)
            if auth["app_name"] == LIVE_PHOTO_STUDIO_APP_NAME:
                charged = 0 if auth["unlimited"] else points
                balance_after = 0 if auth["unlimited"] else auth["balance"]
                balance_before = balance_after if auth["unlimited"] else balance_after + points
                conn.execute(
                    """
                    INSERT OR IGNORE INTO credit_transactions
                        (transaction_id, app_name, code_id, request_id, machine_code,
                         transaction_type, amount, reason, balance_before, balance_after,
                         unlimited, client_version, created_at)
                    VALUES (?, ?, ?, ?, ?, 'consume', ?, ?, ?, ?, ?, '', ?)
                    """,
                    (
                        "txn_" + secrets.token_hex(12),
                        auth["app_name"],
                        auth["code_id"],
                        "reservation:" + reservation_key,
                        auth["machine_code"],
                        charged,
                        operation,
                        balance_before,
                        balance_after,
                        1 if auth["unlimited"] else 0,
                        now,
                    ),
                )
            charged = 0 if auth["unlimited"] else points
            _record_livephoto_point_event(
                conn, auth=auth, reservation_id=reservation_id,
                request_id=reservation_key, operation=operation,
                event_type="commit", points=charged, quoted_points=points,
                balance_before=int(auth["balance"]) + charged,
                balance_after=int(auth["balance"]), mc2_id=mc2_id, now=now,
            )
            conn.commit()
            return {
                "ok": True,
                "status": status,
                "points_used": points,
                "balance": auth["balance"],
                "reserved": _reserved_total(conn, auth),
                "unlimited": auth["unlimited"],
            }
        if path.endswith("/release"):
            release_balance_before = int(auth["balance"])
            if status == "reserved":
                if not auth["unlimited"]:
                    conn.execute(
                        """
                        UPDATE point_accounts
                        SET balance = balance + ?, updated_at = ?
                        WHERE app_name = ? AND code_id = ? AND machine_code = ?
                        """,
                        (points, now, auth["app_name"], auth["code_id"], auth["machine_code"]),
                    )
                    auth["balance"] += points
                conn.execute(
                    "UPDATE point_reservations SET status = 'released', updated_at = ? WHERE reservation_id = ?",
                    (now, reservation_id),
                )
                status = "released"
            elif status == "committed":
                raise PointsError("已确认扣费的记录不能释放。", 409)
            released = 0 if auth["unlimited"] else points
            _record_livephoto_point_event(
                conn, auth=auth, reservation_id=reservation_id,
                request_id=reservation_key, operation=operation,
                event_type="release", points=released, quoted_points=points,
                balance_before=release_balance_before,
                balance_after=int(auth["balance"]), mc2_id=mc2_id, now=now,
            )
            conn.commit()
            return {
                "ok": True,
                "status": status,
                "points_released": points if status == "released" else 0,
                "balance": auth["balance"],
                "reserved": _reserved_total(conn, auth),
                "unlimited": auth["unlimited"],
            }
    raise PointsError("未知积分接口。", 404)


class Handler(BaseHTTPRequestHandler):
    server_version = "OVDTLicenseServer/2.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (utc_now(), fmt % args))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/license/credits/precise/balance":
            try:
                json_response(self, 200, handle_por_precise_balance(self.headers))
            except (DeviceApiError, PreciseCreditError) as exc:
                json_response(self, exc.status, {"ok": False, "message": str(exc)})
            except Exception:
                json_response(self, 500, {"ok": False, "message": "precise balance unavailable"})
            return
        if parsed.path == LIVEPHOTO_MC2_PREFIX + "/runtime":
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "app_name": LIVE_PHOTO_STUDIO_APP_NAME,
                    "mc2Version": LIVEPHOTO_MC2_VERSION,
                    "enabled": bool(LIVEPHOTO_MC2_ENABLED),
                    "challengeTtlSeconds": LIVEPHOTO_MC2_CHALLENGE_TTL_SECONDS,
                    "sessionTtlSeconds": LIVEPHOTO_MC2_SESSION_TTL_SECONDS,
                    "publicKeyFormat": "P-256-X9.63-uncompressed-base64",
                    "signatureFormat": "ECDSA-P256-SHA256-DER-base64",
                },
            )
            return
        if parsed.path == LIVEPHOTO_MC2_PREFIX + "/status":
            try:
                json_response(self, 200, handle_livephoto_mc2_status(self.headers))
            except LivePhotoMC2Error as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "error_code": exc.code, "error": str(exc), "message": str(exc)},
                )
            except Exception:
                json_response(
                    self, 500,
                    {"ok": False, "error_code": "MC2_INTERNAL_ERROR", "error": "MC2 设备验证失败。"},
                )
            return
        if parsed.path == "/health":
            summary = database_summary()
            json_response(
                self,
                200,
                {
                    "ok": True,
                    "service": "license",
                    "schema_version": SCHEMA_VERSION,
                    "apps": sorted(_supported_apps_from_db()),
                    "feishu_sync": {
                        "configured": feishu_configured(),
                        "outbox": summary["feishu_outbox"],
                    },
                    "time": utc_now(),
                },
            )
            return
        if parsed.path == "/api/license/device/status":
            try:
                json_response(self, 200, handle_device_status(self.headers))
            except DeviceApiError as exc:
                json_response(self, exc.status, {"ok": False, "error": str(exc), "message": str(exc)})
            except Exception as exc:
                json_response(self, 500, {"ok": False, "error": str(exc), "message": str(exc)})
            return
        json_response(self, 404, {"ok": False, "error": "unknown endpoint"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/license/credits/precise/consume":
            try:
                json_response(self, 200, handle_por_precise_consume(read_json(self), self.headers))
            except (DeviceApiError, PreciseCreditError) as exc:
                json_response(self, exc.status, {"ok": False, "message": str(exc)})
            except Exception:
                json_response(self, 500, {"ok": False, "message": "precise settlement unavailable"})
            return
        mc2_handlers = {
            LIVEPHOTO_MC2_PREFIX + "/migration/challenge": lambda data: handle_livephoto_mc2_migration_challenge(data, self.headers),
            LIVEPHOTO_MC2_PREFIX + "/migrate": lambda data: handle_livephoto_mc2_migrate(data, self.headers),
            LIVEPHOTO_MC2_PREFIX + "/auth/challenge": handle_livephoto_mc2_auth_challenge,
            LIVEPHOTO_MC2_PREFIX + "/session": handle_livephoto_mc2_session,
        }
        if parsed.path in mc2_handlers:
            try:
                json_response(self, 200, mc2_handlers[parsed.path](read_json(self)))
            except LivePhotoMC2Error as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "error_code": exc.code, "error": str(exc), "message": str(exc)},
                )
            except DeviceApiError as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "error_code": "MC2_LEGACY_AUTH_FAILED", "error": str(exc), "message": str(exc)},
                )
            except Exception:
                json_response(
                    self, 500,
                    {"ok": False, "error_code": "MC2_INTERNAL_ERROR", "error": "MC2 请求处理失败。"},
                )
            return
        if parsed.path == "/api/license/credits/consume":
            try:
                result = handle_credit_consume(read_json(self), self.headers)
                json_response(self, 200, result)
            except DeviceApiError as exc:
                json_response(self, exc.status, {"ok": False, "success": False, "error": str(exc), "message": str(exc)})
            except PointsError as exc:
                json_response(self, exc.status, {"ok": False, "success": False, "error": str(exc), "message": str(exc)})
            except Exception as exc:
                json_response(self, 500, {"ok": False, "success": False, "error": str(exc), "message": str(exc)})
            return
        if parsed.path == "/api/license/points/consume-ai-label":
            try:
                result = handle_ai_label_consume(read_json(self), self.headers)
                json_response(self, 200, result)
            except DeviceApiError as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "error_code": "device_auth_failed", "error": str(exc), "message": str(exc)},
                )
            except PointsError as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "error_code": "ai_label_charge_rejected", "error": str(exc), "message": str(exc)},
                )
            except Exception:
                json_response(
                    self, 500,
                    {"ok": False, "error_code": "internal_error", "error": "积分服务处理失败。", "message": "积分服务处理失败。"},
                )
            return
        if parsed.path == "/api/license/time/renew":
            try:
                result = handle_time_renew(read_json(self), self.headers)
                json_response(self, 200, result)
            except DeviceApiError as exc:
                json_response(self, exc.status, {"ok": False, "success": False, "error": str(exc), "message": str(exc)})
            except Exception as exc:
                json_response(self, 500, {"ok": False, "success": False, "error": str(exc), "message": str(exc)})
            return
        if parsed.path.startswith("/api/license/points/"):
            try:
                result = handle_points_payload(parsed.path, read_json(self), self.headers)
                json_response(self, 200, result)
            except PointsError as exc:
                json_response(self, exc.status, {"ok": False, "success": False, "error": str(exc), "message": str(exc)})
            except Exception as exc:
                json_response(self, 500, {"ok": False, "success": False, "error": str(exc), "message": str(exc)})
            return
        if parsed.path == "/api/license/device/refresh":
            try:
                json_response(self, 200, handle_device_refresh(read_json(self), self.headers))
            except DeviceApiError as exc:
                json_response(self, exc.status, {"ok": False, "error": str(exc), "message": str(exc)})
            except Exception as exc:
                json_response(self, 500, {"ok": False, "error": str(exc), "message": str(exc)})
            return
        if parsed.path == "/api/license/identity/observe":
            # 唯一改动点：ai-media-library 的 v3 机器身份观测。
            #
            # 分两段，界线是"是否已确认归属"：
            #   归属判定阶段 —— 任何失败都返回 404。app_name 只能从请求体里读，
            #     所以必须先 read_json；它自带 65536 字节上限，正文过大会抛异常。
            #     此处不得降级为 200：对一个本不属于该应用的路径返回 200，
            #     等于确认了该路径存在。归属不明也按 404 处理。
            #   已确认归属阶段 —— 只有确认是 ai-media-library 之后，
            #     后续任何异常才吞掉并返回 200 空响应，保证不影响本应用自身的请求。
            #
            # app_name 在此用字面量比较，不依赖新模块是否可导入，
            # 这样即使新模块缺失或损坏，其他应用拿到的仍是干净的 404。
            try:
                _aiml_data = read_json(self)
                _aiml_app = str((_aiml_data or {}).get("app_name") or "").strip()
            except Exception:
                _aiml_data = None
                _aiml_app = ""
            if _aiml_app != "ai-media-library":
                json_response(self, 404, {"ok": False, "error": "unknown endpoint"})
                return
            try:
                from ai_media_license_identity import (
                    handle_identity_observe as _aiml_handle_identity_observe,
                )
                _aiml_credential_verified = False
                _aiml_activation_id = None
                try:
                    _aiml_row = _device_auth(self.headers)
                    _aiml_credential_verified = True
                    _aiml_activation_id = _aiml_row["id"] if "id" in _aiml_row.keys() else None
                except Exception:
                    # 无凭证或凭证无效都只是"未验证"，不改变既有校验逻辑。
                    _aiml_credential_verified = False
                _aiml_status, _aiml_body = _aiml_handle_identity_observe(
                    _aiml_data,
                    DB_PATH,
                    credential_verified=_aiml_credential_verified,
                    activation_id=_aiml_activation_id,
                )
                json_response(self, _aiml_status, _aiml_body)
            except Exception:
                try:
                    json_response(self, 200, {"ok": True})
                except Exception:
                    pass
            return
        if parsed.path == "/api/license/device/unbind":
            try:
                json_response(self, 200, handle_device_unbind(self.headers, self.client_address[0]))
            except DeviceApiError as exc:
                json_response(self, exc.status, {"ok": False, "error": str(exc), "message": str(exc)})
            except Exception as exc:
                json_response(self, 500, {"ok": False, "error": str(exc), "message": str(exc)})
            return
        if parsed.path == "/api/license/admin/unbind":
            try:
                result = handle_admin_unbind(read_json(self), self.headers, self.client_address[0])
                json_response(self, 200, result)
            except DeviceApiError as exc:
                json_response(self, exc.status, {"ok": False, "error": str(exc), "message": str(exc)})
            except Exception as exc:
                json_response(self, 500, {"ok": False, "error": str(exc), "message": str(exc)})
            return
        if parsed.path == "/api/license/admin/batch-action":
            try:
                result = handle_admin_batch_action(
                    read_json(self), self.headers, self.client_address[0]
                )
                json_response(self, 200, result)
            except DeviceApiError as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "success": False, "error": str(exc), "message": str(exc)},
                )
            except Exception as exc:
                json_response(
                    self, 500,
                    {"ok": False, "success": False, "error": str(exc), "message": str(exc)},
                )
            return
        if parsed.path == "/api/license/admin/primary/reissue":
            try:
                result = handle_admin_primary_reissue(
                    read_json(self), self.headers, self.client_address[0]
                )
                json_response(self, 200, result)
            except DeviceApiError as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "success": False, "error": str(exc), "message": str(exc)},
                )
            except Exception as exc:
                json_response(
                    self, 500,
                    {"ok": False, "success": False, "error": str(exc), "message": str(exc)},
                )
            return
        if parsed.path == "/api/license/admin/credits/adjust":
            try:
                result = handle_admin_credit_adjust(
                    read_json(self), self.headers, self.client_address[0]
                )
                json_response(self, 200, result)
            except DeviceApiError as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "success": False, "error": str(exc), "message": str(exc)},
                )
            except Exception as exc:
                json_response(
                    self, 500,
                    {"ok": False, "success": False, "error": str(exc), "message": str(exc)},
                )
            return
        if parsed.path == "/api/license/admin/balance/migrate":
            try:
                result = handle_admin_balance_migrate(
                    read_json(self), self.headers, self.client_address[0]
                )
                json_response(self, 200, result)
            except DeviceApiError as exc:
                json_response(
                    self, exc.status,
                    {"ok": False, "success": False, "error": str(exc), "message": str(exc)},
                )
            except Exception as exc:
                json_response(
                    self, 500,
                    {"ok": False, "success": False, "error": str(exc), "message": str(exc)},
                )
            return
        if parsed.path != "/api/license/activate":
            json_response(self, 404, {"ok": False, "error": "unknown endpoint"})
            return
        activation_payload = None
        activation_stage = "read_json"
        try:
            activation_payload = read_json(self)
            activation_stage = "activation"
            result = handle_activation_payload(activation_payload, self.client_address[0], self.headers)
            activation_stage = "response"
            json_response(self, 200, result)
        except Exception as exc:
            activation_app_name = None
            if activation_stage == "activation" and isinstance(activation_payload, dict):
                activation_app_name = str(activation_payload.get("app_name") or "").strip()
            if activation_stage == "read_json":
                try:
                    from ai_media_license_error_log import record_unattributed_request
                    record_unattributed_request(
                        headers=self.headers,
                        peer_ip=self.client_address[0],
                    )
                except Exception:
                    pass
            elif activation_app_name == "ai-media-library":
                try:
                    from ai_media_license_error_log import record_activation_error
                    record_activation_error(
                        payload=activation_payload,
                        error=exc,
                        headers=self.headers,
                        peer_ip=self.client_address[0],
                    )
                except Exception:
                    pass
            json_response(
                self,
                400,
                {
                    "ok": False,
                    "success": False,
                    "error": str(exc),
                    "message": str(exc),
                },
            )


def main():
    parser = argparse.ArgumentParser(description="Multi-app license server.")
    parser.add_argument("--migrate-only", action="store_true", help="Migrate the database and exit.")
    parser.add_argument("--inspect", action="store_true", help="Print non-sensitive database counts and exit.")
    parser.add_argument("--import-csv", default="", help="Import redeem codes from CSV.")
    parser.add_argument("--import-hash-csv", default="", help="Import pre-hashed legacy codes from CSV.")
    parser.add_argument("--export-feishu-csv", default="", help="Export code inventory for Feishu Base.")
    parser.add_argument(
        "--sync-feishu-inventory",
        action="store_true",
        help="Queue plaintext code inventory for Feishu Base.",
    )
    parser.add_argument(
        "--app-name",
        default=LEGACY_APP_NAME,
        help="CSV app namespace. Apps can be created from the ops admin.",
    )
    args = parser.parse_args()

    init_db()
    if args.import_csv:
        import_redeem_codes(args.import_csv, args.app_name)
        return
    if args.import_hash_csv:
        import_hashed_codes(args.import_hash_csv, args.app_name)
        return
    if args.export_feishu_csv:
        export_feishu_inventory(args.export_feishu_csv, args.app_name)
        return
    if args.sync_feishu_inventory:
        print(
            json.dumps(
                enqueue_feishu_inventory(args.app_name),
                ensure_ascii=False,
                indent=2,
            )
        )
        return
    if args.inspect:
        print(json.dumps(database_summary(), ensure_ascii=False, indent=2))
        return
    if args.migrate_only:
        print(json.dumps(database_summary(), ensure_ascii=False, indent=2))
        return

    started = start_feishu_worker()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"license server listening on {HOST}:{PORT}")
    print(f"database: {DB_PATH}")
    print(f"feishu sync: {'enabled' if started else 'not configured'}")
    server.serve_forever()


if __name__ == "__main__":
    main()
