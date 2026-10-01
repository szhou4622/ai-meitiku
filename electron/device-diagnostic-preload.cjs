const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("deviceDiagnostic", Object.freeze({
  platform: () => ipcRenderer.invoke("device-diagnostic:platform"),
  submit: (verificationCode) => ipcRenderer.invoke("device-diagnostic:submit", String(verificationCode || "")),
}));
