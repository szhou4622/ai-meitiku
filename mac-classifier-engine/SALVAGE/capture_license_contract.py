#!/usr/bin/env python3
"""Capture the legacy classifier license wire contract without network access."""

from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path


SALVAGE_ROOT = Path(__file__).resolve().parent
ENGINE_ROOT = SALVAGE_ROOT.parent
OUTPUT = SALVAGE_ROOT / "behavior-samples" / "modules" / "license_client.json"
SAMPLE_MACHINE = "ABCD-EFGH-IJKL-MNOP-QRST"


class FakeResponse:
    status = 200

    def __init__(self, payload: dict[str, object]):
        self.stream = io.BytesIO(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def read(self) -> bytes:
        return self.stream.read()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def main() -> int:
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("must run with CPython 3.12")
    os.environ.pop("ARK_API_KEY", None)
    sys.path.insert(0, str(ENGINE_ROOT / "src"))
    from xiaoguan_classifier import license_client as module

    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout):
        body = json.loads(request.data.decode("utf-8"))
        captured.update({
            "url": request.full_url,
            "method": request.method,
            "timeout_seconds": timeout,
            "headers": dict(request.header_items()),
            "request_fields": sorted(body),
            "request_sample": {
                **body,
                "activation_code": "<redacted-activation-code>",
                "code": "<redacted-activation-code>",
                "machine_code": "<redacted-machine-code>",
            },
        })
        return FakeResponse({"ok": True, "data": {"status": "active"}})

    original_urlopen = module.urllib.request.urlopen
    original_machine_code = module.machine_code
    original_machine_source = module._machine_source
    try:
        module.urllib.request.urlopen = fake_urlopen
        module.machine_code = lambda: SAMPLE_MACHINE
        status, response = module._request_activation("SALVAGE-TEST-CODE")
        captured["response_sample"] = {"http_status": status, "body": response}

        sample_response = {
            "ok": True,
            "data": {
                "bound_machine_code": SAMPLE_MACHINE,
                "issued_at": "2026-09-16T00:00:00Z",
                "expires_at": "2026-10-16T00:00:00Z",
                "license_type": "monthly",
                "duration_days": 30,
                "code_id": "sample-code-id",
                "status": "active",
            },
        }
        state = module._state_from_response("SALVAGE-TEST-CODE", sample_response, None)
        state["activation_credential"] = "<redacted-activation-code>"
        state["machine_code"] = "<redacted-machine-code>"
        captured["normalized_state_fields"] = sorted(state)
        captured["normalized_state_sample"] = state

        module.machine_code = original_machine_code
        module._machine_source = lambda: "SALVAGE-SAMPLE-HARDWARE"
        captured["machine_code_format_sample"] = module.machine_code()
    finally:
        module.urllib.request.urlopen = original_urlopen
        module.machine_code = original_machine_code
        module._machine_source = original_machine_source

    payload = {
        "module": "xiaoguan_classifier.license_client",
        "observed": True,
        "network_used": False,
        "note": "All HTTP behavior was captured with a local fake urlopen; no request left the process.",
        "samples": captured,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(OUTPUT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
