const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('goldMt5', Object.freeze({
  state: () => ipcRenderer.invoke('mt5:state'),
  connect: () => ipcRenderer.invoke('mt5:connect'),
  disconnect: () => ipcRenderer.invoke('mt5:disconnect'),
  refresh: () => ipcRenderer.invoke('mt5:refresh'),
  installIntegration: () => ipcRenderer.invoke('mt5:install-integration'),
  setZonesVisible: visible => ipcRenderer.invoke('mt5:zones-visible', visible === true)
}));

contextBridge.exposeInMainWorld('goldUpdates', Object.freeze({
  check: () => ipcRenderer.invoke('updates:check'),
  apply: () => ipcRenderer.invoke('updates:apply')
}));
