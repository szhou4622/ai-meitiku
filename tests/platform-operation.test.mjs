import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlatformOperation } from '../electron/platform-operation.mjs';
import { PlatformOperationReceipts } from '../electron/platform-operation-receipts.mjs';
import { PlatformTaskClient } from '../electron/platform-task-client.mjs';

const task = { feature: 'prompt-library', provider: 'volcengine', payload: { messages: [] } };
function clientFor({ confirm = async () => true, prices = [], used = '0.123456', cached = false, pending = false } = {}) {
  const calls = [];
  const bodies = new Map(); let count = 0;
  const client = new PlatformTaskClient({ confirm, request: async (action, input) => {
    calls.push({ action, input });
    if (action === 'quote') {
      const body = { ok: true, app_name: 'ai-media-library', quote_id: (++count).toString(16).padStart(40, '0'),
        feature: task.feature, provider: task.provider, points: prices[count - 1] || '1.000001', pricing_kind: 'estimate',
        price_version: 'fixture-v1', billing_basis: 'supplier_usage_tariff', expires_at: 9999999999, status: 'quoted' };
      bodies.set(body.quote_id, body);
      return cached ? { ...body, status: 'succeeded', points_used: used, result: {} } : body;
    }
    return { ...bodies.get(input.quote_id), status: pending ? 'awaiting-bill' : 'succeeded',
      ...(pending ? { billing_pending: true } : { points_used: used }), result: {} };
  } });
  return { client, calls };
}

test('five replacement calls share one consent and one precise total after the operation ends', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aiml-operation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const notices = [];
  const receipts = new PlatformOperationReceipts({ file: path.join(directory, 'receipts.json'), onNotice: value => notices.push(value) });
  const operation = createPlatformOperation({ maxSteps: 5, onUpdate: value => receipts.update(value) });
  let confirmations = 0;
  const { client, calls } = clientFor({ confirm: async options => {
    confirmations++;
    assert.equal(options.message, '本次最多扣除 5.000005 积分');
    assert.doesNotMatch(JSON.stringify(options), /模型|供应商|Token|单价|volcengine/);
    return true;
  } });
  for (let i = 0; i < 5; i++) await client.execute({ ...task, requestId: String(i), operation });
  assert.equal(confirmations, 1); assert.equal(notices.length, 0);
  await operation.finish(); await operation.finish();
  assert.equal(notices.length, 1); assert.equal(notices[0].pointsUsed, '0.61728');
  assert.equal(calls.filter(call => call.action === 'run').length, 5);
  assert.ok(calls.every(call => !('operation' in call.input) && !('limit' in call.input)));
});

test('a higher later quote stops before payment and never opens an extra confirmation', async () => {
  const operation = createPlatformOperation({ maxSteps: 2 }); let confirms = 0;
  const { client, calls } = clientFor({ prices: ['1', '2'], used: '0.5', confirm: async () => { confirms++; return true; } });
  await client.execute({ ...task, requestId: 'first', operation });
  await assert.rejects(client.execute({ ...task, requestId: 'second', operation }), { code: 'PLATFORM_OPERATION_LIMIT' });
  assert.equal(confirms, 1); assert.equal(calls.filter(call => call.action === 'run').length, 1);
});

test('outstanding bills consume their full ceiling until a trusted receipt arrives', async () => {
  const operation = createPlatformOperation({ maxSteps: 2 });
  const { client, calls } = clientFor({ prices: ['1', '1.1'], pending: true });
  await client.execute({ ...task, requestId: 'first', operation });
  await assert.rejects(client.execute({ ...task, requestId: 'second', operation }), { code: 'PLATFORM_OPERATION_LIMIT' });
  assert.equal(calls.filter(call => call.action === 'run').length, 1);
});

test('cancelling the one consent also cancels concurrent substeps without reopening it', async () => {
  const operation = createPlatformOperation({ maxSteps: 5 }); let confirms = 0;
  const { client, calls } = clientFor({ confirm: async () => { confirms++; return false; } });
  const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => client.execute({ ...task, requestId: String(index), operation })));
  assert.equal(confirms, 1);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'PLATFORM_TASK_CANCELLED'));
  assert.equal(calls.filter(call => call.action === 'run').length, 0);
});

test('cancel and cached paid results produce no new debit notice', async () => {
  for (const cached of [false, true]) {
    const operation = createPlatformOperation({ maxSteps: 5 });
    const { client, calls } = clientFor({ cached, confirm: async () => false });
    if (cached) await client.execute({ ...task, operation });
    else await assert.rejects(client.execute({ ...task, operation }), { code: 'PLATFORM_TASK_CANCELLED' });
    await operation.finish();
    assert.equal(operation.snapshot().tasks.length, 0);
    assert.equal(calls.filter(call => call.action === 'run').length, 0);
  }
});

test('pending substeps settle into one aggregate after restart without duplicate notices', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aiml-operation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'receipts.json'); const notices = [];
  const first = new PlatformOperationReceipts({ file });
  await first.update({ id: 'same-operation', finished: true, tasks: [{ quoteId: 'a', pointsUsed: null }, { quoteId: 'b', pointsUsed: '0.1' }] });
  const resumed = new PlatformOperationReceipts({ file, onNotice: value => notices.push(value) });
  await resumed.settle({ quoteId: 'a', pointsUsed: '0.200001' });
  await resumed.settle({ quoteId: 'a', pointsUsed: '0.200001' });
  assert.deepEqual(notices, [{ id: 'same-operation', pointsUsed: '0.300001' }]);
  const again = new PlatformOperationReceipts({ file, onNotice: value => notices.push(value) });
  await again.settle({ quoteId: 'b', pointsUsed: '0.1' });
  assert.equal(notices.length, 1);
});

test('a completed failing step preserves its actual charge for the final aggregate', async () => {
  const operation = createPlatformOperation();
  const client = new PlatformTaskClient({ confirm: async () => true, request: async action => ({
    ok: true, app_name: 'ai-media-library', quote_id: 'a'.repeat(40), feature: task.feature, provider: task.provider,
    points: '1', pricing_kind: 'estimate', price_version: 'fixture-v1', billing_basis: 'supplier_usage_tariff', expires_at: 9999999999,
    status: action === 'quote' ? 'quoted' : 'failed', ...(action === 'run' ? { points_used: '0.2' } : {}),
  }) });
  await assert.rejects(client.execute({ ...task, operation }), error => error.terminalFailure && error.pointsUsed === '0.2');
  await operation.finish();
  assert.equal(operation.snapshot().tasks[0].pointsUsed, '0.2');
});
