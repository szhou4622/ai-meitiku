import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const serverUrl = new URL("../electron/voice-backend/server.mjs", import.meta.url).href;
const serverPath = fileURLToPath(new URL("../electron/voice-backend/server.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// 真正加载一次后端模块：顶层 await 会跑迁移，随后立刻关闭监听让进程退出。
async function bootVoiceBackend(dataDir) {
  const port = await freePort();
  await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", `const m = await import(${JSON.stringify(serverUrl)}); m.server.close();`],
    {
      env: {
        ...process.env,
        SKILL_STUDIO_DATA_DIR: dataDir,
        PORT: String(port),
        MINIMAX_API_KEY: "",
      },
      timeout: 60000,
    },
  );
}

async function withDataDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "voice-store-migration-"));
  try {
    await mkdir(join(dir, "data"), { recursive: true });
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const readStore = async (dir) => JSON.parse(await readFile(join(dir, "data", "voices.json"), "utf8"));

test("迁移把旧版可合成记录标成历史记录，并保留 providerVoiceId", async () => {
  await withDataDir(async (dir) => {
    await writeFile(join(dir, "data", "voices.json"), JSON.stringify({
      voices: [
        { id: "legacy-1", name: "旧音色", provider: "minimax", providerVoiceId: "vs_legacy_1", status: "已激活", createdAt: "2026-09-01T00:00:00.000Z", audios: [] },
        { id: "legacy-2", name: "旧音色但无ID", provider: "minimax", providerVoiceId: "", status: "已激活", createdAt: "2026-09-02T00:00:00.000Z", audios: [] },
        { id: "preview-1", name: "新试听", provider: "minimax", providerVoiceId: "", status: "试听已生成", createdAt: "2026-09-17T00:00:00.000Z", audios: [] },
        { id: "failed-1", name: "失败记录", provider: "minimax", providerVoiceId: "", status: "生成失败", errorMessage: "样本太短", createdAt: "2026-09-17T01:00:00.000Z", audios: [] },
      ],
    }, null, 2));

    await bootVoiceBackend(dir);
    const store = await readStore(dir);
    const byId = Object.fromEntries(store.voices.map((v) => [v.id, v]));

    assert.equal(store.schemaVersion, 2);

    // 带音色 ID 的旧记录被标记，且 ID 仍然留在本地
    assert.equal(byId["legacy-1"].status, "历史记录（合成已停用）");
    assert.equal(byId["legacy-1"].providerVoiceId, "vs_legacy_1");
    assert.match(byId["legacy-1"].legacyNotice, /不再提供语音合成/);
    assert.ok(byId["legacy-1"].migratedAt);

    // 仅凭 status 也能识别为旧记录
    assert.equal(byId["legacy-2"].status, "历史记录（合成已停用）");

    // 仅试听模式下产生的记录不受影响
    assert.equal(byId["preview-1"].status, "试听已生成");
    assert.equal(byId["preview-1"].legacyNotice, undefined);
    assert.equal(byId["failed-1"].status, "生成失败");
    assert.equal(byId["failed-1"].errorMessage, "样本太短");
  });
});

test("迁移只执行一次，重复启动不会再改写记录", async () => {
  await withDataDir(async (dir) => {
    await writeFile(join(dir, "data", "voices.json"), JSON.stringify({
      voices: [{ id: "legacy-1", name: "旧音色", provider: "minimax", providerVoiceId: "vs_legacy_1", status: "已激活", createdAt: "2026-09-01T00:00:00.000Z", audios: [] }],
    }, null, 2));

    await bootVoiceBackend(dir);
    const first = await readStore(dir);
    const firstMigratedAt = first.voices[0].migratedAt;
    assert.ok(firstMigratedAt);

    // 第二次启动：版本标记已是 2，迁移应整体跳过
    await bootVoiceBackend(dir);
    const second = await readStore(dir);
    assert.equal(second.schemaVersion, 2);
    assert.equal(second.voices[0].migratedAt, firstMigratedAt);

    // 用户改过状态后再启动，也不会被迁移二次覆盖
    second.voices[0].status = "用户自定义";
    await writeFile(join(dir, "data", "voices.json"), JSON.stringify(second, null, 2));
    await bootVoiceBackend(dir);
    assert.equal((await readStore(dir)).voices[0].status, "用户自定义");
  });
});

test("全新安装不会被当成存量数据迁移", async () => {
  await withDataDir(async (dir) => {
    await bootVoiceBackend(dir);
    const store = await readStore(dir).catch(() => null);
    // 没有任何声音时不应写出记录；若写出则必须已是当前版本且为空
    if (store) {
      assert.equal(store.schemaVersion, 2);
      assert.deepEqual(store.voices, []);
    }
  });
});

test("失败的复刻会留下记录，但不保留音色 ID 和已删除的音频地址", async () => {
  const source = await readFile(serverPath, "utf8");
  assert.match(source, /const failedVoice = \{/);
  assert.match(source, /await Promise\.allSettled\(\[upsertVoiceItem\(failedVoice\)\]\)/);
  assert.match(source, /status: "生成失败"/);
  // 临时目录仍然清理
  assert.match(source, /rm\(voiceDir, \{ recursive: true, force: true \}\)/);
  // 目录已删，音频地址必须清空，避免界面挂 404
  assert.match(source, /sampleAudioUrl: "",\n\s+previewAudioUrl: "",/);
});
