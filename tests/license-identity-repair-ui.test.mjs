import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

// Exercise the actual gate component's render and handlers without starting
// Electron, contacting production, or exporting a test-only API from the app.
const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const segment = source.slice(source.indexOf("function LicenseGate("), source.indexOf("function LicenseManagement("));
const compiled = ts.transpileModule(segment + "\nexport { LicenseGate };", {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const base = { softwareName: "AI媒体库", protocolVersion: 2, phase: "needs_activation", authorized: false,
  license: null, canUnbind: false, message: "请输入激活码" };
function gate(state, code = "", bridge = {}) {
  let calls = 0;
  const context = { exports: {}, require: () => jsx,
    useState: (initial) => [calls++ === 0 ? code : initial, () => {}], useEffect: () => {},
    initialUpdateState: {}, window: { desktopBridge: bridge },
    licenseStatusLabel: () => "授权", formatServerDate: (date) => date,
  };
  for (const name of ["ShieldCheck", "RefreshCw", "KeyRound", "AlertTriangle", "Unlink", "LockKeyhole",
    "MachineCodeField", "LicenseDiagnosticLogPanel", "UpdateDialog"]) context[name] = () => null;
  vm.runInNewContext(compiled, context);
  let changed;
  const tree = context.exports.LicenseGate({ state, onStateChange: (next) => { changed = next; }, children: "已进入软件" });
  return { tree, changed: () => changed };
}
function elements(tree) {
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...[tree.props?.children].flat(Infinity).flatMap(elements)];
}
function label(node) {
  if (!node || typeof node !== "object") return "";
  const child = node?.props?.children;
  if (typeof child === "string") return child;
  return [child].flat(Infinity).map((item) => typeof item === "string" ? item : label(item)).join("");
}

test("activation gate shows repair with new-card scope; empty input disables it", () => {
  const { tree } = gate(base);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /修复设备识别/);
  assert.match(html, /全新、未绑定/);
  const button = elements(tree).find((node) => node.type === "button" && label(node) === "修复设备识别");
  assert.equal(button.props.disabled, true);
});

test("repair button sends entered code to dedicated bridge and updates gate state", async () => {
  let received;
  const next = { ...base, identityRepairPending: true };
  const result = gate(base, "SYNTHETIC-NEW-CARD", { licenseRepairIdentity: async (code) => { received = code; return next; } });
  const button = elements(result.tree).find((node) => node.type === "button" && label(node) === "修复设备识别");
  assert.equal(button.props.type, "button");
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  assert.equal(received, "SYNTHETIC-NEW-CARD");
  assert.equal(result.changed(), next);
});

test("pending repair disables ordinary activation and exposes same-code continuation", () => {
  const { tree } = gate({ ...base, identityRepairPending: true }, "SAME-CARD");
  const buttons = elements(tree).filter((node) => node.type === "button");
  assert.equal(buttons.find((button) => button.props.type === "submit").props.disabled, true);
  assert.ok(buttons.find((button) => label(button) === "继续修复设备识别"));
});

test("existing and expired licenses do not expose identity replacement", () => {
  const active = gate({ ...base, phase: "active", authorized: true, canUnbind: true, license: {} });
  assert.equal(active.tree, "已进入软件");
  const expired = renderToStaticMarkup(gate({ ...base, phase: "expired", canUnbind: true, license: {} }).tree);
  assert.doesNotMatch(expired, /修复设备识别/);
  assert.match(expired, /使用新码恢复/);
});

test("desktop preview mode enters the application without an activation code", () => {
  const preview = gate({ ...base, previewAllFeatures: true });
  assert.equal(preview.tree, "已进入软件");
});
