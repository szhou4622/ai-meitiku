"""Target-app-only identity baseline and canonical activation storage.

This is not hardware attestation. A valid, unused time card plus two independently
conflicting strong factors are required before a new binding may be issued.
The recovery secret proves possession of a pre-activation installation secret;
it does not, by itself, prove that two physical computers differ.
"""

import hashlib
import hmac
import os
import secrets
from datetime import datetime, timezone

from ai_media_license_identity import APP_NAME, STRONG_FACTORS, parse_identity_payload


def _parse_now(value):
    try:
        return datetime.strptime(str(value), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc).replace(microsecond=0)


def create_schema(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS aiml_identity_baseline (
            app_name TEXT NOT NULL CHECK (app_name = 'ai-media-library'),
            code_id TEXT NOT NULL,
            v2_machine_code TEXT NOT NULL,
            platform TEXT NOT NULL,
            factors_json TEXT NOT NULL,
            enrolled_at TEXT NOT NULL,
            PRIMARY KEY (app_name, code_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS aiml_canonical_binding (
            app_name TEXT NOT NULL CHECK (app_name = 'ai-media-library'),
            code_id TEXT NOT NULL,
            v2_machine_code TEXT NOT NULL,
            canonical_machine_code TEXT NOT NULL UNIQUE,
            platform TEXT NOT NULL,
            factors_json TEXT NOT NULL,
            recovery_secret_hash TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (app_name, code_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS aiml_canonical_v2 ON aiml_canonical_binding(app_name, v2_machine_code)")


def creation_enabled(env=None):
    source = os.environ if env is None else env
    return str(source.get("AIML_CANONICAL_CREATE_ENABLED", "") or "").strip().lower() == "true"


def _valid_recovery_secret(value):
    text = str(value or "").strip().lower()
    return text if len(text) == 64 and all(c in "0123456789abcdef" for c in text) else ""


def recovery_hash(secret):
    return hashlib.sha256(("aiml-recovery-v1\0" + secret).encode()).hexdigest()


def deterministic_credential(server_secret, code_id, canonical, recovery_secret):
    if not server_secret or not _valid_recovery_secret(recovery_secret):
        raise ValueError("canonical recovery unavailable")
    message = ("aiml-credential-v1\0" + code_id + "\0" + canonical + "\0" + recovery_secret).encode()
    return hmac.new(server_secret.encode(), message, hashlib.sha256).hexdigest()


def _factor_decision(old, new, platform):
    """Return same/different/review; omission is never counted as a difference."""
    if old.get("platform") != platform or not new:
        return "review"
    strong = STRONG_FACTORS.get(platform, ())
    old_hashes = old.get("factors") or {}
    new_hashes = new.get("factors") or {}
    matches = [key for key in strong if old_hashes.get(key) and old_hashes.get(key) == new_hashes.get(key)]
    differences = [key for key in strong if old_hashes.get(key) and new_hashes.get(key)
                   and old_hashes[key] != new_hashes[key]]
    # Windows MachineGuid alone is a known clone collision. Distinct BIOS and
    # system disk (or another pair of independent strong factors) are required.
    independent_differences = [key for key in differences if key != "machine_guid"]
    if len(matches) >= 2 and not independent_differences:
        return "same"
    if len(independent_differences) >= 2:
        return "different"
    if platform == "darwin" and len(differences) >= 2:
        return "different"
    return "review"


def _read_json(text):
    import json
    try:
        value = json.loads(str(text or "{}"))
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def _safe_observation(data):
    try:
        return parse_identity_payload(data)
    except (TypeError, ValueError, OverflowError):
        return None


def enroll_baseline(conn, data, authenticated_row, now):
    """Enroll an old v2 baseline only after normal device credential auth."""
    if not authenticated_row or authenticated_row.get("app_name") != APP_NAME:
        return "unauthorized"
    bound = str(authenticated_row.get("bound_machine_code") or "").strip().lower()
    observed_v2 = str(data.get("machine_code") or "").strip().lower()
    if not bound.startswith("V2_".lower()) or observed_v2 != bound:
        return "not_legacy_v2"
    observation = _safe_observation(data)
    if not observation or observation["v2_machine_code"] != observed_v2 or observation["low_confidence"]:
        return "insufficient_factors"
    platform = observation["platform"]
    if len([key for key in STRONG_FACTORS[platform] if observation["factors"].get(key)]) < 2:
        return "insufficient_factors"
    code_id = str(authenticated_row["code_id"])
    existing = conn.execute(
        "SELECT platform, factors_json FROM aiml_identity_baseline WHERE app_name = ? AND code_id = ?",
        (APP_NAME, code_id),
    ).fetchone()
    if existing:
        prior = {"platform": existing[0], "factors": _read_json(existing[1])}
        return "confirmed" if _factor_decision(prior, observation, platform) == "same" else "needs_review"
    import json
    conn.execute("""
        INSERT INTO aiml_identity_baseline
        (app_name, code_id, v2_machine_code, platform, factors_json, enrolled_at)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (APP_NAME, code_id, observed_v2, platform,
          json.dumps(observation["factors"], sort_keys=True), now))
    return "enrolled"


def resolve_activation(conn, *, data, code_id, row, target_primary, authenticated_row,
                       supplied_credential, credential_hash, now, allow_create):
    """Run before the legacy same-v2 primary check and before activation writes.

    Returns a decision and optional opaque server-issued canonical code. The
    caller must keep this in the SAME transaction as the activation INSERT.
    """
    v2 = str(data.get("machine_code") or "").strip().lower()
    observation = _safe_observation(data)
    recovery_secret = _valid_recovery_secret(data.get("activation_recovery_secret"))
    existing_mapping = conn.execute(
        "SELECT * FROM aiml_canonical_binding WHERE app_name = ? AND code_id = ?",
        (APP_NAME, code_id),
    ).fetchone()
    if existing_mapping:
        canonical = str(existing_mapping["canonical_machine_code"])
        if not row or str(row["binding_status"] or "") not in ("active", "unbound"):
            return {"kind": "review"}
        if str(row["binding_status"] or "") == "active" and str(row["bound_machine_code"]).lower() != canonical:
            return {"kind": "review"}
        authenticated = bool(authenticated_row and authenticated_row.get("app_name") == APP_NAME
                             and authenticated_row.get("code_id") == code_id
                             and str(authenticated_row.get("bound_machine_code") or "").lower() == canonical
                             and supplied_credential
                             and hmac.compare_digest(str(row["device_credential_hash"]), credential_hash(supplied_credential)))
        recovery = bool(recovery_secret and observation and v2 == str(existing_mapping["v2_machine_code"])
                        and hmac.compare_digest(str(existing_mapping["recovery_secret_hash"]), recovery_hash(recovery_secret)))
        if recovery:
            prior = {"platform": existing_mapping["platform"], "factors": _read_json(existing_mapping["factors_json"])}
            recovery = _factor_decision(prior, observation, observation["platform"]) == "same"
        if str(row["binding_status"] or "") == "unbound" and not recovery:
            return {"kind": "review"}
        if not authenticated and not recovery:
            return {"kind": "review"}
        return {"kind": "resume", "canonical": canonical, "recovery_secret": recovery_secret if recovery else ""}

    if not target_primary or row is not None:
        return {"kind": "legacy"}
    # Existing card remains protected by existing credential requirements.
    # Only a second, truly unused time card can take the new-device branch.
    if not allow_create:
        return {"kind": "legacy"}
    # A validated existing primary credential is stronger evidence than an
    # untrusted new factor list. Never let a current holder create a second
    # primary by changing/spoofing its hashes.
    if (authenticated_row and authenticated_row.get("app_name") == APP_NAME
            and authenticated_row.get("code_id") == str(target_primary["code_id"])
            and str(authenticated_row.get("bound_machine_code") or "").lower() ==
            str(target_primary["bound_machine_code"] or "").lower()):
        return {"kind": "same"}
    if not observation or observation["low_confidence"] or observation["v2_machine_code"] != v2 or not recovery_secret:
        return {"kind": "review"}
    platform = observation["platform"]
    if len([key for key in STRONG_FACTORS[platform] if observation["factors"].get(key)]) < 2:
        return {"kind": "review"}
    # A manually reviewed diagnostic is an installation proof, not an
    # activation grant.  It can only unlock this already-protected branch:
    # target card is unused, strong factors are present, recovery secret is
    # valid and canonical creation is enabled.  It is consumed in this same
    # transaction after the canonical mapping is inserted.
    from ai_media_device_diagnostic import find_approved_installation
    approved_report_id = find_approved_installation(conn, data, now=_parse_now(now))
    if not approved_report_id:
        old_code = str(target_primary["code_id"])
        baseline = conn.execute(
            "SELECT platform, factors_json FROM aiml_identity_baseline WHERE app_name = ? AND code_id = ?",
            (APP_NAME, old_code),
        ).fetchone()
        if not baseline:
            return {"kind": "review"}
        previous = {"platform": baseline[0], "factors": _read_json(baseline[1])}
        decision = _factor_decision(previous, observation, platform)
        if decision != "different":
            return {"kind": decision}
        for saved in conn.execute(
            "SELECT platform, factors_json FROM aiml_canonical_binding WHERE app_name = ? AND v2_machine_code = ?",
            (APP_NAME, v2),
        ):
            previous = {"platform": saved[0], "factors": _read_json(saved[1])}
            decision = _factor_decision(previous, observation, platform)
            if decision != "different":
                return {"kind": decision}
    import json
    canonical = "v3_" + secrets.token_hex(32)
    conn.execute("""
        INSERT INTO aiml_canonical_binding
        (app_name, code_id, v2_machine_code, canonical_machine_code, platform,
         factors_json, recovery_secret_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (APP_NAME, code_id, v2, canonical, platform,
          json.dumps(observation["factors"], sort_keys=True), recovery_hash(recovery_secret), now))
    if approved_report_id:
        from ai_media_device_diagnostic import consume_approved_installation
        consume_approved_installation(
            conn,
            report_id=approved_report_id,
            code_id=code_id,
            canonical_machine_code=canonical,
            now=_parse_now(now),
        )
    return {"kind": "new", "canonical": canonical, "recovery_secret": recovery_secret}
