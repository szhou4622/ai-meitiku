import { app, safeStorage } from 'electron';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { LicenseSecureStore } from '../electron/license-secure-store.mjs';
import { LicenseService } from '../electron/license-service.mjs';
import { createPlatformTransport } from '../electron/platform-transport.mjs';

// Existing authenticated task status only: no quote, supplier generation,
// activation, redemption or user-data migration is possible through this tool.
const [folder, receiptsFile, outputFile] = process.argv.slice(2);
if (!folder || !path.isAbsolute(folder) || !path.basename(folder).startsWith('aiml-points-preview-')
    || !receiptsFile || !outputFile) throw new Error('Isolated verification paths required');
app.setName('ai-media-library'); app.setPath('userData', folder);
app.whenReady().then(async () => {
  try {
    const store = new LicenseSecureStore({ userDataPath: folder, safeStorage });
    const credential = await store.readCredential();
    const service = new LicenseService({ secureStore: store, clientVersion: '1.1.24',
      machineCode: async () => credential.boundMachineCode || await store.readMachineCode() });
    const before = await service.requestPoints('balance');
    const request = createPlatformTransport(service);
    const input = JSON.parse(await readFile(receiptsFile, 'utf8'));
    const statuses = [];
    for (const receipt of input.receipts) {
      if (!/^[a-f0-9]{40}$/.test(receipt.quote_id)) throw new Error('Invalid receipt identity');
      const status = await request('status', { quote_id: receipt.quote_id });
      statuses.push({ quoteId: status.quote_id, feature: status.feature, provider: status.provider,
        status: status.status, pointsUsed: status.points_used ?? null, errorCode: status.error_code ?? null });
    }
    const after = await service.requestPoints('balance');
    const transactions = await service.requestPoints('transactions', { limit: 100 });
    const result = { appName:'ai-media-library', ok:true, supplierGenerationRequests:0,
      before:{balanceUnits:before.balanceUnits, reservedUnits:before.reservedUnits, availableUnits:before.availableUnits},
      after:{balanceUnits:after.balanceUnits, reservedUnits:after.reservedUnits, availableUnits:after.availableUnits},
      statuses, transactions:transactions.items };
    await writeFile(outputFile, JSON.stringify(result,null,2), {mode:0o600});
    console.log(JSON.stringify({ok:true, balance:result.after, statuses:statuses.map(s=>({feature:s.feature,status:s.status,pointsUsed:s.pointsUsed}))}));
    app.quit();
  } catch(error) { console.error(JSON.stringify({ok:false,errorCode:error.code || error.kind || error.name})); app.exit(1); }
});
