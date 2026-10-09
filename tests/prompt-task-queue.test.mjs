import assert from "node:assert/strict";
import test from "node:test";
import { createPromptTaskQueue } from "../electron/prompt-task-queue.mjs";

test("queues different records, rejects duplicate submissions, and advances after failure", async () => {
  const queue = createPromptTaskQueue({ concurrency: 1 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const first = queue.enqueue("a", async () => {
    events.push("a-start");
    await gate;
    throw new Error("API failed");
  });
  const failed = assert.rejects(first, /API failed/);
  const second = queue.enqueue("b", async () => { events.push("b-start"); return "b-result"; });
  await assert.rejects(queue.enqueue("a", async () => {}), /已有任务/);
  assert.deepEqual(events, ["a-start"]);
  release();
  await failed;
  assert.equal(await second, "b-result");
  assert.deepEqual(events, ["a-start", "b-start"]);
  assert.equal(await queue.enqueue("a", async () => "retry"), "retry");
});

test("defaults to three active jobs and queues a fourth", async () => {
  const queue = createPromptTaskQueue();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  const tasks = ["a", "b", "c", "d"].map(id => queue.enqueue(id, async () => { started.push(id); await gate; return id; }));
  await Promise.resolve();
  assert.equal(queue.concurrency, 3);
  assert.deepEqual(started, ["a", "b", "c"]);
  release();
  assert.deepEqual(await Promise.all(tasks), ["a", "b", "c", "d"]);
});

test("429 reduces request concurrency, retries only the rejected request and recovers gradually", async () => {
  const changes = [];
  const queue = createPromptTaskQueue({ retryDelayMs: 1, recoveryMs: 0, onChange: value => changes.push(value) });
  let stageOne = 0;
  let stageTwo = 0;
  await queue.enqueue("a", async () => {
    await queue.request("a", async () => { stageOne++; return new Response("ok"); });
    const response = await queue.request("a", async () => {
      stageTwo++;
      return stageTwo === 1 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : new Response("ok");
    });
    assert.equal(response.status, 200);
  });
  assert.equal(stageOne, 1);
  assert.equal(stageTwo, 2);
  assert.equal(queue.concurrency, 1);
  assert.ok(changes.some(value => value.state === "retrying" && value.message === "等待重试" && value.concurrency === 1));
  for (let i = 0; i < 11; i++) await queue.enqueue(`success-${i}`, () => queue.request(`success-${i}`, async () => new Response("ok")));
  assert.equal(queue.concurrency, 3);
});

test("persistent rate limits have bounded retries; network errors and billing limits are not retried", async () => {
  const queue = createPromptTaskQueue({ retryDelayMs: 1, maxRetries: 2 });
  let calls = 0;
  const response = await queue.enqueue("limited", () => queue.request("limited", async () => { calls++; return new Response("{}", { status: 429 }); }));
  assert.equal(response.status, 429);
  assert.equal(calls, 3);
  let networkCalls = 0;
  await assert.rejects(queue.enqueue("network", () => queue.request("network", async () => { networkCalls++; throw new Error("timeout"); })), /timeout/);
  assert.equal(networkCalls, 1);
  let billingCalls = 0;
  await queue.enqueue("billing", () => queue.request("billing", async () => { billingCalls++; return new Response(JSON.stringify({ error: { code: "insufficient_quota" } }), { status: 429 }); }));
  assert.equal(billingCalls, 1);
  assert.equal((await queue.enqueue("next", () => queue.request("next", async () => new Response("ok")))).status, 200);
});

test("reduced limit also caps retries of jobs already in flight", async () => {
  const queue = createPromptTaskQueue({ retryDelayMs: 1 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0;
  let retryPeak = 0;
  const jobs = ["a", "b", "c"].map(id => {
    let attempts = 0;
    return queue.enqueue(id, () => queue.request(id, async () => {
      attempts++;
      if (attempts === 1) { await gate; return new Response("{}", { status: 429 }); }
      active++;
      retryPeak = Math.max(retryPeak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active--;
      return new Response("ok");
    }));
  });
  release();
  await Promise.all(jobs);
  assert.equal(retryPeak, 1);
});
