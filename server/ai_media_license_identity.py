"""v3 machine-identity observation for app_name = 'ai-media-library'.

This module is exclusive to one application. It is imported from exactly one
place in the shared ``license_server.py`` (a single branch in ``do_POST``) and
every public entry point swallows its own exceptions, so a failure here can
never change the behaviour of any other application on the shared server.

Hard boundaries, in order of importance:

1.  Every table carries ``CHECK (app_name = 'ai-media-library')``. Scoping is a
    database guarantee, not a code convention.
2.  ``activations`` is never read for writing, never altered, and referenced
    only by a soft ``activation_id`` column with no foreign key.
3.  ``device_credential`` validation is not reimplemented, relaxed or bypassed.
    In the ``migrate`` phase a missing credential short-circuits to
    ``needs_review`` *before* any score is consulted.
4.  Factor weights are decided here. A weight supplied by a client is never
    read, even if one is present in the payload.
"""

import hashlib
import json
import os
import sqlite3
from datetime import datetime, timezone

APP_NAME = "ai-media-library"

PHASE_OFF = "off"
PHASE_OBSERVE = "observe"
PHASE_MIGRATE = "migrate"
PHASE_ENFORCE = "enforce"
_PHASES = (PHASE_OFF, PHASE_OBSERVE, PHASE_MIGRATE, PHASE_ENFORCE)
_PHASE_ENV = "AIML_IDENTITY_PHASE"

DECISION_NO_OP = "no_op"
DECISION_SAME_DEVICE = "same_device"
DECISION_NEEDS_REVIEW = "needs_review"
DECISION_NEW_DEVICE = "new_device"

STATE_OBSERVED = "observed"
STATE_BOUND = "bound"
STATE_NEEDS_REVIEW = "needs_review"
STATE_SUPERSEDED = "superseded"

# ---------------------------------------------------------------------------
# Authoritative weight table. The client sends no weights; if a payload ever
# contains one it is ignored by construction because only `hash` is read.
# ---------------------------------------------------------------------------

FACTOR_WEIGHTS = {
    "win32": {
        "machine_guid": 3,
        "bios_uuid": 3,
        "system_disk_serial": 3,
        "baseboard_serial": 2,
        "cpu_processor_id": 1,
        "physical_mac": 1,
    },
    "darwin": {
        "io_platform_uuid": 3,
        "io_platform_serial_number": 3,
        "hardware_model": 1,
        "physical_mac": 1,
    },
}

# Only these can establish "same machine". Weak factors may support a match but
# never create one, so a match built purely from MAC + model cannot bind.
STRONG_FACTORS = {
    "win32": ("machine_guid", "bios_uuid", "system_disk_serial"),
    "darwin": ("io_platform_uuid", "io_platform_serial_number"),
}

MINIMUM_MATCHING_STRONG_FACTORS = 2
BIND_THRESHOLD = 0.75
REVIEW_THRESHOLD = 0.45

_HASH_LENGTH = 32
_MAX_FACTORS_PER_REQUEST = 16


def _utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def current_phase(env=None):
    """Read the rollout phase. Anything unreadable or unknown means ``off``."""
    source = os.environ if env is None else env
    try:
        value = str(source.get(_PHASE_ENV, "") or "").strip().lower()
    except Exception:
        return PHASE_OFF
    return value if value in _PHASES else PHASE_OFF


# ---------------------------------------------------------------------------
# Payload validation
# ---------------------------------------------------------------------------

def _valid_hash(value):
    try:
        text = str(value or "").strip().lower()
    except Exception:
        return ""
    if len(text) != _HASH_LENGTH:
        return ""
    return text if all(c in "0123456789abcdef" for c in text) else ""


def _valid_machine_code(value, prefixes=("v2_", "v3_")):
    try:
        text = str(value or "").strip().lower()
    except Exception:
        return ""
    if not text.startswith(prefixes):
        return ""
    body = text.split("_", 1)[1]
    if len(body) != 64 or not all(c in "0123456789abcdef" for c in body):
        return ""
    return text


