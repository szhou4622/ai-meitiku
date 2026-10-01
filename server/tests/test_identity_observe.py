"""4b tests: v3 identity observation, scoring, phases and isolation.

Run with:  python3 -m unittest discover -s server/tests -v
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from itertools import combinations

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ai_media_license_identity as identity  # noqa: E402

APP = "ai-media-library"
CONTROL_APPS = ("OriginalVideoDedupTool", "qianchuan-lapian-tool", "DadaoMaterialClassifier")


def h(seed):
    return (seed * 32)[:32]


def win_payload(app_name=APP, **overrides):
    factors = {
        "machine_guid": {"hash": h("a")},
        "bios_uuid": {"hash": h("b")},
        "system_disk_serial": {"hash": h("c")},
        "baseboard_serial": {"hash": h("d")},
        "cpu_processor_id": {"hash": h("e")},
        "physical_mac": {"hash": h("f")},
    }
    factors.update(overrides.pop("factors", {}))
    body = {
        "app_name": app_name,
        "machine_code": "v2_" + "1" * 64,
        "machine_identity_v3": {
            "version": 3,
            "platform": "win32",
            "candidate_machine_code": "v3_" + "2" * 64,
            "factors": factors,
            "collection": {"duration_ms": 900, "fallback_used": False, "timed_out": False},
            "low_confidence": overrides.pop("low_confidence", False),
        },
    }
    body.update(overrides)
    return body


class TempDb(unittest.TestCase):
    def setUp(self):
        fd, self.db_path = tempfile.mkstemp(suffix=".sqlite3")
        os.close(fd)
        conn = sqlite3.connect(self.db_path)
        # 一张与线上同名的表，用来证明我们从不写它
        conn.execute("CREATE TABLE activations (id INTEGER PRIMARY KEY, app_name TEXT, binding_status TEXT)")
        conn.execute("INSERT INTO activations (app_name, binding_status) VALUES ('OriginalVideoDedupTool','active')")
        conn.commit()
        conn.close()

    def tearDown(self):
        os.unlink(self.db_path)

    def counts(self):
        conn = sqlite3.connect(self.db_path)
        out = {}
        for table in ("aiml_machine_identity_device", "aiml_machine_identity_factor",
                      "aiml_machine_identity_event", "activations"):
            try:
                out[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            except sqlite3.OperationalError:
                out[table] = None
        conn.close()
        return out


# ---------------------------------------------------------------- 权重与分母

class TestScoring(unittest.TestCase):
    def test_weights_are_server_side_only(self):
        """客户端上报的 weight/strength 一律不进入解析结果。"""
        body = win_payload()
        body["machine_identity_v3"]["factors"]["machine_guid"]["weight"] = 999
        body["machine_identity_v3"]["factors"]["machine_guid"]["strength"] = "max"
        parsed = identity.parse_identity_payload(body)
        self.assertEqual(parsed["factors"]["machine_guid"], h("a"))
        # 解析结果里只有哈希字符串，不存在任何客户端数字
        for value in parsed["factors"].values():
            self.assertIsInstance(value, str)

    def test_denominator_is_union_so_omission_cannot_inflate(self):
        """藏掉不匹配的因子不能抬高分数：它仍留在分母里。"""
        stored = {"machine_guid": h("a"), "bios_uuid": h("b"), "system_disk_serial": h("z")}
        # 老实上报：磁盘序列号不匹配
        honest = identity.score_against(stored, {"machine_guid": h("a"), "bios_uuid": h("b"),
                                                 "system_disk_serial": h("c")}, "win32")
        # 构造上报：藏掉磁盘序列号
        gaming = identity.score_against(stored, {"machine_guid": h("a"), "bios_uuid": h("b")}, "win32")
        self.assertEqual(honest["denominator"], 9)
        self.assertEqual(gaming["denominator"], 9, "省略已知因子后分母必须不变")
        self.assertLessEqual(gaming["ratio"], honest["ratio"] + 1e-9)

    def test_new_factor_cannot_inflate(self):
        stored = {"machine_guid": h("a")}
        padded = identity.score_against(stored, {"machine_guid": h("a"), "physical_mac": h("f")}, "win32")
        self.assertEqual(padded["numerator"], 3)
        self.assertEqual(padded["denominator"], 4, "新增因子只会进分母")

    def test_weak_only_match_never_binds(self):
        """全靠弱因子拼出的高比值不得判为同机。"""
        score = identity.score_against({"physical_mac": h("f"), "hardware_model": h("m")},
                                       {"physical_mac": h("f"), "hardware_model": h("m")}, "darwin")
        self.assertEqual(score["ratio"], 1.0)
        self.assertNotEqual(identity.classify(score), identity.DECISION_SAME_DEVICE)

    def test_strong_conflict_means_new_device(self):
        """克隆机特征：machine_guid 相同，bios_uuid 与磁盘序列号不同。"""
        stored = {"machine_guid": h("a"), "bios_uuid": h("b"), "system_disk_serial": h("c")}
        clone = {"machine_guid": h("a"), "bios_uuid": h("x"), "system_disk_serial": h("y")}
        score = identity.score_against(stored, clone, "win32")
        self.assertEqual(score["conflicting_strong_factors"], ["bios_uuid", "system_disk_serial"])
        self.assertEqual(identity.classify(score), identity.DECISION_NEW_DEVICE)

    def test_low_confidence_never_concludes_new_device(self):
        """因子少只降低信息量，不得降低信任度。"""
        stored = {"machine_guid": h("a"), "bios_uuid": h("b")}
        score = identity.score_against(stored, {"machine_guid": h("a"), "bios_uuid": h("b")}, "win32")
        self.assertEqual(identity.classify(score, low_confidence=True), identity.DECISION_NEEDS_REVIEW)


# ---------------------------------------------------------------- 约束 4

class TestCredentialGate(TempDb):
    def test_migrate_without_credential_never_binds(self):
        """满分 + 全强因子匹配 + 无凭证 → needs_review，且不写绑定。"""
        # 先在 observe 阶段建立一条记录
        identity.handle_identity_observe(win_payload(), self.db_path, phase="observe")
        before = self.counts()

        status, body = identity.handle_identity_observe(
            win_payload(), self.db_path, credential_verified=False, phase="migrate")
        after = self.counts()

        self.assertEqual(status, 200)
        self.assertEqual(body["identity_assessment"]["state"], identity.DECISION_NEEDS_REVIEW)
        self.assertNotIn("canonical_machine_code", body)
        self.assertEqual(before["activations"], after["activations"], "activations 行数必须不变")
        conn = sqlite3.connect(self.db_path)
        bound = conn.execute(
            "SELECT COUNT(*) FROM aiml_machine_identity_device WHERE state = ?",
            (identity.STATE_BOUND,)).fetchone()[0]
        conn.close()
        self.assertEqual(bound, 0, "无凭证时不得出现 bound 绑定")

    def test_migrate_without_credential_issues_nothing(self):
        _, body = identity.handle_identity_observe(
            win_payload(), self.db_path, credential_verified=False, phase="migrate")
        text = repr(body).lower()
        for leak in ("credential", "session", "token", "activation_code"):
            self.assertNotIn(leak, text)

    def test_migrate_without_credential_leaves_v2_intact(self):
        conn = sqlite3.connect(self.db_path)
        before = conn.execute("SELECT id, app_name, binding_status FROM activations").fetchall()
        conn.close()
        identity.handle_identity_observe(win_payload(), self.db_path,
                                         credential_verified=False, phase="migrate")
        conn = sqlite3.connect(self.db_path)
        after = conn.execute("SELECT id, app_name, binding_status FROM activations").fetchall()
        conn.close()
        self.assertEqual(before, after, "v2 绑定行必须逐字节相同")

    def test_no_score_can_bypass_credential_gate(self):
        """穷举：任何因子组合、任何分数，凭证缺失时判定恒为 needs_review。"""
        names = list(identity.FACTOR_WEIGHTS["win32"])
        checked = 0
        for size in range(1, len(names) + 1):
            for combo in combinations(names, size):
                factors = {n: {"hash": h(chr(97 + i))} for i, n in enumerate(names) if n in combo}
                body = win_payload()
                body["machine_identity_v3"]["factors"] = factors
                _, resp = identity.handle_identity_observe(
                    body, self.db_path, credential_verified=False, phase="migrate")
                self.assertEqual(resp["identity_assessment"]["state"],
                                 identity.DECISION_NEEDS_REVIEW,
                                 f"组合 {combo} 绕过了凭证闸门")
                self.assertNotIn("canonical_machine_code", resp)
                checked += 1
        self.assertEqual(checked, 2 ** len(names) - 1)

    def test_enforce_also_requires_credential(self):
        _, body = identity.handle_identity_observe(
            win_payload(), self.db_path, credential_verified=False, phase="enforce")
        self.assertEqual(body["identity_assessment"]["state"], identity.DECISION_NEEDS_REVIEW)


# ---------------------------------------------------------------- 四阶段

class TestPhases(TempDb):
    def test_off_touches_nothing(self):
        status, body = identity.handle_identity_observe(win_payload(), self.db_path, phase="off")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True, "identity_phase": "off"})
        self.assertIsNone(self.counts()["aiml_machine_identity_device"], "off 阶段不得建表")

    def test_unknown_phase_falls_back_to_off(self):
        for value in ("", "ENFORCE_ALL", "yes", "1", None):
            env = {} if value is None else {"AIML_IDENTITY_PHASE": value}
            self.assertEqual(identity.current_phase(env), "off")

    def test_observe_records_but_never_binds(self):
        status, body = identity.handle_identity_observe(win_payload(), self.db_path, phase="observe")
        self.assertEqual(status, 200)
        self.assertNotIn("canonical_machine_code", body, "observe 不得返回 canonical")
        counts = self.counts()
        self.assertEqual(counts["aiml_machine_identity_device"], 1)
        self.assertGreaterEqual(counts["aiml_machine_identity_event"], 1)
        conn = sqlite3.connect(self.db_path)
        states = [r[0] for r in conn.execute("SELECT state FROM aiml_machine_identity_device")]
        conn.close()
        self.assertEqual(states, [identity.STATE_OBSERVED])

    def test_observe_shows_detailed_score_enforce_does_not(self):
        identity.handle_identity_observe(win_payload(), self.db_path, phase="observe")
        _, observed = identity.handle_identity_observe(win_payload(), self.db_path, phase="observe")
        self.assertIn("scoreNumerator", observed["identity_assessment"])

        _, enforced = identity.handle_identity_observe(
            win_payload(), self.db_path, credential_verified=True, phase="enforce")
        self.assertEqual(set(enforced["identity_assessment"]), {"state"},
                         "enforce 阶段只能给粗粒度状态")
        for leak in ("scoreNumerator", "scoreDenominator", "threshold", "matchedFactors"):
            self.assertNotIn(leak, repr(enforced))


# ---------------------------------------------------------------- 三台克隆机

class TestCloneMachines(TempDb):
    def test_three_clones_become_three_devices(self):
        """同一 v2 码、不同 BIOS UUID 与磁盘序列号 → 三行独立记录。"""
        for tag in ("a", "b", "c"):
            body = win_payload()
            body["machine_identity_v3"]["candidate_machine_code"] = "v3_" + tag * 64
            body["machine_identity_v3"]["factors"]["bios_uuid"] = {"hash": h(tag)}
            body["machine_identity_v3"]["factors"]["system_disk_serial"] = {"hash": h(tag + "1")}
            identity.handle_identity_observe(body, self.db_path, phase="observe")

        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT v2_machine_code, canonical_machine_code FROM aiml_machine_identity_device"
        ).fetchall()
        conn.close()
        self.assertEqual(len(rows), 3, "三台克隆机应产生三行独立设备记录")
        self.assertEqual(len({r[0] for r in rows}), 1, "三行共享同一个 v2 机器码")
        self.assertEqual(len({r[1] for r in rows}), 3, "三行的 canonical 各不相同")


# ---------------------------------------------------------------- 隔离性

    def test_clones_stay_distinct_without_a_valid_candidate_code(self):
        """回归：candidate 缺失或非法时，不得退回按 v2 码归并。

        克隆机共享 v2 码，一旦以它作为设备主键，三台机器会塌缩成一行，
        正好重现 v3 要消灭的撞码。此时必须改用强因子派生的内部键。
        """
        for tag, candidate in (("a", None), ("b", "not-a-code"), ("c", "v3_zzz")):
            body = win_payload()
            if candidate is None:
                body["machine_identity_v3"].pop("candidate_machine_code")
            else:
                body["machine_identity_v3"]["candidate_machine_code"] = candidate
            body["machine_identity_v3"]["factors"]["bios_uuid"] = {"hash": h(tag)}
            body["machine_identity_v3"]["factors"]["system_disk_serial"] = {"hash": h(tag + "1")}
            identity.handle_identity_observe(body, self.db_path, phase="observe")

        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT v2_machine_code, canonical_machine_code FROM aiml_machine_identity_device"
        ).fetchall()
        conn.close()
        self.assertEqual(len(rows), 3, "无有效 candidate 时仍须保持三行独立")
        self.assertEqual(len({r[0] for r in rows}), 1)
        self.assertEqual(len({r[1] for r in rows}), 3)

    def test_server_derived_key_is_never_returned_to_the_client(self):
        body = win_payload()
        body["machine_identity_v3"].pop("candidate_machine_code")
        _, resp = identity.handle_identity_observe(
            body, self.db_path, credential_verified=True, phase="migrate")
        self.assertNotIn("v3d_", repr(resp), "服务端派生的内部键不得回给客户端")


class TestIsolation(TempDb):
    def test_control_apps_get_404_and_touch_nothing(self):
        for app in CONTROL_APPS:
            before = self.counts()
            status, body = identity.handle_identity_observe(
                win_payload(app_name=app), self.db_path, phase="observe")
            after = self.counts()
            self.assertEqual(status, 404, f"{app} 必须得到 404")
            self.assertEqual(body, {"ok": False, "error": "unknown endpoint"})
            self.assertEqual(before, after, f"{app} 的请求不得改变任何行数")

    def test_control_apps_never_appear_in_new_tables(self):
        identity.handle_identity_observe(win_payload(), self.db_path, phase="observe")
        for app in CONTROL_APPS:
            identity.handle_identity_observe(win_payload(app_name=app), self.db_path, phase="observe")
        conn = sqlite3.connect(self.db_path)
        for table in ("aiml_machine_identity_device", "aiml_machine_identity_event"):
            count = conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE app_name != ?", (APP,)).fetchone()[0]
            self.assertEqual(count, 0, f"{table} 不得出现其他 app 的行")
        conn.close()

    def test_check_constraint_rejects_other_app_at_db_level(self):
        """即使代码被绕过，数据库层也必须拒绝。"""
        conn = sqlite3.connect(self.db_path)
        identity.ensure_schema(conn)
        with self.assertRaises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO aiml_machine_identity_device "
                "(app_name, v2_machine_code, canonical_machine_code, first_seen_at, last_seen_at, state) "
                "VALUES (?,?,?,?,?,?)",
                ("qianchuan-lapian-tool", "v2_x", "v3_x", "t", "t", "observed"))
        conn.close()

    def test_missing_app_name_is_404(self):
        for bad in ({}, {"app_name": ""}, {"app_name": None}, {"app_name": "ai-media-librar"},
                    {"app_name": "ai-media-library-x"}, "not a dict", None, []):
            status, _ = identity.handle_identity_observe(bad, self.db_path, phase="observe")
            self.assertEqual(status, 404, f"{bad!r} 应得到 404")
        # 前后空白会被 strip，与 license_server.py 读取 app_name 的方式一致
        status, _ = identity.handle_identity_observe(
            win_payload(app_name=" ai-media-library "), self.db_path, phase="observe")
        self.assertEqual(status, 200)

    def test_fault_injection_never_propagates(self):
        """故障注入：模块内部抛异常时必须返回 200 且不影响调用方。"""
        original = identity.parse_identity_payload
        identity.parse_identity_payload = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
        try:
            status, body = identity.handle_identity_observe(
                win_payload(), self.db_path, phase="observe")
            self.assertEqual(status, 200)
            self.assertEqual(body, {"ok": True})
        finally:
            identity.parse_identity_payload = original

        # 注入故障后，对照 app 依然只得到干净的 404
        for app in CONTROL_APPS:
            status, _ = identity.handle_identity_observe(
                win_payload(app_name=app), self.db_path, phase="observe")
            self.assertEqual(status, 404)

    def test_unreachable_database_still_returns_200(self):
        status, body = identity.handle_identity_observe(
            win_payload(), "/nonexistent/dir/does-not-exist.sqlite3", phase="observe")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"ok": True})

    def test_malformed_payloads_never_raise(self):
        for bad in (
            {"app_name": APP},
            {"app_name": APP, "machine_identity_v3": None},
            {"app_name": APP, "machine_identity_v3": {"version": 2}},
            {"app_name": APP, "machine_identity_v3": {"version": 3, "platform": "linux", "factors": {}}},
            {"app_name": APP, "machine_identity_v3": {"version": 3, "platform": "win32", "factors": "nope"}},
            {"app_name": APP, "machine_identity_v3": {"version": 3, "platform": "win32",
                                                      "factors": {"machine_guid": {"hash": "zz"}}}},
        ):
            status, body = identity.handle_identity_observe(bad, self.db_path, phase="observe")
            self.assertEqual(status, 200)
            self.assertTrue(body.get("ok"))


if __name__ == "__main__":
    unittest.main()
