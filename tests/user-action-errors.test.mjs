import test from "node:test";
import assert from "node:assert/strict";
import { classifyUserAction, serializeUserAction, userActionError } from "../electron/user-action-errors.mjs";
import { diagnosticHandler } from "../electron/application-log.mjs";
import { QianchuanService } from "../electron/qianchuan-service.mjs";
import { promptConnection } from "../electron/prompt-library-service.mjs";

function fixture() {
  const logs = [], events = [];
  return { logs, events, log: { write: (...args) => logs.push(args) }, event: { sender: { isDestroyed: () => false, send: (name, value) => events.push({ name, value }) } } };
}
test("the original Electron bootstrap message becomes a connection prerequisite without diagnostic detail", () => {
  const raw = "千川授权读取失败：Error invoking remote method 'qianchuan-bootstrap': Error: 本机尚未完成千川授权\n操作：qianchuan-bootstrap\n错误码：Error\n诊断编号：old-id";
  const action = classifyUserAction(raw);
  assert.equal(action.target, "qianchuan");
  assert.equal(action.action, "去连接千川");
  assert.doesNotMatch(action.message, /remote method|诊断编号|错误码/);
  const wrapped = `Error invoking remote method 'qianchuan-bootstrap': Error: ${serializeUserAction(action)}`;
  assert.deepEqual(classifyUserAction(wrapped), action);
  assert.deepEqual(classifyUserAction(`读取失败：${wrapped}`), action);
});
test("a real Qianchuan bootstrap rejection is logged as a prerequisite and emits a connection action", async () => {
  const { log, logs, events, event } = fixture();
  let calls = 0;
  const service = new QianchuanService({
    secureStore: { readCredential: async () => ({ deviceSession: "fixture-session", deviceCredential: "fixture-proof" }) },
    fetchImpl: async (url) => {
      calls++;
      if (url.endsWith("/session/exchange")) return Response.json({ access_token: "fixture-token", expires_in: 600 });
      return Response.json({ detail: "本机尚未完成千川授权" }, { status: 403 });
    },
  });
  await assert.rejects(diagnosticHandler(log, "qianchuan-bootstrap", () => service.bootstrap())(event), error => {
    assert.equal(error.code, "QIANCHUAN_CONNECT_REQUIRED");
    assert.doesNotMatch(error.message, /诊断编号|错误码/);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal(classifyUserAction(events[0].value).target, "qianchuan");
  assert.ok(logs.some(([level, name]) => level === "warn" && name === "operation.action-required"));
  assert.ok(!logs.some(([level]) => level === "error"));
});
test("missing API configuration guides settings and never attempts a supplier call", async () => {
  const { log, event, events } = fixture();
  let supplierCalls = 0;
  await assert.rejects(diagnosticHandler(log, "prompt-library-reverse", () => {
    promptConnection({ provider: "volcengine", volcengine: {} }, true);
    supplierCalls++;
  })(event), error => classifyUserAction(error)?.target === "models");
  assert.equal(supplierCalls, 0);
  assert.equal(classifyUserAction(events[0].value).action, "去配置 API");
  const result = { success: false, message: "MiniMax API Key 未配置，请先在后端配置后再使用声音复刻。" };
  assert.equal(await diagnosticHandler(log, "voice-preview", () => result)(event), result);
  assert.equal(classifyUserAction(events.at(-1).value).target, "models");
});
test("input validation and expiry are guidance, while unknown exceptions preserve diagnostics", async () => {
  assert.equal(classifyUserAction("请选择需要替换的参考图片").target, null);
  assert.equal(classifyUserAction("千川账户授权已过期").code, "QIANCHUAN_AUTH_EXPIRED");
  assert.equal(classifyUserAction(userActionError("MODEL_API_SETUP_REQUIRED")).target, "models");
  assert.equal(classifyUserAction("千川服务尚未就绪"), null);
  assert.equal(classifyUserAction("授权已过期，请重新授权", "qianchuan-bootstrap").target, "qianchuan");
  assert.equal(classifyUserAction("设备授权已过期", "qianchuan-bootstrap"), null);
  assert.equal(classifyUserAction("所选 API 请求失败（HTTP 401）", "prompt-library-reverse").target, "models");
  assert.equal(classifyUserAction("所选 API 请求失败（HTTP 503）", "prompt-library-reverse"), null);
  assert.equal(classifyUserAction(new Error("Cannot read properties of undefined")), null);
  const { log, logs, event } = fixture();
  const error = Object.assign(new Error("磁盘空间不足"), { code: "ENOSPC" });
  await assert.rejects(diagnosticHandler(log, "qianchuan-bootstrap", () => { throw error; })(event), /磁盘空间不足.*诊断编号/s);
  assert.ok(logs.some(([level, name]) => level === "error" && name === "operation.error"));
});
