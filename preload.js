'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('esms', {
  openExternal: (url) => ipcRenderer.send('open-external', url),
  setBadge: (count) => ipcRenderer.send('badge', count),
  onSwitchService: (cb) => ipcRenderer.on('switch-service', (_e, key) => cb(key)),
  onReloadService: (cb) => ipcRenderer.on('reload-service', () => cb()),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  restartToUpdate: () => ipcRenderer.send('restart-to-update'),
});
