import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  IMAGE_REVERSE_PROMPT,
  VIDEO_REVERSE_PROMPT,
  frameTimes,
  inspectReverseSource,
  parseReverseVideoOutput,
  prepareReverseFrames,
  reverseMedia,
  runMediaCommand,
} from "../electron/prompt-reverse.mjs";
import { createPromptLibraryService } from "../electron/prompt-library-service.mjs";

const profiles = {
  provider: "relay",
  relay: {
    baseUrl: "https://relay.example/v1",
    apiKey: "fixture-key",
    textModel: "text-fixture",
    visionModel: "vision-fixture",
  },
};
const sixParts = (content) =>
  `【主体】${content}\n【风格】写实\n【光影】顶部柔光，阴影柔和\n【时间线】\n0–1s 动作\n【BGM】未验证\n【限制】身份一致`;
const config = {
  ...profiles.relay,
  provider: "relay",
  model: "vision-fixture",
};
async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reverse-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const response = (text) =>
  Response.json({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });

test("revoked VIP before the supplier request preserves the entitlement rejection", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "image.png");
  await writeFile(file, "synthetic-image-bytes");
  const denied = Object.assign(new Error("当前授权不包含此VIP功能"), { code: "FEATURE_NOT_ENTITLED" });
  await assert.rejects(reverseMedia({
    file, source: { kind: "image", mime: "image/png" }, config,
    fetchImpl: async () => { throw denied; },
  }), error => error === denied);
});

test("image reversal submits the user's exact methodology plus actual image bytes and returns full only", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "image.png");
  await writeFile(file, "actual-image-bytes");
  let submitted;
  const output = await reverseMedia({
    file,
    source: { kind: "image", mime: "image/png" },
    config,
    fetchImpl: async (_url, options) => {
      submitted = JSON.parse(options.body);
      return response("简要概述\n详细描述\n技术分析\n空间分析\n情感解读");
    },
  });
  assert.ok(submitted.messages[0].content.startsWith(IMAGE_REVERSE_PROMPT));
  assert.ok(
    submitted.messages[1].content[0].image_url.url.endsWith(
      Buffer.from("actual-image-bytes").toString("base64"),
    ),
  );
  assert.equal(submitted.model, "vision-fixture");
  assert.equal(output.shots, "");
  assert.deepEqual(output.usage, { input: 10, output: 20, total: 30 });
});
test("video reversal sends timestamped real-frame evidence and supplied dialogue before combining both outputs", async (t) => {
  const root = await temporary(t);
  const calls = [];
  const output = await reverseMedia({
    file: path.join(root, "reference.mp4"),
    source: { kind: "video", duration: 2, hasAudio: true },
    config,
    prepare: async () => ({
      frames: [
        { time: 0, url: "data:image/jpeg;base64,YQ==" },
        { time: 1, url: "data:image/jpeg;base64,Yg==" },
      ],
      cuts: [1],
    }),
    transcript: "0–1s 原片台词",
    transcribe: async () => {
      throw new Error("should not call when user supplies transcript");
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      return response(
        calls.length === 1
          ? "0–1s 红色主体；1–2s 蓝色主体。"
          : JSON.stringify({
              full: sixParts("全片中文提示词"),
              shots: [
                { start: 0, end: 1, prompt: sixParts("分镜一") + "\n本镜总时长1秒" },
                { start: 1, end: 2, prompt: sixParts("分镜二") + "\n本镜总时长1秒" },
              ],
            }),
      );
    },
  });
  assert.ok(calls[0].messages[0].content.startsWith(VIDEO_REVERSE_PROMPT));
  assert.ok(calls[1].messages[0].content.startsWith(VIDEO_REVERSE_PROMPT));
  for (const section of [
    "一、分析原片",
    "二、还原原则",
    "三、参考素材的职责",
    "四、逐镜描述方法",
    "五、最终输出",
    "六、输出前复核",
  ]) {
    assert.ok(VIDEO_REVERSE_PROMPT.includes(section));
  }
  assert.match(calls[1].messages[0].content, /shots必须按真实分镜返回数组/);
  assert.match(calls[1].messages[0].content, /光影必须独立成段且有具体内容/);
  assert.match(VIDEO_REVERSE_PROMPT, /【光影】[\s\S]*主光源[\s\S]*照射方向/);
  assert.ok(!VIDEO_REVERSE_PROMPT.includes("视频频"));
  assert.ok(
    calls[0].messages[1].content.some((part) =>
      part.text?.includes("1.000 秒"),
    ),
  );
  assert.ok(calls[0].messages[1].content[0].text.includes("原片台词"));
  assert.ok(calls[1].messages[1].content.includes("红色主体"));
  assert.equal(output.full, sixParts("全片中文提示词"));
  assert.match(output.shots, /分镜二/);
  assert.deepEqual(output.usage, { input: 20, output: 40, total: 60 });
});
test("unavailable audio is marked unverified, incomplete video output is rejected", async () => {
  const calls = [];
  await reverseMedia({
    file: "fixture.mp4",
    source: { kind: "video", duration: 1, hasAudio: true },
    config,
    prepare: async () => ({
      frames: [{ time: 0, url: "data:image/jpeg;base64,YQ==" }],
      cuts: [],
    }),
    transcribe: async () => {
      throw new Error("missing ASR");
    },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return response(
        calls.length === 1
          ? "画面证据"
          : JSON.stringify({
              full: sixParts("整片"),
              shots: [{ start: 0, end: 1, prompt: sixParts("单镜") }],
            }),
      );
    },
  });
  assert.ok(calls[1].messages[1].content.includes("尚未验证"));
  assert.throws(
    () => parseReverseVideoOutput('{"full":"仅整片"}'),
    /缺少|完整/,
  );
  assert.throws(
    () => parseReverseVideoOutput('{"full":"","shots":"逐镜"}'),
    /完整/,
  );
  assert.throws(() => parseReverseVideoOutput(JSON.stringify({
    full: sixParts("整片").replace(/【光影】[^\n]*\n/, ""),
    shots: [{ start: 0, end: 1, prompt: sixParts("单镜") }],
  }), 1), /光影/);
});

