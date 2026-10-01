"""Local-only regression for shared routes preserved by the AI media merge.

Run with two source paths and a directory containing the *unchanged* online
license_core.py, por_precise_credits.py and ai_media_license_error_log.py.
All requests use synthetic codes and separate temporary SQLite databases.
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
from http.server import ThreadingHTTPServer


APP = "ProductOperationReport"
CARD = "SYNTHETIC-POR-TEST-CARD"
MACHINE = "v2_" + "d" * 64
TOKEN = "synthetic-internal-token"


def load_server(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def request(port, method, path, body=None, headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    payload = json.dumps(body).encode() if body is not None else None
    request_headers = {"Content-Type": "application/json", **(headers or {})}
    try:
        connection.request(method, path, payload, request_headers)
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def ledger(conn):
    """Only compare business state; random transaction IDs are not semantics."""
    account = conn.execute(
        "SELECT balance, balance_mode, billing_api FROM point_accounts WHERE app_name = ?",
        (APP,),
    ).fetchone()
    precise = conn.execute(
        "SELECT balance_units, mirror_points, machine_code FROM por_precise_accounts WHERE app_name = ?",
        (APP,),
    ).fetchone()
    transactions = conn.execute(
        "SELECT logical_task_id, attempt_id, amount_units, billed_model, bill_ref, cost_cny, "
        "balance_before_units, balance_after_units FROM por_precise_transactions WHERE app_name = ? "
        "ORDER BY logical_task_id",
        (APP,),
    ).fetchall()
    return account, precise, transactions


def scenario(source, label):
    server = load_server(source, f"merged_shared_{label}")
    server.POR_PRECISE_ENABLED = True
    server.POR_PRECISE_INTERNAL_TOKEN = TOKEN
    server.POR_PRECISE_POINTS_PER_CNY = "100"
    server.POR_PRECISE_COST_RATE = "0.5"
    server.DEVICE_SESSION_SECRET = "synthetic-session-secret-for-isolation"
    server.FEISHU_SYNC_ENABLED = False
    with tempfile.TemporaryDirectory(prefix=f"aiml-shared-{label}-") as temporary:
        server.DB_PATH = Path(temporary) / "license.sqlite3"
        server.init_db()
        code_hash = server.code_hash_for_app(CARD, APP)
        code_id = code_hash[:16].upper()
        with sqlite3.connect(server.DB_PATH) as conn:
            conn.execute(
                "INSERT INTO redeem_codes "
                "(app_name, code_id, code_hash, credits, duration_days, unlimited, "
                "license_type, expires_at, disabled, created_at) "
                "VALUES (?, ?, ?, 100, 0, 0, 'credits', '', 0, ?)",
                (APP, code_id, code_hash, server.utc_now()),
            )
            conn.commit()

        http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        results = {}
        try:
            status, activated = request(http.server_port, "POST", "/api/license/activate", {
                "app_name": APP, "activation_code": CARD, "machine_code": MACHINE,
                "license_protocol_version": 2, "client_version": "synthetic-isolation",
            })
            assert status == 200 and activated["action"] == "activated", (status, activated)
            proof = {
                "Authorization": "Bearer " + activated["license"]["device_session"],
                "X-Device-Credential": activated["license"]["device_credential"],
                "X-POR-Internal-Token": TOKEN,
            }
            with sqlite3.connect(server.DB_PATH) as conn:
                conn.execute(
                    "UPDATE point_accounts SET balance = 100, balance_mode = 'server_managed', "
                    "billing_api = 'credits_consume' WHERE app_name = ? AND code_id = ?",
                    (APP, code_id),
                )
                conn.commit()

            status, body = request(http.server_port, "GET", "/api/license/credits/precise/balance")
            results["missing_token"] = (status, body.get("message"))
            assert status == 403
            status, body = request(http.server_port, "GET", "/api/license/credits/precise/balance", headers={
                **proof, "X-Device-Credential": "synthetic-wrong-credential",
            })
            results["invalid_credential"] = (status, body.get("message"))
            assert status == 401
            with sqlite3.connect(server.DB_PATH) as conn:
                assert conn.execute(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' "
                    "AND name = 'por_precise_accounts'"
                ).fetchone()[0] == 0

            status, body = request(http.server_port, "GET", "/api/license/credits/precise/balance", headers=proof)
            results["balance"] = (status, body.get("remaining_units"), body.get("units_per_point"))
            assert results["balance"] == (200, 100_000_000, 1_000_000)
            valid = {
                "logical_task_id": "synthetic-task-1", "attempt_id": "synthetic-attempt-1",
                "amount_units": 20_000_000, "billed_model": "synthetic-model",
                "bill_ref": "synthetic-bill", "cost_cny": "0.1",
            }
            with sqlite3.connect(server.DB_PATH) as conn:
                before = ledger(conn)
            status, body = request(http.server_port, "POST", "/api/license/credits/precise/consume",
                                   {**valid, "cost_cny": "0.2"}, proof)
            results["pricing_rejected"] = (status, body.get("message"))
            assert status == 409
            with sqlite3.connect(server.DB_PATH) as conn:
                assert ledger(conn) == before, "Rejected charge changed business state"

            status, body = request(http.server_port, "POST", "/api/license/credits/precise/consume",
                                   valid, proof)
            results["consumed"] = (status, body.get("idempotent"), body.get("remaining_units"))
            assert results["consumed"] == (200, False, 80_000_000)
            with sqlite3.connect(server.DB_PATH) as conn:
                consumed_state = ledger(conn)
            status, body = request(http.server_port, "POST", "/api/license/credits/precise/consume",
                                   valid, proof)
            results["idempotent"] = (status, body.get("idempotent"), body.get("remaining_units"))
            assert results["idempotent"] == (200, True, 80_000_000)
            with sqlite3.connect(server.DB_PATH) as conn:
                assert ledger(conn) == consumed_state, "Idempotent retry wrote again"
            status, body = request(http.server_port, "POST", "/api/license/credits/precise/consume",
                                   {**valid, "attempt_id": "synthetic-attempt-2"}, proof)
            results["conflict_rejected"] = (status, body.get("message"))
            assert status == 409
            with sqlite3.connect(server.DB_PATH) as conn:
                assert ledger(conn) == consumed_state, "Conflicting retry changed business state"
                results["final_ledger"] = consumed_state
                results["activation"] = conn.execute(
                    "SELECT app_name, code_id, bound_machine_code, binding_status, binding_role, "
                    "credential_version FROM activations WHERE app_name = ?", (APP,)
                ).fetchall()
        finally:
            http.shutdown()
            http.server_close()
            worker.join(timeout=5)
        return results


def main():
    baseline, merged, dependency_dir = map(Path, sys.argv[1:4])
    por_source = dependency_dir / "por_precise_credits.py"
    expected = "00f3782c26d775254c8d36b1587ed66eadeca830450dc6d043f76b70efd32dfb"
    assert hashlib.sha256(por_source.read_bytes()).hexdigest() == expected, "POR dependency changed"
    sys.path.insert(0, str(dependency_dir))
    sys.path.insert(0, str(baseline.resolve().parents[1]))
    before = scenario(baseline, "baseline")
    after = scenario(merged, "merged")
    assert before == after, f"Shared route changed: {before!r} != {after!r}"
    for name in ("missing_token", "invalid_credential", "balance", "pricing_rejected",
                 "consumed", "idempotent", "conflict_rejected"):
        print(f"{name}: {after[name]}")
    print("Shared route HTTP and synthetic transaction state: identical")


if __name__ == "__main__":
    main()
