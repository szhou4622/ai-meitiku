import assert from "node:assert/strict";
import test from "node:test";
import {
  LICENSE_CONFIG,
  licenseConfigForRuntime,
  TEST_LICENSE_BASE_URL_ENV,
} from "../electron/license-config.mjs";

test("未打包客户端仅接受显式的 127.0.0.1 测试鉴权地址", () => {
  const config = licenseConfigForRuntime({
    isPackaged: false,
    environment: { [TEST_LICENSE_BASE_URL_ENV]: "http://127.0.0.1:18791/api/license/" },
  });
  assert.equal(config.baseUrl, "http://127.0.0.1:18791/api/license");
  assert.equal(config.appName, "ai-media-library");
  assert.equal(config.protocolVersion, 2);
});

test("正式安装包忽略测试地址并继续使用生产常量", () => {
  assert.equal(licenseConfigForRuntime({
    isPackaged: true,
    environment: { [TEST_LICENSE_BASE_URL_ENV]: "http://127.0.0.1:18791/api/license" },
  }), LICENSE_CONFIG);
});

test("测试地址拒绝公网、HTTPS、凭证、查询参数和错误路径", () => {
  for (const value of [
    "https://127.0.0.1:18791/api/license",
    "http://localhost:18791/api/license",
    "http://example.com:18791/api/license",
    "http://user:pass@127.0.0.1:18791/api/license",
    "http://127.0.0.1:18791/api/license?mode=test",
    "http://127.0.0.1:18791/other",
  ]) {
    assert.throws(() => licenseConfigForRuntime({
      isPackaged: false,
      environment: { [TEST_LICENSE_BASE_URL_ENV]: value },
    }), /只允许/);
  }
});
