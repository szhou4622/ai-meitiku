import assert from "node:assert/strict";
import test from "node:test";

import { LicenseDiagnosticLog, sanitizeDiagnosticDetails } from "../electron/license-diagnostic-log.mjs";

test("license diagnostic log redacts secrets, machine codes and activation codes", () => {
  const machineCode = `v2_${"a".repeat(64)}`;
  const details = sanitizeDiagnosticDetails({
    activationCode: "AIM-ABCD-EFGH-IJKL",
    deviceSession: "session-secret",
    machineCode,
    endpoint: "/activate",
    message: `Bearer super-secret ${machineCode}`,
  });
  const text = JSON.stringify(details);
  assert.doesNotMatch(text, /AIM-ABCD/);
  assert.doesNotMatch(text, /session-secret/);
  assert.doesNotMatch(text, new RegExp("a{64}"));
  assert.doesNotMatch(text, /super-secret/);
  assert.equal(details.endpoint, "/activate");
});

test("license diagnostic log keeps a bounded chronological session log", () => {
  let tick = 0;
  let latest = null;
  const log = new LicenseDiagnosticLog({
    maxEntries: 20,
    now: () => new Date(Date.UTC(2026, 8, 23, 8, 0, tick++)),
    onChange: (snapshot) => { latest = snapshot; },
  });
  for (let index = 0; index < 24; index += 1) {
    log.add(index === 23 ? "success" : "info", "authorization", `step-${index}`, { status: index });
  }
  assert.equal(log.snapshot().entries.length, 20);
  assert.equal(log.snapshot().entries[0].message, "step-4");
  assert.equal(latest.entries.at(-1).level, "success");
  assert.match(log.toText(), /授权运行诊断/);
  assert.match(log.toText(), /step-23/);

  const cleared = log.clear();
  assert.equal(cleared.entries.length, 1);
  assert.match(cleared.entries[0].message, /已清空/);
});
