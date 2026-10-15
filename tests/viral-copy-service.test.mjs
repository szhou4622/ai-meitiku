import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createViralCopyService,
  normalizeCopySegment,
  parseManualTranscript,
  parseWhisperTranscript,
  viralCopyKey,
  viralCopyReferenceKey,
  whisperTranscribeArguments,
} from "../electron/viral-copy-service.mjs";

test("Whisper preserves English and timestamps while converting Chinese offline to simplified", () => {
  const result = parseWhisperTranscript({ result: { language: "zh" }, transcription: [
    { text: "這個軟體支援 English API，價格 12.5 元", offsets: { from: 100, to: 2500 } },
  ] });
  assert.equal(result[0].text, "这个软体支援 English API，价格 12.5 元");
  assert.deepEqual([result[0].start, result[0].end], [0.1, 2.5]);
  assert.equal(parseWhisperTranscript({ language: "en", segments: [{ text: "Hello, world!", start: 0, end: 1 }] })[0].text, "Hello, world!");
  assert.throws(() => parseWhisperTranscript({ result: { language: "ja" }, transcription: [] }), { code: "ASR_UNSUPPORTED_LANGUAGE" });
  assert.throws(() => parseWhisperTranscript({ language: "zh", segments: [{ text: "こんにちは" }] }), { code: "ASR_UNSUPPORTED_LANGUAGE" });
  const args = whisperTranscribeArguments("model", "audio", "output");
  assert.equal(args[args.indexOf("-l") + 1], "auto");
  assert.ok(!args.includes("--translate") && !args.includes("-tr"));
  assert.ok(!args.includes("--prompt"));
});

const binding = { advertiserId: "account-1", materialId: "material-2", source: "qianchuan" };

test("文案只能绑定具备账户和素材 ID 的视频", () => {
  assert.equal(viralCopyKey(binding), "account-1:material-2");
  assert.throws(() => viralCopyKey({ advertiserId: "account-1" }), /素材 ID/);
});

test("本地素材和独立文案使用稳定键", () => {
  assert.equal(viralCopyReferenceKey({ assetId: 42 }), "asset:42");
  assert.equal(viralCopyReferenceKey({ referenceId: "csv-1" }), "standalone:csv-1");
  assert.throws(() => viralCopyReferenceKey({}), /缺少/);
});

test("逐行文案和 SRT 均保留真实文本，不推断缺失时间", () => {
  const lines = parseManualTranscript("真实第一句\n真实第二句");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].start, null);
  assert.equal(lines[0].confirmed, false);
  const subtitles = parseManualTranscript("1\n00:00:02,100 --> 00:00:04,500\n第一句\n\n2\n00:00:05,000 --> 00:00:07,000\n第二句");
  assert.deepEqual(subtitles.map((part) => [part.start, part.end, part.text]), [[2.1, 4.5, "第一句"], [5, 7, "第二句"]]);
  assert.equal(parseWhisperTranscript({ segments: [{ text: "识别口播", offsets: { from: 1200, to: 2700 } }] })[0].end, 2.7);
  assert.throws(() => parseManualTranscript("00:00:05 --> bad\n错误字幕"), /时间码无效/);
});

test("并发保存不同素材不会丢失记录", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) => service.save(
      { advertiserId: "account-1", materialId: `material-${index}` },
      [{ text: `文案 ${index}` }],
    )));
    assert.equal((await service.load()).length, 8);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("本地素材与独立文案可单独保存", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    await service.saveReference({ assetId: 7, title: "本地视频" }, [{ text: "与画面对应的文案" }]);
    await service.saveReference({ referenceId: "manual-1", title: "独立脚本" }, [{ text: "只有脚本" }]);
    const records = await service.load();
    assert.deepEqual(records.map((item) => item.key).sort(), ["asset:7", "standalone:manual-1"]);
    assert.equal(records.find((item) => item.key === "standalone:manual-1").title, "独立脚本");
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("文案大分类可保存、修改，未指定时保留原分类", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-category-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    await service.saveReference({ referenceId: "grouped", majorCategory: "用户自填组" }, [{ text: "文案" }]);
    assert.equal((await service.load())[0].major_category, "用户自填组");
    await service.saveReference({ referenceId: "grouped" }, [{ text: "修改后" }]);
    assert.equal((await service.load())[0].major_category, "用户自填组");
    await service.saveReference({ referenceId: "grouped", majorCategory: "另一个组" }, [{ text: "再次修改" }]);
    assert.equal((await service.load())[0].major_category, "另一个组");
  } finally { await rm(userDataPath, { recursive: true, force: true }); }
});