def parse_identity_payload(data):
    """Return a normalized observation, or ``None`` when unusable.

    Only ``hash`` is read out of each factor entry. Any ``weight``, ``strength``
    or similar client-supplied field is discarded here and never reaches the
    scoring code.
    """
    if not isinstance(data, dict):
        return None

    identity = data.get("machine_identity_v3")
    if not isinstance(identity, dict):
        return None
    if int(identity.get("version") or 0) != 3:
        return None

    platform = str(identity.get("platform") or "").strip()
    if platform not in FACTOR_WEIGHTS:
        return None

    known = FACTOR_WEIGHTS[platform]
    raw_factors = identity.get("factors")
    if not isinstance(raw_factors, dict) or len(raw_factors) > _MAX_FACTORS_PER_REQUEST:
        return None

    factors = {}
    for name, entry in raw_factors.items():
        if name not in known or not isinstance(entry, dict):
            continue
        digest = _valid_hash(entry.get("hash"))
        if digest:
            factors[name] = digest

    return {
        "platform": platform,
        "factors": factors,
        "candidate_machine_code": _valid_machine_code(identity.get("candidate_machine_code"), ("v3_",)),
        "v2_machine_code": _valid_machine_code(data.get("machine_code"), ("v2_",)),
        "low_confidence": bool(identity.get("low_confidence")),
    }


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def score_against(stored_factors, presented_factors, platform):
    """Weighted match between a stored device and the current observation.

    The denominator is the union of stored and presented factor names, so a
    client cannot raise its score by omitting factors that would not match:
    an omitted factor that we have seen before stays in the denominator and
    contributes nothing to the numerator.
    """
    weights = FACTOR_WEIGHTS.get(platform, {})
    strong = STRONG_FACTORS.get(platform, ())

    names = set(stored_factors) | set(presented_factors)
    denominator = sum(weights.get(name, 0) for name in names)

    numerator = 0
    matched = []
    conflicting = []
    for name in sorted(names):
        stored = stored_factors.get(name)
        presented = presented_factors.get(name)
        if not stored or not presented:
            continue
        if stored == presented:
            numerator += weights.get(name, 0)
            matched.append(name)
        else:
            conflicting.append(name)

    return {
        "numerator": numerator,
        "denominator": denominator,
        "ratio": (numerator / denominator) if denominator else 0.0,
        "matched_factors": matched,
        "conflicting_factors": conflicting,
        "matching_strong_factors": [n for n in matched if n in strong],
        "conflicting_strong_factors": [n for n in conflicting if n in strong],
    }


def classify(score, low_confidence=False):
    """Turn a score into a decision. Two gates outrank the ratio itself."""
    # A positively conflicting strong factor is the clone-machine signature:
    # same MachineGuid, different BIOS UUID / disk serial.
    if score["conflicting_strong_factors"]:
        return DECISION_NEW_DEVICE
    # A high ratio assembled only from weak factors must never bind.
    if len(score["matching_strong_factors"]) < MINIMUM_MATCHING_STRONG_FACTORS:
        return DECISION_NEEDS_REVIEW if score["ratio"] >= REVIEW_THRESHOLD else DECISION_NEW_DEVICE
    # A partial read is missing information, not evidence of a different device.
    if low_confidence:
        return DECISION_NEEDS_REVIEW
    if score["ratio"] >= BIND_THRESHOLD:
        return DECISION_SAME_DEVICE
    if score["ratio"] >= REVIEW_THRESHOLD:
        return DECISION_NEEDS_REVIEW
    return DECISION_NEW_DEVICE


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

