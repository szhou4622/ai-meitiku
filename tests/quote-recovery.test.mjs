import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PlatformTaskClient } from '../electron/platform-task-client.mjs';
import { createPlatformOperation } from '../electron/platform-operation.mjs';
import { createPromptPlatformRequests } from '../electron/prompt-platform-requests.mjs';

const task = { feature: 'prompt-library', provider: 'volcengine', payload: { messages: [] }, requestId: 'logical-original' };
function fixture({ expireDuringConsent = false, cancelRecovery = false, state = 'quoted', changedPrice = false,
  raceOnRun = false, statusFails = false, requestId = task.requestId } = {}) {
  let clock = expireDuringConsent || raceOnRun ? 0 : 301000;
  const calls = [], dialogs = [], rows = new Map(), ids = new Map();
  const old = { ok: true, app_name: 'ai-media-library', quote_id: 'a'.repeat(40), feature: task.feature, provider: task.provider,
    points: '1', pricing_kind: 'estimate', price_version: 'v1', billing_basis: 'supplier_usage_tariff', expires_at: 300, status: 'quoted' };
  let generations = 0;
  rows.set(old.quote_id, old); ids.set(requestId, old.quote_id);
  const client = new PlatformTaskClient({ now: () => clock,
    confirm: async options => {
      dialogs.push(options);
      if (options.title === '积分报价已过期') return !cancelRecovery;
      if (expireDuringConsent && dialogs.length === 1) clock = 301000;
      return true;
    },
    request: async (action, input) => {
      calls.push({ action, input });
      if (action === 'quote') {
        if (!ids.has(input.request_id)) {
          const quoteId = createHash('sha1').update(input.request_id).digest('hex');
          ids.set(input.request_id, quoteId);
          rows.set(quoteId, { ...old, quote_id: quoteId, expires_at: clock / 1000 + 300,
            ...(changedPrice ? { price_version: 'v2', points: '2' } : {}) });
        }
        return rows.get(ids.get(input.request_id));
      }
      if (action === 'status') {
        if (statusFails) throw Object.assign(new Error('unavailable'), { kind: 'network' });
        if (state !== 'quoted') return { ...old, status: state, ...(state === 'succeeded'
          ? { points_used: '0.2', result: { content: 'existing result' } }
          : state === 'awaiting-bill' ? { billing_pending: true, result: { content: 'existing result' } } : {}) };
        return rows.get(input.quote_id);
      }
      const row = rows.get(input.quote_id);
      if ((raceOnRun && input.quote_id === old.quote_id) || clock / 1000 >= row.expires_at)
        throw Object.assign(new Error('expired'), { code: 'QUOTE_EXPIRED' });
      generations++;
      const completed = { ...row, status: 'succeeded', points_used: '0.2', result: { content: 'new result' } };
      rows.set(input.quote_id, completed);
      return completed;
    } });
  return { client, calls, dialogs, old, generations: () => generations };
}

test('an expired quote offers continue, renews only after a proven unsubmitted status, and runs once', async () => {
  const f = fixture();
  const result = await f.client.execute(task);
  assert.equal(result.result.content, 'new result');
  assert.equal(f.generations(), 1);
  assert.deepEqual(f.calls.map(c => c.action), ['quote', 'status', 'quote', 'run']);
  assert.deepEqual(f.dialogs[0].buttons, ['重新报价并继续', '暂不执行']);
  assert.equal(f.dialogs[0].cancelId, 1);
  assert.notEqual(f.calls[0].input.request_id, f.calls[2].input.request_id);
});

test('expiry while the total-consent dialog is open does not submit the stale quote or leave pending billing', async () => {
  const f = fixture({ expireDuringConsent: true });
  const operation = createPlatformOperation({ maxSteps: 5 });
  await f.client.execute({ ...task, operation });
  await operation.finish();
  const rows = operation.snapshot().tasks;
  assert.equal(rows[0].notSubmitted, true);
  assert.equal(rows[0].pointsUsed, '0');
  assert.equal(rows[0].billingPending, false);
  assert.equal(rows[1].pointsUsed, '0.2');
  assert.equal(f.generations(), 1);
  assert.deepEqual(f.calls.filter(c => c.action === 'run').map(c => c.input.quote_id), [rows[1].quoteId]);
});

test('a server-side expiry race is recovered after checking the same quote status', async () => {
  const f = fixture({ raceOnRun: true });
  await f.client.execute({ ...task, operation: createPlatformOperation({ maxSteps: 2 }) });
  assert.equal(f.generations(), 1);
  assert.deepEqual(f.calls.map(c => c.action), ['quote', 'run', 'status', 'quote', 'run']);
});

test('declining recovery keeps confirmed unsubmitted billing at zero and performs no new quote or run', async () => {
  const f = fixture({ expireDuringConsent: true, cancelRecovery: true });
  const operation = createPlatformOperation({ maxSteps: 2 });
  await assert.rejects(f.client.execute({ ...task, operation }), error => error.code === 'PLATFORM_TASK_CANCELLED' && error.notSubmitted && !error.billingPending);
  assert.equal(operation.snapshot().tasks[0].pointsUsed, '0');
  assert.equal(f.calls.filter(c => c.action === 'quote').length, 1);
  assert.equal(f.generations(), 0);
});

test('a task accepted by another process reuses its completed result instead of renewing or charging again', async () => {
  const f = fixture({ state: 'succeeded' });
  assert.equal((await f.client.execute(task)).result.content, 'existing result');
  assert.deepEqual(f.calls.map(c => c.action), ['quote', 'status']);
  assert.equal(f.dialogs.length, 0);
});

