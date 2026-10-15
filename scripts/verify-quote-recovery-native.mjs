// Local desktop acceptance: real app, native dialogs and a real expired quote.
// Existing user data is preserved; only encrypted license files are copied.
import { app, BrowserWindow, dialog, safeStorage } from 'electron';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LicenseSecureStore } from '../electron/license-secure-store.mjs';
import { LicenseService } from '../electron/license-service.mjs';
import { createPlatformTransport } from '../electron/platform-transport.mjs';
import { PlatformTaskClient } from '../electron/platform-task-client.mjs';
import { createPlatformOperation } from '../electron/platform-operation.mjs';
import { PlatformOperationReceipts } from '../electron/platform-operation-receipts.mjs';
import { createGeneratedResults } from '../electron/generated-results.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidence = path.join(root, 'artifacts/quote-recovery-20261015');
const folder = await mkdtemp(path.join(tmpdir(), 'aiml-acceptance-127-'));
await cp(path.join(app.getPath('appData'), 'ai-media-library', 'license'), path.join(folder, 'license'), { recursive: true });
app.setAppPath(root);
process.env.AI_MEDIA_LIBRARY_TEST_USER_DATA_PATH = folder;
process.env.AI_MEDIA_LIBRARY_USE_PRODUCTION_LICENSE_STORE = 'true';
process.env.AI_MEDIA_LIBRARY_PREVIEW_ALL_FEATURES = 'true';
process.env.AI_MEDIA_LIBRARY_LOCAL_PORT = '43832';
process.env.AI_MEDIA_LIBRARY_VOICE_PORT = '43834';
await import('../electron/main.mjs');

app.whenReady().then(async () => {
  try {
    let window;
    for (let attempt = 0; attempt < 120; attempt++) {
      window = BrowserWindow.getAllWindows().find(value => !value.isDestroyed() && value.webContents.getURL().startsWith('http://127.0.0.1:43832'));
      if (window && !window.webContents.isLoading()) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!window || window.webContents.isLoading()) throw new Error('Desktop window did not load');
    window.setTitle('AI媒体库 · 1.1.27 报价恢复验收'); window.show(); window.focus();
    const store = new LicenseSecureStore({ userDataPath: folder, safeStorage });
    const credential = await store.readCredential();
    const service = new LicenseService({ secureStore: store, clientVersion: '1.1.27',
      machineCode: async () => credential.boundMachineCode || await store.readMachineCode() });
    const request = createPlatformTransport(service);
    const seed = JSON.parse(await readFile(path.join(evidence, 'real-expiry-seed.json'), 'utf8'));
    while (Date.now() < seed.quote.expires_at * 1000) {
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, seed.quote.expires_at * 1000 - Date.now())));
    }
    const original = await request('status', { quote_id: seed.quote.quote_id });
    if (original.status !== 'quoted') throw new Error('Seed is no longer unsubmitted');
    const before = await service.requestPoints('balance');
    const calls = [], dialogs = [], notices = [];
    const receipts = new PlatformOperationReceipts({ file: path.join(folder, 'acceptance-operation-receipts.json'),
      onNotice: value => { notices.push(value); window.webContents.send('platform-points-notice', value); } });
    const operation = createPlatformOperation({ maxSteps: 1, onUpdate: value => receipts.update(value) });
    const client = new PlatformTaskClient({ request: async (action, input) => {
      calls.push({ action, requestId: input.request_id, quoteId: input.quote_id });
      return request(action, input);
    }, confirm: async options => {
      dialogs.push({ title: options.title, message: options.message, buttons: options.buttons });
      console.log(JSON.stringify({ event: 'native-dialog', ...dialogs.at(-1) }));
      const result = await dialog.showMessageBox(window, options);
      return result.response === 0;
    } });
    const completed = await client.execute({ feature: seed.input.feature, provider: seed.input.provider,
      payload: seed.input.payload, requestId: seed.input.request_id, operation });
    await operation.finish();
    const text = completed.result?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('No real model response');
    await createGeneratedResults(folder).save({ id: completed.quoteId, feature: seed.input.feature,
      stage: '报价恢复验收完成', text, billing: { quoteId: completed.quoteId,
        pointsUsed: completed.pointsUsed, billingPending: completed.billingPending === true } });
    const after = await service.requestPoints('balance');
    const originalAfter = await request('status', { quote_id: seed.quote.quote_id });
    if (originalAfter.status !== 'quoted' || completed.quoteId === seed.quote.quote_id) throw new Error('Original quote was executed');
    const report = { ok: true, version: '1.1.27', actualDesktopApp: true, nativeDialogs: dialogs,
      naturallyExpiredServerQuote: true, originalQuoteStillUnsubmitted: true,
      quoteCalls: calls.filter(c => c.action === 'quote').length, runCalls: calls.filter(c => c.action === 'run').length,
      renewedQuoteId: completed.quoteId, oldQuoteId: seed.quote.quote_id,
      pointsUsed: completed.pointsUsed, billingPending: completed.billingPending === true,
      responseText: text, before: { balanceUnits: before.balanceUnits, reservedUnits: before.reservedUnits },
      after: { balanceUnits: after.balanceUnits, reservedUnits: after.reservedUnits },
      operation: operation.snapshot(), notices, acceptanceUserDataPath: folder,
      productionUserDataChanged: false, windowsAcceptancePerformed: false };
    await writeFile(path.join(evidence, 'native-live-verification.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: true, realAcceptance: true, pointsUsed: completed.pointsUsed, runCalls: report.runCalls, resultCharacters: text.length }));
    await dialog.showMessageBox(window, { title: '报价恢复验收通过',
      message: '已使用过期报价恢复并完成真实生成', detail: `旧报价未执行；本次仅执行 1 个新任务，实际扣除 ${completed.pointsUsed ?? '待结算'} 积分。\n结果：${text}`,
      buttons: ['完成'], noLink: true });
  } catch (error) {
    await mkdir(evidence, { recursive: true });
    await writeFile(path.join(evidence, 'native-live-failure.json'), JSON.stringify({ ok: false, code: error.code || error.kind || error.name,
      message: /Real quote has not expired|Seed is no longer|Desktop window|No real model|Original quote/.test(error.message || '') ? error.message : undefined }, null, 2));
    console.error(JSON.stringify({ ok: false, code: error.code || error.kind || error.name }));
  }
});
