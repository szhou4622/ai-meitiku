import test from 'node:test';
import assert from 'node:assert/strict';
import { createClassifierPlatformProxy } from '../electron/classifier-platform-proxy.mjs';

test('classifier proxy requires a local capability and reuses one paid result for SDK retries', async t => {
  const calls = [];
  const proxy = await createClassifierPlatformProxy(async input => {
    calls.push(input); return { result: { id: 'test-receipt', choices: [{ message: { role: 'assistant', content: 'test labels' }, finish_reason: 'stop' }] } };
  });
  t.after(() => proxy.close()); proxy.selectTask('logical-task-1');
  const input = { model: 'ignored-client-model', messages: [{ role: 'user', content: 'test' }] };
  const send = token => fetch(proxy.baseUrl + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(input) });
  assert.equal((await send('bad')).status, 403);
  const first = await send(proxy.token); assert.equal(first.status, 200); await first.json();
  await (await send(proxy.token)).json(); assert.equal(calls.length, 1);
  assert.equal(calls[0].feature, 'classifier'); assert.equal(calls[0].payload.model, undefined);
  proxy.selectTask('logical-task-2'); await (await send(proxy.token)).json(); assert.equal(calls.length, 2);
});

test('a cancelled classifier quote cannot trigger repeated confirmation through SDK retries', async t => {
  let calls = 0;
  const proxy = await createClassifierPlatformProxy(async () => { calls++; throw Object.assign(new Error('cancelled'), { code: 'PLATFORM_TASK_CANCELLED' }); });
  t.after(() => proxy.close()); proxy.selectTask('logical-task');
  for (let i = 0; i < 2; i++) {
    const response = await fetch(proxy.baseUrl + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${proxy.token}` }, body: JSON.stringify({ messages: [] }) });
    assert.equal(response.status, 409); await response.json();
  }
  assert.equal(calls, 1);
});
