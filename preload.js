'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

// Absolute file: URL for the <webview> preload. In a packaged app __dirname
// lives inside app.asar; the preload is unpacked (see build.asarUnpack) so we
// point at the on-disk copy.
let wvPreload = path.join(__dirname, 'webview-preload.js');
if (wvPreload.includes(`app.asar${path.sep}`)) {
  wvPreload = wvPreload.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

contextBridge.exposeInMainWorld('esms', {
  platform: process.platform,
  webviewPreload: pathToFileURL(wvPreload).toString(),

  openExternal: (url) => ipcRenderer.send('open-external', url),
  setBadge: (count) => ipcRenderer.send('badge', count),

  onSwitchService: (cb) => ipcRenderer.on('switch-service', (_e, key) => cb(key)),
  onReloadService: (cb) => ipcRenderer.on('reload-service', () => cb()),

  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  restartToUpdate: () => ipcRenderer.send('restart-to-update'),
  checkForUpdates: () => ipcRenderer.send('check-updates'),

  // Saved-logins vault + session.
  savedLoginCount: () => ipcRenderer.invoke('vault-count'),
  clearSavedLogins: () => ipcRenderer.send('vault-clear'),
  signOut: () => ipcRenderer.invoke('sign-out'),
});
