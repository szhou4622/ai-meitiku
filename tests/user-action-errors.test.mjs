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
  assert.equal(classifyUserAction("所选 API 请求失败（HTTP 503）", "prompt-library-reverse").code, 'MODEL_SERVICE_UNAVAILABLE');
  assert.equal(classifyUserAction(new Error("Cannot read properties of undefined")), null);
  const { log, logs, event } = fixture();
  const error = Object.assign(new Error("磁盘空间不足"), { code: "ENOSPC" });
  await assert.rejects(diagnosticHandler(log, "qianchuan-bootstrap", () => { throw error; })(event), /磁盘空间不足.*诊断编号/s);
  assert.ok(logs.some(([level, name]) => level === "error" && name === "operation.error"));
});

test('declined platform quote is normal cancellation, while provider and billing failures stay errors',async()=>{
 const {isPlatformQuoteCancellation}=await import('../electron/user-action-errors.mjs');
 assert.equal(isPlatformQuoteCancellation(Object.assign(new Error('已取消，本次未提交任务，也未扣积分。'),{code:'PLATFORM_TASK_CANCELLED'})),true);
 assert.equal(isPlatformQuoteCancellation(new Error("Error invoking remote method 'prompt-library-reverse': Error: 已取消，本次未提交任务，也未扣积分。")),true);
 assert.equal(isPlatformQuoteCancellation(new Error('已取消运行，但积分状态待确认')),false);
 assert.equal(isPlatformQuoteCancellation(Object.assign(new Error('余额不足'),{code:'INSUFFICIENT_POINTS'})),false);
 assert.equal(isPlatformQuoteCancellation(new Error('模型超时')),false);
});

test('insufficient points survives both IPC rejection and the exact historical error-detail envelope', async () => {
  const { log, logs, events, event } = fixture();
  const insufficient = Object.assign(new Error('可用积分不足，请充值后重试。'), { code: 'INSUFFICIENT_POINTS' });
  let rejection;
  try { await diagnosticHandler(log, 'classifier-generate-template-draft', () => { throw insufficient; })(event); }
  catch (error) { rejection = error; }
  assert.equal(rejection.code, 'INSUFFICIENT_POINTS');
  assert.doesNotMatch(rejection.message, /诊断编号|错误码/);
  const ipc = new Error(`Error invoking remote method 'classifier-generate-template-draft': Error: ${rejection.message}`);
  for (const input of [insufficient, ipc, events[0].value,
    { operation: 'classifier-generate-template-draft', message: "AI 生成草案失败：Error invoking remote method 'classifier-generate-template-draft': Error: 可用积分不足，请充值后重试。\n操作：classifier-generate-template-draft\n错误码：INSUFFICIENT_POINTS\n诊断编号：fixture-id" },
    { message: '请求未完成\n错误码：INSUFFICIENT_POINTS\n诊断编号：fixture-id' }]) {
    const action = classifyUserAction(input);
    assert.equal(action.code, 'INSUFFICIENT_POINTS');
    assert.equal(action.title, '积分不足');
    assert.equal(action.target, 'api');
    assert.equal(action.action, '去充值积分');
    assert.doesNotMatch(action.message, /remote method|诊断编号|错误码|ACTION_REQUIRED/);
  }
  assert.ok(logs.some(([level, name]) => level === 'warn' && name === 'operation.action-required'));
  assert.ok(!logs.some(([level]) => level === 'error'));
});

test('known business prerequisites remain guidance through returned results and string-only IPC', async () => {
  for (const [code, message, target] of [
    ['INVALID_REDEEM_CODE', '请输入有效的媒体库积分码。', 'api'],
    ['REDEEM_CODE_NOT_FOUND', '积分码无效，请核对后重试。', 'api'],
    ['REDEEM_CODE_USED', '积分码已被其他账户兑换。', 'api'],
    ['LEGACY_CODE_REVIEW_REQUIRED', '该旧码需管理员核对，不能直接作为积分码兑换。', 'api'],
    ['LEGACY_BALANCE_REVIEW_REQUIRED', '历史积分余额需管理员核对后迁移。', 'api'],
    ['QUOTE_EXPIRED', '积分报价已过期，请重新发起任务。', null],
    ['QUOTE_CONFIGURATION_CHANGED', '积分报价已更新，请重新确认后运行。', null],
    ['PLATFORM_API_UNAVAILABLE', '此功能的积分生成服务尚未开放，本次未提交任务，也未扣积分。', 'models'],
    ['CONSUMPTION_DISABLED', '平台积分消费暂不可用。', 'models'],
    ['SUBTITLE_FILE_TOO_LARGE', '上传文件不能超过 1 GB。', null],
    ['QIANCHUAN_AUTH_EXPIRED', '千川账户授权已失效，请重新完成官方授权。', 'qianchuan'],
    ['MODEL_API_SETUP_REQUIRED', '所选 API 配置不完整', 'models'],
    ['USER_INPUT_REQUIRED', '请选择需要替换的参考图片', null],
  ]) {
    const { log, logs, events, event } = fixture();
    const result = { ok: false, code, message };
    assert.equal(await diagnosticHandler(log, 'fixture-operation', () => result)(event), result);
    assert.equal(classifyUserAction(events[0].value)?.code, code);
    for (const value of [result, new Error(`操作未完成：Error invoking remote method 'fixture-operation': Error: ${message}`)]) {
      const action = classifyUserAction(value);
      assert.equal(action?.code, code, message);
      assert.equal(action.target, target);
      assert.doesNotMatch(action.message, /remote method|诊断编号|错误码/);
    }
    assert.ok(!logs.some(([level]) => level === 'error'), code);
  }
});

