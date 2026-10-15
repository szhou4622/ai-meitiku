import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUserAction } from '../electron/user-action-errors.mjs';
import { diagnosticHandler } from '../electron/application-log.mjs';

const prerequisites = [
  ['积分余额不足', 'INSUFFICIENT_POINTS'],
  ['本机缺少设备凭证，请先完成设备授权验证。', 'POINTS_CREDENTIAL_REQUIRED'],
  ['请先完成设备授权验证', 'PLATFORM_CREDENTIAL_REQUIRED'],
  ['请先填写产品信息和分类需求', 'USER_INPUT_REQUIRED'],
  ['请先上传原素材', 'USER_INPUT_REQUIRED'],
  ['请先导入提示词，或完成原素材反推', 'USER_INPUT_REQUIRED'],
  ['请拖入 1–9 张本地 JPG、PNG 或 WebP 图片', 'USER_INPUT_REQUIRED'],
  ['参考图片最多 9 张', 'USER_FILE_REQUIRED'],
  ['参考图片超过 10MB', 'USER_FILE_REQUIRED'],
  ['参考素材仅支持 JPG、PNG、WebP 图片', 'USER_FILE_REQUIRED'],
  ['每张图片须非空且不超过 10MB', 'USER_FILE_REQUIRED'],
  ['图片反推仅支持整片提示词', 'USER_FILE_REQUIRED'],
  ['图片反推不包含视频台词', 'USER_FILE_REQUIRED'],
  ['提示词文件过大，请控制在 100,000 字以内', 'USER_FILE_REQUIRED'],
  ['CSV 至少需要表头和 1 行数据', 'USER_FILE_REQUIRED'],
  ['CSV 最多支持 5000 行数据', 'USER_FILE_REQUIRED'],
  ['CSV 最多支持 128 列数据', 'USER_FILE_REQUIRED'],
  ['CSV 存在未闭合的引号', 'USER_FILE_REQUIRED'],
  ['同一列不能同时作为大分类和细分类字段', 'USER_FILE_REQUIRED'],
  ['最多保留 128 个数据字段', 'USER_FILE_REQUIRED'],
  ['CSV 中没有可导入的画面或文案', 'USER_FILE_REQUIRED'],
  ['没有识别到抖音或小红书链接', 'USER_FILE_REQUIRED'],
  ['单次最多添加 100 条链接', 'USER_FILE_REQUIRED'],
  ['共享网盘中没有可处理的图片或视频', 'USER_FILE_REQUIRED'],
  ['只能转写视频文件', 'USER_FILE_REQUIRED'],
  ['上传文件不能超过阿里云官方上限 1 GB', 'USER_FILE_REQUIRED'],
  ['字幕区域必须位于画面内，宽度和高度必须大于 0', 'USER_FILE_REQUIRED'],
  ['视频不能为空，上传文件不能超过 1 GB', 'USER_FILE_REQUIRED'],
  ['文件内容不是可识别的 MP4 视频', 'USER_FILE_REQUIRED'],
  ['上传视频分辨率不得超过 1080P（横屏 1920×1080 或竖屏 1080×1920）', 'USER_FILE_REQUIRED'],
  ['已有分类任务正在运行', 'TASK_IN_PROGRESS'],
  ['已有文案转写任务正在进行', 'TASK_IN_PROGRESS'],
  ['仍有去字幕任务运行或等待提交，请完成或取消待处理队列后再更换密钥', 'TASK_IN_PROGRESS'],
  ['请等待当前批次完成，或先取消待处理队列', 'TASK_IN_PROGRESS'],
  ['任务仍在处理，请稍后查看原任务；不会重复提交。', 'PLATFORM_TASK_PENDING'],
  ['成片尚未完成', 'NO_ACTIVE_TASK'],
  ['当前任务无需重试', 'NO_ACTIVE_TASK'],
  ['本批次已没有待提交视频，已提交任务会继续处理', 'NO_ACTIVE_TASK'],
  ['本批次没有可取消的待提交视频', 'NO_ACTIVE_TASK'],
  ['该任务无需重试同步', 'NO_ACTIVE_TASK'],
  ['提示词已被删除，请重新选择', 'RESOURCE_CHANGED'],
  ['提示词已发生变化，请重新打开后再保存', 'RESOURCE_CHANGED'],
  ['参考图片不存在，请重新选择', 'RESOURCE_CHANGED'],
  ['CSV 字段选择已过期，请重新选择文件', 'RESOURCE_CHANGED'],
  ['当前授权页面已过期，请重新发起授权', 'RESOURCE_CHANGED'],
  ['原视频已变化，请重新添加视频', 'RESOURCE_CHANGED'],
  ['请先完成飞瓜登录', 'FEIGUA_AUTH_REQUIRED'],
  ['飞瓜需要图形验证，请在已打开的飞瓜窗口完成验证后重新采集', 'FEIGUA_VERIFICATION_REQUIRED'],
  ['请先配置并保存登录入口网址', 'FEIGUA_ENTRY_REQUIRED'],
  ['此服务商的分类草案积分模式尚未开放', 'PLATFORM_API_UNAVAILABLE'],
  ['提示词库积分接口尚未开放。', 'PLATFORM_FEATURE_UNAVAILABLE'],
  ['更新密钥时请同时填写 AccessKey ID 和 Secret；两项留空则保留', 'ALIYUN_SETUP_REQUIRED'],
];

