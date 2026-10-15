import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PlatformBillingWatch } from "../electron/platform-billing-watch.mjs";

test("pending billing survives restart; repeated checks settle once without another generation", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiml-billing-test-"));
  try {
    const file = path.join(folder, "pending.json"), id = "a".repeat(40), calls = [], events = [];
    const initial = new PlatformBillingWatch({ file, request: async () => { throw new Error("offline"); } });
    await initial.add(id); await initial.add(id); await initial.tick();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).quoteIds, [id]);
    const resumed = new PlatformBillingWatch({ file, request: async (action, payload) => {
      calls.push({ action, payload });
      return { ok: true, app_name: "ai-media-library", quote_id: id, status: "succeeded", points_used: "0.092600" };
    }, onSettled: value => events.push(value) });
    await resumed.tick(); await resumed.tick();
    assert.equal(events.length, 1); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { action: "status", payload: { quote_id: id } });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).quoteIds, []);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("wrong task or app and pending response never clear the original task", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "aiml-billing-test-"));
  try {
    const id = "b".repeat(40), file = path.join(folder, "pending.json");
    let body = { ok: true, app_name: "other-app", quote_id: id, status: "succeeded", points_used: "1" };
    const watcher = new PlatformBillingWatch({ file, request: async () => body,
      onSettled: () => assert.fail("unverified settlement") });
    await watcher.add(id); await watcher.tick();
    body = { ...body, app_name: "ai-media-library", quote_id: "c".repeat(40) }; await watcher.tick();
    body = { ...body, quote_id: id, status: "awaiting-bill" }; await watcher.tick();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).quoteIds, [id]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('failed billing stays pending until an exact settled amount arrives, then stops polling', async t => {
  const folder=await mkdtemp(path.join(os.tmpdir(),'failed-billing-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  let paid=0;const settled=[];const quoteId='f'.repeat(40);
  const watch=new PlatformBillingWatch({file:path.join(folder,'pending.json'),request:async()=>({ok:true,app_name:'ai-media-library',quote_id:quoteId,status:'failed',...(paid?{points_used:'0.400000'}:{billing_pending:true})}),onSettled:value=>settled.push(value)});
  await watch.add(quoteId);await watch.tick();assert.equal(watch.ids.size,1);assert.equal(settled.length,0);
  paid=1;await watch.tick();await watch.tick();assert.equal(watch.ids.size,0);assert.deepEqual(settled,[{quoteId,pointsUsed:'0.400000',failed:true}]);
});