test('classifier quote cancellation is informational, but uncertain billing and unexpected faults retain diagnostics', async () => {
  const { log, logs, events, event } = fixture();
  const cancellation = Object.assign(new Error('已取消，本次未提交任务，也未扣积分。'), { code: 'PLATFORM_TASK_CANCELLED' });
  await assert.rejects(diagnosticHandler(log, 'classifier-generate-template-draft', () => { throw cancellation; })(event), { code: 'PLATFORM_TASK_CANCELLED' });
  assert.equal(events.length, 0);
  assert.ok(logs.some(([level, name]) => level === 'info' && name === 'operation.cancelled'));
  assert.ok(!logs.some(([level]) => level === 'error'));
  assert.equal(classifyUserAction(cancellation).code, 'PLATFORM_TASK_CANCELLED');
  for (const value of [
    Object.assign(new Error('可用积分不足'), { code: 'INSUFFICIENT_POINTS', terminalFailure: true }),
    Object.assign(new Error('积分结算待核对'), { code: 'INSUFFICIENT_POINTS', billingPending: true }),
    Object.assign(new Error('兑换请求冲突'), { code: 'IDEMPOTENCY_CONFLICT' }),
    Object.assign(new Error('余额数据无法确认'), { code: 'INVALID_POINTS_RESPONSE' }),
    new Error('磁盘空间不足'), new Error('Cannot read properties of undefined'),
  ]) assert.equal(classifyUserAction(value, 'classifier-generate-template-draft'), null);
});

test('model output, timeout, refusal and availability failures are guidance, never developer bug dialogs', async () => {
  const cases = [
    [new Error('分镜 2 的时间或独立提示词不完整，请重新生成'), 'MODEL_OUTPUT_INCOMPLETE'],
    [Object.assign(new Error('供应商返回格式不完整'), {code:'invalid_schema'}), 'MODEL_OUTPUT_INCOMPLETE'],
    [Object.assign(new Error('正文为空'), {code:'empty_response'}), 'MODEL_OUTPUT_INCOMPLETE'],
    [Object.assign(new Error('正文截断'), {code:'output_truncated'}), 'MODEL_OUTPUT_INCOMPLETE'],
    [Object.assign(new Error('连接中断'), {code:'stream_interrupted'}), 'MODEL_OUTPUT_INCOMPLETE'],
    [new Error('文本模型 90 秒内没有返回，请稍后重试'), 'MODEL_RESPONSE_TIMEOUT'],
    [Object.assign(new Error('等待超时'), {code:'idle_timeout'}), 'MODEL_RESPONSE_TIMEOUT'],
    [Object.assign(new Error('模型拒绝'), {code:'refusal'}), 'MODEL_CONTENT_RESTRICTED'],
    [Object.assign(new Error('限制输出'), {code:'content_filter'}), 'MODEL_CONTENT_RESTRICTED'],
    [new Error('模型请求失败（HTTP 503）'), 'MODEL_SERVICE_UNAVAILABLE'],
  ];
  for (const [error,code] of cases) {
    const {log,logs,event,events} = fixture();
    assert.equal(classifyUserAction(error, 'classifier-generate-template-draft')?.code, code);
    await assert.rejects(diagnosticHandler(log,'classifier-generate-template-draft',()=>{throw error;})(event), value => {
      assert.match(value.message, /ACTION_REQUIRED/);
      assert.doesNotMatch(value.message, /诊断编号|参考编号|诊断类型/);
      return true;
    });
    assert.ok(events.every(entry=>!entry.value.message.includes('诊断编号')));
    assert.ok(!logs.some(([level])=>level==='error'));
    assert.equal(classifyUserAction(new TypeError(error.message),'classifier-generate-template-draft'),null);
  }
  assert.equal(classifyUserAction(new Error('HTTP 503'),'storage-management-generated-read'), null);
  assert.equal(classifyUserAction(new Error('磁盘文件 JSON 不完整'),'classifier-generate-template-draft'),null);
});
