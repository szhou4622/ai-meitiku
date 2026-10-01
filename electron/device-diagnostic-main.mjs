import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeviceDiagnosticDocument } from "./device-diagnostic-document.mjs";
import { LICENSE_CONFIG } from "./license-config.mjs";
import { LicenseSecureStore } from "./license-secure-store.mjs";
import { createStableMachineIdentity } from "./machine-code.mjs";
import { collectMacosFactorHashes } from "./machine-identity/collectors/macos.mjs";
import { collectWindowsFactorHashes } from "./machine-identity/collectors/windows.mjs";
import {
  buildDeviceDiagnosticRequest,
  deviceDiagnosticErrorMessage,
  normalizeDeviceDiagnosticCode,
  prepareDeviceDiagnosticRequest,
  submitDeviceDiagnostic,
} from "./device-diagnostic-service.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const productionUserDataPath = path.join(app.getPath("appData"), LICENSE_CONFIG.appName);
app.setName(LICENSE_CONFIG.appName);
// Acquire the same lock identity as the production application before moving
// this tool's own UI data elsewhere. The diagnostic and main app must never
// mutate their shared encrypted authorization store concurrently.
app.setPath("userData", productionUserDataPath);
const hasProductionStoreLock = app.requestSingleInstanceLock();
app.setPath("userData", path.join(app.getPath("appData"), `${LICENSE_CONFIG.appName}-device-diagnostic`));

let mainWindow = null;
let submitting = false;

async function collectIdentity() {
  const secureStore = new LicenseSecureStore({ userDataPath: productionUserDataPath, safeStorage });
  const [stableIdentity, identityResult] = await Promise.all([
    createStableMachineIdentity({ appName: LICENSE_CONFIG.appName, secureStore }),
    process.platform === "darwin"
      ? collectMacosFactorHashes({ appName: LICENSE_CONFIG.appName })
      : process.platform === "win32"
        ? collectWindowsFactorHashes({ appName: LICENSE_CONFIG.appName })
        : Promise.reject(new Error("当前系统暂不支持设备核验工具")),
  ]);
  return { secureStore, stableIdentity, identityResult };
}

async function loadDiagnosticPage(browserWindow) {
  const [html, css, renderer] = await Promise.all([
    readFile(path.join(moduleDirectory, "device-diagnostic.html"), "utf8"),
    readFile(path.join(moduleDirectory, "device-diagnostic.css"), "utf8"),
    readFile(path.join(moduleDirectory, "device-diagnostic-renderer.js"), "utf8"),
  ]);
  const document = buildDeviceDiagnosticDocument({ html, css, renderer });
  await browserWindow.loadURL(`data:text/html;base64,${Buffer.from(document, "utf8").toString("base64")}`);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 680,
    minWidth: 560,
    minHeight: 620,
    title: "AI媒体库设备核验工具",
    backgroundColor: "#f4f7f7",
    show: false,
    webPreferences: {
      preload: path.join(moduleDirectory, "device-diagnostic-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => { mainWindow = null; });
  try {
    await loadDiagnosticPage(mainWindow);
  } catch (error) {
    console.error("设备核验页面加载失败", error);
    const message = "设备核验工具页面加载失败，请重新下载安装包。";
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<meta charset="utf-8"><title>加载失败</title><body style="font-family:-apple-system,sans-serif;padding:32px;color:#7d2525"><h2>${message}</h2></body>`)}`);
    mainWindow.show();
  }
}

ipcMain.handle("device-diagnostic:platform", () => ({
  platform: process.platform,
  arch: process.arch,
  version: app.getVersion(),
}));

ipcMain.handle("device-diagnostic:submit", async (_event, verificationCode) => {
  if (submitting) return { ok: false, message: "核验信息正在提交，请勿重复操作。" };
  submitting = true;
  try {
    const normalizedCode = normalizeDeviceDiagnosticCode(verificationCode);
    const { secureStore, stableIdentity, identityResult } = await collectIdentity();
    // Validate all non-secret inputs before creating or reading the recovery
    // proof. Invalid/low-confidence submissions must not mutate secure state.
    prepareDeviceDiagnosticRequest({
      appName: LICENSE_CONFIG.appName,
      verificationCode: normalizedCode,
      machineCode: stableIdentity.active_machine_code,
      identityResult,
    });
    const recoverySecret = await secureStore.readOrCreateActivationRecoverySecret();
    const request = buildDeviceDiagnosticRequest({
      appName: LICENSE_CONFIG.appName,
      verificationCode: normalizedCode,
      machineCode: stableIdentity.active_machine_code,
      recoverySecret,
      identityResult,
    });
    return await submitDeviceDiagnostic({ baseUrl: LICENSE_CONFIG.baseUrl, request });
  } catch (error) {
    // Return a normal IPC value so Electron does not prepend a raw remote-method
    // stack or provider name to the user-facing diagnostic error.
    return { ok: false, message: deviceDiagnosticErrorMessage(error) };
  } finally {
    submitting = false;
  }
});

if (!hasProductionStoreLock) {
  dialog.showErrorBox("请先退出 AI媒体库", "设备核验工具不能与 AI媒体库主程序同时运行。请完全退出主程序后重试。");
  app.quit();
} else {
  app.whenReady().then(createWindow).catch((error) => {
    console.error("设备核验工具启动失败", error);
    app.quit();
  });
}
app.on("window-all-closed", () => app.quit());