function fixture() {
  const logs = [], events = [];
  return { logs, events, log: { write: (...args) => logs.push(args) }, event: { sender: { isDestroyed: () => false, send: (name, value) => events.push({ name, value }) } } };
}

for (const [message, code] of prerequisites) test(`ordinary operation: ${message}`, async () => {
  const { logs, events, log, event } = fixture();
  const channel = 'fixture-operation';
  await assert.rejects(diagnosticHandler(log, channel, () => { throw new Error(message); })(event), error => {
    assert.equal(error.code, code);
    const ipc = new Error(`Error invoking remote method '${channel}': Error: ${error.message}`);
    const action = classifyUserAction(ipc);
    assert.equal(action?.code, code);
    assert.doesNotMatch(action.message, /remote method|诊断编号|错误码|ACTION_REQUIRED/);
    return true;
  });
  assert.equal(events.length, 1);
  assert.equal(classifyUserAction(events[0].value)?.code, code);
  assert.equal(logs.some(([level]) => level === 'error'), false);
  const returned = { ok: false, error: message };
  assert.equal(await diagnosticHandler(log, channel, () => returned)(event), returned);
  assert.equal(classifyUserAction(events.at(-1).value)?.code, code);
});

test('ordinary cancellations keep return contracts, stay quiet and never claim unverified billing', async () => {
  for (const [channel, result] of [
    ['prompt-library-export', { ok: false, cancelled: true }],
    ['classifier-export-template', { ok: false, cancelled: true }],
    ['qianchuan-library-sync', { success: false, cancelled: true, message: '同步已取消，进度已保存' }],
    ['choose-directory', { canceled: true }],
  ]) {
    const { logs, events, log, event } = fixture();
    assert.equal(await diagnosticHandler(log, channel, () => result)(event), result);
    assert.equal(events.length, 0);
    assert.equal(logs.some(([level]) => level === 'error'), false);
    const action = classifyUserAction(result);
    assert.equal(action.code, 'OPERATION_CANCELLED');
    assert.doesNotMatch(action.message, /未扣|未提交|退款/);
  }
  const { logs, log, event } = fixture();
  await assert.rejects(diagnosticHandler(log, 'feigua-start', () => { throw Object.assign(new Error('页面读取已取消'), { code: 'FEIGUA_CANCELLED' }); })(event), error => classifyUserAction(error).code === 'FEIGUA_CANCELLED');
  assert.equal(logs.some(([level]) => level === 'error'), false);
});

test('nested business error payloads preserve their classification', () => {
  assert.equal(classifyUserAction({ ok: false, error: { code: 'DEVICE_CHANGED', message: '设备授权已变更' } }).code, 'DEVICE_CHANGED');
  assert.equal(classifyUserAction({ ok: false, error: { code: 'PLATFORM_TASK_PENDING', message: '请查看原任务' } }).code, 'PLATFORM_TASK_PENDING');
});

