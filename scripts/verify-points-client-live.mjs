import { app, safeStorage } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LicenseSecureStore } from "../electron/license-secure-store.mjs";
import { LicenseService } from "../electron/license-service.mjs";

const folder = process.argv[2];
if (!folder || !path.isAbsolute(folder) || !path.basename(folder).startsWith("aiml-points-preview-")) {
  throw new Error("Only an isolated points verification directory is allowed");
}
app.setName("ai-media-library");
app.setPath("userData", folder);
app.whenReady().then(async () => {
try {
  const store = new LicenseSecureStore({ userDataPath: folder, safeStorage });
  const credential = await store.readCredential();
  const service = new LicenseService({
    secureStore: store, clientVersion: "1.1.19", previewAllFeatures: true,
    machineCode: async () => credential.boundMachineCode || await store.readMachineCode(),
  });
  const balance = await service.requestPoints("balance");
  const transactions = await service.requestPoints("transactions", { limit: 30 });
  const result = { ok: true, appName: balance.appName, balanceUnits: balance.balanceUnits,
    reservedUnits: balance.reservedUnits, availableUnits: balance.availableUnits,
    transactionCount: transactions.items.length, actualCredentialValidated: true,
    redemptionSubmitted: false, consumptionSubmitted: false };
  await writeFile(path.join(folder, "points-live-verification.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
  app.quit();
} catch (error) {
  console.error(JSON.stringify({ ok: false, errorCode: error.code || "LIVE_POINTS_CHECK_FAILED" }));
  app.exit(1);
}
});
