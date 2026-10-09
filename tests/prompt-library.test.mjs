import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatShotPrompts } from "../electron/prompt-shots.mjs";
import {
  createPromptLibraryService,
  normalizePrompt,
  promptConnection,
} from "../electron/prompt-library-service.mjs";
import {
  featureDefinitions,
  featureRegistry,
} from "../electron/feature-registry.mjs";

const sixParts = (text) => `【主体】${text}\n【风格】写实\n【光影】顶部柔光，阴影柔和\n【时间线】\n0–1秒 动作\n【BGM】未知\n【限制】人物一致`;
const profiles = {
  provider: "volcengine",
  volcengine: { endpointId: "ep-test", apiKey: "test-volcano-key" },
  relay: {
    baseUrl: "https://relay.example/v1/",
    textModel: "relay-text",
    visionModel: "relay-vision",
    apiKey: "test-relay-key",
  },
};
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "prompt-library-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    service: createPromptLibraryService({
      userDataPath: root,
      getProfiles: async () => profiles,
      reverseMedia: async () => ({
        full: "原文",
        shots: "原逐镜",
        provider: "volcengine",
        model: "ep-test",
        usage: null,
      }),
      ...options,
    }),
  };
}
async function readyForMigration(root, service) {
  const draft = await service.importText("测试", "原文");
  const file = path.join(root, "reference.mp4");
  await writeFile(file, "fixture");
  const bound = await service.setSource(draft.id, draft.revision, file, {
    kind: "video",
    mime: "video/mp4",
    duration: 1,
    width: 10,
    height: 10,
    hasAudio: false,
  });
  const reversed = await service.reverse(bound.id, bound.revision);
  return service.migrate(reversed.id, reversed.revision);
}
function replacementMock(body, candidate, anchor) {
  const system = body.messages[0].content;
  const input = JSON.parse(body.messages[1].content[0].text);
  if (system.startsWith("你是参考图内容分析师")) return JSON.stringify({ references: input.replacementMaterials.map(item => ({ materialId: item.id, role: item.role, description: "参考图具体描述", anchors: [anchor] })), forbiddenTerms: [], adaptations: ["按所选角色适配动作与台词"] });
  if (system.startsWith("你是替换结果核查员")) return JSON.stringify({ passed: true, checks: { references: true, oldElementsRemoved: true, actionsAdapted: true, dialogueAdapted: true, unchangedRolesPreserved: true, noInventedClaims: true, objectContinuity: true }, issues: [] });
  return candidate;
}
test("prompt library follows subtitle removal in navigation and owns its protected IPC operations", () => {
  const index = featureDefinitions.findIndex(
    (entry) => entry.id === "subtitle-removal",
  );
  assert.equal(featureDefinitions[index + 1].id, "prompt-library");
  for (const suffix of [
    "list",
    "save",
    "generate",
    "material-add",
    "export",
    "copy",
  ])
    assert.equal(
      featureRegistry.forIpc(`prompt-library-${suffix}`).id,
      "prompt-library",
    );
});

