import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import beforePack, { verifyLocalAsrAssets } from "../scripts/verify-local-asr-assets.mjs";

test("ASR packaging gate checks the selected platform and rejects missing or corrupted model bytes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asr-assets-"));
  t.after(() => rm(root, {recursive:true,force:true}));
  const bytes = Buffer.from("test model");
  const entry = {path:"model.bin",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  await writeFile(path.join(root,"local-asr-manifest.json"), JSON.stringify({files:[{...entry,target:"shared"},{...entry,target:"darwin-arm64"}]}));
  await assert.rejects(verifyLocalAsrAssets(root), /缺失或不完整/);
  await writeFile(path.join(root,"model.bin"), bytes);
  await beforePack({packager:{info:{appDir:root}}, electronPlatformName:"darwin", arch:3});
  await assert.rejects(verifyLocalAsrAssets(root,"win32-x64"), /清单/);
  await writeFile(path.join(root,"model.bin"), Buffer.from("bad! model"));
  await assert.rejects(verifyLocalAsrAssets(root), /校验失败/);
});
