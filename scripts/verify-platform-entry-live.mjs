import { app, safeStorage } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LicenseSecureStore } from "../electron/license-secure-store.mjs";
import { LicenseService } from "../electron/license-service.mjs";

const folder = process.argv[2];
const expectedConsumption = process.env.AIML_VERIFY_CONSUMPTION_ENABLED === "1";
if (!folder || !path.isAbsolute(folder) || !path.basename(folder).startsWith("aiml-points-preview-")) {
  throw new Error("Only an isolated verification directory is allowed");
}
app.setName("ai-media-library");
app.setPath("userData", folder);
app.whenReady().then(async () => {
  try {
    const store = new LicenseSecureStore({ userDataPath: folder, safeStorage });
    let credential = await store.readCredential();
    const service = new LicenseService({
      secureStore: store, clientVersion: "1.1.19", previewAllFeatures: true,
      machineCode: async () => credential.boundMachineCode || await store.readMachineCode(),
    });
    // Refresh through the existing credential flow when necessary, never activate/unbind.
    const original = await service.requestPoints("balance");
    credential = await store.readCredential();
    const gateway = "https://api.dadaozixun.com/api/ai-media-library/v1/";
    const request = async (endpoint) => {
      const response = await fetch(gateway + endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(12000),
        headers: { "Content-Type": "application/json", ...service.credentialHeaders(credential) },
        body: JSON.stringify({ app_name: "ai-media-library" }),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true || body.app_name !== "ai-media-library") {
        throw new Error("Gateway verification failed");
      }
      return body;
    };
    const capabilities = await request("capabilities");
    const balance = await request("wallet/balance");
    const history = await request("wallet/transactions");
    if (balance.balance_units !== original.balanceUnits || capabilities.generation_enabled !== false
        || capabilities.consumption_enabled !== expectedConsumption
        || !["aliyun", "volcengine", "minimax"].every((name) => capabilities.providers?.[name]?.configured === true)) {
      throw new Error("Gateway state mismatch");
    }
    const result = { ok: true, appName: "ai-media-library", actualCredentialValidated: true,
      encryptedProvidersConfigured: ["aliyun", "volcengine", "minimax"],
      centralWalletMatchesOriginal: true, balanceUnits: balance.balance_units,
      transactionCount: history.items.length, generationEnabled: false, consumptionEnabled: expectedConsumption,
      supplierRequests: 0, redemptionSubmitted: false };
    await writeFile(path.join(folder, "platform-entry-live-verification.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
    app.quit();
  } catch {
    console.error(JSON.stringify({ ok: false, errorCode: "PLATFORM_ENTRY_LIVE_CHECK_FAILED" }));
    app.exit(1);
  }
});
