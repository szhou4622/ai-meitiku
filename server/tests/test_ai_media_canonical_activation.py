"""Synthetic, local-only canonical activation integration tests."""

import json
import http.client
import os
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

from server.tests import test_ai_media_time_conflict as base

APP = base.APP
MACHINE_A = base.MACHINE_A
OTHER_APP = base.OTHER_APP
SERVER = base.SERVER


def identity(label):
    values = {
        "machine_guid": "a" * 32,
        "bios_uuid": ("1" if label == "a" else "2") * 32,
        "system_disk_serial": ("3" if label == "a" else "4") * 32,
        "cpu_processor_id": "5" * 32,
    }
    return {
        "version": 3, "platform": "win32", "low_confidence": False,
        "candidate_machine_code": "v3_" + ("1" if label == "a" else "2") * 64,
        "factors": {name: {"hash": digest} for name, digest in values.items()},
    }


class CanonicalActivationTests(unittest.TestCase):
    add_code = base.TimeConflictTests.add_code
    request_body = base.TimeConflictTests.request_body
    activate = base.TimeConflictTests.activate
    proof = staticmethod(base.TimeConflictTests.proof)
    snapshot = base.TimeConflictTests.snapshot
    start_http = base.TimeConflictTests.start_http
    post = base.TimeConflictTests.post

    def setUp(self):
        self.previous_switch = os.environ.get("AIML_CANONICAL_CREATE_ENABLED")
        os.environ["AIML_CANONICAL_CREATE_ENABLED"] = "true"
        base.TimeConflictTests.setUp(self)

    def tearDown(self):
        base.TimeConflictTests.tearDown(self)
        if self.previous_switch is None:
            os.environ.pop("AIML_CANONICAL_CREATE_ENABLED", None)
        else:
            os.environ["AIML_CANONICAL_CREATE_ENABLED"] = self.previous_switch

    def prepare_a(self, enroll=True):
        self.add_code("AIM-SYNTHETIC-CARD-A")
        self.add_code("AIM-SYNTHETIC-CARD-B")
        a = self.activate("AIM-SYNTHETIC-CARD-A")
        if enroll:
            body = self.request_body("AIM-SYNTHETIC-CARD-A", machine_identity_v3=identity("a"))
            result = SERVER.handle_ai_media_identity_baseline(body, self.proof(a))
            self.assertEqual(result["baseline_state"], "enrolled")
        return a

    def b_body(self, **extra):
        material = {
            "machine_identity_v3": identity("b"),
            "activation_recovery_secret": "f" * 64,
            **extra,
        }
        return self.request_body(
            "AIM-SYNTHETIC-CARD-B",
            **material,
        )

    def b_activate(self, **extra):
        return SERVER.handle_activation_payload(self.b_body(**extra), headers={})

    def activation_row(self, code_id):
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            conn.row_factory = sqlite3.Row
            return dict(conn.execute(
                "SELECT * FROM activations WHERE app_name = ? AND code_id = ?", (APP, code_id)
            ).fetchone())

    def test_clone_has_two_independent_bindings_and_old_row_is_unchanged(self):
        a = self.prepare_a()
        a_id = a["license"]["code_id"]
        before = self.activation_row(a_id)
        b = self.b_activate()
        b_license = b["license"]
        self.assertEqual(b["action"], "activated")
        self.assertTrue(b_license["machine_code"].startswith("V3_"))
        self.assertEqual(b_license["canonical_machine_code"].lower(), b_license["machine_code"].lower())
        self.assertNotEqual(b_license["machine_code"].lower(), identity("b")["candidate_machine_code"])
        self.assertEqual(self.activation_row(a_id), before)
        self.assertEqual(SERVER.handle_device_status(self.proof(a))["code_id"], a_id)
        self.assertEqual(SERVER.handle_device_status(self.proof(b))["code_id"], b_license["code_id"])
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            rows = conn.execute(
                "SELECT code_id, bound_machine_code FROM activations WHERE app_name = ? AND binding_status = 'active'",
                (APP,),
            ).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertNotEqual(rows[0][1], rows[1][1])

    def test_old_device_without_authenticated_baseline_requires_review_without_consuming_new_card(self):
        self.prepare_a(enroll=False)
        before = self.snapshot()
        status, body = self.post(self.b_body())
        self.assertEqual(status, 409)
        self.assertEqual(body["error_code"], "machine_identity_conflict")
        self.assertEqual(self.snapshot(), before)

    def test_admin_approved_diagnostic_unlocks_one_unused_card_atomically(self):
        from ai_media_device_diagnostic import create_challenge, review_report, submit_report

        self.prepare_a()
        # Identical factors would normally be classified as the same computer.
        # A support operator may approve the independently verified installation,
        # but the approval still cannot activate anything without an unused card.
        request = self.b_body(machine_identity_v3=identity("a"))
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            challenge = create_challenge(conn, operator="support-a")
            request["verification_code"] = challenge["verification_code"]
            report = submit_report(conn, request)
            review_report(conn, {
                "report_id": report["report_id"],
                "decision": "approve_new_installation",
                "operator": "admin-a",
                "reason": "synthetic customer and installation verification",
            })
            conn.commit()

        activated = SERVER.handle_activation_payload(self.b_body(machine_identity_v3=identity("a")), headers={})
        self.assertEqual(activated["action"], "activated")
        self.assertTrue(activated["license"]["machine_code"].startswith("V3_"))
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            state, consumed_code = conn.execute(
                "SELECT review_state, consumed_code_id FROM aiml_device_diagnostic_report WHERE report_id = ?",
                (report["report_id"],),
            ).fetchone()
        self.assertEqual(state, "consumed")
        self.assertEqual(consumed_code, activated["license"]["code_id"])

    def test_device_diagnostic_http_routes_require_admin_auth_and_keep_public_submit_scoped(self):
        self.start_http()
        previous_token = SERVER.LICENSE_ADMIN_API_TOKEN
        SERVER.LICENSE_ADMIN_API_TOKEN = "synthetic-admin-token"

        def post_path(path, body, headers=None):
            encoded = json.dumps(body).encode("utf-8")
            connection = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=5)
            try:
                connection.request(
                    "POST", path, encoded,
                    {"Content-Type": "application/json", **(headers or {})},
                )
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        try:
            status, _body = post_path(
                "/api/license/admin/device-diagnostic/challenge",
                {"operator": "support-a"},
            )
            self.assertEqual(status, 403)
            admin = {"X-Admin-Token": "synthetic-admin-token"}
            status, challenge = post_path(
                "/api/license/admin/device-diagnostic/challenge",
                {"operator": "support-a"},
                admin,
            )
            self.assertEqual(status, 200)
            request = self.b_body()
            request["verification_code"] = challenge["verification_code"]
            status, report = post_path("/api/license/device-diagnostic/submit", request)
            self.assertEqual(status, 200)

            status, listing = post_path(
                "/api/license/admin/device-diagnostic/list", {"state": "pending"}, admin,
            )
            self.assertEqual(status, 200)
            self.assertEqual(listing["items"][0]["report_id"], report["report_id"])
            status, reviewed = post_path(
                "/api/license/admin/device-diagnostic/review",
                {
                    "report_id": report["report_id"],
                    "decision": "reject",
                    "operator": "admin-a",
                    "reason": "synthetic rejection",
                },
                admin,
            )
            self.assertEqual(status, 200)
            self.assertEqual(reviewed["review_state"], "rejected")

            other = self.b_body()
            other["app_name"] = OTHER_APP
            other["verification_code"] = "ABCD-2345"
            status, body = post_path("/api/license/device-diagnostic/submit", other)
            self.assertEqual(status, 404)
            self.assertEqual(body["error"], "unknown endpoint")
        finally:
            SERVER.LICENSE_ADMIN_API_TOKEN = previous_token

    def test_same_device_second_time_card_cannot_use_new_identity(self):
        self.prepare_a()
        before = self.snapshot()
        body = self.b_body(machine_identity_v3=identity("a"))
        status, result = self.post(body)
        self.assertEqual(status, 409)
        self.assertEqual(result["error_code"], "existing_time_license")
        self.assertEqual(self.snapshot(), before)

    def test_original_device_proof_in_headers_blocks_second_card_even_if_body_omits_credential(self):
        a = self.prepare_a()
        before = self.snapshot()
        status, result = self.post(self.b_body(), headers=self.proof(a))
        self.assertEqual(status, 409)
        self.assertEqual(result["error_code"], "existing_time_license")
        self.assertEqual(self.snapshot(), before)

    def test_candidate_or_key_difference_alone_does_not_establish_new_device(self):
        self.prepare_a()
        before = self.snapshot()
        partial = identity("a")
        partial["factors"]["system_disk_serial"] = {"hash": "4" * 32}
        partial["candidate_machine_code"] = "v3_" + "9" * 64
        status, result = self.post(self.b_body(machine_identity_v3=partial))
        self.assertEqual(status, 409)
        self.assertEqual(result["error_code"], "machine_identity_conflict")
        self.assertEqual(self.snapshot(), before)

    def test_malformed_identity_does_not_consume_unused_card(self):
        self.prepare_a()
        before = self.snapshot()
        malformed = identity("b")
        malformed["version"] = "not-an-integer"
        status, result = self.post(self.b_body(machine_identity_v3=malformed))
        self.assertEqual(status, 409)
        self.assertEqual(result["error_code"], "machine_identity_conflict")
        self.assertEqual(self.snapshot(), before)

    def test_bound_a_card_cannot_be_taken_with_b_hardware_or_same_v2(self):
        a = self.prepare_a()
        before = self.snapshot()
        body = self.request_body("AIM-SYNTHETIC-CARD-A", machine_identity_v3=identity("b"),
                                 activation_recovery_secret="f" * 64)
        status, _result = self.post(body)
        self.assertEqual(status, 400)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(SERVER.handle_device_status(self.proof(a))["binding_status"], "active")

    def test_lost_response_and_duplicate_request_are_idempotent(self):
        self.prepare_a()
        first = self.b_activate()
        before = self.activation_row(first["license"]["code_id"])
        again = self.b_activate()
        self.assertEqual(again["action"], "already_bound")
        self.assertEqual(first["license"]["device_credential"], again["license"]["device_credential"])
        self.assertEqual(first["license"]["expires_at"], again["license"]["expires_at"])
        after = self.activation_row(first["license"]["code_id"])
        for key in ("activated_at", "payload_json", "device_credential_hash", "credential_version", "transfer_count"):
            self.assertEqual(before[key], after[key], key)

    def test_stopping_creation_keeps_issued_binding_usable(self):
        self.prepare_a()
        b = self.b_activate()
        os.environ["AIML_CANONICAL_CREATE_ENABLED"] = "false"
        self.assertEqual(SERVER.handle_device_status(self.proof(b))["binding_status"], "active")
        resumed = self.b_activate()
        self.assertEqual(resumed["action"], "already_bound")
        self.assertEqual(resumed["license"]["device_credential"], b["license"]["device_credential"])

    def test_creation_off_does_not_issue_canonical_or_consume_unused_card(self):
        a = self.prepare_a()
        os.environ["AIML_CANONICAL_CREATE_ENABLED"] = "false"
        before = self.snapshot()
        status, body = self.post(self.b_body())
        self.assertEqual(status, 409)
        self.assertEqual(body["error_code"], "machine_identity_conflict")
        self.assertEqual(self.snapshot(), before)
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            count = conn.execute("SELECT COUNT(*) FROM aiml_canonical_binding").fetchone()[0]
        self.assertEqual(count, 0)
        self.assertEqual(SERVER.handle_device_status(self.proof(a))["binding_status"], "active")

    def test_unbind_and_reactivate_same_canonical_does_not_reset_expiry(self):
        self.prepare_a()
        b = self.b_activate()
        old_expiry = b["license"]["expires_at"]
        unbound = SERVER.handle_device_unbind(self.proof(b))
        self.assertEqual(unbound["binding_status"], "unbound")
        os.environ["AIML_CANONICAL_CREATE_ENABLED"] = "false"
        again = self.b_activate()
        self.assertEqual(again["action"], "rebound")
        self.assertEqual(again["license"]["expires_at"], old_expiry)
        self.assertEqual(again["license"]["machine_code"], b["license"]["machine_code"])

    def test_wrong_recovery_secret_cannot_take_canonical_binding(self):
        self.prepare_a()
        b = self.b_activate()
        before = self.snapshot()
        status, _body = self.post(self.b_body(activation_recovery_secret="e" * 64))
        self.assertEqual(status, 409)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(SERVER.handle_device_status(self.proof(b))["binding_status"], "active")

    def test_parallel_duplicate_activation_creates_only_one_binding(self):
        self.prepare_a()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _index: self.b_activate(), range(2)))
        self.assertEqual({item["action"] for item in results}, {"activated", "already_bound"})
        self.assertEqual(results[0]["license"]["device_credential"], results[1]["license"]["device_credential"])
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            count = conn.execute("SELECT COUNT(*) FROM aiml_canonical_binding WHERE app_name = ?", (APP,)).fetchone()[0]
        self.assertEqual(count, 1)

    def test_activation_failure_after_mapping_insert_rolls_back_every_field(self):
        self.prepare_a()
        before = self.snapshot()
        original = SERVER._ensure_point_account_for_binding
        try:
            SERVER._ensure_point_account_for_binding = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("synthetic failure"))
            with self.assertRaises(RuntimeError):
                self.b_activate()
        finally:
            SERVER._ensure_point_account_for_binding = original
        self.assertEqual(self.snapshot(), before)

    def test_restart_reopens_persisted_bindings_without_reassigning_old_v2(self):
        a = self.prepare_a()
        b = self.b_activate()
        SERVER.init_db()  # The same schema/open sequence a restarted service uses.
        self.assertEqual(SERVER.handle_device_status(self.proof(a))["machine_code"], MACHINE_A.upper())
        self.assertEqual(SERVER.handle_device_status(self.proof(b))["machine_code"], b["license"]["machine_code"])
        self.assertEqual(self.b_activate()["action"], "already_bound")

    def test_raw_factor_metadata_and_recovery_secret_never_persist_or_echo(self):
        self.prepare_a()
        payload = self.b_body()
        payload["machine_identity_v3"]["factors"]["bios_uuid"]["raw"] = "RAW-HARDWARE-SECRET"
        payload["machine_identity_v3"]["raw"] = "RAW-HARDWARE-SECRET"
        response = SERVER.handle_activation_payload(payload, headers={})
        persisted = self.snapshot()
        self.assertNotIn("RAW-HARDWARE-SECRET", persisted)
        self.assertNotIn("RAW-HARDWARE-SECRET", repr(response))
        self.assertNotIn("f" * 64, persisted)
        self.assertNotIn("f" * 64, repr(response))

    def test_baseline_requires_matching_original_credential_and_cannot_be_replaced(self):
        a = self.prepare_a(enroll=False)
        body = self.request_body("AIM-SYNTHETIC-CARD-A", machine_identity_v3=identity("a"))
        before = self.snapshot()
        with self.assertRaises(SERVER.DeviceApiError):
            SERVER.handle_ai_media_identity_baseline(body, {})
        self.assertEqual(self.snapshot(), before)
        result = SERVER.handle_ai_media_identity_baseline(body, self.proof(a))
        self.assertEqual(result["baseline_state"], "enrolled")
        before = self.snapshot()
        changed = self.request_body("AIM-SYNTHETIC-CARD-A", machine_identity_v3=identity("b"))
        result = SERVER.handle_ai_media_identity_baseline(changed, self.proof(a))
        self.assertEqual(result["baseline_state"], "needs_review")
        self.assertEqual(self.snapshot(), before)

    def test_canonical_binding_supports_session_refresh_and_explicit_time_renewal(self):
        a = self.prepare_a()
        b = self.b_activate()
        proof = self.proof(b)
        b_license = b["license"]
        refreshed = SERVER.handle_device_refresh({
            "app_name": APP, "code_id": b_license["code_id"],
            "machine_code": b_license["machine_code"],
        }, proof)
        self.assertEqual(refreshed["machine_code"], b_license["machine_code"])
        self.assertEqual(refreshed["expires_at"], b_license["expires_at"])
        self.add_code("AIM-SYNTHETIC-RENEWAL")
        renewed = SERVER.handle_time_renew({
            "app_name": APP, "activation_code": "AIM-SYNTHETIC-RENEWAL",
            "request_id": "synthetic-renewal-1", "confirm_renewal": True,
        }, proof)
        self.assertEqual(renewed["action"], "time_renewed")
        self.assertNotEqual(renewed["expires_at"], b_license["expires_at"])
        self.assertEqual(SERVER.handle_device_status(self.proof(a))["expires_at"], a["license"]["expires_at"])

    def test_expired_media_license_preserves_device_proof_for_explicit_new_card_recovery(self):
        self.add_code("AIM-SYNTHETIC-EXPIRED")
        original = self.activate("AIM-SYNTHETIC-EXPIRED")
        license_data = original["license"]
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            row = conn.execute(
                "SELECT payload_json, device_credential_hash FROM activations WHERE app_name = ? AND code_id = ?",
                (APP, license_data["code_id"]),
            ).fetchone()
            payload = json.loads(row[0])
            payload["expires_at"] = "2020-01-01T00:00:00Z"
            credential_hash_before = row[1]
            conn.execute(
                "UPDATE activations SET payload_json = ? WHERE app_name = ? AND code_id = ?",
                (json.dumps(payload, ensure_ascii=False, sort_keys=True), APP, license_data["code_id"]),
            )
            conn.commit()

        refreshed = SERVER.handle_device_refresh({
            "app_name": APP,
            "code_id": license_data["code_id"],
            "machine_code": license_data["machine_code"],
        }, {"X-Device-Credential": license_data["device_credential"]})
        self.assertTrue(refreshed["is_expired"])
        self.assertEqual(refreshed["license_status"], "expired")
        self.assertEqual(refreshed["machine_code"], license_data["machine_code"])
        with self.assertRaises(SERVER.DeviceApiError):
            SERVER.handle_device_status({
                "Authorization": "Bearer " + refreshed["device_session"],
                "X-Device-Credential": license_data["device_credential"],
            })

        self.add_code("AIM-SYNTHETIC-RECOVERY-CARD")
        renewed = SERVER.handle_time_renew({
            "app_name": APP,
            "activation_code": "AIM-SYNTHETIC-RECOVERY-CARD",
            "request_id": "expired-new-card-recovery",
            "confirm_renewal": True,
        }, {
            "Authorization": "Bearer " + refreshed["device_session"],
            "X-Device-Credential": license_data["device_credential"],
        })
        self.assertEqual(renewed["action"], "time_renewed")
        status = SERVER.handle_device_status({
            "Authorization": "Bearer " + refreshed["device_session"],
            "X-Device-Credential": license_data["device_credential"],
        })
        self.assertEqual(status["machine_code"], license_data["machine_code"])
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            row = conn.execute(
                "SELECT device_credential_hash FROM activations WHERE app_name = ? AND code_id = ?",
                (APP, license_data["code_id"]),
            ).fetchone()
        self.assertEqual(row[0], credential_hash_before)

    def test_expired_other_app_keeps_original_refresh_rejection(self):
        self.add_code("OTHER-SYNTHETIC-EXPIRED", OTHER_APP)
        original = self.activate("OTHER-SYNTHETIC-EXPIRED", app=OTHER_APP, machine=MACHINE_A)
        license_data = original["license"]
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            payload = json.loads(conn.execute(
                "SELECT payload_json FROM activations WHERE app_name = ? AND code_id = ?",
                (OTHER_APP, license_data["code_id"]),
            ).fetchone()[0])
            payload["expires_at"] = "2020-01-01T00:00:00Z"
            conn.execute(
                "UPDATE activations SET payload_json = ? WHERE app_name = ? AND code_id = ?",
                (json.dumps(payload, ensure_ascii=False, sort_keys=True), OTHER_APP, license_data["code_id"]),
            )
            conn.commit()
        before = self.snapshot()
        with self.assertRaises(SERVER.DeviceApiError) as caught:
            SERVER.handle_device_refresh({
                "app_name": OTHER_APP,
                "code_id": license_data["code_id"],
                "machine_code": license_data["machine_code"],
            }, {"X-Device-Credential": license_data["device_credential"]})
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(str(caught.exception), "授权已过期。")
        self.assertEqual(self.snapshot(), before)

    def test_machine_readable_credential_errors_are_scoped_to_media_library(self):
        self.add_code("AIM-SYNTHETIC-CREDENTIAL-CODE")
        target = self.activate("AIM-SYNTHETIC-CREDENTIAL-CODE")
        target_proof = self.proof(target)
        target_proof["X-Device-Credential"] = "wrong-proof"
        with self.assertRaises(SERVER.DeviceApiError) as target_error:
            SERVER._device_auth(target_proof)
        self.assertEqual(target_error.exception.code, "device_credential_mismatch")

        self.add_code("OTHER-SYNTHETIC-CREDENTIAL-CODE", OTHER_APP)
        other = self.activate("OTHER-SYNTHETIC-CREDENTIAL-CODE", app=OTHER_APP, machine=MACHINE_A)
        other_proof = self.proof(other)
        other_proof["X-Device-Credential"] = "wrong-proof"
        with self.assertRaises(SERVER.DeviceApiError) as other_error:
            SERVER._device_auth(other_proof)
        self.assertEqual(other_error.exception.code, "")

    def test_other_app_credentials_never_enroll_target_baseline(self):
        self.prepare_a(enroll=False)
        self.add_code("OTHER-SYNTHETIC-CARD", OTHER_APP)
        other = self.activate("OTHER-SYNTHETIC-CARD", app=OTHER_APP, machine=MACHINE_A)
        before = self.snapshot()
        body = self.request_body("AIM-SYNTHETIC-CARD-A", machine_identity_v3=identity("a"))
        with self.assertRaises(SERVER.DeviceApiError):
            SERVER.handle_ai_media_identity_baseline(body, self.proof(other))
        self.assertEqual(self.snapshot(), before)

    def test_other_app_does_not_write_target_mapping(self):
        self.add_code("OTHER-SYNTHETIC-CARD", OTHER_APP)
        result = self.activate("OTHER-SYNTHETIC-CARD", app=OTHER_APP, machine_identity_v3=identity("b"))
        self.assertEqual(result["action"], "activated")
        with sqlite3.connect(SERVER.DB_PATH) as conn:
            count = conn.execute("SELECT COUNT(*) FROM aiml_canonical_binding").fetchone()[0]
        self.assertEqual(count, 0)

    def test_other_app_response_and_database_are_identical_with_creation_switch_on_or_off(self):
        original_path = SERVER.DB_PATH
        original_now = SERVER.utc_now
        original_random = SERVER.secrets.token_urlsafe
        original_switch = os.environ.get("AIML_CANONICAL_CREATE_ENABLED")
        results = []
        try:
            SERVER.utc_now = lambda: "2026-09-17T00:00:00Z"
            SERVER.secrets.token_urlsafe = lambda _size=0: "deterministic-synthetic-token"
            for enabled in ("false", "true"):
                with tempfile.TemporaryDirectory(prefix="aiml-other-app-isolation-") as temporary:
                    os.environ["AIML_CANONICAL_CREATE_ENABLED"] = enabled
                    SERVER.DB_PATH = SERVER.Path(temporary) / "license.sqlite3"
                    SERVER.init_db()
                    self.add_code("OTHER-SYNTHETIC-ISOLATION", OTHER_APP)
                    response = self.activate("OTHER-SYNTHETIC-ISOLATION", app=OTHER_APP,
                                             machine_identity_v3=identity("b"))
                    results.append((response, self.snapshot()))
            self.assertEqual(results[0], results[1])
        finally:
            SERVER.DB_PATH = original_path
            SERVER.utc_now = original_now
            SERVER.secrets.token_urlsafe = original_random
            if original_switch is None:
                os.environ.pop("AIML_CANONICAL_CREATE_ENABLED", None)
            else:
                os.environ["AIML_CANONICAL_CREATE_ENABLED"] = original_switch


if __name__ == "__main__":
    unittest.main()
