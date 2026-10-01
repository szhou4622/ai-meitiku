import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { buildDiagnosticCommand } from "../scripts/build-xhs-diagnostic-cmd.mjs";

const scriptUrl = new URL("../scripts/collect-xhs-download-diagnostics.ps1", import.meta.url);
const launcherUrl = new URL("../scripts/运行小红书诊断.cmd", import.meta.url);

test("Xiaohongshu diagnostic bundle is one-click and collects redacted evidence", async () => {
  const bytes = await readFile(scriptUrl);
  const source = bytes.toString("utf8");
  const launcher = await readFile(launcherUrl, "utf8");

  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(source, /Windows PowerShell 5\.1/);
  assert.match(source, /Get-UrlEvidence/);
  assert.match(source, /robust_initial_state_loader/);
  assert.match(source, /initial_state_invalid_count/);
  assert.match(source, /note_state_missing_count/);
  assert.match(source, /Compress-Archive/);
  assert.doesNotMatch(source, /Copy-Item[^\r\n]*(?:Cookies|tasks\.json)/i);
  assert.doesNotMatch(source, /Get-Content[^\r\n]*(?:Cookies|cookies\.txt)/i);
  assert.match(launcher, /ExecutionPolicy Bypass/);
  assert.match(launcher, /collect-xhs-download-diagnostics\.ps1/);
});

test("standalone CMD embeds the complete diagnostic script within Windows limits", async () => {
  const source = await readFile(scriptUrl, "utf8");
  const command = buildDiagnosticCommand(source);
  const lines = command.split(/\r?\n/);

  assert.match(command, /powershell\.exe -NoProfile -ExecutionPolicy Bypass/);
  assert.match(command, /IO\.Compression\.GzipStream/);
  assert.ok(lines.every((line) => line.length < 8191));
  const payload = lines
    .filter((line) => /^set "P\d+=/.test(line))
    .map((line) => line.replace(/^set "P\d+=/, "").replace(/"$/, ""))
    .join("");
  assert.ok(payload.length > 0);
  assert.equal(gunzipSync(Buffer.from(payload, "base64")).toString("utf8"), source.replace(/^\uFEFF/, ""));
});
