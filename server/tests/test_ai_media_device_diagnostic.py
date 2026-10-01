"""Local-only tests for the one-time device conflict diagnostic flow."""

import json
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import ai_media_canonical_activation as canonical
import ai_media_device_diagnostic as diagnostic


APP = "ai-media-library"
V2 = "v2_" + "a" * 64
RECOVERY = "b" * 64


def payload(label="a", code=""):
    factor = "1" if label == "a" else "2"
    result = {
        "app_name": APP,
        "machine_code": V2,
        "activation_recovery_secret": RECOVERY,
        "machine_identity_v3": {
            "version": 3,
            "platform": "win32",
            "low_confidence": False,
            "candidate_machine_code": "v3_" + factor * 64,
            "factors": {
                "machine_guid": {"hash": "c" * 32},
                "bios_uuid": {"hash": factor * 32},
                "system_disk_serial": {"hash": factor * 32},
            },
        },
    }
    if code:
        result["verification_code"] = code
    return result


class DeviceDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        canonical.create_schema(self.conn)
        diagnostic.create_schema(self.conn)

    def tearDown(self):
        self.conn.close()

    def new_report(self, label="a", now=None):
        challenge = diagnostic.create_challenge(self.conn, operator="客服A", now=now)
        report = diagnostic.submit_report(
            self.conn,
            payload(label, challenge["verification_code"]),
            now=now,
        )
        return challenge, report

    def test_submit_persists_only_hashes_and_consumes_code_once(self):
        challenge, report = self.new_report()
        dump = "\n".join(self.conn.iterdump())
        self.assertNotIn(challenge["verification_code"], dump)
        self.assertNotIn(RECOVERY, dump)
        self.assertIn(canonical.recovery_hash(RECOVERY), dump)
        with self.assertRaises(diagnostic.DeviceDiagnosticError) as caught:
            diagnostic.submit_report(
                self.conn,
                payload("a", challenge["verification_code"]),
            )
        self.assertEqual(caught.exception.code, "verification_code_used")
        self.assertTrue(report["report_id"].startswith("diag_"))

    def test_expired_code_is_rejected_without_report(self):
        created = datetime(2026, 9, 21, 1, 0, tzinfo=timezone.utc)
        challenge = diagnostic.create_challenge(self.conn, operator="客服A", now=created)
        with self.assertRaises(diagnostic.DeviceDiagnosticError) as caught:
            diagnostic.submit_report(
                self.conn,
                payload("a", challenge["verification_code"]),
                now=created + timedelta(seconds=diagnostic.CHALLENGE_TTL_SECONDS + 1),
            )
        self.assertEqual(caught.exception.code, "verification_code_expired")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM aiml_device_diagnostic_report").fetchone()[0], 0)

    def test_other_app_is_rejected_and_does_not_consume_code(self):
        challenge = diagnostic.create_challenge(self.conn, operator="客服A")
        request = payload("a", challenge["verification_code"])
        request["app_name"] = "another-app"
        with self.assertRaises(diagnostic.DeviceDiagnosticError) as caught:
            diagnostic.submit_report(self.conn, request)
        self.assertEqual(caught.exception.status, 404)
        consumed = self.conn.execute(
            "SELECT consumed_at FROM aiml_device_diagnostic_challenge WHERE challenge_id = ?",
            (challenge["challenge_id"],),
        ).fetchone()[0]
        self.assertEqual(consumed, "")

    def test_reviewed_approval_matches_exact_installation_and_is_one_time(self):
        _challenge, report = self.new_report()
        reviewed = diagnostic.review_report(self.conn, {
            "report_id": report["report_id"],
            "decision": "approve_new_installation",
            "operator": "管理员A",
            "reason": "已通过客户订单和远程画面核对",
        })
        self.assertEqual(reviewed["review_state"], "approved_new_installation")
        approved = diagnostic.find_approved_installation(self.conn, payload("a"))
        self.assertEqual(approved, report["report_id"])
        self.assertIsNone(diagnostic.find_approved_installation(self.conn, payload("b")))

        diagnostic.consume_approved_installation(
            self.conn,
            report_id=approved,
            code_id="CODE-B",
            canonical_machine_code="v3_" + "f" * 64,
        )
        self.assertIsNone(diagnostic.find_approved_installation(self.conn, payload("a")))
        with self.assertRaises(diagnostic.DeviceDiagnosticError):
            diagnostic.consume_approved_installation(
                self.conn,
                report_id=approved,
                code_id="CODE-C",
                canonical_machine_code="v3_" + "e" * 64,
            )

    def test_list_masks_machine_and_canonical_codes(self):
        _challenge, report = self.new_report()
        diagnostic.review_report(self.conn, {
            "report_id": report["report_id"],
            "decision": "reject",
            "operator": "管理员A",
            "reason": "信息不一致",
        })
        result = diagnostic.list_reports(self.conn)
        self.assertEqual(len(result["items"]), 1)
        rendered = json.dumps(result, ensure_ascii=False)
        self.assertNotIn(V2, rendered)
        self.assertIn("…", result["items"][0]["machine_code_masked"])


if __name__ == "__main__":
    unittest.main()
