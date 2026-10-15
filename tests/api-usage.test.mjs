import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiUsageStore, API_USAGE_FILE, API_PROVIDERS, apiTaskSelection, requireCustomerApi } from '../electron/api-usage.mjs';
import { classificationApiKeyForProvider, buildClassifierRuntimeEnvironment } from '../electron/classifier-user-config.mjs';
import { promptConnection } from '../electron/prompt-library-service.mjs';
import { featureRegistry } from '../electron/feature-registry.mjs';
function storage() {
  const files = new Map();
  return { files, readEncrypted: async name => files.get(name) || null, writeEncrypted: async (name, text) => files.set(name, text) };
}
test('old installations keep personal API mode and each provider persists independently', async () => {
  const secure = storage(), usage = new ApiUsageStore(secure);
  secure.files.set('api-settings.v1.bin', 'existing encrypted personal credentials');
  assert.deepEqual(await usage.get(), { volcengine: true, relay: true, minimax: true, aliyun: true });
  await Promise.all([usage.set('volcengine', false), usage.set('minimax', false)]);
  const reopened = new ApiUsageStore(secure);
  assert.deepEqual(await reopened.get(), { volcengine: false, relay: true, minimax: false, aliyun: true });
  assert.equal(secure.files.get('api-settings.v1.bin'), 'existing encrypted personal credentials');
  assert.deepEqual(JSON.parse(secure.files.get(API_USAGE_FILE)), await reopened.get());
  await reopened.set('volcengine', true);
  assert.equal((await reopened.get()).minimax, false);
});
test('a failed save retains the original mode and malformed stored modes fail closed', async () => {
  const secure = storage(), usage = new ApiUsageStore(secure);
  await usage.set('aliyun', false);
  secure.writeEncrypted = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(usage.set('aliyun', true), /unavailable/);
  assert.equal((await usage.get()).aliyun, false);
  secure.files.set(API_USAGE_FILE, '{"aliyun":"false"}');
  await assert.rejects(usage.selection('aliyun'), /无法读取/);
  assert.throws(() => usage.set('other-app', false), /服务商/);
  assert.throws(() => usage.set('minimax', 'false'), /布尔值/);
});
test('task selection is immutable and independent of later switch changes', async () => {
  const usage = new ApiUsageStore(storage());
  const running = await usage.selection('volcengine');
  await usage.set('volcengine', false);
  assert.equal(running.apiMode, 'customer_api');
  assert.equal(running.usesSoftwarePoints, false);
  assert.ok(Object.isFrozen(running));
  assert.equal((await usage.selection('volcengine')).apiMode, 'platform_api');
  for (const provider of API_PROVIDERS) {
    assert.throws(() => requireCustomerApi(apiTaskSelection(provider, false)), { code: 'PLATFORM_API_UNAVAILABLE' });
    assert.equal(requireCustomerApi(apiTaskSelection(provider, true)).usesSoftwarePoints, false);
  }
});
test('saved model keys cannot escape through prompt or classifier execution when their switch is off', () => {
  const profiles = { provider: 'volcengine', volcengine: { endpointId: 'ep-test', apiKey: 'synthetic-saved-key', useOwnApi: false },
    relay: { baseUrl: 'https://relay.example/v1', textModel: 'text', visionModel: 'vision', apiKey: 'synthetic-relay-key', useOwnApi: true } };
  assert.throws(() => classificationApiKeyForProvider(profiles, 'volcengine'), { code: 'PLATFORM_API_UNAVAILABLE' });
  assert.throws(() => buildClassifierRuntimeEnvironment({ ARK_API_KEY: 'ambient-key' }, profiles, 'volcengine'), { code: 'PLATFORM_API_UNAVAILABLE' });
  assert.throws(() => promptConnection(profiles), { code: 'PLATFORM_API_UNAVAILABLE' });
  assert.equal(promptConnection({ ...profiles, provider: 'relay' }).apiKey, 'synthetic-relay-key');
  profiles.volcengine.useOwnApi = true;
  profiles.volcengine.apiKey = '';
  assert.throws(() => promptConnection(profiles), /配置不完整/);
});
test('provider switch IPC belongs only to media settings', () => {
  assert.equal(featureRegistry.forIpc('api-settings-usage-get').id, 'settings');
  assert.equal(featureRegistry.forIpc('api-settings-usage-set').id, 'settings');
});
