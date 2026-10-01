"""Ephemeral HTTP fixture for client/server canonical activation E2E tests."""

from http.server import ThreadingHTTPServer
from pathlib import Path
import os
import sqlite3
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server.tests.test_ai_media_time_conflict import APP, SERVER  # noqa: E402


def main():
    with tempfile.TemporaryDirectory(prefix="aiml-canonical-e2e-") as temporary:
        SERVER.DB_PATH = Path(temporary) / "license.sqlite3"
        SERVER.DEVICE_SESSION_SECRET = "local-synthetic-session-secret"
        SERVER.FEISHU_SYNC_ENABLED = False
        os.environ["AIML_CANONICAL_CREATE_ENABLED"] = "true"
        SERVER.init_db()
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            conn.execute(
                "INSERT INTO apps (app_name, display_name, default_credits, signed_codes, active, created_at) "
                "VALUES (?, 'synthetic', 0, 0, 1, ?)",
                (APP, SERVER.utc_now()),
            )
            for code in ("AIM-SYNTHETIC-CARD-A", "AIM-SYNTHETIC-CARD-B"):
                digest = SERVER.code_hash_for_app(code, APP)
                conn.execute(
                    "INSERT INTO redeem_codes "
                    "(app_name, code_id, code_hash, credits, duration_days, unlimited, "
                    "license_type, expires_at, disabled, created_at) "
                    "VALUES (?, ?, ?, 0, 365, 0, 'time_365d', '', 0, ?)",
                    (APP, digest[:16].upper(), digest, SERVER.utc_now()),
                )
            conn.commit()
        server = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        print(f"PORT={server.server_port}", flush=True)
        try:
            server.serve_forever()
        finally:
            server.server_close()


if __name__ == "__main__":
    main()