test("queued prompt reverse rechecks VIP before executing and retains already finished data", async t => {
  let allowed = true, release, calls = 0;
  const { root, service } = await fixture(t, {
    assertAccess: () => { if (!allowed) throw Object.assign(new Error("无权"), {code:"FEATURE_NOT_ENTITLED"}); },
    taskQueueOptions: { concurrency: 1 },
    reverseMedia: async () => { calls++; return new Promise(resolve => { release = () => resolve({full:"已提交结果", shots:"", provider:"test"}); }); },
  });
  const file = path.join(root, "fixture.png");
  await writeFile(file, "fixture");
  const records = [];
  for (const title of ["first", "second"]) {
    const item = await service.importText(title, "原文");
    records.push(await service.setSource(item.id, item.revision, file, {kind:"image",mime:"image/png"}));
  }
  const first = service.reverse(records[0].id, records[0].revision);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const second = service.reverse(records[1].id, records[1].revision);
  const rejection = assert.rejects(second, /无权/);
  allowed = false;
  release(); await first; await rejection;
  assert.equal(calls, 1);
  const saved = await service.list();
  assert.equal(saved.length, 2);
  assert.equal(saved.find(item => item.id === records[0].id).reverse.full, "已提交结果");
  assert.equal(saved.find(item => item.id === records[1].id).reverse, null);
});
test("saves and reloads independent mode/view variants, favorites, dialogue and recent usage", async (t) => {
  const { root, service } = await fixture(t);
  const item = await service.importText("手提包", "原始提示词");
  const saved = await service.save({
    ...item,
    favorite: true,
    dialogue: "新台词",
    variants: {
      restore: { full: "还原整片", shots: "还原逐镜" },
      template: { full: "模板整片", shots: "模板逐镜" },
    },
  });
  const visited = await service.visit(saved.id);
  const reopened = createPromptLibraryService({
    userDataPath: root,
    getProfiles: async () => profiles,
  });
  assert.deepEqual((await reopened.list())[0].variants, saved.variants);
  assert.equal((await reopened.list())[0].favorite, true);
  assert.equal((await reopened.list())[0].dialogue, "新台词");
  assert.ok(visited.lastUsedAt);
  await assert.rejects(
    service.save({ ...item, title: "旧编辑器" }),
    /发生变化/,
  );
  await service.remove(saved.id, saved.revision);
  assert.deepEqual(await reopened.list(), []);
});
test("serializes concurrent creates and reports corrupt storage rather than replacing it", async (t) => {
  const { root, service } = await fixture(t);
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      service.importText(`记录${i}`, `内容${i}`),
    ),
  );
  assert.equal((await service.list()).length, 12);
  await writeFile(path.join(root, "prompt-library/library.json"), "invalid");
  await assert.rejects(service.list());
  await assert.rejects(service.importText("新记录", "内容"));
  assert.equal(
    await readFile(path.join(root, "prompt-library/library.json"), "utf8"),
    "invalid",
  );
});
test("selected provider supplies only its own key and text or vision model", () => {
  assert.deepEqual(promptConnection(profiles), {
    provider: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "ep-test",
    apiKey: "test-volcano-key",
  });
  const relay = { ...profiles, provider: "relay" };
  assert.equal(promptConnection(relay).model, "relay-text");
  assert.equal(promptConnection(relay, true).model, "relay-vision");
  assert.equal(promptConnection(relay).apiKey, "test-relay-key");
  assert.throws(
    () => promptConnection({ ...relay, relay: { ...relay.relay, apiKey: "" } }),
    /配置不完整/,
  );
});
test("generation reads provider anew each time, transmits actual image bytes and does not overwrite source", async (t) => {
  let active = profiles;
  const requests = [];
  const { root, service } = await fixture(t, {
    getProfiles: async () => active,
    fetchImpl: async (url, options) => {
      requests.push({
        url,
        headers: options.headers,
        body: JSON.parse(options.body),
      });
      return Response.json({
        choices: [
          { message: { content: typeof requests.at(-1).body.messages[1].content === "string" ? sixParts("生成的提示词") : replacementMock(requests.at(-1).body, sixParts("生成的提示词"), "提示词") }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 },
      });
    },
  });
  const item = await readyForMigration(root, service);
  const payload = {
    id: item.id,
    action: "refine",
    mode: "template",
    view: "full",
    source: "原文",
  };
  const output = await service.generate(payload);
  assert.equal(requests[0].body.model, "ep-test");
  assert.equal(requests[0].headers.Authorization, "Bearer test-volcano-key");
  assert.deepEqual(output.usage, { input: 20, output: 30, total: 50 });
  active = { ...profiles, provider: "relay" };
  await service.generate(payload);
  assert.equal(requests[1].url, "https://relay.example/v1/chat/completions");
  assert.equal(requests[1].body.model, "relay-text");
  const image = path.join(root, "product.png");
  await writeFile(image, Buffer.from("test image bytes"));
  const withMaterial = await service.addMaterials(
    item.id,
    item.revision,
    "product",
    [image],
  );
  await rm(image);
  await service.generate({
    ...payload,
    action: "replace",
    mode: "template",
    materialIds: [withMaterial.materials[0].id],
  });
  const imageRequest = requests[2];
  assert.equal(imageRequest.body.model, "relay-vision");
  assert.ok(
    imageRequest.body.messages[1].content.some(
      (part) =>
        part.type === "image_url" &&
        part.image_url.url.includes(
          Buffer.from("test image bytes").toString("base64"),
        ),
    ),
  );
  assert.ok(
    imageRequest.body.messages[1].content.some((part) =>
      part.text?.includes("产品"),
    ),
  );
  assert.equal((await service.list())[0].variants.restore.full, "原文");
  assert.ok(!JSON.stringify(await service.list()).includes("test-relay-key"));
  await assert.rejects(
    service.generate({
      ...payload,
      action: "replace",
      materialIds: ["unknown"],
    }),
    /参考图片不存在/,
  );
});
test("invalid attachments and excess references cannot change stored materials", async (t) => {
  const { root, service } = await fixture(t);
  const item = await service.importText("测试", "原文");
  const source = path.join(root, "image.png");
  await writeFile(source, "image");
  await assert.rejects(
    service.addMaterials(
      item.id,
      item.revision,
      "product",
      Array(10).fill(source),
    ),
    /最多 9 张/,
  );
  await assert.rejects(
    service.addMaterials(item.id, item.revision, "invalid", [source]),
    /请选择参考图片/,
  );
  assert.deepEqual((await service.list())[0].materials, []);
  const imported = normalizePrompt({
    title: "不信任路径",
    materials: [{ file: "../../secrets" }],
  });
  assert.deepEqual(imported.materials, []);
});
test("API error, truncation, empty output and incomplete configuration preserve source", async (t) => {
  for (const response of [
    Response.json({}, { status: 401 }),
    Response.json({
      choices: [{ finish_reason: "length", message: { content: "半句" } }],
    }),
    Response.json({ choices: [] }),
  ]) {
    const { root, service } = await fixture(t, {
      fetchImpl: async () => response,
    });
    const item = await readyForMigration(root, service);
    await assert.rejects(
      service.generate({
        id: item.id,
        action: "refine",
        mode: "template",
        view: "full",
        source: "原文",
      }),
    );
    assert.equal((await service.list())[0].variants.restore.full, "原文");
  }
  let calls = 0;
  let incomplete = false;
  const { root, service } = await fixture(t, {
    getProfiles: async () =>
      incomplete ? { ...profiles, provider: "relay", relay: {} } : profiles,
    fetchImpl: async () => {
      calls++;
    },
  });
  const item = await readyForMigration(root, service);
  incomplete = true;
  await assert.rejects(
    service.generate({
      id: item.id,
      action: "refine",
      mode: "template",
      view: "full",
      source: "原文",
    }),
    /配置不完整/,
  );
  assert.equal(calls, 0);
});

test("all editing actions receive authoritative duration and reject expanded timelines without overwriting baseline", async (t) => {
  const requests = [];
  const { root, service } = await fixture(t, {
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({
        choices: [
          {
            message: { content: "节拍（37-40s）：动作" },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
  const item = await readyForMigration(root, service);
  for (const action of ["refine", "convert", "apply-dialogue"]) {
    await assert.rejects(
      service.generate({
        id: item.id,
        mode: "template",
        view: "full",
        action,
        source: "错误旧版本 40秒",
        dialogue: "新台词",
      }),
      /实际时长/,
    );
    const input = JSON.parse(requests.at(-1).messages[1].content);
    assert.equal(input.sourceDurationSeconds, 1);
    assert.match(requests.at(-1).messages[0].content, /错误时长/);
  }
  assert.equal((await service.list())[0].variants.restore.full, "原文");
});

test("video editing rejects API output without lighting and preserves the saved baseline", async (t) => {
  const { root, service } = await fixture(t, {
    fetchImpl: async () => Response.json({ choices: [{ message: { content: sixParts("修改结果").replace(/【光影】[^\n]*\n/, "") }, finish_reason: "stop" }] }),
  });
  const item = await readyForMigration(root, service);
  await assert.rejects(service.generate({ id: item.id, mode: "template", view: "full", action: "refine", source: item.reverse.full }), /光影/);
  assert.equal((await service.list())[0].reverse.full, "原文");
});

test("shot refinement validates each local duration without comparing it to whole-video duration", async (t) => {
  const prompt = "【主体】人物\n【风格】本镜总时长0.5秒\n【光影】顶部柔光，阴影柔和\n【时间线】0–0.5秒 动作\n【BGM】未知\n【限制】保持身份";
  const shots = [{ start: 0, end: 0.5, prompt }, { start: 0.5, end: 1, prompt }];
  const { root, service } = await fixture(t, {
    reverseMedia: async () => ({ full: "原文", shots: formatShotPrompts(shots) }),
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify(shots) }, finish_reason: "stop" }] }),
  });
  const item = await readyForMigration(root, service);
  const result = await service.generate({ id: item.id, mode: "template", view: "shots", action: "refine", source: item.reverse.shots });
  assert.equal(result.text, formatShotPrompts(shots));
});

test("replacement sends all selected role images and their actual bytes with original timeline", async (t) => {
  let request;
  const { root, service } = await fixture(t, {
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return Response.json({
        choices: [
          {
            message: { content: replacementMock(request, sixParts("0–1s：按三张参考图片替换后的镜头"), "镜头") },
            finish_reason: "stop",
          },
        ],
      });
    },
  });
  let item = await readyForMigration(root, service);
  for (const role of ["product", "person", "scene"]) {
    const file = path.join(root, `${role}.png`);
    await writeFile(file, `${role} real image bytes`);
    item = await service.addMaterials(item.id, item.revision, role, [file]);
  }
  await service.generate({
    id: item.id,
    mode: "template",
    view: "full",
    action: "replace",
    source: "旧描述",
    materialIds: item.materials.map((m) => m.id),
  });
  const parts = request.messages[1].content;
  assert.equal(parts.filter((p) => p.type === "image_url").length, 3);
  assert.deepEqual(JSON.parse(parts[0].text).selectedReplacementRoles, [
    "product",
    "person",
    "scene",
  ]);
  assert.equal(JSON.parse(parts[0].text).originalShotTimeline, "原逐镜");
  for (const role of ["product", "person", "scene"])
    assert.ok(
      parts.some((p) =>
        p.image_url?.url.includes(
          Buffer.from(`${role} real image bytes`).toString("base64"),
        ),
      ),
    );
  assert.match(request.messages[0].content, /禁止保留所选角色的原描述/);
});


test("generation queue leaves browsing and creates available, and keeps each output on its submitting record", async (t) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const requests = [];
  const { root, service } = await fixture(t, {
    taskQueueOptions: { concurrency: 1 },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) { started(); await gate; }
      return new Response(JSON.stringify({ choices: [{ message: { content: sixParts(`独立结果${requests.length}`) }, finish_reason: "stop" }] }), { status: 200 });
    },
  });
  const a = await readyForMigration(root, service);
  const b = await readyForMigration(root, service);
  const payload = item => ({ action: "refine", id: item.id, mode: "template", view: "full", source: item.variants.template.full, instructions: "", dialogue: "", materialIds: [] });
  const first = service.generate(payload(a));
  await running;
  const second = service.generate(payload(b));
  await assert.rejects(service.generate(payload(a)), /已有任务/);
  const visited = await service.visit(b.id);
  assert.equal(visited.id, b.id);
  const created = await service.importText("生成期间新建", "新文本");
  assert.ok((await service.list()).some(item => item.id === created.id));
  assert.equal(requests.length, 1);
  release();
  const [outputA, outputB] = await Promise.all([first, second]);
  assert.equal(outputA.text, sixParts("独立结果1"));
  assert.equal(outputB.text, sixParts("独立结果2"));
  assert.equal(requests.length, 2);
  const items = await service.list();
  assert.equal(items.find(item => item.id === a.id).variants.template.full, a.variants.template.full);
  assert.equal(items.find(item => item.id === b.id).variants.template.full, b.variants.template.full);
});

