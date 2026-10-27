// Security regression tests: loads main.js against a mocked electron and
// exercises the navigation, popup, vault, IPC, permission and updater handlers.
// Run with: npm test  (no Electron binary needed)
const Module = require('module');
const path = require('path');
const EventEmitter = require('events');
const MAIN = path.join(__dirname, '..', 'main.js');
const opened = [], ipcOn = {}, ipcHandle = {};
const userData = require('fs').mkdtempSync(path.join(require('os').tmpdir(), 'esms-ws-'));
class WC extends EventEmitter { constructor(type){super(); this.type=type;} getType(){return this.type;} send(){} getURL(){return '';} setWindowOpenHandler(h){this.openHandler=h;} reload(){} }
let mainWin;
class BrowserWindow extends EventEmitter {
  constructor(){ super(); this.webContents = new WC('window'); mainWin = this; app.emit('web-contents-created', {}, this.webContents); }
  loadFile(){} once(ev, cb){ super.once(ev, cb); } show(){} isDestroyed(){return false;} isMinimized(){return false;} getBounds(){return {width:1,height:1};}
  static getAllWindows(){ return [mainWin]; }
}
const app = new EventEmitter();
Object.assign(app, { requestSingleInstanceLock:()=>true, setAsDefaultProtocolClient(){}, getPath:()=>userData, getVersion:()=>'0.5.0',
  userAgentFallback:'UA', whenReady:()=>Promise.resolve(), setBadgeCount(){}, quit(){} });
const sesHandlers = {};
const ses = { getUserAgent:()=>'UA', setUserAgent(){}, setPermissionRequestHandler(h){sesHandlers.req=h;}, setPermissionCheckHandler(h){sesHandlers.check=h;}, clearStorageData: async()=>{} };
const electron = { app, BrowserWindow, shell:{ openExternal:(u)=>opened.push(u) },
  ipcMain:{ on:(c,h)=>ipcOn[c]=h, handle:(c,h)=>ipcHandle[c]=h },
  Menu:{ setApplicationMenu(){}, buildFromTemplate:()=>({}) }, nativeImage:{ createFromDataURL:()=>({}) },
  safeStorage:{ isEncryptionAvailable:()=>true, encryptString:(s)=>Buffer.from('E'+s), decryptString:(b)=>b.toString().slice(1) },
  session:{ fromPartition:()=>ses, defaultSession:{ setPermissionRequestHandler(h){sesHandlers.defReq=h;}, setPermissionCheckHandler(h){sesHandlers.defCheck=h;} } }, net:{ request:()=>({ setHeader(){}, on(){}, end(){} }) } };
