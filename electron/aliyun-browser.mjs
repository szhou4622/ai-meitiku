export const aliyunLinks = Object.freeze({
  activate: 'https://vision.aliyun.com/videoenhan',
  keys: 'https://ram.console.aliyun.com/manage/ak',
  guide: 'https://help.aliyun.com/zh/viapi/developer-reference/api-t470ol',
  pricing: 'https://help.aliyun.com/zh/viapi/product-overview/billing-is-introduced-9',
});
export function isAliyunPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && ['aliyun.com', 'alibabacloud.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}
export function createAliyunBrowser({ BrowserWindow, shell, session }) {
  let window = null;
  return async (key, mode) => {
    const url = aliyunLinks[key];
    if (!url || !['system', 'embedded'].includes(mode)) throw new Error('打开方式或官方页面无效');
    if (mode === 'system') { await shell.openExternal(url); return; }
    if (!window || window.isDestroyed()) {
      const partition = session.fromPartition('persist:aliyun-subtitle');
      partition.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
      window = new BrowserWindow({ width: 1180, height: 820, title: '去字幕服务',
        webPreferences: { session: partition, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
      window.on('page-title-updated', event => event.preventDefault());
      window.webContents.on('will-navigate', (event, target) => { if (!isAliyunPage(target)) event.preventDefault(); });
      window.webContents.on('will-redirect', (event, target) => { if (!isAliyunPage(target)) event.preventDefault(); });
      window.webContents.setWindowOpenHandler(({ url: target }) => {
        if (isAliyunPage(target)) void window?.loadURL(target).catch(() => {});
        return { action: 'deny' };
      });
      window.on('closed', () => { window = null; });
    }
    await window.loadURL(url); window.show(); window.focus();
  };
}