test("ASR evidence reaches every model request and retains a public success or failure status", async () => {
  for (const available of [true, false]) {
    const calls = [];
    const output = await reverseMedia({
      file: "fixture.mp4",
      source: { kind: "video", duration: 1, hasAudio: true }, config,
      prepare: async () => ({ frames: [{time: 0, url: "data:image/jpeg;base64,YQ=="}], cuts: [] }),
      transcribe: async () => {
        if (!available) throw Object.assign(new Error("本机缺少本地转写组件：Whisper 语音模型"), {code: "ASR_COMPONENTS_MISSING"});
        return {segments: [{start: 0, end: 1, text: "简体台词 English API"}]};
      },
      fetchImpl: async (_url, options) => {
        calls.push(JSON.parse(options.body));
        return response(calls.length === 1 ? "画面证据" : JSON.stringify({full: sixParts("整片"), shots: [{start: 0, end: 1, prompt: sixParts("单镜")}]}));
      },
    });
    assert.equal(output.evidence.audioStatus, available ? "transcribed" : "failed");
    if (available) {
      for (const call of calls) assert.match(JSON.stringify(call.messages[1].content), /简体台词 English API/);
      assert.match(output.evidence.audioEvidence, /无法据此判断背景音乐/);
    } else assert.match(output.evidence.audioError, /Whisper 语音模型/);
  }
});
test("reversal baseline cannot be overwritten by template save and image records have no shot version", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "image.png");
  await writeFile(file, "bytes");
  const service = createPromptLibraryService({
    userDataPath: root,
    getProfiles: async () => profiles,
    reverseMedia: async () => ({
      full: "原始画面分析",
      shots: "不应该保存",
      usage: null,
    }),
  });
  const draft = await service.importText("来源", "");
  await assert.rejects(service.migrate(draft.id, draft.revision), /请先/);
  const bound = await service.setSource(draft.id, draft.revision, file, {
    kind: "image",
    mime: "image/png",
  });
  const reversed = await service.reverse(bound.id, bound.revision);
  assert.equal(reversed.variants.restore.shots, "");
  const template = await service.migrate(reversed.id, reversed.revision);
  assert.equal(template.variants.template.full, "原始画面分析");
  const saved = await service.save({
    ...template,
    variants: {
      restore: { full: "伪造的原始结果", shots: "伪造" },
      template: { full: "修改后的产品", shots: "图片禁止逐镜" },
    },
    reverse: { full: "伪造" },
  });
  assert.equal(saved.reverse.full, "原始画面分析");
  assert.equal(saved.variants.restore.full, "原始画面分析");
  assert.equal(saved.variants.template.full, "修改后的产品");
  assert.equal(saved.variants.template.shots, "");
  await assert.rejects(
    service.generate({
      id: saved.id,
      action: "refine",
      mode: "template",
      view: "shots",
      source: "内容",
    }),
    /图片反推仅支持/,
  );
  const replaced = await service.setSource(saved.id, saved.revision, file, {
    kind: "image",
    mime: "image/png",
  });
  assert.equal(replaced.reverse, null);
  assert.equal(replaced.variants.template.full, "");
});
test("source changes during a reverse request cannot receive stale generated results", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "source.png");
  await writeFile(file, "bytes");
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const service = createPromptLibraryService({
    userDataPath: root,
    getProfiles: async () => profiles,
    reverseMedia: async () => {
      started();
      await pending;
      return { full: "旧源结果", shots: "" };
    },
  });
  const draft = await service.importText("测试", "");
  const bound = await service.setSource(draft.id, draft.revision, file, {
    kind: "image",
    mime: "image/png",
  });
  const reverse = service.reverse(bound.id, bound.revision);
  await ready;
  const newSource = await service.setSource(bound.id, bound.revision, file, {
    kind: "image",
    mime: "image/png",
  });
  release();
  await assert.rejects(reverse, /发生变化/);
  assert.equal((await service.list())[0].source.id, newSource.source.id);
  assert.equal((await service.list())[0].reverse, null);
});
test("real synthetic video inspection and frame preparation detect the scene change and cover the end", async (t) => {
  const ffmpeg = fileURLToPath(
    new URL(
      `../bundled-tools/${process.platform}-${process.arch}/ffmpeg${process.platform === "win32" ? ".exe" : ""}`,
      import.meta.url,
    ),
  );
  try {
    await access(ffmpeg);
  } catch {
    t.skip("ffmpeg is unavailable");
    return;
  }
  const root = await temporary(t);
  const file = path.join(root, "two-scenes.mp4");
  await runMediaCommand(ffmpeg, [
    "-nostdin",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=red:s=160x120:d=1:r=24",
    "-f",
    "lavfi",
    "-i",
    "color=blue:s=160x120:d=1:r=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=2.05",
    "-filter_complex",
    "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map",
    "[v]",
    "-map",
    "2:a",
    "-c:a",
    "aac",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-y",
    file,
  ]);
  const metadata = await inspectReverseSource(file, ffmpeg);
  assert.equal(metadata.kind, "video");
  assert.ok(metadata.duration > 2);
  assert.equal(metadata.hasAudio, true);
  const evidence = await prepareReverseFrames(file, metadata, ffmpeg, () => {});
  assert.ok(evidence.cuts.some((cut) => Math.abs(cut - 1) < 0.1));
  assert.ok(evidence.frames.some((frame) => frame.time >= 1.9));
  assert.ok(
    evidence.frames.every((frame) => frame.time < 2),
    "Never seek into the audio-only tail",
  );
  assert.ok(
    evidence.frames.every((frame) =>
      frame.url.startsWith("data:image/jpeg;base64,"),
    ),
  );
  assert.ok(frameTimes(3, [0.8]).includes(0.8));
});

