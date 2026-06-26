const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("exporterAPI", {
  start: () => ipcRenderer.invoke("exporter:start"),
  stop: () => ipcRenderer.invoke("exporter:stop"),
  sendInput: (input) => ipcRenderer.invoke("exporter:send-input", input),
  openOutput: () => ipcRenderer.invoke("output:open"),
  onLog: (callback) => ipcRenderer.on("exporter:log", (_event, text) => callback(text)),
  onStatus: (callback) => ipcRenderer.on("exporter:status", (_event, status) => callback(status))
});
