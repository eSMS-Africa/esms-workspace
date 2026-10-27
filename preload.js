'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// This preload runs sandboxed (no Node path/url/fs). The main process passes the
// file: URL of the <webview> preload as an argument; it also forces that preload
// on every pane in will-attach-webview, so this value is only a hint.
const arg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith('--esms-wv-preload='));
const wvPreload = arg ? arg.slice('--esms-wv-preload='.length) : '';

contextBridge.exposeInMainWorld('esms', {
  platform: process.platform,
  webviewPreload: wvPreload,

  openExternal: (url) => ipcRenderer.send('open-external', url),
  setBadge: (count) => ipcRenderer.send('badge', count),

  onSwitchService: (cb) => ipcRenderer.on('switch-service', (_e, key) => cb(key)),
  onReloadService: (cb) => ipcRenderer.on('reload-service', () => cb()),

  // Role entitlements - which gated panes (admin/support) this signed-in user
  // may see. Secure default is none until central auth confirms the roles.
  onEntitlements: (cb) => ipcRenderer.on('entitlements', (_e, ent) => cb(ent)),

  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, s) => cb(s)),
  restartToUpdate: () => ipcRenderer.send('restart-to-update'),
  checkForUpdates: () => ipcRenderer.send('check-updates'),

  // Saved-logins vault + session.
  savedLoginCount: () => ipcRenderer.invoke('vault-count'),
  clearSavedLogins: () => ipcRenderer.send('vault-clear'),
  signOut: () => ipcRenderer.invoke('sign-out'),
});