test('provider quota and rate limits, upload credentials and cleanup guards guide the corresponding next step', async () => {
  for (const [channel, message, code] of [
    ['classifier-generate-template-draft', '请求失败（HTTP 402）', 'MODEL_QUOTA_REQUIRED'],
    ['prompt-library-generate', 'insufficient_quota', 'MODEL_QUOTA_REQUIRED'],
    ['api-settings-test', '账户余额不足', 'MODEL_QUOTA_REQUIRED'],
    ['classifier-run', '模型请求失败（HTTP 429）', 'MODEL_RATE_LIMITED'],
    ['voice-preview', 'too many requests', 'MODEL_RATE_LIMITED'],
    ['aliyun-subtitle-verify', 'InvalidAccessKeyId', 'ALIYUN_SETUP_REQUIRED'],
  ]) {
    const { log, logs, event } = fixture();
    await assert.rejects(diagnosticHandler(log, channel, () => { throw new Error(message); })(event), error => classifyUserAction(error)?.code === code);
    assert.equal(logs.some(([level]) => level === 'error'), false);
  }
  const { log, logs, events, event } = fixture();
  const blocked = { ok: false, blocked: true, message: '分类任务正在运行，已保留相关缓存。', reclaimedBytes: 0 };
  assert.equal(await diagnosticHandler(log, 'storage-management-clear', () => blocked)(event), blocked);
  assert.equal(classifyUserAction(events[0].value).code, 'OPERATION_BLOCKED');
  assert.equal(classifyUserAction(events[0].value).message, blocked.message);
  assert.equal(logs.some(([level]) => level === 'error'), false);
  assert.equal(classifyUserAction(new Error('请求失败（HTTP 429）'), 'qianchuan-library-sync'), null);
});

test('incomplete model output remains actionable guidance without erasing real diagnostics', async () => {
  const { log, logs, event } = fixture();
  const input = new Error('模型没有返回可用的完整提示词');
  await assert.rejects(diagnosticHandler(log, 'classifier-run', () => { throw input; })(event), /ACTION_REQUIRED:MODEL_OUTPUT_INCOMPLETE/);
  assert.ok(logs.some(([level, name]) => level === 'warn' && name === 'operation.action-required'));
  assert.ok(logs.every(([level]) => level !== 'error'));
});

test('unexpected exceptions, corruption, failed cancellation and uncertain charges retain diagnostics across IPC', async () => {
  for (const input of [
    new TypeError('可用积分不足'),
    new SyntaxError('CSV 存在未闭合的引号'),
    new Error('系统安全凭证存储尚未就绪'),
    new Error('分类 API 独立配置无法读取，请检查系统安全凭证存储'),
    new Error('提示词库文件格式无效'),
    new Error('missing logical classifier task'),
    new Error('云服务返回了无法识别的下载地址'),
    new Error('下载后端未包含在安装包中'),
    new Error('内部状态损坏：可用积分不足，请充值后重试。'),
    new Error('缓存读取失败，上一条提示为：可用积分不足，请充值或兑换积分后重试。'),
    new Error('千川服务暂时无法连接，请重试'),
    Object.assign(new Error('磁盘空间不足'), { code: 'ENOSPC' }),
    Object.assign(new Error('任务处理失败，本次扣除 0.25 积分。请保留原任务。'), { code: 'INSUFFICIENT_POINTS', terminalFailure: true }),
    Object.assign(new Error('任务处理失败，积分结算待核对；请保留原任务。'), { code: 'INSUFFICIENT_POINTS', billingPending: true }),
  ]) {
    const { logs, log, event } = fixture();
    assert.equal(classifyUserAction(input), null);
    await assert.rejects(diagnosticHandler(log, 'classifier-run', () => { throw input; })(event), error => {
      assert.match(error.message, /诊断编号/);
      const ipc = new Error(`Error invoking remote method 'classifier-run': Error: ${error.message}`);
      assert.equal(classifyUserAction(ipc), null, input.message);
      return true;
    });
    assert.ok(logs.some(([level]) => level === 'error'));
  }
  const { log, events, event } = fixture();
  await diagnosticHandler(log, 'classifier-cancel', () => ({ ok: false, cancelled: true, error: '无法保存任务记录' }))(event);
  assert.equal(events.length, 1);
  assert.equal(classifyUserAction(events[0].value), null);
});
