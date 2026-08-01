'use strict';

const { app, BrowserWindow, shell, ipcMain, Menu, nativeImage } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

// Single instance — focus the existing window instead of opening a second.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;

  function createWindow() {
    win = new BrowserWindow({
      width: 1320,
      height: 860,
      minWidth: 940,
      minHeight: 600,
      title: 'eSMS Workspace',
      backgroundColor: '#0d0e12',
      show: false,
      icon: path.join(__dirname, 'build', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,            // the service panes are <webview>s
        spellcheck: true,
      },
    });

    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { win = null; });
  }

  // ── IPC from the renderer ──
  // Open non-eSMS links in the user's real browser.
  ipcMain.on('open-external', (_e, url) => {
    try {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    } catch (_) { /* ignore */ }
  });

  // Aggregate unread badge across services (macOS/Linux dock; Windows overlay).
  ipcMain.on('badge', (_e, count) => {
    const n = Number(count) || 0;
    try { app.setBadgeCount(n); } catch (_) {}
    if (process.platform === 'win32' && win) {
      win.setOverlayIcon(n > 0 ? makeOverlay(n) : null, n > 0 ? `${n} unread` : '');
    }
  });

  // Keep navigation inside the eSMS domains; send everything else to the browser.
  const isInternal = (url) => {
    try { return /(^|\.)esmsafrica\.io$/.test(new URL(url).hostname); } catch (_) { return false; }
  };
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (!isInternal(url)) { shell.openExternal(url); return { action: 'deny' }; }
      return { action: 'allow' };
    });
    contents.on('will-navigate', (ev, url) => {
      if (contents.getType() === 'webview' && !isInternal(url)) {
        ev.preventDefault();
        shell.openExternal(url);
      }
    });
  });

  function makeOverlay(n) {
    const label = n > 99 ? '99+' : String(n);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="15" fill="#e5484d"/><text x="16" y="21" font-family="Arial" font-size="${label.length > 2 ? 12 : 15}" fill="#fff" text-anchor="middle" font-weight="700">${label}</text></svg>`;
    return nativeImage.createFromDataURL('data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
  }

  app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu());
    createWindow();

    // Background auto-updates (from GitHub Releases via electron-updater).
    autoUpdater.autoDownload = true;
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  function send(channel) {
    return () => win && win.webContents.send(channel);
  }

  function buildMenu() {
    const isMac = process.platform === 'darwin';
    const services = [
      { label: 'Email', key: 'email', accel: 'CmdOrCtrl+1' },
      { label: 'SMS', key: 'sms', accel: 'CmdOrCtrl+2' },
      { label: 'SMPP', key: 'smpp', accel: 'CmdOrCtrl+3' },
      { label: 'Admin', key: 'admin', accel: 'CmdOrCtrl+4' },
    ];
    const template = [
      ...(isMac ? [{ role: 'appMenu' }] : []),
      {
        label: 'Workspace',
        submenu: [
          ...services.map(s => ({
            label: s.label, accelerator: s.accel,
            click: () => win && win.webContents.send('switch-service', s.key),
          })),
          { type: 'separator' },
          { label: 'Reload service', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.send('reload-service') },
          { label: 'Check for Updates…', click: () => autoUpdater.checkForUpdatesAndNotify().catch(() => {}) },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ];
    return Menu.buildFromTemplate(template);
  }
}
