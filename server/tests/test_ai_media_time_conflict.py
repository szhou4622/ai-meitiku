"""Synthetic activation tests for the media-library v2 collision guard.

No production database, customer code, or external service is used.
Run: python3 -m unittest server.tests.test_ai_media_time_conflict -v
"""

import hashlib
import http.client
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import types
import unittest
from http.server import ThreadingHTTPServer


APP = "ai-media-library"
OTHER_APP = "QianchuanMixCutTool"
MACHINE_A = "v2_" + "a" * 64
MACHINE_B = "v2_" + "b" * 64
CANDIDATE_A = "v3_" + "1" * 64
CANDIDATE_B = "v3_" + "2" * 64
SOURCE = Path(os.environ.get("AIML_LICENSE_CANDIDATE") or
              Path(__file__).resolve().parents[1] / "patches" / "license_server.py.merged-candidate")


def load_server():
    # This repository contains the deployable full candidate, not license_core.
    # Provide synthetic stand-ins without touching an installed server runtime.
    core = types.ModuleType("license_core")
    core.APP_NAME = "OriginalVideoDedupTool"
    core.INITIAL_CREDITS = 100
    core._is_expired = lambda _value: False
    core.code_hash = lambda code: hashlib.sha256(str(code).encode()).hexdigest()
    previous = sys.modules.get("license_core")
    previous_por = sys.modules.get("por_precise_credits")
    if previous_por is None:
        por = types.ModuleType("por_precise_credits")
        por.APP_NAME = "ProductOperationReport"
        por.PreciseCreditError = type("PreciseCreditError", (Exception,), {})
        por.balance = lambda *_args, **_kwargs: None
        por.consume = lambda *_args, **_kwargs: None
        por.ensure_schema = lambda *_args, **_kwargs: None
        sys.modules["por_precise_credits"] = por
    sys.modules["license_core"] = core
    try:
        loader = importlib.machinery.SourceFileLoader("aiml_time_conflict_candidate", str(SOURCE))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module
    finally:
        if previous is None:
            sys.modules.pop("license_core", None)
        else:
            sys.modules["license_core"] = previous
        if previous_por is None:
            sys.modules.pop("por_precise_credits", None)


SERVER = load_server()


class TimeConflictTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aiml-time-conflict-")
        SERVER.DB_PATH = Path(self.temp.name) / "license.sqlite3"
        SERVER.DEVICE_SESSION_SECRET = "synthetic-test-session-key"
        SERVER.FEISHU_SYNC_ENABLED = False
        SERVER.init_db()
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            conn.execute(
                "INSERT INTO apps (app_name, display_name, default_credits, signed_codes, active, created_at) "
                "VALUES (?, 'test', 0, 0, 1, ?)",
                (APP, SERVER.utc_now()),
            )
            conn.commit()
        self.http = None
        self.http_thread = None

    def tearDown(self):
        if self.http:
            self.http.shutdown()
            self.http.server_close()
            self.http_thread.join(timeout=5)
        self.temp.cleanup()

    def add_code(self, code, app=APP):
        code_hash = SERVER.code_hash_for_app(code, app)
        code_id = code_hash[:16].upper()
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            conn.execute(
                "INSERT INTO redeem_codes "
                "(app_name, code_id, code_hash, credits, duration_days, unlimited, "
                "license_type, expires_at, disabled, created_at) "
                "VALUES (?, ?, ?, 0, 365, 0, 'time_365d', '', 0, ?)",
                (app, code_id, code_hash, SERVER.utc_now()),
            )
            conn.commit()
        return code_id

    def request_body(self, code, machine=MACHINE_A, app=APP, candidate=CANDIDATE_A, **extra):
        return {
            "app_name": app,
            "activation_code": code,
            "machine_code": machine,
            "machine_identity_v3": {"version": 3, "candidate_machine_code": candidate},
            "client_version": "synthetic-test",
            "license_protocol_version": 2,
            **extra,
        }

    def activate(self, code, machine=MACHINE_A, app=APP, headers=None, **extra):
        return SERVER.handle_activation_payload(
            self.request_body(code, machine, app, **extra),
            headers=headers or {},
        )

    @staticmethod
    def proof(response):
        license_data = response["license"]
        return {
            "Authorization": "Bearer " + license_data["device_session"],
            "X-Device-Credential": license_data["device_credential"],
        }

    def snapshot(self):
        """Compare every persisted field, not just row counts."""
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            tables = [row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )]
            content = {
                table: conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid').fetchall()
                for table in tables
            }
        return json.dumps(content, ensure_ascii=False, sort_keys=True, default=str)

    def assert_rejected_without_change(self, code, expected_error, machine=MACHINE_A, app=APP,
                                       headers=None, **extra):
        before = self.snapshot()
        with self.assertRaises(expected_error) as caught:
            self.activate(code, machine, app, headers, **extra)
        self.assertEqual(self.snapshot(), before, "A rejected activation changed persisted data")
        return caught.exception

    def start_http(self):
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), SERVER.Handler)
        self.http_thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.http_thread.start()

    def post(self, body, headers=None):
        if not self.http:
            self.start_http()
        encoded = json.dumps(body).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
        try:
            conn.request("POST", "/api/license/activate", encoded,
                         {"Content-Type": "application/json", **(headers or {})})
            response = conn.getresponse()
            return response.status, json.loads(response.read())
        finally:
            conn.close()

    def test_new_device_same_v2_different_v3_has_structured_conflict_without_writes(self):
        self.add_code("AIM-SYNTHETIC-OLD")
        self.add_code("AIM-SYNTHETIC-NEW")
        self.activate("AIM-SYNTHETIC-OLD", candidate=CANDIDATE_A)
        before = self.snapshot()
        status, body = self.post(self.request_body("AIM-SYNTHETIC-NEW", candidate=CANDIDATE_B))
        self.assertEqual(status, 409)
        self.assertEqual(body["error_code"], "machine_identity_conflict")
        self.assertEqual(body["action"], "manual_identity_review")
        self.assertIn("复制脱敏诊断", body["message"])
        self.assertNotIn("积分合并", body["message"])
        self.assertNotIn("续期", body["message"])
        self.assertNotIn("AIM-SYNTHETIC-NEW", repr(body))
        self.assertNotIn(MACHINE_A, repr(body))
        self.assertNotIn(CANDIDATE_B, repr(body))
        self.assertEqual(self.snapshot(), before)

    def test_same_device_valid_primary_proof_requires_separate_renewal(self):
        self.add_code("AIM-SYNTHETIC-OLD")
        self.add_code("AIM-SYNTHETIC-NEW")
        old = self.activate("AIM-SYNTHETIC-OLD")
        proof = self.proof(old)
        before = self.snapshot()
        status, body = self.post(self.request_body(
            "AIM-SYNTHETIC-NEW", device_credential=old["license"]["device_credential"]), proof)
        self.assertEqual(status, 409)
        self.assertEqual(body["error_code"], "existing_time_license")
        self.assertEqual(body["action"], "renewal_requires_confirmation")
        self.assertIn("明确确认续期", body["message"])
        self.assertIn("不会消耗新卡", body["message"])
        self.assertNotIn(old["license"]["device_session"], repr(body))
        self.assertNotIn(old["license"]["device_credential"], repr(body))
        self.assertEqual(self.snapshot(), before)

    def test_invalid_or_unrelated_proof_never_confirms_same_device(self):
        self.add_code("AIM-SYNTHETIC-OLD")
        self.add_code("AIM-SYNTHETIC-NEW")
        self.add_code("AIM-SYNTHETIC-OTHER")
        self.add_code("OTHER-SYNTHETIC-OLD", OTHER_APP)
        original = self.activate("AIM-SYNTHETIC-OLD")
        other_primary = self.activate("AIM-SYNTHETIC-OTHER", MACHINE_B)
        other_app = self.activate("OTHER-SYNTHETIC-OLD", MACHINE_A, OTHER_APP)
        cases = [
            ({}, {}),
            ({"Authorization": "Bearer invalid", "X-Device-Credential": "invalid"}, {}),
            (self.proof(other_primary), {}),
            (self.proof(other_app), {}),
            (self.proof(original), {"device_credential": "wrong-body-proof"}),
        ]
        for headers, extra in cases:
            with self.subTest(headers=tuple(headers), extra=bool(extra)):
                before = self.snapshot()
                status, body = self.post(self.request_body("AIM-SYNTHETIC-NEW", **extra), headers)
                self.assertEqual(status, 409)
                self.assertEqual(body["error_code"], "machine_identity_conflict")
                self.assertEqual(self.snapshot(), before)

    def test_old_card_and_valid_original_proof_remain_compatible(self):
        self.add_code("AIM-SYNTHETIC-OLD")
        old = self.activate("AIM-SYNTHETIC-OLD")
        proof = self.proof(old)
        result = self.activate("AIM-SYNTHETIC-OLD", headers=proof,
                               device_credential=old["license"]["device_credential"])
        self.assertEqual(result["action"], "already_bound")
        self.assertEqual(result["license"]["code_id"], old["license"]["code_id"])
        self.assertEqual(SERVER._device_auth(proof)["code_id"], old["license"]["code_id"])

    def test_old_card_body_credential_remains_compatible_without_session_header(self):
        self.add_code("AIM-SYNTHETIC-OLD")
        old = self.activate("AIM-SYNTHETIC-OLD")
        result = self.activate("AIM-SYNTHETIC-OLD",
                               device_credential=old["license"]["device_credential"])
        self.assertEqual(result["action"], "already_bound")

    def test_bad_session_does_not_bypass_original_card_credential_check(self):
        self.add_code("AIM-SYNTHETIC-OLD")
        self.activate("AIM-SYNTHETIC-OLD")
        before = self.snapshot()
        status, body = self.post(self.request_body("AIM-SYNTHETIC-OLD"), {
            "Authorization": "Bearer invalid",
            "X-Device-Credential": "invalid",
        })
        self.assertEqual(status, 400)
        self.assertNotIn("error_code", body)
        self.assertEqual(self.snapshot(), before)

    def test_same_code_without_credential_still_rejected_without_writes(self):
        self.add_code("AIM-SYNTHETIC-OLD")
        self.activate("AIM-SYNTHETIC-OLD")
        error = self.assert_rejected_without_change("AIM-SYNTHETIC-OLD", ValueError)
        self.assertIn("设备凭证缺失", str(error))

    def test_different_v2_using_bound_code_still_rejected_without_writes(self):
        self.add_code("AIM-SYNTHETIC-OLD")
        self.activate("AIM-SYNTHETIC-OLD")
        error = self.assert_rejected_without_change("AIM-SYNTHETIC-OLD", ValueError, MACHINE_B)
        self.assertIn("仍绑定在其他电脑", str(error))

    def test_other_app_keeps_original_time_merge_response_and_data(self):
        self.add_code("OTHER-SYNTHETIC-OLD", OTHER_APP)
        self.add_code("OTHER-SYNTHETIC-NEW", OTHER_APP)
        self.activate("OTHER-SYNTHETIC-OLD", app=OTHER_APP)
        before = self.snapshot()
        status, body = self.post(self.request_body("OTHER-SYNTHETIC-NEW", app=OTHER_APP))
        self.assertEqual(status, 400)
        self.assertEqual(body, {
            "ok": False,
            "success": False,
            "error": "时间卡不能使用积分合并，请使用 /api/license/time/renew 续期。",
            "message": "时间卡不能使用积分合并，请使用 /api/license/time/renew 续期。",
        })
        self.assertEqual(self.snapshot(), before)

    def test_other_app_invalid_session_still_uses_original_error_path(self):
        self.add_code("OTHER-SYNTHETIC-OLD", OTHER_APP)
        before = self.snapshot()
        status, body = self.post(self.request_body("OTHER-SYNTHETIC-OLD", app=OTHER_APP), {
            "Authorization": "Bearer invalid",
            "X-Device-Credential": "invalid",
        })
        self.assertEqual(status, 400)
        self.assertEqual(body, {
            "ok": False,
            "success": False,
            "error": "设备会话无效。",
            "message": "设备会话无效。",
        })
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
