import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  licenseUserDataDirectoryName,
  licenseUserDataPath,
  PRODUCTION_LICENSE_STORE_ENV,
  TEST_USER_DATA_PATH_ENV,
} from "../electron/license-user-data.mjs";
import { previewEnvironment } from "../scripts/launch-electron-preview.mjs";

test("正式安装包继续使用既有稳定授权目录", () => {
  assert.equal(licenseUserDataDirectoryName({ appName: "ai-media-library", isPackaged: true, environment: {} }), "ai-media-library");
});

test("开发模式默认隔离正式用户授权目录", () => {
  assert.equal(licenseUserDataDirectoryName({ appName: "ai-media-library", isPackaged: false, environment: {} }), "ai-media-library-development");
});

test("开发模式仅可通过显式环境变量读取正式授权目录", () => {
  assert.equal(licenseUserDataDirectoryName({
    appName: "ai-media-library",
    isPackaged: false,
    environment: { [PRODUCTION_LICENSE_STORE_ENV]: "true" },
  }), "ai-media-library");
  assert.equal(licenseUserDataDirectoryName({
    appName: "ai-media-library",
    isPackaged: false,
    environment: { [PRODUCTION_LICENSE_STORE_ENV]: "TRUE" },
  }), "ai-media-library-development");
});

test("桌面联调可显式使用独立绝对目录，正式安装包忽略测试目录", () => {
  const testPath = "/tmp/ai-media-client-integration";
  assert.equal(licenseUserDataPath({
    appDataPath: "/Users/test/Library/Application Support",
    appName: "ai-media-library",
    isPackaged: false,
    environment: { [TEST_USER_DATA_PATH_ENV]: testPath },
  }), testPath);
  assert.equal(licenseUserDataPath({
    appDataPath: "/Users/test/Library/Application Support",
    appName: "ai-media-library",
    isPackaged: true,
    environment: { [TEST_USER_DATA_PATH_ENV]: testPath },
  }), "/Users/test/Library/Application Support/ai-media-library");
  assert.throws(() => licenseUserDataPath({
    appDataPath: "/tmp",
    appName: "ai-media-library",
    isPackaged: false,
    environment: { [TEST_USER_DATA_PATH_ENV]: "relative/path" },
  }), /绝对路径/);
});

test("默认桌面预览使用既有授权目录，隔离测试仍可明确选择", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(packageJson.scripts.desktop, /launch-electron-preview\.mjs/);
  assert.match(packageJson.scripts["desktop:isolated"], /launch-electron-preview\.mjs --isolated/);
  const baseline = { SAMPLE: "kept" };
  const previewFlags = { AI_MEDIA_LIBRARY_PREVIEW_ALL_FEATURES: "true" };
  assert.deepEqual(previewEnvironment(baseline), { ...baseline, ...previewFlags, [PRODUCTION_LICENSE_STORE_ENV]: "true" });
  assert.deepEqual(previewEnvironment({ ...baseline, [PRODUCTION_LICENSE_STORE_ENV]: "true" }, true), { ...baseline, ...previewFlags });
  assert.deepEqual(baseline, { SAMPLE: "kept" });
});
