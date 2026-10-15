import test from 'node:test';
import assert from 'node:assert/strict';
import { createPromptPlatformRequests } from '../electron/prompt-platform-requests.mjs';

const messages = [{ role: 'user', content: 'test' }];
const result = { choices: [{ message: { content: 'result' } }] };
test('a later explicit request after cancellation gets a fresh quote while paid identities remain reusable', async () => {
  let history = { tasks: [] }, cancelled = true;
  const ids = [];
  const make = () => createPromptPlatformRequests({ operation: { id: 'record', action: 'reverse' }, config: {},
    readJournal: async () => history, journal: async value => { history = value; },
    platformExecute: async input => {
      ids.push(input.requestId); await input.onQuoted('a'.repeat(40));
      if (cancelled) throw Object.assign(new Error('已取消'), { code: 'PLATFORM_TASK_CANCELLED' });
      return { quoteId: 'b'.repeat(40), pointsUsed: '0.100001', result };
    } });
  await assert.rejects(make().request(messages), { code: 'PLATFORM_TASK_CANCELLED' });
  assert.equal(history.pointsUsed, '0.000000');
  cancelled = false;
  await make().request(messages); await make().request(messages);
  assert.notEqual(ids[0], ids[1]); assert.equal(ids[1], ids[2]); assert.ok(ids[1].length <= 128);
});
test('cancelling a later stage still reports the cost of completed stages', async () => {
  let count = 0;
  const platform = createPromptPlatformRequests({ operation: { id: 'record' }, config: {},
    platformExecute: async input => {
      const quoteId = (++count).toString(16).padStart(40, '0'); await input.onQuoted(quoteId);
      if (count === 2) throw Object.assign(new Error('已取消'), { code: 'PLATFORM_TASK_CANCELLED' });
      return { quoteId, pointsUsed: '0.100001', result };
    } });
  await platform.request(messages);
  await assert.rejects(platform.request([{ role: 'user', content: 'second stage' }]), /已完成部分使用 0.100001 积分/);
  assert.equal(platform.summary().pointsUsed, '0.100001');
});
test('an unconfirmed supplier outcome retains the original quote identity on explicit recovery', async () => {
  let history = { tasks: [] }; const ids = [];
  const make = () => createPromptPlatformRequests({ operation: { id: 'record' }, config: {},
    readJournal: async () => history, journal: async value => { history = value; },
    platformExecute: async input => {
      ids.push(input.requestId); await input.onQuoted('a'.repeat(40));
      throw Object.assign(new Error('pending'), { code: 'SUPPLIER_OUTCOME_UNKNOWN' });
    } });
  await assert.rejects(make().request(messages)); await assert.rejects(make().request(messages));
  assert.equal(ids[0], ids[1]); assert.equal(history.pointsUsed, null);
});
