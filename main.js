'use strict';

const { app, BrowserWindow, shell, ipcMain, Menu, nativeImage, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const isMac = process.platform === 'darwin';

// Single instance - focus the existing window instead of opening a second.
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
      backgroundColor: '#1b1712',
      show: false,
      icon: path.join(__dirname, 'build', 'icon.png'),
      // Native-feeling window: on macOS the traffic lights sit inside our
      // dark rail; other platforms keep the standard frame.
      ...(isMac ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 15, y: 20 } } : {}),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,              // trusted preload needs path/url/fs; renderer stays isolated
        webviewTag: true,            // the service panes are <webview>s
        spellcheck: true,
      },
    });

    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { win = null; });

    // If the shell's own renderer ever dies, reload it rather than leaving a
    // white window. (Service webviews recover themselves in the renderer.)
    win.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason !== 'clean-exit' && win && !win.isDestroyed()) {
        setTimeout(() => { try { win.reload(); } catch (_) {} }, 400);
      }
    });
    win.webContents.on('unresponsive', () => { try { win.webContents.forcefullyCrashRenderer(); } catch (_) {} });
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

  // ── First-party password vault ──
  // Logins are saved encrypted by the OS keychain (macOS Keychain / Windows
  // DPAPI / Linux libsecret) via safeStorage, and only ever for eSMS origins.
  const vaultFile = () => path.join(app.getPath('userData'), 'logins.json');
  const readVault = () => { try { return JSON.parse(fs.readFileSync(vaultFile(), 'utf8')); } catch (_) { return {}; } };
  const writeVault = (v) => { try { fs.writeFileSync(vaultFile(), JSON.stringify(v), { mode: 0o600 }); } catch (_) {} };
  const canVault = () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } };
  const senderIsEsms = (e) => {
    try { return /(^|\.)esmsafrica\.io$/.test(new URL(e.senderFrame.url).hostname); } catch (_) { return false; }
  };
  const enc = (s) => safeStorage.encryptString(s).toString('base64');
  const dec = (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64'));

  ipcMain.handle('vault-get', (e, origin) => {
    if (!senderIsEsms(e) || !canVault()) return null;
    const rec = readVault()[origin];
    if (!rec || !rec.p) return null;
    try { return { username: rec.u ? dec(rec.u) : '', password: dec(rec.p) }; } catch (_) { return null; }
  });
  ipcMain.handle('vault-save', (e, data) => {
    if (!senderIsEsms(e) || !canVault() || !data || !data.password) return false;
    try {
      const v = readVault();
      v[data.origin] = { u: data.username ? enc(data.username) : '', p: enc(data.password) };
      writeVault(v);
      return true;
    } catch (_) { return false; }
  });
  ipcMain.handle('vault-count', () => Object.keys(readVault()).length);
  ipcMain.on('vault-clear', () => { writeVault({}); toRenderer('vault-changed', 0); });
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

  function toRenderer(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  app.whenReady().then(() => {
    // Let the eSMS web apps show desktop notifications (new email, etc.) and
    // use the clipboard, without a permission prompt. Everything else is denied.
    try {
      const ses = session.fromPartition('persist:esms');
      const ALLOW = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write']);
      ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOW.has(permission)));
      ses.setPermissionCheckHandler((_wc, permission) => ALLOW.has(permission));
    } catch (_) {}

    Menu.setApplicationMenu(buildMenu());
    createWindow();

    // ── Background auto-updates (GitHub Releases via electron-updater) ──
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', (i) => toRenderer('update-status', { state: 'available', version: i && i.version }));
    autoUpdater.on('download-progress', (p) => toRenderer('update-status', { state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => toRenderer('update-status', { state: 'ready', version: i && i.version }));
    autoUpdater.on('error', () => toRenderer('update-status', { state: 'idle' }));
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Restart to apply a downloaded update.
  ipcMain.on('restart-to-update', () => {
    try { autoUpdater.quitAndInstall(); } catch (_) {}
  });

  // Manual update check from the settings menu.
  ipcMain.on('check-updates', () => { autoUpdater.checkForUpdatesAndNotify().catch(() => {}); });

  // Sign out everywhere: wipe the shared session (cookies + storage).
  ipcMain.handle('sign-out', async () => {
    try {
      const ses = session.fromPartition('persist:esms');
      await ses.clearStorageData();
      return true;
    } catch (_) { return false; }
  });

  // ── Never stay crashed: recover the shell if its renderer dies ──
  ipcMain.on('shell-recover', () => { if (win && !win.isDestroyed()) win.reload(); });

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