_SCHEMA = (
    """
    CREATE TABLE IF NOT EXISTS aiml_machine_identity_device (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL CHECK (app_name = 'ai-media-library'),
        v2_machine_code TEXT NOT NULL,
        v3_machine_code TEXT,
        canonical_machine_code TEXT NOT NULL,
        activation_id INTEGER,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        state TEXT NOT NULL,
        UNIQUE (app_name, canonical_machine_code)
    )
    """,
    "CREATE INDEX IF NOT EXISTS aiml_identity_device_v2 ON aiml_machine_identity_device (app_name, v2_machine_code)",
    "CREATE INDEX IF NOT EXISTS aiml_identity_device_v3 ON aiml_machine_identity_device (app_name, v3_machine_code)",
    "CREATE INDEX IF NOT EXISTS aiml_identity_device_state ON aiml_machine_identity_device (app_name, state)",
    """
    CREATE TABLE IF NOT EXISTS aiml_machine_identity_factor (
        device_id INTEGER NOT NULL,
        factor_name TEXT NOT NULL,
        factor_hash TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (device_id, factor_name)
    )
    """,
    "CREATE INDEX IF NOT EXISTS aiml_identity_factor_lookup ON aiml_machine_identity_factor (factor_name, factor_hash)",
    """
    CREATE TABLE IF NOT EXISTS aiml_machine_identity_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name TEXT NOT NULL CHECK (app_name = 'ai-media-library'),
        at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        v2_machine_code TEXT,
        v3_machine_code TEXT,
        match_score_num INTEGER,
        match_score_den INTEGER,
        decision TEXT,
        phase TEXT,
        detail_json TEXT
    )
    """,
    "CREATE INDEX IF NOT EXISTS aiml_identity_event_at ON aiml_machine_identity_event (app_name, at)",
)


def ensure_schema(conn):
    for statement in _SCHEMA:
        conn.execute(statement)


def _load_candidates(conn, v2_machine_code, presented_factors, platform):
    """Devices worth scoring: same v2 code, or sharing any presented factor."""
    device_ids = set()
    if v2_machine_code:
        for row in conn.execute(
            "SELECT id FROM aiml_machine_identity_device WHERE app_name = ? AND v2_machine_code = ?",
            (APP_NAME, v2_machine_code),
        ):
            device_ids.add(int(row[0]))

    for name, digest in presented_factors.items():
        for row in conn.execute(
            """
            SELECT d.id FROM aiml_machine_identity_factor f
            JOIN aiml_machine_identity_device d ON d.id = f.device_id
            WHERE f.factor_name = ? AND f.factor_hash = ? AND d.app_name = ?
            """,
            (name, digest, APP_NAME),
        ):
            device_ids.add(int(row[0]))

    candidates = []
    for device_id in sorted(device_ids):
        row = conn.execute(
            """
            SELECT id, v2_machine_code, v3_machine_code, canonical_machine_code,
                   activation_id, state
            FROM aiml_machine_identity_device WHERE id = ?
            """,
            (device_id,),
        ).fetchone()
        if not row:
            continue
        stored = {
            r[0]: r[1]
            for r in conn.execute(
                "SELECT factor_name, factor_hash FROM aiml_machine_identity_factor WHERE device_id = ?",
                (device_id,),
            )
        }
        # Only score factors this platform actually defines.
        stored = {k: v for k, v in stored.items() if k in FACTOR_WEIGHTS.get(platform, {})}
        candidates.append({
            "id": int(row[0]),
            "v2_machine_code": row[1],
            "v3_machine_code": row[2],
            "canonical_machine_code": row[3],
            "activation_id": row[4],
            "state": row[5],
            "factors": stored,
        })
    return candidates