const updater = new EventEmitter(); updater.checkForUpdates = () => Promise.resolve(); updater.checkForUpdatesAndNotify = () => Promise.resolve(); updater.quitAndInstall = () => {};
const origLoad = Module._load;
Module._load = function (req, ...rest) { if (req === 'electron') return electron; if (req === 'electron-updater') return { autoUpdater: updater }; return origLoad.call(this, req, ...rest); };
const realSetInterval = global.setInterval, realSetTimeout = global.setTimeout;
global.setInterval = () => 0; global.setTimeout = (fn, ms) => (ms >= 1000 ? 0 : realSetTimeout(fn, ms));
require(MAIN);
let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };
(async () => {
  await new Promise((r) => realSetTimeout(r, 20));
  const wv = new WC('webview'); app.emit('web-contents-created', {}, wv);
  const nav = (wc, url) => { let prevented = false; wc.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url); return prevented; };
  ok(!nav(wv, 'https://sms.esmsafrica.io/x'), 'webview may navigate to eSMS https');
  ok(nav(wv, 'https://evil-esmsafrica.io/'), 'blocks evil-esmsafrica.io');
  ok(nav(wv, 'https://esmsafrica.io.evil.com/'), 'blocks esmsafrica.io.evil.com');
  ok(nav(wv, 'file://esmsafrica.io/etc/passwd'), 'blocks file:// naming an eSMS host');
  ok(nav(wv, 'http://sms.esmsafrica.io/'), 'blocks plain http eSMS');
  ok(!nav(wv, 'https://checkout.flutterwave.com/v3/hosted/pay/abc'), 'Flutterwave checkout stays in app');
  ok(!nav(wv, 'https://ravemodal.flutterwave.com/x'), 'Flutterwave modal stays in app');
  ok(!nav(wv, 'https://checkout.sgmpayment.com/x'), 'Flutterwave Kenya checkout stays in app');
  ok(!nav(wv, 'https://flutterwave.com/pay/x'), 'flutterwave.com stays in app');
  opened.length = 0; ok(nav(wv, 'https://evil.flutterwave.com.attacker.io/') && opened.length === 1, 'look-alike Flutterwave host opens in browser');
  opened.length = 0; ok(nav(wv, 'http://checkout.flutterwave.com/') , 'plain http Flutterwave blocked');
  opened.length = 0; nav(wv, 'ms-msdt:/id PCWDiagnostic'); ok(opened.length === 0, 'dangerous scheme not handed to the OS');
  opened.length = 0; nav(wv, 'https://example.com/'); ok(opened[0] === 'https://example.com/', 'external https opens in browser');
  const shellWc = mainWin.webContents;
  ok(nav(shellWc, 'file:///tmp/evil.html'), 'shell cannot be navigated to another file');
  ok(!nav(shellWc, require('url').pathToFileURL(path.join(path.dirname(MAIN), 'renderer', 'index.html')).href + '#x'), 'shell own page allowed');
  opened.length = 0; const r = wv.openHandler({ url: 'smb://host/share' }); ok(r.action === 'deny' && opened.length === 0, 'popup with smb: denied, not opened');
  const r2 = wv.openHandler({ url: 'https://accounts.google.com/o/oauth2' }); ok(r2.action === 'allow' && r2.overrideBrowserWindowOptions.webPreferences.sandbox === true, 'OAuth popup allowed, sandboxed');
  // vault
  const frame = (u) => ({ senderFrame: { url: u }, sender: wv });
  ok(await ipcHandle['vault-save'](frame('https://auth.esmsafrica.io/login'), { origin: 'https://evil.com', username: 'u', password: 'p' }) === true, 'vault save from auth');
  const got = await ipcHandle['vault-get'](frame('https://auth.esmsafrica.io/login'), 'https://whatever');
  ok(got && got.password === 'p', 'vault get returns own-origin creds');
  ok(await ipcHandle['vault-get'](frame('https://links.esmsafrica.io/'), 'https://auth.esmsafrica.io') === null, 'other subdomain cannot read auth creds');
  ok(await ipcHandle['vault-get'](frame('http://auth.esmsafrica.io/login')) === null, 'http frame refused');
  ok(await ipcHandle['vault-count']({ sender: wv }) === 0, 'vault-count from webview refused');
  ok(await ipcHandle['vault-count']({ sender: shellWc }) === 1, 'vault-count from shell');
  ok(await ipcHandle['sign-out']({ sender: wv }) === false, 'sign-out from webview refused');
  // permissions
  let granted; sesHandlers.req(null, 'notifications', (g) => granted = g, { requestingUrl: 'https://send.esmsafrica.io/inbox' }); ok(granted === true, 'notifications for eSMS');
  sesHandlers.req(null, 'notifications', (g) => granted = g, { requestingUrl: 'https://github.com/' }); ok(granted === false, 'notifications denied for github');
  sesHandlers.req(null, 'media', (g) => granted = g, { requestingUrl: 'https://send.esmsafrica.io/' }); ok(granted === false, 'media denied');
  ok(sesHandlers.check(null, 'notifications', 'https://sms.esmsafrica.io') === true, 'check handler eSMS');
  ok(sesHandlers.check(null, 'notifications', 'https://accounts.google.com') === false, 'check handler google denied');
  // updater: browser opened once per version
  opened.length = 0; updater.emit('update-available', { version: '0.5.0' }); updater.emit('error'); updater.emit('error');
  ok(opened.length === 1, 'release page opened once, not on every error (' + opened.length + ')');
  // will-attach-webview
  let blocked = false; const prefs = { nodeIntegration: true };
  shellWc.emit('will-attach-webview', { preventDefault: () => blocked = true }, prefs, { src: 'https://evil.com' });
  ok(blocked && prefs.nodeIntegration === false, 'foreign webview blocked + node off');
  blocked = false; shellWc.emit('will-attach-webview', { preventDefault: () => blocked = true }, {}, { src: '' });
  ok(!blocked, 'lazy (no src) webview allowed');
  const p2 = { preload: '/tmp/evil.js', preloadURL: 'file:///tmp/evil.js', sandbox: false };
  shellWc.emit('will-attach-webview', { preventDefault(){} }, p2, { src: 'https://sms.esmsafrica.io/' });
  ok(p2.preload === path.join(path.dirname(MAIN), 'webview-preload.js') && !('preloadURL' in p2) && p2.sandbox === true, 'pane preload forced to ours, sandboxed');
  blocked = false; wv.emit('will-attach-webview', { preventDefault: () => blocked = true }, {}, { src: 'https://sms.esmsafrica.io/' });
  ok(blocked, 'a service page cannot attach its own webview');
  let dg; sesHandlers.defReq(null, 'notifications', (g) => dg = g); ok(dg === false && sesHandlers.defCheck(null, 'notifications', 'file://') === false, 'shell session grants no permissions');
  console.log(fails ? `${fails} FAILED` : 'ALL OK'); process.exit(fails ? 1 : 0);
})();