test("service retries rate-limited generation and exposes the reduced concurrency without overwriting the record", async (t) => {
  let calls = 0;
  const changes = [];
  const { root, service } = await fixture(t, {
    taskQueueOptions: { retryDelayMs: 1 },
    onTaskChange: value => changes.push(value),
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify({ choices: [{ message: { content: sixParts("重试结果") }, finish_reason: "stop" }] }));
    },
  });
  const item = await readyForMigration(root, service);
  assert.equal((await service.status()).concurrency, 3);
  const output = await service.generate({ action: "refine", id: item.id, mode: "template", view: "full", source: item.variants.template.full, instructions: "", dialogue: "", materialIds: [] });
  assert.equal(output.text, sixParts("重试结果"));
  assert.equal(calls, 2);
  assert.equal((await service.status()).concurrency, 1);
  assert.ok(changes.some(value => value.id === item.id && value.state === "retrying"));
  assert.equal((await service.list()).find(value => value.id === item.id).variants.template.full, item.variants.template.full);
});

test("imported text migrates directly and can be refined and replaced without inventing reverse metadata", async (t) => {
  const requests = [];
  const { root, service } = await fixture(t, {
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const candidate = "深灰色长裤提示词";
      const text = Array.isArray(body.messages[1].content) ? replacementMock(body, candidate, "长裤") : candidate;
      return Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });
    },
  });
  const imported = await service.importText("自带提示词", "一位人物展示产品，保留自然光和构图。");
  let item = await service.migrate(imported.id, imported.revision);
  assert.equal(item.variants.template.full, imported.variants.restore.full);
  assert.equal(item.reverse, null);
  assert.equal(item.source, null);
  await service.generate({ action: "refine", mode: "template", view: "full", id: item.id, source: item.variants.template.full });
  assert.equal(JSON.parse(requests[0].messages[1].content).originalReverse, imported.variants.restore.full);
  const file = path.join(root, "pants.png");
  await writeFile(file, "fixture image bytes");
  item = await service.addMaterials(item.id, item.revision, "product", [file]);
  const result = await service.generate({ action: "replace", mode: "template", view: "full", id: item.id, source: item.variants.template.full, materialIds: item.materials.map(item => item.id) });
  assert.equal(result.text, "深灰色长裤提示词");
  const rewrite = requests.find(body => body.messages[0].content.startsWith("你是电商素材提示词改写师"));
  assert.ok(!rewrite.messages[0].content.includes("总时长为null秒"));
  assert.match(rewrite.messages[0].content, /不编造未知时长/);
  const saved = (await service.list()).find(value => value.id === item.id);
  assert.equal(saved.variants.restore.full, imported.variants.restore.full);
  assert.equal(saved.reverse, null);
  assert.equal(saved.source, null);
});

test("an attached but unreversed source still requires reversal instead of treating text as verified media", async (t) => {
  const { root, service } = await fixture(t);
  const item = await service.importText("文本", "原文");
  const file = path.join(root, "video.mp4");
  await writeFile(file, "fixture");
  const withSource = await service.setSource(item.id, item.revision, file, { kind: "video", duration: 1 });
  await assert.rejects(service.migrate(withSource.id, withSource.revision), /先导入提示词/);
  await assert.rejects(service.generate({ action: "refine", mode: "template", view: "full", id: withSource.id, source: "原文" }), /完成原素材反推/);
});
