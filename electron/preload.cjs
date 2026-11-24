const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('goldMt5', Object.freeze({
  state: () => ipcRenderer.invoke('mt5:state'),
  connect: () => ipcRenderer.invoke('mt5:connect'),
  disconnect: () => ipcRenderer.invoke('mt5:disconnect'),
  installIntegration: () => ipcRenderer.invoke('mt5:install-integration')
}));
