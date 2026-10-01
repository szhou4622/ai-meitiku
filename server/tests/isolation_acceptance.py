"""第 14 点隔离性验收：真实启动 before/after 两个服务端逐字节比对。

不是单元测试，而是端到端验收：对同一组请求分别打到未改动的服务端和改动后的
服务端，比对 HTTP 状态、响应体字节、以及数据库行数。对照 app 的任何一处差异
都判定为失败。

用法（由 run_isolation_acceptance.sh 调用）：
    python3 isolation_acceptance.py <before_dir> <after_dir>
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

APP = "ai-media-library"
CONTROL_APPS = ("OriginalVideoDedupTool", "qianchuan-lapian-tool", "DadaoMaterialClassifier")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for(port, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def request(port, path, payload=None, headers=None, method=None):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Accept", "application/json")
    if data:
        req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return -1, str(e).encode()


class Server:
    def __init__(self, source_dir, phase=None, label=""):
        self.source_dir = source_dir
        self.phase = phase
        self.label = label
        self.dir = tempfile.mkdtemp(prefix=f"aiml-iso-{label}-")
        for name in os.listdir(source_dir):
            shutil.copy2(os.path.join(source_dir, name), self.dir)
        self.db = os.path.join(self.dir, "license.sqlite3")
        self.port = free_port()
        self.proc = None

    def start(self):
        env = dict(os.environ)
        env["OVDT_LICENSE_DB"] = self.db
        env["OVDT_LICENSE_PORT"] = str(self.port)
        if self.phase:
            env["AIML_IDENTITY_PHASE"] = self.phase
        self.proc = subprocess.Popen(
            [sys.executable, "license_server.py"],
            cwd=self.dir, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if not wait_for(self.port):
            out, err = self.proc.communicate(timeout=5)
            raise RuntimeError(f"[{self.label}] 启动失败\nSTDOUT:\n{out.decode()}\nSTDERR:\n{err.decode()}")
        return self

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        shutil.rmtree(self.dir, ignore_errors=True)

    def table_counts(self):
        import sqlite3
        if not os.path.exists(self.db):
            return {}
        conn = sqlite3.connect(self.db)
        names = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        out = {}
        for n in names:
            if n.startswith("aiml_"):
                continue  # 新表只存在于 after，比对时排除
            try:
                out[n] = conn.execute(f"SELECT COUNT(*) FROM {n}").fetchone()[0]
            except Exception:
                out[n] = "?"
        conn.close()
        return out


def control_probes():
    """对照 app 的请求集合：合法与非法各一组。"""
    probes = []
    for app in CONTROL_APPS:
        probes.append((f"{app}/activate-valid", "/api/license/activate", {
            "app_name": app, "activation_code": "TEST-CODE-0001",
            "machine_code": "v2_" + "a" * 64, "client_version": "1.0.0",
            "license_protocol_version": 2,
        }, None, None))
        probes.append((f"{app}/activate-malformed", "/api/license/activate", {
            "app_name": app, "machine_code": 12345,
        }, None, None))
        probes.append((f"{app}/device-status", "/api/license/device/status", None,
                       {"Authorization": "Bearer bogus", "X-Device-Credential": "bogus"}, "GET"))
        probes.append((f"{app}/device-unbind", "/api/license/device/unbind", {"app_name": app},
                       {"Authorization": "Bearer bogus", "X-Device-Credential": "bogus"}, None))
        # 对照 app 打到新端点必须 404
        probes.append((f"{app}/identity-observe", "/api/license/identity/observe", {
            "app_name": app,
            "machine_identity_v3": {"version": 3, "platform": "win32",
                                    "factors": {"machine_guid": {"hash": "a" * 32}}},
        }, None, None))
    probes.append(("shared/health", "/health", None, None, "GET"))
    probes.append(("shared/unknown", "/api/license/does-not-exist", {"app_name": "x"}, None, None))
    return probes


def normalize(body):
    """剔除本来就会变化的字段（时间戳等），只比对语义内容。"""
    try:
        data = json.loads(body.decode("utf-8"))
    except Exception:
        return body
    if isinstance(data, dict):
        data.pop("time", None)
    return json.dumps(data, ensure_ascii=False, sort_keys=True).encode("utf-8")


def run_phase(before_dir, after_dir, phase):
    before = Server(before_dir, phase=None, label="before").start()
    after = Server(after_dir, phase=phase, label=f"after-{phase}").start()
    failures = []
    try:
        for name, path, payload, headers, method in control_probes():
            s1, b1 = request(before.port, path, payload, headers, method)
            s2, b2 = request(after.port, path, payload, headers, method)
            n1, n2 = normalize(b1), normalize(b2)

            if name.endswith("/identity-observe"):
                # before 不认识该端点 → 404；after 因 app_name 不符也必须 404
                if s2 != 404:
                    failures.append(f"[{phase}] {name}: after 应返回 404，实际 {s2}")
                continue

            if s1 != s2:
                failures.append(f"[{phase}] {name}: 状态码 {s1} -> {s2}")
            if n1 != n2:
                failures.append(f"[{phase}] {name}: 响应体不同\n  before={n1[:300]}\n  after ={n2[:300]}")

        c1, c2 = before.table_counts(), after.table_counts()
        if c1 != c2:
            failures.append(f"[{phase}] 既有表行数不同: {c1} vs {c2}")

        # 新表不得出现其他 app
        import sqlite3
        if os.path.exists(after.db):
            conn = sqlite3.connect(after.db)
            for table in ("aiml_machine_identity_device", "aiml_machine_identity_event"):
                try:
                    n = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE app_name != ?", (APP,)).fetchone()[0]
                    if n:
                        failures.append(f"[{phase}] {table} 出现了 {n} 行非 {APP} 数据")
                except sqlite3.OperationalError:
                    pass
            conn.close()
    finally:
        before.stop()
        after.stop()
    return failures


def run_fault_injection(before_dir, after_dir):
    """把新模块替换成必然抛异常的版本，确认对照 app 完全不受影响。"""
    broken_dir = tempfile.mkdtemp(prefix="aiml-iso-broken-")
    for name in os.listdir(after_dir):
        shutil.copy2(os.path.join(after_dir, name), broken_dir)
    # Keep the module's other exports available to canonical activation.
    # Inject a failure into the observe handler only.
    with open(os.path.join(broken_dir, "ai_media_license_identity.py"), "a", encoding="utf-8") as f:
        f.write("\ndef handle_identity_observe(*a, **k):\n"
                "    raise RuntimeError('injected fault')\n")

    before = Server(before_dir, label="before").start()
    broken = Server(broken_dir, phase="observe", label="broken").start()
    failures = []
    try:
        for name, path, payload, headers, method in control_probes():
            if name.endswith("/identity-observe"):
                continue
            s1, b1 = request(before.port, path, payload, headers, method)
            s2, b2 = request(broken.port, path, payload, headers, method)
            if s1 != s2 or normalize(b1) != normalize(b2):
                failures.append(f"[fault] {name}: {s1} -> {s2}，故障注入影响了对照 app")
        # 本应用打到新端点：模块抛异常，但分支必须吞掉并返回 200
        s, b = request(broken.port, "/api/license/identity/observe", {
            "app_name": APP,
            "machine_identity_v3": {"version": 3, "platform": "win32",
                                    "factors": {"machine_guid": {"hash": "a" * 32}}},
        })
        if s != 200:
            failures.append(f"[fault] 本应用请求应被吞掉并返回 200，实际 {s} {b[:200]}")
    finally:
        before.stop()
        broken.stop()
        shutil.rmtree(broken_dir, ignore_errors=True)
    return failures


def main():
    before_dir, after_dir = sys.argv[1], sys.argv[2]
    all_failures = []

    for phase in ("off", "observe", "migrate", "enforce"):
        print(f"--- 阶段 {phase} × {len(CONTROL_APPS)} 个对照 app ---")
        failures = run_phase(before_dir, after_dir, phase)
        for f in failures:
            print("  FAIL", f)
        if not failures:
            print("  OK   响应体与行数逐项一致")
        all_failures += failures

    print("--- 故障注入 ---")
    failures = run_fault_injection(before_dir, after_dir)
    for f in failures:
        print("  FAIL", f)
    if not failures:
        print("  OK   模块抛异常时对照 app 不受任何影响")
    all_failures += failures

    print()
    if all_failures:
        print(f"隔离性验收失败：{len(all_failures)} 项")
        return 1
    print("隔离性验收通过：4 个阶段 × 3 个对照 app + 故障注入，全部一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
