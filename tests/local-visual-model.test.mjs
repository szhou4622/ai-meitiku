import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  LOCAL_VISUAL_MODEL_FILES,
  LOCAL_VISUAL_MODEL_ID,
  LOCAL_VISUAL_MODEL_ROUTE,
  resolveLocalVisualModelRequest,
} from "../electron/local-visual-model.mjs";

test("local visual model manifest contains only the split quantized CLIP runtime", () => {
  assert.equal(LOCAL_VISUAL_MODEL_ID, "Xenova/clip-vit-base-patch32");
  assert.ok(LOCAL_VISUAL_MODEL_FILES.some((file) => file.path === "onnx/text_model_quantized.onnx"));
  assert.ok(LOCAL_VISUAL_MODEL_FILES.some((file) => file.path === "onnx/vision_model_quantized.onnx"));
  assert.ok(LOCAL_VISUAL_MODEL_FILES.every((file) => file.size > 0 && /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.ok(LOCAL_VISUAL_MODEL_FILES.reduce((sum, file) => sum + file.size, 0) < 160 * 1024 * 1024);
});

test("local visual model HTTP resolver only exposes manifest files", () => {
  const root = path.resolve("/tmp/ai-media-models");
  const allowed = `${LOCAL_VISUAL_MODEL_ROUTE}${LOCAL_VISUAL_MODEL_ID}/config.json`;
  assert.equal(resolveLocalVisualModelRequest(root, allowed), path.join(root, LOCAL_VISUAL_MODEL_ID, "config.json"));
  assert.equal(resolveLocalVisualModelRequest(root, `${LOCAL_VISUAL_MODEL_ROUTE}../../secret`), null);
  assert.equal(resolveLocalVisualModelRequest(root, `${LOCAL_VISUAL_MODEL_ROUTE}${LOCAL_VISUAL_MODEL_ID}/README.md`), null);
  assert.equal(resolveLocalVisualModelRequest(root, "/other/model"), null);
});

test("every desktop installer prepares and includes the local visual model", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  for (const scriptName of ["desktop:win", "desktop:win:dir", "desktop:pack", "desktop:dmg:arm64:unsigned", "desktop:dmg:x64:unsigned", "desktop:dmg:universal:unsigned"]) {
    assert.match(packageJson.scripts[scriptName], /local-model:prepare/);
  }
  for (const platform of ["win", "mac"]) {
    assert.ok(packageJson.build[platform].extraResources.some((entry) => entry.from === "bundled-models" && entry.to === "models"));
  }
  const macBuildScript = await readFile(new URL("../scripts/build-macos-notarized.sh", import.meta.url), "utf8");
  assert.match(macBuildScript, /prepare-local-visual-model\.mjs/);
});
