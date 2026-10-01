import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildDeviceDiagnosticDocument } from "../electron/device-diagnostic-document.mjs";

test("设备核验页面在打包后不依赖 file URL 的相对资源", () => {
  const html = `<!doctype html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; script-src 'self'">
    <link rel="stylesheet" href="device-diagnostic.css">
    </head><body><script src="device-diagnostic-renderer.js"></script></body></html>`;
  const result = buildDeviceDiagnosticDocument({
    html,
    css: "body { color: green; }",
    renderer: "window.ready = true;",
  });
  assert.match(result, /<style>body \{ color: green; \}<\/style>/);
  assert.match(result, /<script>window\.ready = true;<\/script>/);
  assert.match(result, /style-src 'unsafe-inline'/);
  assert.match(result, /script-src 'unsafe-inline'/);
  assert.doesNotMatch(result, /device-diagnostic\.(?:css|renderer\.js)/);
});

test("内联脚本不会意外闭合 script 标签", () => {
  const html = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><link rel="stylesheet" href="device-diagnostic.css"><script src="device-diagnostic-renderer.js"></script>';
  const result = buildDeviceDiagnosticDocument({ html, css: "", renderer: 'const value = "</script>";' });
  assert.match(result, /<\\\/script>/);
});

test("核验工具明确提示先退出主程序以避免共享存储竞争", async () => {
  const html = await readFile(new URL("../electron/device-diagnostic.html", import.meta.url), "utf8");
  assert.match(html, /完全退出 AI媒体库主程序/);
  assert.match(html, /随机安装核验凭据/);
  const mainSource = await readFile(new URL("../electron/device-diagnostic-main.mjs", import.meta.url), "utf8");
  assert.match(mainSource, /requestSingleInstanceLock/);
  assert.match(mainSource, /不能与 AI媒体库主程序同时运行/);
});
