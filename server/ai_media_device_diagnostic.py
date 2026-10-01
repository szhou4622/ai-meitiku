"""One-time, target-app-only device conflict diagnostics.

The diagnostic path never changes an activation by itself.  A public client can
consume an administrator-created one-time code and upload only the same hashed
machine factors already used by the AI media library.  An administrator may
then approve that report as a distinct installation.  The approval is consumed
atomically by a later, otherwise valid activation of an unused time card.

Raw hardware identifiers, activation codes and device credentials are neither
accepted nor persisted here.
"""

import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone

from ai_media_canonical_activation import _factor_decision, recovery_hash
from ai_media_license_identity import APP_NAME, STRONG_FACTORS, parse_identity_payload


CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CHALLENGE_TTL_SECONDS = 15 * 60
APPROVAL_TTL_SECONDS = 24 * 60 * 60
MAX_ADMIN_LIST_ITEMS = 200


class DeviceDiagnosticError(Exception):
    def __init__(self, message, status=400, code="device_diagnostic_error"):
        super().__init__(message)
        self.status = int(status)
        self.code = str(code)


def _utc_now():
    return datetime.now(timezone.utc).replace(microsecond=0)


def _iso(value):
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_time(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return None


def _code_hash(code):
    normalized = str(code or "").strip().upper()
    return hashlib.sha256(("aiml-device-diagnostic-v1\0" + normalized).encode()).hexdigest()


def _normalize_code(value):
    text = str(value or "").strip().upper().replace(" ", "")
    compact = text.replace("-", "")
    if len(compact) != 8 or any(char not in CODE_ALPHABET for char in compact):
        raise DeviceDiagnosticError("核验码格式不正确。", 400, "invalid_verification_code")
    return compact[:4] + "-" + compact[4:]


def _new_code():
    compact = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return compact[:4] + "-" + compact[4:]


def _valid_v2(value):
    text = str(value or "").strip().lower()
    return text if len(text) == 67 and text.startswith("v2_") and all(c in "0123456789abcdef" for c in text[3:]) else ""


def _valid_recovery_secret(value):
    text = str(value or "").strip().lower()
    return text if len(text) == 64 and all(c in "0123456789abcdef" for c in text) else ""


def create_schema(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS aiml_device_diagnostic_challenge (
            challenge_id TEXT PRIMARY KEY,
            app_name TEXT NOT NULL CHECK (app_name = 'ai-media-library'),
            code_hash TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            consumed_at TEXT NOT NULL DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS aiml_device_diagnostic_report (
            report_id TEXT PRIMARY KEY,
            challenge_id TEXT NOT NULL UNIQUE,
            app_name TEXT NOT NULL CHECK (app_name = 'ai-media-library'),
            v2_machine_code TEXT NOT NULL,
            platform TEXT NOT NULL,
            factors_json TEXT NOT NULL,
            recovery_secret_hash TEXT NOT NULL,
            automatic_assessment TEXT NOT NULL,
            review_state TEXT NOT NULL,
            created_at TEXT NOT NULL,
            reviewed_at TEXT NOT NULL DEFAULT '',
            reviewed_by TEXT NOT NULL DEFAULT '',
            review_note TEXT NOT NULL DEFAULT '',
            approval_expires_at TEXT NOT NULL DEFAULT '',
            consumed_at TEXT NOT NULL DEFAULT '',
            consumed_code_id TEXT NOT NULL DEFAULT '',
            canonical_machine_code TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (challenge_id) REFERENCES aiml_device_diagnostic_challenge(challenge_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS aiml_device_diagnostic_state ON aiml_device_diagnostic_report(app_name, review_state, created_at)")
    conn.execute("CREATE INDEX IF NOT EXISTS aiml_device_diagnostic_proof ON aiml_device_diagnostic_report(app_name, v2_machine_code, recovery_secret_hash)")


def create_challenge(conn, *, operator, now=None):
    operator = str(operator or "").strip()
    if not operator or len(operator) > 120:
        raise DeviceDiagnosticError("生成核验码必须记录操作人。")
    current = now or _utc_now()
    for _attempt in range(20):
        code = _new_code()
        try:
            challenge_id = "diag_ch_" + secrets.token_hex(12)
            conn.execute("""
                INSERT INTO aiml_device_diagnostic_challenge
                    (challenge_id, app_name, code_hash, created_at, expires_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                challenge_id, APP_NAME, _code_hash(code), _iso(current),
                _iso(current + timedelta(seconds=CHALLENGE_TTL_SECONDS)), operator,
            ))
            return {
                "ok": True,
                "app_name": APP_NAME,
                "challenge_id": challenge_id,
                "verification_code": code,
                "expires_at": _iso(current + timedelta(seconds=CHALLENGE_TTL_SECONDS)),
            }
        except Exception as exc:
            if "UNIQUE" not in str(exc).upper():
                raise
    raise DeviceDiagnosticError("暂时无法生成核验码，请重试。", 503, "challenge_generation_failed")


def _known_factor_sets(conn, v2_machine_code):
    known = []
    for table in ("aiml_identity_baseline", "aiml_canonical_binding"):
        try:
            rows = conn.execute(
                f"SELECT platform, factors_json FROM {table} WHERE app_name = ? AND v2_machine_code = ?",
                (APP_NAME, v2_machine_code),
            ).fetchall()
        except Exception:
            rows = []
        for platform, factors_json in rows:
            try:
                factors = json.loads(str(factors_json or "{}"))
            except (TypeError, ValueError):
                continue
            if isinstance(factors, dict):
                known.append({"platform": str(platform), "factors": factors})
    return known


def _automatic_assessment(conn, observation):
    known = _known_factor_sets(conn, observation["v2_machine_code"])
    if not known:
        return "needs_review"
    decisions = [_factor_decision(item, observation, observation["platform"]) for item in known]
    if "same" in decisions:
        return "same_installation"
    if decisions and all(item == "different" for item in decisions):
        return "likely_new_installation"
    return "needs_review"


def submit_report(conn, data, *, now=None):
    if not isinstance(data, dict) or str(data.get("app_name") or "").strip() != APP_NAME:
        raise DeviceDiagnosticError("未找到核验服务。", 404, "unknown_endpoint")
    code = _normalize_code(data.get("verification_code"))
    v2 = _valid_v2(data.get("machine_code"))
    recovery_secret = _valid_recovery_secret(data.get("activation_recovery_secret"))
    observation = parse_identity_payload(data)
    if not v2 or not recovery_secret or not observation or observation["v2_machine_code"] != v2:
        raise DeviceDiagnosticError("本机身份信息不完整，请重新采集。", 400, "incomplete_identity")
    strong_count = sum(1 for name in STRONG_FACTORS[observation["platform"]] if observation["factors"].get(name))
    if observation["low_confidence"] or strong_count < 2:
        raise DeviceDiagnosticError("本机强身份因子不足，请联系管理员人工核对。", 409, "insufficient_identity")

    current = now or _utc_now()
    challenge = conn.execute("""
        SELECT challenge_id, expires_at, consumed_at
        FROM aiml_device_diagnostic_challenge
        WHERE app_name = ? AND code_hash = ?
    """, (APP_NAME, _code_hash(code))).fetchone()
    if not challenge:
        raise DeviceDiagnosticError("核验码无效。", 404, "verification_code_not_found")
    if str(challenge[2] or ""):
        raise DeviceDiagnosticError("核验码已使用，请联系管理员重新生成。", 409, "verification_code_used")
    expires_at = _parse_time(challenge[1])
    if not expires_at or current > expires_at:
        raise DeviceDiagnosticError("核验码已过期，请联系管理员重新生成。", 410, "verification_code_expired")

    report_id = "diag_" + secrets.token_hex(16)
    assessment = _automatic_assessment(conn, observation)
    conn.execute("""
        INSERT INTO aiml_device_diagnostic_report
            (report_id, challenge_id, app_name, v2_machine_code, platform,
             factors_json, recovery_secret_hash, automatic_assessment,
             review_state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    """, (
        report_id, challenge[0], APP_NAME, v2, observation["platform"],
        json.dumps(observation["factors"], sort_keys=True, separators=(",", ":")),
        recovery_hash(recovery_secret), assessment, _iso(current),
    ))
    conn.execute(
        "UPDATE aiml_device_diagnostic_challenge SET consumed_at = ? WHERE challenge_id = ? AND consumed_at = ''",
        (_iso(current), challenge[0]),
    )
    return {
        "ok": True,
        "app_name": APP_NAME,
        "report_id": report_id,
        "status": "pending_review",
        "message": "设备核验信息已安全上传，请等待管理员确认。",
    }


def list_reports(conn, *, state="", limit=50):
    state = str(state or "").strip()
    limit = max(1, min(int(limit or 50), MAX_ADMIN_LIST_ITEMS))
    params = [APP_NAME]
    where = "app_name = ?"
    if state:
        where += " AND review_state = ?"
        params.append(state)
    params.append(limit)
    rows = conn.execute(f"""
        SELECT report_id, v2_machine_code, platform, automatic_assessment,
               review_state, created_at, reviewed_at, reviewed_by, review_note,
               approval_expires_at, consumed_at, consumed_code_id,
               canonical_machine_code
        FROM aiml_device_diagnostic_report
        WHERE {where}
        ORDER BY created_at DESC LIMIT ?
    """, tuple(params)).fetchall()
    items = []
    for row in rows:
        items.append({
            "report_id": str(row[0]),
            "machine_code_masked": str(row[1])[:11] + "…" + str(row[1])[-6:],
            "platform": str(row[2]),
            "automatic_assessment": str(row[3]),
            "review_state": str(row[4]),
            "created_at": str(row[5]),
            "reviewed_at": str(row[6]),
            "reviewed_by": str(row[7]),
            "review_note": str(row[8]),
            "approval_expires_at": str(row[9]),
            "consumed_at": str(row[10]),
            "consumed_code_id": str(row[11]),
            "canonical_machine_code_masked": (str(row[12])[:9] + "…" + str(row[12])[-6:]) if row[12] else "",
        })
    return {"ok": True, "app_name": APP_NAME, "items": items}


def review_report(conn, data, *, now=None):
    report_id = str(data.get("report_id") or "").strip()
    decision = str(data.get("decision") or "").strip()
    operator = str(data.get("operator") or "").strip()
    reason = str(data.get("reason") or "").strip()
    if decision not in {"approve_new_installation", "confirm_same_installation", "reject"}:
        raise DeviceDiagnosticError("核验结论无效。")
    if not report_id or not operator or not reason:
        raise DeviceDiagnosticError("管理员确认必须填写报告、操作人和原因。")
    row = conn.execute(
        "SELECT review_state FROM aiml_device_diagnostic_report WHERE app_name = ? AND report_id = ?",
        (APP_NAME, report_id),
    ).fetchone()
    if not row:
        raise DeviceDiagnosticError("没有找到设备核验报告。", 404, "report_not_found")
    if str(row[0]) != "pending":
        raise DeviceDiagnosticError("该核验报告已经处理。", 409, "report_already_reviewed")
    current = now or _utc_now()
    review_state = {
        "approve_new_installation": "approved_new_installation",
        "confirm_same_installation": "confirmed_same_installation",
        "reject": "rejected",
    }[decision]
    approval_expires = _iso(current + timedelta(seconds=APPROVAL_TTL_SECONDS)) if decision == "approve_new_installation" else ""
    conn.execute("""
        UPDATE aiml_device_diagnostic_report
        SET review_state = ?, reviewed_at = ?, reviewed_by = ?, review_note = ?, approval_expires_at = ?
        WHERE app_name = ? AND report_id = ? AND review_state = 'pending'
    """, (review_state, _iso(current), operator[:120], reason[:500], approval_expires, APP_NAME, report_id))
    return {
        "ok": True,
        "app_name": APP_NAME,
        "report_id": report_id,
        "review_state": review_state,
        "approval_expires_at": approval_expires,
    }


def find_approved_installation(conn, data, *, now=None):
    """Find an unconsumed approval whose protected proof exactly matches data."""
    observation = parse_identity_payload(data)
    recovery_secret = _valid_recovery_secret(data.get("activation_recovery_secret")) if isinstance(data, dict) else ""
    if not observation or not recovery_secret or not observation["v2_machine_code"]:
        return None
    current = now or _utc_now()
    rows = conn.execute("""
        SELECT report_id, platform, factors_json, approval_expires_at
        FROM aiml_device_diagnostic_report
        WHERE app_name = ? AND v2_machine_code = ? AND recovery_secret_hash = ?
          AND review_state = 'approved_new_installation' AND consumed_at = ''
        ORDER BY reviewed_at DESC
    """, (APP_NAME, observation["v2_machine_code"], recovery_hash(recovery_secret))).fetchall()
    for report_id, platform, factors_json, approval_expires_at in rows:
        expires = _parse_time(approval_expires_at)
        if not expires or current > expires or str(platform) != observation["platform"]:
            continue
        try:
            saved = json.loads(str(factors_json or "{}"))
        except (TypeError, ValueError):
            continue
        if isinstance(saved, dict) and hmac.compare_digest(
            json.dumps(saved, sort_keys=True, separators=(",", ":")),
            json.dumps(observation["factors"], sort_keys=True, separators=(",", ":")),
        ):
            return str(report_id)
    return None


def consume_approved_installation(conn, *, report_id, code_id, canonical_machine_code, now=None):
    current = now or _utc_now()
    cursor = conn.execute("""
        UPDATE aiml_device_diagnostic_report
        SET review_state = 'consumed', consumed_at = ?, consumed_code_id = ?, canonical_machine_code = ?
        WHERE app_name = ? AND report_id = ?
          AND review_state = 'approved_new_installation' AND consumed_at = ''
    """, (_iso(current), str(code_id), str(canonical_machine_code), APP_NAME, str(report_id)))
    if cursor.rowcount != 1:
        raise DeviceDiagnosticError("设备核验批准已失效，请重新核验。", 409, "approval_unavailable")
