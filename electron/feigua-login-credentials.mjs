import { normalizeLoginEntryUrl } from './feigua-login-entry.mjs';

export const FEIGUA_LOGIN_CREDENTIAL_FILE = 'feigua-login-credentials.v1.bin';
const invalid = () => new Error('本机登录信息无法读取，原加密文件已保留');

export function normalizeLoginCredentials(input) {
  if (!input || typeof input.username !== 'string' || typeof input.password !== 'string') return null;
  const username = input.username.trim();
  if (!username || username.length > 256 || !input.password || input.password.length > 4096 || /[\u0000]/.test(username + input.password)) return null;
  return { username, password: input.password };
}

export class FeiguaLoginCredentialStore {
  constructor({ secureStore }) { this.secureStore = secureStore; this.queue = Promise.resolve(); }

  async read(entryUrl) {
    await this.queue;
    const entry = normalizeLoginEntryUrl(entryUrl);
    const text = await this.secureStore.readEncrypted(FEIGUA_LOGIN_CREDENTIAL_FILE);
    if (!text) return null;
    let value;
    try { value = JSON.parse(text); } catch { throw invalid(); }
    if (value?.version !== 1 || typeof value.entryUrl !== 'string') throw invalid();
    if (value.entryUrl !== entry || value.remember === false) return null;
    const credentials = normalizeLoginCredentials(value);
    if (!credentials) throw invalid();
    return credentials;
  }

  write(entryUrl, credentials) {
    const entry = normalizeLoginEntryUrl(entryUrl);
    const value = credentials ? normalizeLoginCredentials(credentials) : null;
    if (!entry || credentials && !value) return Promise.reject(new Error('登录信息未能保存，请检查输入'));
    const write = this.queue.then(async () => {
      const backend = this.secureStore.safeStorage;
      if (process.platform === 'linux' && backend?.getSelectedStorageBackend?.() === 'basic_text') throw new Error('系统安全存储不可用，请手动登录');
      await this.secureStore.writeEncrypted(FEIGUA_LOGIN_CREDENTIAL_FILE, JSON.stringify({ version: 1, entryUrl: entry, remember: Boolean(value), ...value }));
    });
    this.queue = write.catch(() => {});
    return write;
  }
}

// Runs only in an isolated renderer world, without Node, IPC, or application
// bridges. Secrets return directly to the main process, never its public UI.
export function loginFormMemory({ command, origin, credentials }) {
  const slot = '__aiMediaLoginMemoryV1';
  if (location.origin !== origin) return { installed: false };
  if (command === 'take') {
    const state = window[slot];
    if (!state) return { installed: false };
    state.capture();
    const pending = state.pending;
    state.pending = null;
    return { installed: true, remember: state.remember, credentials: pending, sequence: state.sequence };
  }
  if (window[slot]) return { installed: true, remember: window[slot].remember };
  const usernames = [...document.querySelectorAll('input#username[name="username"]')];
  const passwords = [...document.querySelectorAll('input#password[name="password"]')];
  if (usernames.length !== 1 || passwords.length !== 1) return { installed: false };
  const username = usernames[0], password = passwords[0], form = username.closest('form');
  if (!username.getClientRects().length || !password.getClientRects().length) return { installed: false };
  if (!form || password.closest('form') !== form || form.querySelectorAll('input[type="password"]').length !== 1) return { installed: false };
  const loginButtons = [...form.querySelectorAll('button,input[type="submit"]')].filter(node => /^(登录|登陆)$/.test((node.textContent || node.value || '').replace(/\s/g, '')));
  if (!loginButtons.length) return { installed: false };
  const checkbox = form.querySelector('input#save_pass[type="checkbox"]');
  const remembered = () => checkbox ? checkbox.checked : true;
  let filled = false;
  const setValue = (node, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (remembered() && credentials && (!username.value || username.value.trim() === credentials.username)) {
    if (!username.value) { setValue(username, credentials.username); filled = true; }
    if (!password.value) { setValue(password, credentials.password); filled = true; }
  }
  const state = { pending: null, remember: remembered(), last: '', sequence: 0 };
  state.capture = () => {
    state.remember = remembered();
    const candidate = state.remember && username.value.trim() && password.value ? { username: username.value, password: password.value } : null;
    if (state.remember && !candidate) return; // Clearing a field isn't a new credential.
    const snapshot = JSON.stringify({ remember: state.remember, candidate });
    if (snapshot !== state.last) {
      state.last = snapshot; state.pending = candidate || { remember: false }; state.sequence++;
      window.__aiMediaCredentialCapture?.publish({ remember: state.remember, credentials: state.pending, sequence: state.sequence });
    }
  };
  window[slot] = state;
  form.addEventListener('input', state.capture, true);
  form.addEventListener('change', state.capture, true);
  form.addEventListener('submit', state.capture, true);
  loginButtons.forEach(button => button.addEventListener('click', state.capture, true));
  state.capture();
  return { installed: true, filled, remember: state.remember };
}
