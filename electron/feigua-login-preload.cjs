/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');

// The website cannot access this world or the app's IPC bridge. Synchronous
// acknowledgement captures submit/click values before navigation destroys it;
// encryption is queued in the main process and never blocks this acknowledgement.
contextBridge.exposeInIsolatedWorld(47, '__aiMediaCredentialCapture', {
  publish: payload => ipcRenderer.sendSync('feigua-private-login-memory', payload),
});
