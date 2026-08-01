'use strict';

// Each service is a persistent <webview> sharing one session (persist:esms) —
// sign in once, switch freely. Panes hold the webview + loading/error overlays.
const SERVICES = [
  { key: 'email', label: 'Email', url: 'https://send.esmsafrica.io',
    icon: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 7L2 7"/>' },
  { key: 'sms', label: 'SMS', url: 'https://sms.esmsafrica.io',
    icon: '<path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>' },
  { key: 'smpp', label: 'SMPP', url: 'https://smpp.esmsafrica.io',
    icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>' },
  { key: 'admin', label: 'Admin', url: 'https://auth.esmsafrica.io/admin',
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>' },
];

const $ = (s) => document.querySelector(s);
const nav = $('#nav'), stage = $('#stage'), splash = $('#splash');
const unread = {}, panes = {};
let active = null, firstReady = false;

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
    btn.innerHTML = `${svg(s.icon)}<span class="dot" data-dot="${s.key}"></span><span class="label">${s.label}</span>`;
    btn.onclick = () => show(s.key);
    nav.appendChild(btn);

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
    wv.setAttribute('src', s.url);
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
  active = key;
  document.querySelectorAll('.svc').forEach((b) => b.classList.toggle('active', b.dataset.key === key));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('active', p.dataset.key === key));
}

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
    if (s.state === 'available') { title.textContent = 'Update available'; sub.textContent = `Version ${s.version || ''} — downloading…`; action.classList.add('hidden'); }
    else if (s.state === 'downloading') { title.textContent = 'Downloading update'; sub.textContent = `${s.percent || 0}%`; action.classList.add('hidden'); }
    else if (s.state === 'ready') { title.textContent = 'Update ready'; sub.textContent = 'Restart to apply.'; action.classList.remove('hidden'); rail.classList.add('on'); }
  });
} catch (_) {}

build();
