'use strict';

const { app, BrowserWindow, shell, ipcMain, Menu, nativeImage, safeStorage, session, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');

const isMac = process.platform === 'darwin';

// Single instance - focus the existing window instead of opening a second.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let deepLinkQueue = [];
  let onShellLoaded = () => {};   // set once identity checks are wired up
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

  // The only preload a service <webview> may run. In a packaged app __dirname is
  // inside app.asar; the file is unpacked (build.asarUnpack) so use that copy.
  const WV_PRELOAD = (() => {
    const p = path.join(__dirname, 'webview-preload.js');
    return p.includes(`app.asar${path.sep}`) ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p;
  })();

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
        sandbox: true,               // the shell preload only uses contextBridge/ipcRenderer
        // Sandboxed preloads can't require('path'), so hand them the webview preload URL.
        additionalArguments: [`--esms-wv-preload=${pathToFileURL(WV_PRELOAD).href}`],
        webviewTag: true,            // the service panes are <webview>s
        spellcheck: true,
      },
    });

    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    win.webContents.on('did-finish-load', () => { try { onShellLoaded(); } catch (_) {} });
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
  ipcMain.on('open-external', (e, url) => {
    if (!fromShell(e) || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
    openExternalSafe(url);
  });

  // Aggregate unread badge across services (macOS/Linux dock; Windows overlay).
  ipcMain.on('badge', (e, count) => {
    if (!fromShell(e)) return;
    const n = Math.max(0, Math.min(Number(count) || 0, 9999));
    try { app.setBadgeCount(n); } catch (_) {}
    if (process.platform === 'win32' && win) {
      win.setOverlayIcon(n > 0 ? makeOverlay(n) : null, n > 0 ? `${n} unread` : '');
    }
  });

  // Keep navigation inside the eSMS domains; send everything else to the browser.
  // HTTPS only: a file:// or http:// URL that merely names an eSMS host must not
  // count as internal.
  const ESMS_HOST = /(^|\.)esmsafrica\.io$/i;
  const isInternal = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && ESMS_HOST.test(u.hostname);
    } catch (_) { return false; }
  };
  // Only hand web/mail/phone links to the OS. Any other scheme (ms-msdt:, smb:,
  // file:, custom protocol handlers...) from page content - e.g. a link inside a
  // received email - could launch a local program, so it is dropped.
  const SAFE_EXTERNAL = new Set(['https:', 'http:', 'mailto:', 'tel:']);
  const openExternalSafe = (url) => {
    try {
      if (SAFE_EXTERNAL.has(new URL(url).protocol)) shell.openExternal(url);
    } catch (_) { /* ignore */ }
  };
  // Trusted third-party auth/payment hosts that MUST complete INSIDE the app's
  // shared session (persist:esms). Without this, Google/GitHub OAuth and card
  // checkout get ejected to the system browser and lose the session, so sign-in
  // and card top-ups can never finish in the app.
  const FLUTTERWAVE_CHECKOUT_HOSTS = new Set([
    'flutterwave.com',
    'checkout.flutterwave.com',
    'ravemodal.flutterwave.com',
    'checkout.sgmpayment.com',
  ]);
  const isTrustedAuth = (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:') return false;
      const h = u.hostname;
      return (
        h === 'accounts.google.com' ||
        h === 'github.com' || h === 'api.github.com' ||
        // Card and mobile money top-ups go through Flutterwave hosted checkout:
        // keep it in the app session so the return to /topup/result is still
        // signed in. checkout.sgmpayment.com is Flutterwave's Kenya checkout.
        FLUTTERWAVE_CHECKOUT_HOSTS.has(h)
      );
    } catch (_) { return false; }
  };
  const SHELL_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  const isAllowedInApp = (url) => isInternal(url) || isTrustedAuth(url);

  // ── First-party password vault ──
  // Logins are saved encrypted by the OS keychain (macOS Keychain / Windows
  // DPAPI / Linux libsecret) via safeStorage, and only ever for eSMS origins.
  const vaultFile = () => path.join(app.getPath('userData'), 'logins.json');
  const readVault = () => { try { return JSON.parse(fs.readFileSync(vaultFile(), 'utf8')); } catch (_) { return {}; } };
  const writeVault = (v) => { try { fs.writeFileSync(vaultFile(), JSON.stringify(v), { mode: 0o600 }); } catch (_) {} };
  const canVault = () => { try { return safeStorage.isEncryptionAvailable(); } catch (_) { return false; } };
  // The vault is keyed by the CALLING frame's own origin - never by an origin
  // the page supplies - so one eSMS subdomain can't read or overwrite the saved
  // login of another (an XSS on any *.esmsafrica.io page must not be able to
  // ask for auth.esmsafrica.io's password).
  const senderOrigin = (e) => {
    try {
      const u = new URL(e.senderFrame.url);
      return u.protocol === 'https:' && ESMS_HOST.test(u.hostname) ? u.origin : null;
    } catch (_) { return null; }
  };
  // Shell-only IPC (badge, vault admin, sign-out, updates) must come from the
  // app window itself, not from a service page or popup.
  const fromShell = (e) => !!(win && !win.isDestroyed() && e.sender === win.webContents);
  const enc = (s) => safeStorage.encryptString(s).toString('base64');
  const dec = (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64'));

  ipcMain.handle('vault-get', (e) => {
    const origin = senderOrigin(e);
    if (!origin || !canVault()) return null;
    const rec = readVault()[origin];
    if (!rec || !rec.p) return null;
    try { return { username: rec.u ? dec(rec.u) : '', password: dec(rec.p) }; } catch (_) { return null; }
  });
  ipcMain.handle('vault-save', (e, data) => {
    const origin = senderOrigin(e);
    if (!origin || !canVault() || !data || typeof data.password !== 'string' || !data.password) return false;
    try {
      const v = readVault();
      v[origin] = { u: data.username ? enc(data.username) : '', p: enc(data.password) };
      writeVault(v);
      return true;
    } catch (_) { return false; }
  });
  ipcMain.handle('vault-count', (e) => (fromShell(e) ? Object.keys(readVault()).length : 0));
  ipcMain.on('vault-clear', (e) => { if (!fromShell(e)) return; writeVault({}); toRenderer('vault-changed', 0); });
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedInApp(url)) {
        // Open in a child window that shares the login session so OAuth / Flutterwave
        // popups complete against the same cookies as the app.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 480, height: 720, autoHideMenuBar: true,
            webPreferences: { partition: 'persist:esms', contextIsolation: true, nodeIntegration: false, sandbox: true },
          },
        };
      }
      openExternalSafe(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (ev, url) => {
      // The shell window only ever shows its own bundled page: never let it be
      // navigated away (e.g. a link or file dropped onto the window), since it
      // carries the privileged preload bridge.
      if (win && contents === win.webContents) {
        if (url.split(/[?#]/)[0] !== SHELL_URL) { ev.preventDefault(); openExternalSafe(url); }
        return;
      }
      // Keep eSMS and trusted auth/payment hosts inside the webview session; push
      // everything else out to the system browser. (OAuth / payment popups are
      // left free to follow their provider's redirects.)
      if (contents.getType() === 'webview' && !isAllowedInApp(url)) {
        ev.preventDefault();
        openExternalSafe(url);
      }
    });
    // Service panes must stay isolated, whatever the renderer asks for.
    contents.on('will-attach-webview', (ev, webPreferences, params) => {
      // Only the shell window may create service panes.
      if (!win || contents !== win.webContents) { ev.preventDefault(); return; }
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      // Whatever preload the renderer asked for, a pane only ever gets ours.
      delete webPreferences.preloadURL;
      webPreferences.preload = WV_PRELOAD;
      if (params.src && params.src !== 'about:blank' && !isAllowedInApp(params.src)) ev.preventDefault();
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
      // Only eSMS pages get them - not Google/GitHub/Flutterwave or embedded frames.
      const esmsOrigin = (u) => { try { return isInternal(u); } catch (_) { return false; } };
      ses.setPermissionRequestHandler((wc, permission, cb, details) => {
        const origin = (details && details.requestingUrl) || (wc && wc.getURL && wc.getURL()) || '';
        cb(ALLOW.has(permission) && esmsOrigin(origin));
      });
      ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => ALLOW.has(permission) && esmsOrigin(requestingOrigin));
    } catch (_) {}

    // The shell window (default session) is a local page: it needs no permissions.
    try {
      session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
      session.defaultSession.setPermissionCheckHandler(() => false);
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
    // A reloaded or re-created shell renderer starts with every gated pane
    // hidden; forget the cached entitlements so the next check re-sends them
    // (otherwise Admin/Support stayed hidden after a shell reload, or after
    // closing and reopening the window on macOS).
    onShellLoaded = () => { lastEnt = ''; refreshIdentity(); };
    setInterval(refreshIdentity, 60 * 1000);             // pick up sign-in / role changes
    app.on('browser-window-focus', () => refreshIdentity());   // any window, incl. a re-created one

    // ── Auto-updates (GitHub Releases via electron-updater) ──
    // Always check, auto-download, and auto-restart into the new version - no
    // user action needed. autoInstallOnAppQuit stays on as a safety net.
    let updateApplying = false;
    let lastUpdateCheck = 0;
    let availableVersion = null;
    const RELEASES_URL = 'https://github.com/eSMS-Africa/esms-workspace/releases/latest';
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    // quitAndInstall silently no-ops on an UNSIGNED macOS app (Squirrel.Mac needs a
    // valid signature), and download can error the same way. So whenever the
    // in-place update can't be applied, fall back to opening the release download
    // page - the update still reaches the user, just via a manual install.
    // The banner shows every time, but the browser is opened at most once per
    // version per session: the 30-minute re-check would otherwise reopen the
    // release page in the browser over and over on an unsigned macOS build.
    let downloadOpenedFor = null;
    const openDownload = () => {
      toRenderer('update-status', { state: 'manual', version: availableVersion, url: RELEASES_URL });
      const v = availableVersion || 'latest';
      if (downloadOpenedFor === v) return;
      downloadOpenedFor = v;
      try { shell.openExternal(RELEASES_URL); } catch (_) {}
    };
    // Attempt an in-place relaunch; if the app is still alive shortly after (the
    // update could not be applied), fall back to the download page.
    const applyOrFallback = (silent) => {
      let quitting = false;
      app.once('before-quit', () => { quitting = true; });
      try { autoUpdater.quitAndInstall(false, true); } catch (_) {}
      setTimeout(() => { if (!quitting) openDownload(); }, 4000);
      if (!silent) return;
    };

    autoUpdater.on('checking-for-update', () => toRenderer('update-status', { state: 'checking' }));
    autoUpdater.on('update-available', (i) => { availableVersion = i && i.version; toRenderer('update-status', { state: 'available', version: availableVersion }); });
    autoUpdater.on('update-not-available', () => toRenderer('update-status', { state: 'idle' }));
    autoUpdater.on('download-progress', (p) => toRenderer('update-status', { state: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (i) => {
      if (updateApplying) return;
      updateApplying = true;
      availableVersion = (i && i.version) || availableVersion;
      // Tell the window an update is in hand, give it a brief moment to show the
      // notice, then relaunch into the new version (or fall back to a download).
      toRenderer('update-status', { state: 'restarting', version: availableVersion });
      setTimeout(() => applyOrFallback(true), 6000);
    });
    autoUpdater.on('error', () => {
      // An error after an update was found (typical for an unsigned mac build):
      // offer the manual download instead of silently going idle.
      if (availableVersion) openDownload();
      else toRenderer('update-status', { state: 'idle' });
    });

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

  // Restart to apply a downloaded update. If the in-place install can't run
  // (unsigned macOS), fall back to opening the release download page.
  ipcMain.on('restart-to-update', (e) => {
    if (!fromShell(e)) return;
    let quitting = false;
    app.once('before-quit', () => { quitting = true; });
    try { autoUpdater.quitAndInstall(false, true); } catch (_) {}
    setTimeout(() => {
      if (quitting) return;
      const url = 'https://github.com/eSMS-Africa/esms-workspace/releases/latest';
      toRenderer('update-status', { state: 'manual', url });
      try { shell.openExternal(url); } catch (_) {}
    }, 4000);
  });

  // Manual update check from the settings menu.
  ipcMain.on('check-updates', (e) => { if (fromShell(e)) autoUpdater.checkForUpdates().catch(() => {}); });

  // Sign out everywhere: wipe the shared session (cookies + storage).
  ipcMain.handle('sign-out', async (e) => {
    if (!fromShell(e)) return false;
    try {
      const ses = session.fromPartition('persist:esms');
      await ses.clearStorageData();
      return true;
    } catch (_) { return false; }
  });

  // ── Never stay crashed: recover the shell if its renderer dies ──
  ipcMain.on('shell-recover', (e) => { if (fromShell(e) && win && !win.isDestroyed()) win.reload(); });

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
      {
        // Custom View menu WITHOUT the default Reload/Force-Reload: those also bind
        // CmdOrCtrl+R and would reload the whole shell (tearing down every pane),
        // clashing with Workspace -> "Reload service". Keep zoom/fullscreen/devtools.
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' },
        ],
      },
      { role: 'windowMenu' },
    ];
    return Menu.buildFromTemplate(template);
  }
}
