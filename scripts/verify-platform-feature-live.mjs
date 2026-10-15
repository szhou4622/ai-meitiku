import { app, safeStorage } from 'electron';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LicenseSecureStore } from '../electron/license-secure-store.mjs';
import { LicenseService } from '../electron/license-service.mjs';
import { createPlatformTransport } from '../electron/platform-transport.mjs';
import { PlatformTaskClient } from '../electron/platform-task-client.mjs';

const [folder, feature, inputFile, evidenceFile] = process.argv.slice(2);
if (!folder || !path.basename(folder).startsWith('aiml-points-preview-') || !path.isAbsolute(folder)
    || !['schemes','classifier','voice','subtitle-removal'].includes(feature) || !process.argv.includes('--run-confirmed'))
  throw new Error('Explicit authorized isolated live verification required');
app.setName('ai-media-library'); app.setPath('userData', folder);
app.whenReady().then(async () => {
  try {
    const store = new LicenseSecureStore({ userDataPath: folder, safeStorage });
    const credential = await store.readCredential();
    const service = new LicenseService({ secureStore: store, clientVersion: '1.1.24',
      machineCode: async () => credential.boundMachineCode || await store.readMachineCode() });
    const before = await service.requestPoints('balance');
    const payload = JSON.parse(await readFile(inputFile, 'utf8'));
    const provider = { schemes:'volcengine',classifier:'volcengine',voice:'minimax','subtitle-removal':'aliyun' }[feature];
    const requestId = 'live-20261013:' + createHash('sha256').update(feature + JSON.stringify(payload)).digest('hex');
    const request = createPlatformTransport(service);
    const client = new PlatformTaskClient({ request, confirm: async (options, quote) => {
      console.log(JSON.stringify({ event:'quote', feature, points:quote.points, billingBasis:quote.billingBasis }));
      return true; // User explicitly authorized these paid acceptance tests.
    } });
    const completed = await client.execute({ feature, provider, payload, requestId });
    const after = await service.requestPoints('balance');
    const usage = completed.result?.usage || completed.result?.extra_info || null;
    const result = { ok:true, feature, provider, quoteId:completed.quoteId, pointsUsed:completed.pointsUsed,
      billingPending:completed.billingPending === true, usage,
      resultPresent:!!completed.result, text:completed.result?.choices?.[0]?.message?.content || null,
      audioReturned:!!completed.result?.demo_audio, videoReturned:!!completed.result?.VideoUrl,
      before:{balanceUnits:before.balanceUnits,reservedUnits:before.reservedUnits},
      after:{balanceUnits:after.balanceUnits,reservedUnits:after.reservedUnits} };
    await writeFile(evidenceFile, JSON.stringify(result,null,2), { mode:0o600 });
    console.log(JSON.stringify({ ...result, text: result.text ? `${result.text.length} characters returned` : null }));
    app.quit();
  } catch (error) { console.error(JSON.stringify({ ok:false, feature, errorCode:error.code || error.kind || error.name })); app.exit(1); }
});
