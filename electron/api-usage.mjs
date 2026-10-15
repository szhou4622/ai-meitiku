export const API_USAGE_FILE = 'api-usage.v1.bin';
export const API_PROVIDERS = Object.freeze(['volcengine', 'relay', 'minimax', 'aliyun']);
const labels = { volcengine: '火山引擎', relay: '中转', minimax: 'MiniMax', aliyun: '阿里云' };
function providerCheck(provider) {
  if (!API_PROVIDERS.includes(provider)) throw new Error('不支持的 API 服务商');
}
export function apiTaskSelection(provider, useOwnApi = true) {
  providerCheck(provider);
  if (typeof useOwnApi !== 'boolean') throw new Error('API 使用开关必须为布尔值');
  return Object.freeze({ provider, apiMode: useOwnApi ? 'customer_api' : 'platform_api', usesSoftwarePoints: !useOwnApi });
}
// Until a provider's central execution endpoint is wired, fail before any personal-key call.
// Platform execution must be an explicit branch; never catch-and-fallback between payment modes.
export function requireCustomerApi(selection) {
  providerCheck(selection?.provider);
  if (selection.apiMode === 'platform_api') {
    const error = new Error(`${labels[selection.provider]}已选择积分模式，平台接口尚未接通；本次未调用个人 API，也未扣积分。`);
    error.code = 'PLATFORM_API_UNAVAILABLE'; error.status = 409;
    throw error;
  }
  if (selection.apiMode !== 'customer_api') throw new Error('任务的 API 使用方式无效');
  return selection;
}
export class ApiUsageStore {
  constructor(secureStore) { this.secureStore = secureStore; this.writes = Promise.resolve(); }
  async read() {
    const raw = await this.secureStore.readEncrypted(API_USAGE_FILE);
    const values = Object.fromEntries(API_PROVIDERS.map(provider => [provider, true]));
    if (raw) {
      const stored = JSON.parse(raw);
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('API 使用方式无法读取');
      for (const provider of API_PROVIDERS) {
        if (stored[provider] !== undefined) {
          if (typeof stored[provider] !== 'boolean') throw new Error('API 使用方式无法读取');
          values[provider] = stored[provider];
        }
      }
    }
    return values;
  }
  async get() { await this.writes; return this.read(); }
  async selection(provider) { providerCheck(provider); return apiTaskSelection(provider, (await this.get())[provider]); }
  set(provider, useOwnApi) {
    apiTaskSelection(provider, useOwnApi);
    const task = this.writes.then(async () => {
      const values = await this.read(); values[provider] = useOwnApi;
      await this.secureStore.writeEncrypted(API_USAGE_FILE, JSON.stringify(values));
      return values;
    });
    this.writes = task.catch(() => {});
    return task;
  }
}