test("时间段必须有效，自定义分类原值会保留", () => {
  assert.throws(() => normalizeCopySegment({ text: "片段", start: 5, end: 2 }), /结束时间/);
  assert.equal(normalizeCopySegment({ text: "片段", category: "用户自定义分类" }).category, "用户自定义分类");
  assert.equal(normalizeCopySegment({ text: "片段" }).category, "未分类");
  assert.deepEqual(normalizeCopySegment({ text: "片段", classifications: [
    { field: "一级分类", value: "食品" }, { field: "二级分类", value: "酸菜" }, { field: "一级分类", value: "食品" },
  ] }).classifications, [{ field: "一级分类", value: "食品" }, { field: "二级分类", value: "酸菜" }]);
  assert.deepEqual(normalizeCopySegment({ text: "片段", data_fields: [
    { name: "作者", value: "阿忠" }, { name: "播放", value: "12万" }, { name: "", value: "忽略" },
  ] }).data_fields, [{ name: "作者", value: "阿忠" }, { name: "播放", value: "12万" }]);
});

test("保存文案按素材键去重，损坏主索引时使用备份且不会覆盖有效备份", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath, platform: "test", arch: "test" });
  try {
    await service.save(binding, [{ text: "第一版", category: "开头钩子", confirmed: false }]);
    await service.save(binding, [{ text: "第二版", category: "痛点共鸣", confirmed: true }]);
    assert.equal((await service.load()).length, 1);
    assert.equal((await service.load())[0].segments[0].text, "第二版");
    const primaryPath = path.join(userDataPath, "viral-copy-library.json");
    const backupPath = path.join(userDataPath, "viral-copy-library.backup.json");
    await writeFile(primaryPath, "{broken", "utf8");
    assert.equal((await service.load())[0].segments[0].text, "第一版");
    await service.save(binding, [{ text: "恢复后的版本", category: "信任背书", confirmed: true }]);
    assert.equal((await service.load())[0].segments[0].text, "恢复后的版本");
    assert.equal(JSON.parse(await readFile(backupPath, "utf8")).records[0].segments[0].text, "第一版");
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("缺少本地转写组件时明确失败，不产生虚假文案记录", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const videoPath = path.join(userDataPath, "sample.mp4");
  const service = createViralCopyService({ userDataPath, platform: "test", arch: "test" });
  try {
    await writeFile(videoPath, "test", "utf8");
    assert.equal((await service.capabilities()).transcribeAvailable, false);
    await assert.rejects(service.transcribe(videoPath), /缺少本地转写组件/);
    assert.deepEqual(await service.load(), []);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

function targetFor(record, index) {
  return { key: record.key, index, segmentId: record.segments[index].id, updatedAt: record.updated_at };
}

test("卡片内直接修改只更新目标文案并保留分类、数据、画面及确认状态", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-inline-edit-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const original = await service.saveReference({ referenceId: "inline", title: "原标题", majorCategory: "原大类" }, [{
      id: "target",
      text: "原文案",
      classifications: [{ field: "内容类型", value: "口播" }],
      data_fields: [{ name: "消耗", value: "128" }],
      confirmed: true,
      visual_asset_id: 42,
    }, { id: "other", text: "另一段" }]);
    const updated = await service.updateSegmentText(targetFor(original, 0), "  卡片内修改后的文案  ");
    assert.equal(updated.segments[0].text, "卡片内修改后的文案");
    assert.equal(updated.segments[1].text, "另一段");
    assert.deepEqual(updated.segments[0].classifications, [{ field: "内容类型", value: "口播" }]);
    assert.deepEqual(updated.segments[0].data_fields, [{ name: "消耗", value: "128" }]);
    assert.equal(updated.segments[0].confirmed, true);
    assert.equal(updated.segments[0].visual_asset_id, 42);
    assert.equal(updated.major_category, "原大类");
    assert.equal(updated.created_at, original.created_at);
    const beforeRejectedWrites = await readFile(path.join(userDataPath, "viral-copy-library.json"), "utf8");
    await assert.rejects(service.updateSegmentText(targetFor(original, 0), "过期目标修改"), /文案已变化/);
    await assert.rejects(service.updateSegmentText(targetFor(updated, 0), "  "), /文案内容不能为空/);
    assert.equal(await readFile(path.join(userDataPath, "viral-copy-library.json"), "utf8"), beforeRejectedWrites);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("单条删除只移除对应文案片段，不触碰原画面文件", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const mediaPath = path.join(userDataPath, "original.mp4");
  const service = createViralCopyService({ userDataPath });
  try {
    await writeFile(mediaPath, "original-video", "utf8");
    const record = await service.saveReference({ assetId: 7, title: "原视频" }, [
      { id: "opening", text: "第一句" }, { id: "ending", text: "第二句" },
    ]);
    const result = await service.deleteSegments([targetFor(record, 0)]);
    assert.equal(result.deletedCount, 1);
    assert.deepEqual((await service.load())[0].segments.map((segment) => segment.text), ["第二句"]);
    assert.equal(await readFile(mediaPath, "utf8"), "original-video");
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("多选批量删除跨记录原子执行，最后一个片段删除后移除空记录", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const first = await service.saveReference({ referenceId: "first" }, [{ text: "A" }, { text: "B" }]);
    const second = await service.saveReference({ referenceId: "second" }, [{ text: "C" }]);
    const result = await service.deleteSegments([targetFor(first, 0), targetFor(second, 0)]);
    assert.equal(result.deletedCount, 2);
    assert.deepEqual((await service.load()).map((record) => [record.key, record.segments[0].text]), [["standalone:first", "B"]]);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("文案变更后的旧选择不能删除或关联，批量删除不会部分执行", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const first = await service.saveReference({ referenceId: "first" }, [{ text: "A" }]);
    const second = await service.saveReference({ referenceId: "second" }, [{ text: "B" }]);
    const stale = targetFor(first, 0);
    await service.saveReference({ referenceId: "first" }, [{ text: "A 已改" }]);
    const before = await readFile(path.join(userDataPath, "viral-copy-library.json"), "utf8");
    await assert.rejects(service.deleteSegments([targetFor(second, 0), stale]), /文案已变化/);
    await assert.rejects(service.linkVisual(stale, 12), /文案已变化/);
    assert.equal(await readFile(path.join(userDataPath, "viral-copy-library.json"), "utf8"), before);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("手动关联画面按片段保存，可更换、取消且不更改文案来源", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const original = await service.saveReference({ referenceId: "script", title: "独立脚本" }, [
      { text: "开头" }, { text: "结尾" },
    ]);
    const linked = await service.linkVisual(targetFor(original, 0), 42);
    assert.equal(linked.segments[0].visual_asset_id, 42);
    assert.equal(linked.segments[1].visual_asset_id, null);
    assert.equal((await service.load())[0].key, "standalone:script");
    const edited = await service.saveReference({ referenceId: "script", title: "独立脚本" }, linked.segments);
    assert.equal(edited.segments[0].visual_asset_id, 42);
    const unlinked = await service.linkVisual(targetFor(edited, 0), null);
    assert.equal(unlinked.segments[0].visual_asset_id, null);
    await assert.rejects(service.linkVisual(targetFor(unlinked, 0), -1), /画面素材 ID 无效/);
    assert.equal((await service.load())[0].segments[0].text, "开头");
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("首次上传时间在编辑和画面关联后保留，不被最近更新时间覆盖", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const first = await service.saveReference({ referenceId: "csv-row", source: "csv" }, [{ text: "原文案" }]);
    assert.ok(Number.isFinite(Date.parse(first.created_at)));
    const edited = await service.saveReference({ referenceId: "csv-row", source: "csv" }, [{ text: "已编辑文案" }]);
    assert.equal(edited.created_at, first.created_at);
    const linked = await service.linkVisual(targetFor(edited, 0), 42);
    assert.equal(linked.created_at, first.created_at);
    assert.equal((await service.load())[0].created_at, first.created_at);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("一段文案的多个自定义分类字段保存和再编辑后均不丢失", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const classifications = [{ field: "商品类目", value: "酸菜" }, { field: "内容形式", value: "口播" }];
    const first = await service.saveReference({ referenceId: "multi-category", source: "csv" }, [{ text: "测试文案", classifications, confirmed: false }]);
    assert.equal(first.segments[0].category, "酸菜");
    assert.deepEqual(first.segments[0].classifications, classifications);
    const edited = await service.saveReference({ referenceId: "multi-category", source: "csv" }, [{ ...first.segments[0], text: "编辑后" }]);
    assert.deepEqual((await service.load())[0].segments[0].classifications, classifications);
    assert.equal(edited.segments[0].confirmed, false);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("文案 CSV 选中的数据字段保存、重载和再编辑后均不丢失", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const dataFields = [{ name: "作者", value: "阿忠" }, { name: "播放", value: "12万" }];
    const first = await service.saveReference({ referenceId: "copy-data", source: "csv" }, [{ text: "测试文案", data_fields: dataFields }]);
    assert.deepEqual(first.segments[0].data_fields, dataFields);
    const loaded = (await service.load())[0];
    assert.deepEqual(loaded.segments[0].data_fields, dataFields);
    await service.saveReference({ referenceId: "copy-data", source: "csv" }, [{ ...loaded.segments[0], text: "编辑后文案" }]);
    assert.deepEqual((await service.load())[0].segments[0].data_fields, dataFields);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("批量确认与取消确认只修改所选状态，保留文案、分类、画面及上传时间", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const first = await service.saveReference({ referenceId: "first", source: "csv" }, [
      { id: "one", text: "第一句", classifications: [{ field: "类型", value: "开头" }], visual_asset_id: 42 },
      { id: "two", text: "第二句", confirmed: true },
    ]);
    const second = await service.saveReference({ referenceId: "second", source: "manual" }, [{ id: "three", text: "第三句" }]);
    const confirmed = await service.setConfirmedSegments([targetFor(first, 0), targetFor(second, 0)], true);
    assert.equal(confirmed.updatedCount, 2);
    const firstAfter = confirmed.records.find((record) => record.key === first.key);
    const secondAfter = confirmed.records.find((record) => record.key === second.key);
    assert.deepEqual(firstAfter.segments.map((segment) => segment.confirmed), [true, true]);
    assert.equal(secondAfter.segments[0].confirmed, true);
    assert.equal(firstAfter.segments[0].text, "第一句");
    assert.deepEqual(firstAfter.segments[0].classifications, [{ field: "类型", value: "开头" }]);
    assert.equal(firstAfter.segments[0].visual_asset_id, 42);
    assert.equal(firstAfter.created_at, first.created_at);
    const unconfirmed = await service.setConfirmedSegments([targetFor(firstAfter, 0), targetFor(secondAfter, 0)], false);
    assert.deepEqual(unconfirmed.records.find((record) => record.key === first.key).segments.map((segment) => segment.confirmed), [false, true]);
    assert.equal(unconfirmed.records.find((record) => record.key === second.key).segments[0].confirmed, false);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("批量确认遇到过期选择时整体拒绝，不写入部分更改", async () => {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "viral-copy-test-"));
  const service = createViralCopyService({ userDataPath });
  try {
    const first = await service.saveReference({ referenceId: "first" }, [{ text: "A" }]);
    const second = await service.saveReference({ referenceId: "second" }, [{ text: "B" }]);
    await service.saveReference({ referenceId: "first" }, [{ text: "A 已修改" }]);
    const before = await readFile(path.join(userDataPath, "viral-copy-library.json"), "utf8");
    await assert.rejects(service.setConfirmedSegments([targetFor(second, 0), targetFor(first, 0)], true), /文案已变化/);
    await assert.rejects(service.setConfirmedSegments([targetFor(second, 0)], "yes"), /状态无效/);
    assert.equal(await readFile(path.join(userDataPath, "viral-copy-library.json"), "utf8"), before);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});
