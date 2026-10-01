import assert from "node:assert/strict";
import test from "node:test";
import { createSerialTaskRunner } from "../electron/serial-task-runner.mjs";

test("serial task runner prevents an old refresh from overlapping unbind", async () => {
  const run = createSerialTaskRunner();
  const order = [];
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const refresh = run(async () => {
    order.push("refresh-start");
    await refreshGate;
    order.push("refresh-end");
  });
  const unbind = run(async () => { order.push("unbind"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["refresh-start"]);
  releaseRefresh();
  await Promise.all([refresh, unbind]);
  assert.deepEqual(order, ["refresh-start", "refresh-end", "unbind"]);
});

test("a rejected serialized action does not block the next authorization action", async () => {
  const run = createSerialTaskRunner();
  await assert.rejects(run(async () => { throw new Error("first failed"); }), /first failed/);
  assert.equal(await run(async () => "next completed"), "next completed");
});
