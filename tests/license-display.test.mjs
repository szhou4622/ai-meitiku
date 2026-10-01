import assert from "node:assert/strict";
import test from "node:test";
import { licenseDisplayDetails } from "../app/license-display.mjs";

test("shows an ordinary monthly card using its original card term", () => {
  assert.deepEqual(licenseDisplayDetails({
    licenseType: "monthly",
    durationDays: 30,
    activatedAt: "2026-08-20T07:17:00Z",
    expiresAt: "2026-09-19T07:17:00Z",
  }), {
    typeLabel: "月卡",
    durationTitle: "授权时长",
    durationLabel: "30 天",
    accumulated: false,
  });
});

test("uses the accumulated authorization period after extensions instead of the first card face value", () => {
  const result = licenseDisplayDetails({
    licenseType: "monthly",
    durationDays: 30,
    activatedAt: "2026-08-20T07:17:00Z",
    expiresAt: "2029-06-17T07:32:00Z",
  });

  assert.equal(result.typeLabel, "时间授权");
  assert.equal(result.durationTitle, "累计授权时长");
  assert.equal(result.durationLabel, "1032 天");
  assert.equal(result.accumulated, true);
});

test("falls back safely when server dates are absent or invalid", () => {
  assert.deepEqual(licenseDisplayDetails({ licenseType: "yearly", durationDays: 365 }), {
    typeLabel: "年卡",
    durationTitle: "授权时长",
    durationLabel: "365 天",
    accumulated: false,
  });
  assert.equal(licenseDisplayDetails(null).durationLabel, "—");
});
