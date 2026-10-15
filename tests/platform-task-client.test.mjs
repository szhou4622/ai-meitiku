import test from "node:test";
import assert from "node:assert/strict";
import { PlatformTaskClient, platformConfirmation, decodePlatformQuote } from "../electron/platform-task-client.mjs";

const quote = () => ({ ok: true, app_name: "ai-media-library", quote_id: "a".repeat(40),
  feature: "prompt-library", provider: "volcengine", points: "12.345600", pricing_kind: "estimate",
  price_version: "synthetic-v1", billing_basis: "supplier_debit_with_zero_fallback", expires_at: 9999999999, status: "quoted" });
const task = { feature: "prompt-library", provider: "volcengine", payload: { messages: [] }, requestId: "logical-task-1" };
const complete = () => ({ ...quote(), status: "succeeded", points_used: "2.000012", result: { content: "synthetic" } });

test("cancel shows computed points and never submits a task or budget", async () => {
  const calls = [];
  const client = new PlatformTaskClient({ request: async (action, body) => { calls.push({ action, body }); return quote(); },
    confirm: async options => {
      assert.equal(options.message, "本次预计需要 12.3456 积分");
      assert.deepEqual(options.buttons, ["运行", "取消"]);
      assert.equal(options.defaultId, options.cancelId);
      assert.doesNotMatch(JSON.stringify(options), /预算|上限|500/);
      assert.match(options.detail, /点击运行开始生成/);
      assert.doesNotMatch(options.detail, /供应商|实际扣款|账单|Token|官方单价/);
      return false;
    } });
  await assert.rejects(client.execute(task), { code: "PLATFORM_TASK_CANCELLED" });
  assert.deepEqual(calls.map(c => c.action), ["quote"]);
  assert.equal(calls[0].body.api_source, "platform_api");
});

test("confirmation sends quote identity only and displays actual settled fractional points", async () => {
  const calls = [];
  const client = new PlatformTaskClient({ request: async (action, body) => { calls.push({ action, body }); return action === "quote" ? quote() : complete(); }, confirm: async () => true });
  const result = await client.execute(task);
  assert.deepEqual(calls[1], { action: "run", body: { quote_id: "a".repeat(40), confirm_run: true } });
  assert.equal(result.pointsUsed, "2.000012");
});

test("a duplicate click reuses the same confirmation and execution", async () => {
  let confirms = 0, requests = 0, resume;
  const pending = new Promise(resolve => { resume = resolve; });
  const client = new PlatformTaskClient({ request: async action => { requests++; return action === "quote" ? quote() : complete(); },
    confirm: async () => { confirms++; await pending; return true; } });
  const first = client.execute(task), second = client.execute(task);
  assert.equal(first, second);
  await assert.rejects(client.execute({ ...task, payload: { messages: ["changed"] } }), { code: "IDEMPOTENCY_CONFLICT" });
  resume();
  await first;
  assert.equal(confirms, 1);
  assert.equal(requests, 2);
});

test('large subtitle processing outlives text timeout without another generation request', async () => {
  for (const feature of ['subtitle-removal','prompt-library']) {
    let clock=0, runs=0;
    const provider=feature==='subtitle-removal'?'aliyun':'volcengine';
    const client=new PlatformTaskClient({now:()=>clock, wait:async()=>{clock+=16*60*1000;}, confirm:async()=>true,
      request:async action=>{
        const body={...quote(),feature,provider,billing_basis:'supplier_usage_tariff'};
        if(action==='quote')return body;
        if(action==='run'){runs++;return {...body,status:'executing'};}
        return clock>=32*60*1000?{...body,status:'succeeded',points_used:'6.666668',result:{VideoUrl:'synthetic'}}:{...body,status:'executing'};
      }});
    const result=client.execute({...task,feature,provider});
    if(feature==='subtitle-removal')assert.equal((await result).pointsUsed,'6.666668');
    else await assert.rejects(result,{code:'PLATFORM_TASK_PENDING'});
    assert.equal(runs,1);
  }
});

test("a lost execution response queries the original task instead of repeating generation", async () => {
  const calls = [];
  const client = new PlatformTaskClient({ request: async action => {
    calls.push(action);
    if (action === "quote") return quote();
    if (action === "run") throw Object.assign(new Error("synthetic lost response"), { kind: "network" });
    return complete();
  }, confirm: async () => true });
  await client.execute(task);
  assert.deepEqual(calls, ["quote", "run", "status"]);
});

test("unknown upstream outcomes stop without refund claim or automatic regeneration", async () => {
  const calls = [];
  const client = new PlatformTaskClient({ request: async action => {
    calls.push(action); return action === "quote" ? quote() : { ...quote(), status: "unknown" };
  }, confirm: async () => true });
  await assert.rejects(client.execute(task), { code: "SUPPLIER_OUTCOME_UNKNOWN" });
  assert.deepEqual(calls, ["quote", "run"]);
});

