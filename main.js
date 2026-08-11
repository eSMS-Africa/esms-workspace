'use strict';

const { app, BrowserWindow, shell, ipcMain, Menu, nativeImage, safeStorage, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const isMac = process.platform === 'darwin';

// Single instance - focus the existing window instead of opening a second.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let deepLinkQueue = [];
  const PANES = ['email', 'sms', 'smpp', 'admin', 'links', 'support', 'help'];

  // ── Deep links: esmsworkspace://email, esmsworkspace://sms/compose, etc. ──
  const PROTOCOL = 'esmsworkspace';
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
  function routeDeepLink(url) {
    try {
      if (!url || url.indexOf(`${PROTOCOL}://`) !== 0) return;
      const key = url.slice(`${PROTOCOL}://`.length).split(/[/?#]/)[0].toLowerCase();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show(); win.focus();
        if (PANES.includes(key)) win.webContents.send('switch-service', key);
      } else {
        deepLinkQueue.push(key);   // window not up yet - replay on ready
      }
    } catch (_) { /* ignore */ }
  }
  // macOS delivers deep links via open-url; register before ready.
  app.on('open-url', (e, url) => { e.preventDefault(); routeDeepLink(url); });

  // ── Persisted window bounds (size + position across launches) ──
  const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
  function loadWindowState() {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
      if (s && typeof s.width === 'number' && typeof s.height === 'number') return s;
    } catch (_) {}
    return null;
  }
  function saveWindowState() {
    try {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      fs.writeFileSync(stateFile(), JSON.stringify(win.getBounds()), { mode: 0o600 });
    } catch (_) {}
  }

  function createWindow() {
    const st = loadWindowState();
    win = new BrowserWindow({
      width: (st && st.width) || 1320,
      height: (st && st.height) || 860,
      ...(st && typeof st.x === 'number' && typeof st.y === 'number' ? { x: st.x, y: st.y } : {}),
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
    win.once('ready-to-show', () => {
      win.show();
      // Replay a deep link that arrived before the window was ready.
      if (deepLinkQueue.length) {
        const key = deepLinkQueue.pop(); deepLinkQueue = [];
        if (PANES.includes(key)) win.webContents.send('switch-service', key);
      }
    });
    win.on('close', saveWindowState);
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

  // Identify the desktop app to our backends so we can see who's on Workspace.
  // Every webview request carries "eSMSWorkspace/<version>" in the user-agent.
  try { app.userAgentFallback = `${app.userAgentFallback} eSMSWorkspace/${app.getVersion()}`; } catch (_) {}

  app.whenReady().then(() => {
    // Belt-and-braces: also stamp the shared session's user-agent.
    try {
      const s = session.fromPartition('persist:esms');
      if (!/eSMSWorkspace\//.test(s.getUserAgent())) s.setUserAgent(`${s.getUserAgent()} eSMSWorkspace/${app.getVersion()}`);
    } catch (_) {}

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

    // Cold-launch deep link (Windows/Linux pass it in argv).
    const launchLink = process.argv.find((a) => typeof a === 'string' && a.indexOf(`${PROTOCOL}://`) === 0);
    if (launchLink) routeDeepLink(launchLink);

    // ── Workspace usage ping ──
    // The web panes talk to their own backends, so central auth rarely sees a
    // request from the app. We make ONE authenticated call to auth's /auth/me
    // using the shared session (cookies + the eSMSWorkspace user-agent) so a
    // signed-in user is reliably recorded as a Workspace user - on launch and
    // every 6h. It's harmless when not signed in (401, no-op).
    // Role gating: which sensitive panes (Admin/Support) the signed-in user may
    // see. We keep it in lockstep with the web guards (esms-auth dependencies +
    // esms-auth-ui services.ts). Secure default is nothing until auth confirms.
    const entitlementsFor = (roles) => {
      roles = roles || {};
      const support = roles.support === 'agent' || roles.support === 'admin';
      const platformAdmin = roles.global === 'super_admin'
        || Object.entries(roles).some(([k, v]) => k !== 'support' && v === 'admin');
      return { admin: platformAdmin, support: support || platformAdmin };
    };
    let lastEnt = '';
    const pushEntitlements = (ent) => {
      const s = JSON.stringify(ent);
      if (s === lastEnt) return;
      lastEnt = s;
      toRenderer('entitlements', ent);
    };

    // ONE authenticated call to auth's /auth/me (shared session) - records the
    // Workspace user AND tells us their roles so we can gate panes.
    const refreshIdentity = () => {
      try {
        const ses = session.fromPartition('persist:esms');
        const req = net.request({ method: 'GET', url: 'https://auth.esmsafrica.io/auth/me', session: ses, useSessionCookies: true });
        req.setHeader('User-Agent', `${app.userAgentFallback}`);
        req.on('response', (r) => {
          let buf = '';
          r.on('data', (c) => { buf += c; });
          r.on('end', () => {
            if (r.statusCode !== 200) { pushEntitlements({ admin: false, support: false }); return; }
            try { pushEntitlements(entitlementsFor(JSON.parse(buf).app_roles)); }
            catch (_) { pushEntitlements({ admin: false, support: false }); }
          });
        });
        req.on('error', () => {});
        req.end();
      } catch (_) {}
    };
    setTimeout(refreshIdentity, 8000);                   // shortly after launch
    setInterval(refreshIdentity, 60 * 1000);             // pick up sign-in / role changes
    win.on('focus', refreshIdentity);

    // ── Auto-updates (GitHub Releases via electron-updater) ──
    // Always check, auto-download, and auto-restart into the new version - no
    // user action needed. autoInstallOnAppQuit stays on as a safety net.
    let updateApplying = false;
    let lastUpdateCheck = 0;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => toRenderer('update-status', { state: 'checking' }));
    autoUpdater.on('update-available', (i) => toRenderer('update-status', { state: 'available', version: i && i.version }));
    autoUpdater.on('update-not-available', () => toRenderer('update-status', { state: 'idle' }));
    autoUpdater.on('download-progress', (p) => toRenderer('update-status', { state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => {
      if (updateApplying) return;
      updateApplying = true;
      // Tell the window an update is in hand, give it a brief moment to show the
      // notice, then relaunch into the new version automatically.
      toRenderer('update-status', { state: 'restarting', version: i && i.version });
      setTimeout(() => { try { autoUpdater.quitAndInstall(false, true); } catch (_) {} }, 8000);
    });
    autoUpdater.on('error', () => toRenderer('update-status', { state: 'idle' }));

    const checkForUpdates = () => { lastUpdateCheck = Date.now(); autoUpdater.checkForUpdates().catch(() => {}); };
    checkForUpdates();                                       // on launch
    setInterval(checkForUpdates, 30 * 60 * 1000);            // every 30 minutes
    app.on('browser-window-focus', () => {                  // and when refocused (throttled)
      if (Date.now() - lastUpdateCheck > 10 * 60 * 1000) checkForUpdates();
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Restart to apply a downloaded update.
  ipcMain.on('restart-to-update', () => {
    try { autoUpdater.quitAndInstall(); } catch (_) {}
  });

  // Manual update check from the settings menu.
  ipcMain.on('check-updates', () => { autoUpdater.checkForUpdates().catch(() => {}); });

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

  app.on('second-instance', (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    // Windows/Linux deliver the deep link as an argv entry on the 2nd instance.
    const link = argv.find((a) => typeof a === 'string' && a.indexOf(`${PROTOCOL}://`) === 0);
    if (link) routeDeepLink(link);
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
      { label: 'eSMS Links', key: 'links', accel: 'CmdOrCtrl+5' },
      { label: 'Support', key: 'support', accel: 'CmdOrCtrl+6' },
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
