import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveDownloadsPath } from "../electron/system-paths.mjs";

test("uses the OS Downloads path when Electron can resolve it", () => {
  assert.equal(resolveDownloadsPath(name => ({ downloads: "/tmp/Downloads", userData: "/tmp/app" })[name]), "/tmp/Downloads");
});

test("falls back to app userData when Electron cannot resolve Downloads", () => {
  const fallbacks = [];
  const result = resolveDownloadsPath(name => {
    if (name === "downloads") throw new Error("Failed to get downloads path");
    return "/tmp/ai-media-library";
  }, { onFallback: details => fallbacks.push(details) });

  assert.equal(result, path.join("/tmp/ai-media-library", "Downloads"));
  assert.deepEqual(fallbacks, [{ requestedPath: "downloads", fallback: "userData/Downloads" }]);
});

test("falls back to a home subdirectory when both Electron paths are unavailable", () => {
  const result = resolveDownloadsPath(() => { throw new Error("path unavailable"); }, {
    homeDirectory: "/tmp/home",
  });

  assert.equal(result, path.join("/tmp/home", "AI媒体库", "Downloads"));
});

test("rejects an invalid relative Downloads path and falls back", () => {
  const result = resolveDownloadsPath(name => name === "downloads" ? "Downloads" : "/tmp/app");
  assert.equal(result, path.join("/tmp/app", "Downloads"));
});
