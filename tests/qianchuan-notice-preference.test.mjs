import test from "node:test";
import assert from "node:assert/strict";
import { createQianchuanNoticePreference } from "../app/qianchuan-notice-preference.mjs";
import { classifyUserAction } from "../electron/user-action-errors.mjs";

test("mute survives restart until a successful connection and permits the next expiry reminder", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const missing = classifyUserAction("本机尚未完成千川授权");
  const expired = classifyUserAction("千川账户授权已过期");
  const preference = createQianchuanNoticePreference(storage);
  assert.equal(preference.shouldSuppress(missing), false);
  preference.mute();
  const restarted = createQianchuanNoticePreference(storage);
  assert.equal(restarted.shouldSuppress(missing), true);
  assert.equal(restarted.shouldSuppress(expired), true);
  assert.equal(restarted.shouldSuppress({ target: "models" }), false);
  restarted.connected();
  assert.equal(restarted.shouldSuppress(expired), false);
  assert.equal(createQianchuanNoticePreference(storage).shouldSuppress(expired), false);
  restarted.mute();
  assert.equal(restarted.shouldSuppress(expired), true);
});

test("storage failure still allows muting and connection reset for the current session", () => {
  const blocked = () => { throw new Error("storage unavailable"); };
  const preference = createQianchuanNoticePreference({ getItem: blocked, setItem: blocked, removeItem: blocked });
  preference.mute();
  assert.equal(preference.shouldSuppress({ target: "qianchuan" }), true);
  preference.connected();
  assert.equal(preference.shouldSuppress({ target: "qianchuan" }), false);
});
