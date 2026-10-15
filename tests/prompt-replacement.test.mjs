import assert from "node:assert/strict";
import test from "node:test";
import { generateReplacement } from "../electron/prompt-replacement.mjs";
const context = { source: "展示Yep高光小粉瓶，红色包装盒，台词看小粉瓶", originalReverse: "展示Yep高光小粉瓶", sourceKind: "video", sourceDurationSeconds: 11.05, view: "full", selectedReplacementRoles: ["product", "person"], replacementMaterials: [{ id: "product", role: "product" }, { id: "person", role: "person" }] };
const plan = { references: [{ materialId: "product", role: "product", description: "炭灰色直筒裤", anchors: ["炭灰色", "直筒裤"] }, { materialId: "person", role: "person", description: "灰色无袖上衣", anchors: ["灰色无袖"] }], forbiddenTerms: ["Yep", "高光小粉瓶", "红色包装盒"], adaptations: ["展示衣物并改写台词"] };
const audit = { passed: true, checks: { references: true, oldElementsRemoved: true, actionsAdapted: true, dialogueAdapted: true, unchangedRolesPreserved: true, noInventedClaims: true, objectContinuity: true }, issues: [] };
const good = "灰色无袖上衣女性展开炭灰色直筒裤，台词看这条裤子。";
function fixture(outputs) {
  const requests = [];
  return { requests, request: async messages => { requests.push(messages); const value = outputs.shift(); return { choices: [{ message: { content: typeof value === "string" ? value : JSON.stringify(value) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }; } };
}
const content = [{ type: "text", text: JSON.stringify(context) }, { type: "image_url", image_url: { url: "data:image/png;base64,cHJvZHVjdA==" } }];
test("three-stage replacement sends image evidence to all stages and returns provider candidate with combined usage", async () => {
  const mock = fixture([plan, good, audit]);
  const result = await generateReplacement({ context, content, request: mock.request });
  assert.equal(result.choices[0].message.content, good);
  assert.deepEqual(result.usage, { prompt_tokens: 30, completion_tokens: 60, total_tokens: 90 });
  for (const messages of mock.requests) assert.equal(messages[1].content[1].image_url.url, content[1].image_url.url);
  assert.match(mock.requests[1][0].content, /台词/);
  assert.ok(!mock.requests[1][0].content.includes("使用明确占位符"));
});
test("old-product residues retain a flagged draft without automatically paying for another candidate", async () => {
  const mock = fixture([plan, `${good} 口播Yep高光小粉瓶`, audit, good, audit]);
  const result = await generateReplacement({ context, content, request: mock.request });
  assert.equal(result.choices[0].message.content, `${good} 口播Yep高光小粉瓶`);
  assert.equal(mock.requests.length, 3);
  assert.equal(result.quality.status, 'partial');
  assert.match(JSON.stringify(result.quality.issues), /Yep/);
});
test("missing references and dialogue issues remain visible alongside the generated candidate", async () => {
  const failedAudit = { ...audit, passed: false, checks: { ...audit.checks, dialogueAdapted: false }, issues: ["台词仍在卖旧商品"] };
  const mock = fixture([plan, "炭灰色直筒裤", failedAudit, "炭灰色直筒裤", failedAudit]);
  const result = await generateReplacement({ context, content, request: mock.request });
  assert.equal(result.choices[0].message.content, '炭灰色直筒裤');
  assert.equal(result.quality.status, 'partial');
  assert.equal(mock.requests.length, 3);
});
test("invalid reference ids and malformed review cannot be reported as a successful replacement", async () => {
  const wrong = { ...plan, references: [{ ...plan.references[0], materialId: "unknown" }, plan.references[1]] };
  const mock = fixture([wrong]);
  await assert.rejects(generateReplacement({ context, content, request: mock.request }), /识别不完整/);
  const missing = fixture([plan, good, { passed: true, issues: [] }]);
  const retained = await generateReplacement({ context, content, request: missing.request });
  assert.equal(retained.choices[0].message.content, good);
  assert.equal(retained.quality.status, 'partial');
});

test("paraphrased old descriptions do not reject an otherwise valid plan before semantic review", async () => {
  const paraphrased = { ...plan, forbiddenTerms: [...plan.forbiddenTerms, "旧粉色化妆品礼盒"] };
  const mock = fixture([paraphrased, good, audit]);
  const result = await generateReplacement({ context, content, request: mock.request });
  assert.equal(result.choices[0].message.content, good);
  assert.equal(mock.requests.length, 3);
});

test("physical continuity failures are reported without dropping or silently regenerating the paid candidate", async () => {
  const failed = { ...audit, passed: false, checks: { ...audit.checks, objectContinuity: false }, issues: ["同一条裤子同时在手中和桌面"] };
  const mock = fixture([plan, good + "同一条裤子仍放在桌面", failed, good, audit]);
  const result = await generateReplacement({ context, content, request: mock.request });
  assert.equal(result.choices[0].message.content, good + '同一条裤子仍放在桌面');
  assert.equal(result.quality.status, 'partial');
  assert.match(JSON.stringify(result.quality.issues), /手中和桌面/);
  assert.equal(mock.requests.length, 3);
});
