'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('esms', {
  openExternal: (url) => ipcRenderer.send('open-external', url),
  setBadge: (count) => ipcRenderer.send('badge', count),
  onSwitchService: (cb) => ipcRenderer.on('switch-service', (_e, key) => cb(key)),
  onReloadService: (cb) => ipcRenderer.on('reload-service', () => cb()),
});