test('an unknown supplier outcome never offers renewal or claims an unsubmitted zero charge', async () => {
  const f = fixture({ state: 'unknown' });
  await assert.rejects(f.client.execute(task), { code: 'SUPPLIER_OUTCOME_UNKNOWN' });
  assert.deepEqual(f.calls.map(c => c.action), ['quote', 'status']);
  assert.equal(f.dialogs.length, 0);
});

test('an existing result awaiting its bill is preserved without a new quote', async () => {
  const f = fixture({ state: 'awaiting-bill' });
  const result = await f.client.execute(task);
  assert.equal(result.billingPending, true);
  assert.equal(result.pointsUsed, null);
  assert.equal(f.generations(), 0);
});

test('unavailable original-task status stops recovery before creating another quote', async () => {
  const f = fixture({ statusFails: true });
  await assert.rejects(f.client.execute(task), { kind: 'network' });
  assert.equal(f.calls.filter(c => c.action === 'quote').length, 1);
  assert.equal(f.dialogs.length, 0);
});

test('renewal IDs remain deterministic and bounded for maximum-length logical IDs', async () => {
  const generated = [];
  for (let i = 0; i < 2; i++) {
    const f = fixture({ requestId: 'x'.repeat(128) });
    await f.client.execute({ ...task, requestId: 'x'.repeat(128) });
    const id = f.calls.filter(c => c.action === 'quote')[1].input.request_id;
    assert.ok(id.length <= 128); generated.push(id);
  }
  assert.equal(generated[0], generated[1]);
});

test('changed renewed pricing requires explicit total consent and does not silently exceed the original ceiling', async () => {
  const f = fixture({ expireDuringConsent: true, changedPrice: true });
  const operation = createPlatformOperation({ maxSteps: 2 });
  await f.client.execute({ ...task, operation });
  assert.deepEqual(f.dialogs.map(d => d.title), ['确认使用积分', '积分报价已过期', '积分报价已更新']);
  assert.equal(f.dialogs[2].message, '本次最多扣除 4 积分');
  assert.equal(operation.snapshot().limit, '4');
  assert.equal(f.generations(), 1);
});

test('prompt journals close expired zero-cost entries and preserve the effective renewed request for restart', async () => {
  const f = fixture();
  let history;
  const platform = createPromptPlatformRequests({ operation: { id: 'example' }, config: {},
    journal: async value => { history = value; }, platformExecute: input => f.client.execute({ ...input, requestId: task.requestId }) });
  await platform.request([]);
  assert.equal(history.pointsUsed, '0.200000');
  assert.equal(history.billingPending, false);
  assert.equal(history.tasks[0].cancelled, true);
  assert.equal(history.tasks[0].pointsUsed, '0');
  assert.ok(history.tasks[1].requestId.startsWith('renew:'));
});

test('an uncertain prior reservation keeps the original quote even after its nominal TTL', async () => {
  const quote = { ok: true, app_name: 'ai-media-library', quote_id: 'b'.repeat(40), feature: task.feature, provider: task.provider,
    points: '1', pricing_kind: 'estimate', price_version: 'v1', billing_basis: 'supplier_usage_tariff', expires_at: 300, status: 'reserve-failed' };
  const calls = [];
  const client = new PlatformTaskClient({ now: () => 400000, confirm: async () => true, request: async action => {
    calls.push(action);
    return action === 'quote' ? quote : { ...quote, status: 'succeeded', result: {}, points_used: '0.2' };
  } });
  await client.execute(task);
  assert.deepEqual(calls, ['quote', 'run']);
});

test('recovery checks already-executing work until completion without another quote or supplier start', async () => {
  const old = { ok: true, app_name: 'ai-media-library', quote_id: 'b'.repeat(40), feature: task.feature, provider: task.provider,
    points: '1', pricing_kind: 'estimate', price_version: 'v1', billing_basis: 'supplier_usage_tariff', expires_at: 300, status: 'quoted' };
  const calls = []; let statuses = 0;
  const client = new PlatformTaskClient({ now: () => 400000, wait: async () => {}, confirm: async () => { throw new Error('no new consent'); },
    request: async action => {
      calls.push(action);
      if (action === 'quote') return old;
      if (action === 'status' && ++statuses === 2) return { ...old, status: 'succeeded', result: {}, points_used: '0.2' };
      return { ...old, status: 'executing' };
    } });
  await client.execute(task);
  assert.deepEqual(calls, ['quote', 'status', 'run', 'status']);
});

test('continuing a later expired step preserves earlier completed charges and output', async () => {
  const f = fixture(); const operation = createPlatformOperation({ maxSteps: 3 });
  await operation.authorize({ quoteId: 'c'.repeat(40), feature: task.feature, provider: task.provider,
    points: '1', priceVersion: 'v1', billingBasis: 'supplier_usage_tariff' }, async () => true);
  await operation.record({ quoteId: 'c'.repeat(40), pointsUsed: '0.3' });
  await f.client.execute({ ...task, operation });
  const rows = operation.snapshot().tasks;
  assert.equal(rows.find(row => row.quoteId === 'c'.repeat(40)).pointsUsed, '0.3');
  assert.equal(rows.filter(row => row.pointsUsed === '0.2').length, 1);
  assert.equal(f.generations(), 1);
});
