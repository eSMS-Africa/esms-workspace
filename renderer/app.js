'use strict';

// Each service is a persistent <webview> sharing one session (persist:esms) -
// sign in once, switch freely. Panes hold the webview + loading/error overlays.
const SERVICES = [
  { key: 'email', label: 'Email', url: 'https://send.esmsafrica.io/dashboard',
    icon: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 7L2 7"/>' },
  { key: 'sms', label: 'SMS', url: 'https://sms.esmsafrica.io',
    icon: '<path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>' },
  { key: 'smpp', label: 'SMPP', url: 'https://smpp.esmsafrica.io/login',
    icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { key: 'admin', label: 'Admin', url: 'https://auth.esmsafrica.io/admin', gated: 'admin',
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>' },
  { key: 'links', label: 'eSMS Links', url: 'https://links.esmsafrica.io',
    icon: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>' },
  { key: 'support', label: 'Support', url: 'https://auth.esmsafrica.io/support',
    icon: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>' },
  { key: 'help', label: 'Help', url: 'https://esmsafrica.io/help', bottom: true,
    icon: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>' },
];

const $ = (s) => document.querySelector(s);
const nav = $('#nav'), stage = $('#stage'), splash = $('#splash');
const unread = {}, panes = {};
let active = null, firstReady = false;
// Role gating: sensitive panes stay hidden until central auth confirms the
// signed-in user's roles (see main.js refreshIdentity). Secure default: hidden.
const svcByKey = Object.fromEntries(SERVICES.map((s) => [s.key, s]));
let entitled = { admin: false, support: false };
const canSee = (s) => !s.gated || !!entitled[s.gated];

const svg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

function hideSplash() {
  if (firstReady) return;
  firstReady = true;
  splash.classList.add('gone');
  setTimeout(() => splash.remove(), 600);
}
// Safety: never let the splash hang, even if the first load stalls.
setTimeout(hideSplash, 12000);

function updateBadge() {
  const total = Object.values(unread).reduce((a, b) => a + (b || 0), 0);
  try { window.esms.setBadge(total); } catch (_) {}
}
function parseUnread(title) {
  const m = (title || '').match(/^\s*\((\d+)\)/) || (title || '').match(/(\d+)\s+unread/i);
  return m ? parseInt(m[1], 10) : 0;
}

function build() {
  SERVICES.forEach((s) => {
    const btn = document.createElement('button');
    btn.className = 'svc'; btn.dataset.key = s.key;
    if (s.bottom) btn.classList.add('svc-bottom');
    btn.innerHTML = `${svg(s.icon)}<span class="dot" data-dot="${s.key}"></span><span class="label">${s.label}</span>`;
    btn.onclick = () => show(s.key);
    if (s.gated) btn.style.display = canSee(s) ? '' : 'none';   // hidden until entitled
    // Utility tabs (Help) sit at the foot of the rail, next to Settings.
    if (s.bottom) { const anchor = $('#railUpdate'); anchor.parentNode.insertBefore(btn, anchor); }
    else nav.appendChild(btn);

    const pane = document.createElement('div');
    pane.className = 'pane'; pane.dataset.key = s.key;
    pane.innerHTML = `
      <div class="overlay loading"><div class="spin"></div><div class="msg">Loading ${s.label}…</div></div>
      <div class="overlay error hidden">
        <div class="ico">${svg('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>')}</div>
        <div class="title">Couldn't reach ${s.label}</div>
        <div class="msg">Check your connection and try again.</div>
        <button class="retry">Retry</button>
      </div>`;
    const wv = document.createElement('webview');
    wv.dataset.key = s.key;
    wv.setAttribute('partition', 'persist:esms');
    wv.setAttribute('allowpopups', 'true');
    try { if (window.esms && window.esms.webviewPreload) wv.setAttribute('preload', window.esms.webviewPreload); } catch (_) {}
    // Gated panes don't load their URL until the user is entitled AND opens them,
    // so a non-admin never even requests /admin.
    if (s.gated) wv.dataset.lazy = s.url; else wv.setAttribute('src', s.url);
    pane.appendChild(wv);
    stage.appendChild(pane);

    const loading = pane.querySelector('.overlay.loading');
    const error = pane.querySelector('.overlay.error');
    const showLoading = (on) => loading.classList.toggle('hidden', !on);
    const showError = (on) => error.classList.toggle('hidden', !on);

    wv.addEventListener('did-start-loading', () => { showError(false); showLoading(true); });
    const done = () => { showLoading(false); if (s.key === 'email' || active === s.key) hideSplash(); };
    wv.addEventListener('dom-ready', done);
    wv.addEventListener('did-stop-loading', done);
    wv.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3 || e.isMainFrame === false) return;  // aborted / subframe
      showLoading(false); showError(true); hideSplash();
    });
    // Auto-recover a crashed service pane.
    wv.addEventListener('render-process-gone', () => {
      showError(false); showLoading(true);
      setTimeout(() => { try { wv.reload(); } catch (_) {} }, 1200);
    });
    wv.addEventListener('crashed', () => { setTimeout(() => { try { wv.reload(); } catch (_) {} }, 1200); });
    wv.addEventListener('page-title-updated', (e) => {
      unread[s.key] = parseUnread(e.title);
      const dot = document.querySelector(`[data-dot="${s.key}"]`);
      if (dot) { dot.textContent = unread[s.key] > 99 ? '99+' : String(unread[s.key]); dot.classList.toggle('on', unread[s.key] > 0); }
      updateBadge();
    });
    error.querySelector('.retry').onclick = () => { showError(false); showLoading(true); try { wv.reload(); } catch (_) { wv.src = s.url; } };

    panes[s.key] = { pane, wv };
  });
  show('email');
}

function show(key) {
  const s = svcByKey[key];
  // Refuse to open a gated pane the user isn't entitled to (covers nav + menu).
  if (s && s.gated && !canSee(s)) return;
  const p = panes[key];
  if (p && p.wv.dataset.lazy) {
    const cur = p.wv.getAttribute('src');
    if (!cur || cur === 'about:blank') p.wv.setAttribute('src', p.wv.dataset.lazy);  // lazy-load on first authorised open
  }
  active = key;
  document.querySelectorAll('.svc').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
  document.querySelectorAll('.pane').forEach((pn) => pn.classList.toggle('active', pn.dataset.key === key));
}

function applyEntitlements(ent) {
  entitled = { admin: !!(ent && ent.admin), support: !!(ent && ent.support) };
  SERVICES.filter((s) => s.gated).forEach((s) => {
    const btn = document.querySelector(`.svc[data-key="${s.key}"]`);
    if (btn) btn.style.display = canSee(s) ? '' : 'none';
    // If the user is viewing a pane they just lost access to, bounce them out
    // and unload it so no privileged content lingers.
    if (!canSee(s)) {
      const p = panes[s.key];
      if (p) { try { p.wv.setAttribute('src', 'about:blank'); } catch (_) {} }
      if (active === s.key) show('email');
    }
  });
}
try { window.esms.onEntitlements(applyEntitlements); } catch (_) {}

// Menu / shortcuts
try {
  window.esms.onSwitchService((key) => show(key));
  window.esms.onReloadService(() => { const p = panes[active]; if (p) try { p.wv.reload(); } catch (_) {} });
} catch (_) {}

// Auto-update banner
try {
  const bar = $('#updatebar'), title = $('#ub-title'), sub = $('#ub-sub'), action = $('#ub-action'), rail = $('#railUpdate');
  const restart = () => window.esms.restartToUpdate();
  action.onclick = restart; rail.onclick = restart;
  window.esms.onUpdateStatus((s) => {
    if (!s || s.state === 'idle') { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    if (s.state === 'available') { title.textContent = 'Update available'; sub.textContent = `Version ${s.version || ''} - downloading…`; action.classList.add('hidden'); }
    else if (s.state === 'downloading') { title.textContent = 'Downloading update'; sub.textContent = `${s.percent || 0}%`; action.classList.add('hidden'); }
    else if (s.state === 'ready') { title.textContent = 'Update ready'; sub.textContent = 'Restart to apply.'; action.classList.remove('hidden'); rail.classList.add('on'); }
  });
} catch (_) {}

// Platform class (macOS gets extra top padding for the traffic lights).
try { document.body.dataset.platform = (window.esms && window.esms.platform) || ''; } catch (_) {}

// Settings / account menu on the rail.
try {
  const gear = $('#railSettings'), menu = $('#settingsMenu');
  const closeMenu = () => menu.classList.add('hidden');
  gear.onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
    if (!menu.classList.contains('hidden')) {
      window.esms.savedLoginCount().then((n) => {
        const el = $('#savedCount'); if (el) el.textContent = n ? `${n} saved` : 'none saved';
      }).catch(() => {});
    }
  };
  menu.onclick = (e) => e.stopPropagation();
  document.addEventListener('click', closeMenu);

  $('#miReloadAll').onclick = () => { Object.values(panes).forEach((p) => { try { p.wv.reload(); } catch (_) {} }); closeMenu(); };
  $('#miUpdates').onclick = () => { try { window.esms.checkForUpdates(); } catch (_) {} closeMenu(); };
  $('#miClearLogins').onclick = () => {
    try { window.esms.clearSavedLogins(); } catch (_) {}
    const el = $('#savedCount'); if (el) el.textContent = 'none saved';
    closeMenu();
  };
  $('#miSignOut').onclick = async () => {
    closeMenu();
    try { await window.esms.signOut(); } catch (_) {}
    Object.values(panes).forEach((p) => { try { p.wv.reload(); } catch (_) {} });
  };
} catch (_) {}

build();