def _record_event(conn, *, event_type, observation, score, decision, phase, detail=None):
    conn.execute(
        """
        INSERT INTO aiml_machine_identity_event
            (app_name, at, event_type, v2_machine_code, v3_machine_code,
             match_score_num, match_score_den, decision, phase, detail_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            APP_NAME,
            _utc_now(),
            event_type,
            (observation or {}).get("v2_machine_code") or None,
            (observation or {}).get("candidate_machine_code") or None,
            (score or {}).get("numerator"),
            (score or {}).get("denominator"),
            decision,
            phase,
            json.dumps(detail or {}, ensure_ascii=False),
        ),
    )


def _internal_canonical(observation):
    """Stable per-device key for the device row.

    Falling back to the v2 machine code here would be a bug: cloned machines
    share that code, so every clone would collapse into a single row — exactly
    the collision v3 exists to remove. When the client sends no usable v3
    candidate we derive a key from the strong factors instead, which differ
    between clones. This value is internal and is never returned to a client;
    only a client-supplied candidate is ever echoed back as canonical.
    """
    candidate = observation.get("candidate_machine_code")
    if candidate:
        return candidate

    platform = observation.get("platform", "")
    strong = STRONG_FACTORS.get(platform, ())
    present = [(name, observation["factors"][name]) for name in strong if observation["factors"].get(name)]
    if not present:
        return ""

    digest = hashlib.sha256()
    digest.update(b"aiml-server-derived-identity-v3\0")
    digest.update(platform.encode("utf-8"))
    for name, value in sorted(present):
        digest.update(b"\0")
        digest.update(name.encode("utf-8"))
        digest.update(b"=")
        digest.update(value.encode("utf-8"))
    return "v3d_" + digest.hexdigest()


def _upsert_device(conn, observation, state, activation_id=None):
    now = _utc_now()
    canonical = _internal_canonical(observation)
    if not canonical:
        return None

    row = conn.execute(
        "SELECT id FROM aiml_machine_identity_device WHERE app_name = ? AND canonical_machine_code = ?",
        (APP_NAME, canonical),
    ).fetchone()

    if row:
        device_id = int(row[0])
        conn.execute(
            "UPDATE aiml_machine_identity_device SET last_seen_at = ?, state = ? WHERE id = ?",
            (now, state, device_id),
        )
    else:
        cursor = conn.execute(
            """
            INSERT INTO aiml_machine_identity_device
                (app_name, v2_machine_code, v3_machine_code, canonical_machine_code,
                 activation_id, first_seen_at, last_seen_at, state)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                APP_NAME,
                observation.get("v2_machine_code") or "",
                observation.get("candidate_machine_code") or None,
                canonical,
                activation_id,
                now,
                now,
                state,
            ),
        )
        device_id = int(cursor.lastrowid)

    for name, digest in observation["factors"].items():
        existing = conn.execute(
            "SELECT factor_hash FROM aiml_machine_identity_factor WHERE device_id = ? AND factor_name = ?",
            (device_id, name),
        ).fetchone()
        if existing is None:
            conn.execute(
                """
                INSERT INTO aiml_machine_identity_factor
                    (device_id, factor_name, factor_hash, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (device_id, name, digest, now, now),
            )
        else:
            conn.execute(
                "UPDATE aiml_machine_identity_factor SET factor_hash = ?, last_seen_at = ? "
                "WHERE device_id = ? AND factor_name = ?",
                (digest, now, device_id, name),
            )
    return device_id


# ---------------------------------------------------------------------------
# Decision
# ---------------------------------------------------------------------------

def decide(conn, observation, *, phase, credential_verified, activation_id=None):
    """Core decision. Returns a dict describing what the client may be told.

    Constraint 4 is expressed here as a structural short-circuit: in the
    ``migrate`` phase a missing credential returns before the score is ever
    consulted, and that branch has no path that writes a binding.
    """
    if phase == PHASE_OFF:
        return {"decision": DECISION_NO_OP, "phase": phase, "score": None, "canonical_machine_code": ""}

    if not observation or not observation.get("factors"):
        _record_event(conn, event_type="observation", observation=observation, score=None,
                      decision=DECISION_NO_OP, phase=phase, detail={"reason": "no_usable_factors"})
        return {"decision": DECISION_NO_OP, "phase": phase, "score": None, "canonical_machine_code": ""}

    # ---- Constraint 4 hard short-circuit -----------------------------------
    # This must stay above every use of `score`. No hardware match, at any
    # score, may stand in for a device credential.
    if phase in (PHASE_MIGRATE, PHASE_ENFORCE) and not credential_verified:
        _record_event(conn, event_type="migrate_blocked", observation=observation, score=None,
                      decision=DECISION_NEEDS_REVIEW, phase=phase,
                      detail={"reason": "credential_absent"})
        _upsert_device(conn, observation, STATE_NEEDS_REVIEW)
        return {
            "decision": DECISION_NEEDS_REVIEW,
            "phase": phase,
            "score": None,
            "canonical_machine_code": "",
            "reason": "credential_absent",
        }
    # ------------------------------------------------------------------------

    platform = observation["platform"]
    candidates = _load_candidates(conn, observation.get("v2_machine_code"), observation["factors"], platform)

    best = None
    best_score = None
    for candidate in candidates:
        score = score_against(candidate["factors"], observation["factors"], platform)
        if best_score is None or score["ratio"] > best_score["ratio"]:
            best, best_score = candidate, score

    if best_score is None:
        best_score = score_against({}, observation["factors"], platform)
        decision = DECISION_NEW_DEVICE
    else:
        decision = classify(best_score, observation.get("low_confidence"))

    state = {
        DECISION_SAME_DEVICE: STATE_BOUND,
        DECISION_NEEDS_REVIEW: STATE_NEEDS_REVIEW,
        DECISION_NEW_DEVICE: STATE_OBSERVED,
    }.get(decision, STATE_OBSERVED)

    # observe never binds: it only records what it saw.
    if phase == PHASE_OBSERVE:
        state = STATE_OBSERVED

    _upsert_device(conn, observation, state,
                   activation_id if (phase != PHASE_OBSERVE and decision == DECISION_SAME_DEVICE) else None)
    _record_event(conn, event_type="observation", observation=observation, score=best_score,
                  decision=decision, phase=phase,
                  detail={
                      "matched_factors": best_score["matched_factors"],
                      "conflicting_factors": best_score["conflicting_factors"],
                      "low_confidence": bool(observation.get("low_confidence")),
                      "candidate_device_id": (best or {}).get("id"),
                  })

    canonical = ""
    if phase in (PHASE_MIGRATE, PHASE_ENFORCE) and decision == DECISION_SAME_DEVICE:
        canonical = observation.get("candidate_machine_code") or ""

    return {
        "decision": decision,
        "phase": phase,
        "score": best_score,
        "canonical_machine_code": canonical,
    }


def public_response(result):
    """What the client is allowed to see.

    Before ``enforce`` the detailed score helps support diagnose a case. From
    ``enforce`` onward only a coarse state is returned: an exact score is a
    tuning oracle, letting an attacker vary one factor at a time and read the
    threshold and weights back off the number.
    """
    phase = result.get("phase", PHASE_OFF)
    body = {"ok": True, "identity_phase": phase}

    if phase == PHASE_OFF or result.get("decision") == DECISION_NO_OP:
        return body

    canonical = result.get("canonical_machine_code") or ""
    if canonical:
        body["canonical_machine_code"] = canonical

    score = result.get("score")
    if phase == PHASE_ENFORCE or not score:
        body["identity_assessment"] = {"state": result.get("decision")}
        return body

    body["identity_assessment"] = {
        "state": result.get("decision"),
        "scoreNumerator": score["numerator"],
        "scoreDenominator": score["denominator"],
        "threshold": BIND_THRESHOLD,
        "matchedFactors": score["matched_factors"],
        "conflictingFactors": score["conflicting_factors"],
    }
    return body


# ---------------------------------------------------------------------------
# Entry point used by the single branch in license_server.py
# ---------------------------------------------------------------------------

def handle_identity_observe(data, db_path, *, credential_verified=False,
                            activation_id=None, phase=None, env=None):
    """Never raises. Returns ``(status, body)``.

    A request for any other application returns 404 without touching the
    database, so the rest of the shared server is unreachable from here.
    """
    try:
        if not isinstance(data, dict):
            return 404, {"ok": False, "error": "unknown endpoint"}
        if str(data.get("app_name") or "").strip() != APP_NAME:
            return 404, {"ok": False, "error": "unknown endpoint"}

        active_phase = phase if phase in _PHASES else current_phase(env)
        if active_phase == PHASE_OFF:
            return 200, {"ok": True, "identity_phase": PHASE_OFF}

        observation = parse_identity_payload(data)
        if observation is None:
            return 200, {"ok": True, "identity_phase": active_phase}

        conn = sqlite3.connect(db_path, timeout=10)
        try:
            ensure_schema(conn)
            result = decide(conn, observation, phase=active_phase,
                            credential_verified=credential_verified,
                            activation_id=activation_id)
            conn.commit()
        finally:
            conn.close()

        return 200, public_response(result)
    except Exception:
        # A failure here must be invisible to the caller and to every other
        # application on this server.
        return 200, {"ok": True}