test("a successful fast seek without 30.jpg retries the confirmed frame instead of losing evidence", async (t) => {
  const ffmpeg = fileURLToPath(new URL(`../bundled-tools/${process.platform}-${process.arch}/ffmpeg${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
  try { await access(ffmpeg); } catch { t.skip("ffmpeg is unavailable"); return; }
  const root = await temporary(t);
  const file = path.join(root, "fractional-rate.mp4");
  await runMediaCommand(ffmpeg, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x120:duration=16:rate=30000/1001", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file]);
  const metadata = await inspectReverseSource(file, ffmpeg);
  for (const failure of ["missing", "empty", "truncated"]) {
    let retried;
    let sampleTime;
    let temporaryDirectory;
    const command = async (tool, args, ...options) => {
      const output = args.at(-1);
      if (path.basename(output) === "30.jpg" && args.includes("-ss")) {
        sampleTime = Number(args[args.indexOf("-ss") + 1]);
        temporaryDirectory = path.dirname(output);
        if (failure !== "missing") await writeFile(output, failure === "empty" ? "" : "broken jpeg");
        return { stdout: "", stderr: "" }; // FFmpeg can exit 0 without a frame.
      }
      if (path.basename(output) === "30.jpg") retried = args;
      const result = await runMediaCommand(tool, args, ...options);
      // Timestamp collection must not depend on the capped diagnostic log.
      return args.includes("setpts=PTS-STARTPTS,showinfo") ? { ...result, stderr: "" } : result;
    };
    const evidence = await prepareReverseFrames(file, metadata, ffmpeg, () => {}, { command });
    assert.ok(retried, `${failure} JPEG must trigger a real decode retry`);
    assert.ok(!retried.includes("-ss"));
    assert.match(retried[retried.indexOf("-vf") + 1], /select='eq\(n,\d+\)'/);
    assert.equal(evidence.frames[30].time, sampleTime);
    const expected = path.join(root, `${failure}-expected.jpg`);
    await runMediaCommand(ffmpeg, [...retried.slice(0, -1), expected]);
    assert.equal(evidence.frames[30].url, `data:image/jpeg;base64,${(await readFile(expected)).toString("base64")}`);
    assert.ok(evidence.frames.at(-1).time > 15.9, "The final decoded frame is preserved");
    await assert.rejects(access(temporaryDirectory), { code: "ENOENT" });
  }
  let apiCalls = 0;
  let failedDirectory;
  const noJpeg = async (tool, args, ...options) => {
    if (args.at(-1).endsWith(".jpg")) {
      failedDirectory = path.dirname(args.at(-1));
      return { stdout: "", stderr: "" };
    }
    return runMediaCommand(tool, args, ...options);
  };
  await assert.rejects(reverseMedia({
    file, source: metadata, config, ffmpeg,
    prepare: (file, metadata, tool, progress) => prepareReverseFrames(file, metadata, tool, progress, { command: noJpeg }),
    fetchImpl: async () => { apiCalls++; return response("should not be called"); },
  }), error => error.code === "PROMPT_FRAME_UNAVAILABLE" && /原结果已保留/.test(error.message));
  assert.equal(apiCalls, 0, "Incomplete frame evidence must not be sent to the API");
  await assert.rejects(access(failedDirectory), { code: "ENOENT" });
});