test("a settled result is reused without another consent or debit", async () => {
  let calls = 0;
  const client = new PlatformTaskClient({ request: async () => { calls++; return complete(); }, confirm: async () => { throw new Error("must not prompt"); } });
  assert.equal((await client.execute(task)).pointsUsed, "2.000012");
  assert.equal(calls, 1);
});

test("generated results awaiting bills are reused without another paid call", async () => {
  for (const status of ["awaiting-bill", "bill-review"]) {
    const calls = [];
    const client = new PlatformTaskClient({ request: async action => {
      calls.push(action);
      return { ...quote(), status, billing_pending: true, result: { content: "already generated" } };
    }, confirm: async () => { throw new Error("must not confirm again"); } });
    const result = await client.execute(task);
    assert.equal(result.result.content, "already generated");
    assert.equal(result.pointsUsed, null);
    assert.equal(result.billingPending, true);
    assert.deepEqual(calls, ["quote"]);
  }
});

test("missing receipt after generation is pending, never advertised as zero charge", async () => {
  const client = new PlatformTaskClient({ request: async action => action === "quote" ? quote()
    : { ...quote(), status: "awaiting-bill", billing_pending: true, result: { content: "generated" } }, confirm: async () => true });
  const result = await client.execute(task);
  assert.equal(result.pointsUsed, null);
  assert.equal(result.billingPending, true);
});

test("foreign app, provider and malformed price fail before confirmation", () => {
  for (const fields of [{ app_name: "foreign" }, { provider: "minimax" }, { billing_basis: "standard_tariff_usage" }, { points: "NaN" }, { points: "1e6" }, { points: "0.0000001" }]) {
    assert.throws(() => decodePlatformQuote({ ...quote(), ...fields }, task), { code: "INVALID_PLATFORM_QUOTE" });
  }
  const fixed = platformConfirmation({ points: "1.333334", estimated: false });
  assert.equal(fixed.message, "本次需要 1.333334 积分");
});

test("approved usage tariffs cover each provider without exposing internal billing in confirmation", () => {
  for (const [feature,provider] of [['schemes','volcengine','Token'],['classifier','volcengine','Token'],
      ['prompt-library','volcengine','Token'],['voice','minimax','字符'],['subtitle-removal','aliyun','秒数']]) {
    const decoded = decodePlatformQuote({...quote(),feature,provider,billing_basis:'supplier_usage_tariff'}, {feature,provider});
    assert.match(platformConfirmation(decoded).message,/积分/);
    assert.doesNotMatch(JSON.stringify(platformConfirmation(decoded)),/供应商|Token|官方|资源包|字符|秒数|aliyun|volcengine|minimax|模型/i);
  }
  assert.throws(() => decodePlatformQuote({...quote(),feature:'voice',provider:'volcengine',billing_basis:'supplier_usage_tariff'},
    {feature:'voice',provider:'volcengine'}), {code:'INVALID_PLATFORM_QUOTE'});
});

test('terminal platform failure carries settlement state and does not advertise free processing', () => {
  const client=new PlatformTaskClient({});
  for (const pending of [true,false]) {
    assert.throws(()=>client.completed({...quote(),status:'failed',billing_pending:pending,error_code:'SUBTITLE_TASK_FAILED'}),error=>{
      assert.equal(error.terminalFailure,true);assert.equal(error.billingPending,pending);
      assert.doesNotMatch(error.message,/未扣积分|免费/);return true;
    });
  }
});

test('subtitle recovery progress remains attached to the same quote across transient unknown state',async()=>{
 let clock=0,runs=0,queries=0;const phases=[];
 const client=new PlatformTaskClient({now:()=>clock,wait:async ms=>{clock+=ms;},confirm:async()=>true,request:async(action)=>{
  const base={...quote(),feature:'subtitle-removal',provider:'aliyun'};
  if(action==='quote')return base;
  if(action==='run'){runs++;return {...base,status:'unknown',transfer:{phase:'retrieving',last_error:'SUBTITLE_TRANSFER_INTERRUPTED'}};}
  queries++;return queries===1?{...base,status:'executing',transfer:{phase:'storing'}}:{...base,status:'succeeded',points_used:'2',result:{VideoUrl:'synthetic'}};
 }});
 const result=await client.execute({feature:'subtitle-removal',provider:'aliyun',payload:{},onProgress:async value=>phases.push(value.transfer?.phase||value.status)});
 assert.equal(runs,1);assert.equal(queries,2);assert.deepEqual(phases,['retrieving','storing','succeeded']);assert.equal(result.pointsUsed,'2');
});
