"""端到端验证 /api/license/identity/observe 分支本身。

单元测试覆盖的是模块，这里覆盖的是 license_server.py 里那一处分支：
归属判定失败时必须 404 而不是 200，否则等于向不相关的应用确认了该路径存在。

用法：
    python3 endpoint_e2e.py <after_dir>
"""

import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

APP = "ai-media-library"
CONTROL_APPS = ("OriginalVideoDedupTool", "qianchuan-lapian-tool", "DadaoMaterialClassifier")
PATH = "/api/license/identity/observe"

_failures = []


def check(name, actual, expected):
    if actual == expected:
        print(f"  OK   {name}: {actual}")
    else:
        print(f"  FAIL {name}: 期望 {expected}，实际 {actual}")
        _failures.append(name)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def start(after_dir, phase):
    work = tempfile.mkdtemp(prefix="aiml-e2e-")
    for name in os.listdir(after_dir):
        shutil.copy2(os.path.join(after_dir, name), work)
    port = free_port()
    env = dict(os.environ)
    env["OVDT_LICENSE_DB"] = os.path.join(work, "license.sqlite3")
    env["OVDT_LICENSE_PORT"] = str(port)
    env["AIML_IDENTITY_PHASE"] = phase
    proc = subprocess.Popen([sys.executable, "license_server.py"], cwd=work, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.time() + 25
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
                if r.status == 200:
                    return proc, port, work
        except Exception:
            time.sleep(0.2)
    out, err = proc.communicate(timeout=5)
    raise RuntimeError(f"启动失败\n{out.decode()}\n{err.decode()}")


def raw_post(port, body_bytes, content_length=None):
    """直接走 http.client，以便发送畸形正文和伪造的 Content-Length。"""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.putrequest("POST", PATH)
        conn.putheader("Content-Type", "application/json")
        conn.putheader("Content-Length", str(content_length if content_length is not None else len(body_bytes)))
        conn.endheaders()
        if body_bytes:
            conn.send(body_bytes)
        response = conn.getresponse()
        return response.status, response.read()
    finally:
        conn.close()


def valid_payload(app_name):
    return {
        "app_name": app_name,
        "machine_code": "v2_" + "1" * 64,
        "machine_identity_v3": {
            "version": 3,
            "platform": "win32",
            "candidate_machine_code": "v3_" + "2" * 64,
            "factors": {
                "machine_guid": {"hash": "a" * 32},
                "bios_uuid": {"hash": "b" * 32},
                "system_disk_serial": {"hash": "c" * 32},
            },
            "low_confidence": False,
        },
    }


def main():
    after_dir = sys.argv[1]
    proc, port, work = start(after_dir, "observe")
    try:
        print("--- 归属判定失败一律 404（不得返回 200 泄露路径存在）---")

        # 畸形 JSON：read_json 抛异常，归属不明
        status, _ = raw_post(port, b'{"app_name": "OriginalVideoDedupTool"')
        check("对照 app 发畸形 JSON", status, 404)

        status, _ = raw_post(port, b'{"app_name": "ai-media-library"')
        check("本应用发畸形 JSON（归属不明同样 404）", status, 404)

        status, _ = raw_post(port, b'not json at all')
        check("完全不是 JSON", status, 404)

        # 超过 read_json 的 65536 上限
        oversize = json.dumps({
            "app_name": "OriginalVideoDedupTool",
            "padding": "x" * 70000,
        }).encode("utf-8")
        status, _ = raw_post(port, oversize)
        check("对照 app 正文超过 65536 字节", status, 404)

        oversize_target = json.dumps({
            "app_name": APP,
            "padding": "x" * 70000,
        }).encode("utf-8")
        status, _ = raw_post(port, oversize_target)
        check("本应用正文超过 65536 字节", status, 404)

        # 伪造的超大 Content-Length：read_json 在读取前即拒绝
        status, _ = raw_post(port, b'{}', content_length=999999)
        check("伪造超大 Content-Length", status, 404)

        # 空正文 / JSON 数组 / null
        status, _ = raw_post(port, b'')
        check("空正文", status, 404)
        status, _ = raw_post(port, b'[]')
        check("JSON 数组", status, 404)
        status, _ = raw_post(port, b'null')
        check("JSON null", status, 404)

        print("--- 归属明确后的正常行为 ---")

        for app in CONTROL_APPS:
            status, body = raw_post(port, json.dumps(valid_payload(app)).encode("utf-8"))
            check(f"对照 app {app} 合法请求", status, 404)
            check(f"对照 app {app} 响应体", json.loads(body).get("error"), "unknown endpoint")

        status, body = raw_post(port, json.dumps(valid_payload(APP)).encode("utf-8"))
        check("本应用合法请求", status, 200)
        parsed = json.loads(body)
        check("本应用响应 ok", parsed.get("ok"), True)
        check("本应用响应阶段", parsed.get("identity_phase"), "observe")

        print("--- 模块损坏时仍不得泄露路径 ---")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)

    # 把新模块删掉，确认对照 app 仍拿到 404 而不是 200
    broken = tempfile.mkdtemp(prefix="aiml-e2e-broken-")
    for name in os.listdir(after_dir):
        if name != "ai_media_license_identity.py":
            shutil.copy2(os.path.join(after_dir, name), broken)
    proc, port, work = start(broken, "observe")
    try:
        for app in CONTROL_APPS:
            status, _ = raw_post(port, json.dumps(valid_payload(app)).encode("utf-8"))
            check(f"模块缺失时对照 app {app}", status, 404)
        status, _ = raw_post(port, json.dumps(valid_payload(APP)).encode("utf-8"))
        check("模块缺失时本应用降级为 200", status, 200)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(broken, ignore_errors=True)

    print()
    if _failures:
        print(f"端点验收失败：{len(_failures)} 项 -> {_failures}")
        return 1
    print("端点验收通过：归属判定失败一律 404，归属明确后才降级为 200")
    return 0


if __name__ == "__main__":
    sys.exit(main())
