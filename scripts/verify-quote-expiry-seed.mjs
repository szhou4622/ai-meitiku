import { app, safeStorage } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LicenseSecureStore } from '../electron/license-secure-store.mjs';
import { LicenseService } from '../electron/license-service.mjs';
import { createPlatformTransport } from '../electron/platform-transport.mjs';

app.setName('ai-media-library');
app.whenReady().then(async () => {
try {
  const userDataPath = path.join(app.getPath('appData'), 'ai-media-library');
  const store = new LicenseSecureStore({ userDataPath, safeStorage });
  const credential = await store.readCredential();
  const service = new LicenseService({ secureStore: store, clientVersion: '1.1.27',
    machineCode: async () => credential.boundMachineCode || await store.readMachineCode() });
  const request = createPlatformTransport(service);
  const input = { request_id: 'expiry-acceptance:' + randomUUID(), feature: 'prompt-library', provider: 'volcengine',
    api_source: 'platform_api', payload: { messages: [{ role: 'user', content: '请只回复“报价恢复验收通过”。' }], max_tokens: 32, temperature: 0 } };
  const quote = await request('quote', input);
  const directory = path.resolve('artifacts/quote-recovery-20261015');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'real-expiry-seed.json'), JSON.stringify({ input, quote, createdAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ ok: true, expiresAt: quote.expires_at, status: quote.status, quotedPoints: quote.points, supplierCalls: 0 }));
  app.quit();
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || error.kind || error.name }));
  app.exit(1);
}
});
